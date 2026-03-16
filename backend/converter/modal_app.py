"""
gifcaption-converter — Modal GPU endpoint for WebM→MP4 conversion

Uses NVIDIA T4 GPU with NVENC for hardware-accelerated H.264 encoding.
Memory snapshots reduce cold start time by pre-loading boto3 + imports.

Deploy:
  modal deploy backend/converter/modal_app.py

After deployment, update MODAL_CONVERTER_ENDPOINT in
frontend/video-editor/edit/index.html with the printed URL.

Required Modal secret "gifcaption-aws" with keys:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ASSETS_BUCKET
"""

import modal

app = modal.App("gifcaption-converter")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("wget", "xz-utils")
    .run_commands(
        # BtbN static ffmpeg with NVENC support (uses nv-codec-headers at runtime)
        "wget -q -O /tmp/ffmpeg.tar.xz "
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-linux64-gpl.tar.xz",
        "tar -xf /tmp/ffmpeg.tar.xz -C /opt/ --strip-components=1",
        "rm /tmp/ffmpeg.tar.xz",
    )
    .pip_install("boto3", "fastapi[standard]", "pydantic")
)


@app.cls(
    gpu="T4",
    image=image,
    timeout=300,
    scaledown_window=300,
    enable_memory_snapshot=True,
    secrets=[modal.Secret.from_name("gifwidgets-aws")],
)
class Converter:
    @modal.enter(snap=True)
    def load(self):
        """Runs once before snapshot — boto3 + imports are captured."""
        import boto3
        import os

        self.s3 = boto3.client(
            "s3",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
        self.bucket = os.environ["ASSETS_BUCKET"]

    @modal.enter()
    def warmup(self):
        """Runs after snapshot restore — warms up NVENC on the live GPU."""
        import subprocess

        # Short encode to force NVENC driver initialization
        subprocess.run(
            [
                "/opt/bin/ffmpeg", "-y",
                "-f", "lavfi", "-i", "nullsrc=s=320x240:d=0.1:r=30",
                "-c:v", "h264_nvenc", "-f", "null", "-",
            ],
            capture_output=True,
            timeout=30,
        )

    @modal.asgi_app()
    def web(self):
        import os
        import re
        import tempfile
        import subprocess
        from fastapi import FastAPI
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse
        from pydantic import BaseModel

        web_app = FastAPI()
        web_app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["POST", "OPTIONS"],
            allow_headers=["Content-Type"],
        )

        class ConvertRequest(BaseModel):
            job_id: str
            filename: str = "converted.mp4"

        @web_app.post("/convert")
        async def convert(req: ConvertRequest):
            if not re.match(r"^[a-f0-9]{12}$", req.job_id):
                return JSONResponse({"error": "Invalid job_id"}, status_code=400)

            input_key = f"convert/{req.job_id}/input.webm"
            output_key = f"convert/{req.job_id}/output.mp4"

            with tempfile.TemporaryDirectory() as tmpdir:
                input_path = os.path.join(tmpdir, "input.webm")
                output_path = os.path.join(tmpdir, "output.mp4")

                try:
                    self.s3.download_file(self.bucket, input_key, input_path)
                except Exception:
                    return JSONResponse(
                        {"error": "Input file not found — upload may have expired"},
                        status_code=400,
                    )

                # GPU-accelerated encode via NVENC
                result = subprocess.run(
                    [
                        "/opt/bin/ffmpeg", "-y",
                        "-i", input_path,
                        "-c:v", "h264_nvenc",
                        "-preset", "p4",
                        "-movflags", "+faststart",
                        "-c:a", "aac",
                        output_path,
                    ],
                    capture_output=True,
                    timeout=240,
                )

                # Fallback to CPU encode if NVENC unavailable
                if result.returncode != 0:
                    result = subprocess.run(
                        [
                            "/opt/bin/ffmpeg", "-y",
                            "-i", input_path,
                            "-c:v", "libx264",
                            "-preset", "fast",
                            "-movflags", "+faststart",
                            "-c:a", "aac",
                            output_path,
                        ],
                        capture_output=True,
                        timeout=240,
                    )

                if result.returncode != 0:
                    return JSONResponse(
                        {
                            "error": "Conversion failed",
                            "detail": result.stderr.decode(
                                "utf-8", errors="replace"
                            )[-500:],
                        },
                        status_code=500,
                    )

                self.s3.upload_file(
                    output_path,
                    self.bucket,
                    output_key,
                    ExtraArgs={"ContentType": "video/mp4"},
                )

            safe_filename = (
                re.sub(r"[^\w\s.\-]", "", req.filename).strip() or "converted.mp4"
            )
            if not safe_filename.endswith(".mp4"):
                safe_filename += ".mp4"

            download_url = self.s3.generate_presigned_url(
                "get_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": output_key,
                    "ResponseContentDisposition": (
                        f'attachment; filename="{safe_filename}"'
                    ),
                },
                ExpiresIn=3600,
            )

            # Clean up input file
            try:
                self.s3.delete_object(Bucket=self.bucket, Key=input_key)
            except Exception:
                pass

            return {"download_url": download_url}

        @web_app.post("/warmup")
        async def warmup():
            return {"ok": True}

        return web_app

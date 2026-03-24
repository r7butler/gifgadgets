"""
gifwidgets-converter — Modal GPU endpoint for WebM→MP4 conversion

Uses NVIDIA T4 GPU with NVENC for hardware-accelerated H.264 encoding.
Memory snapshots reduce cold start time by pre-loading boto3 + imports.

Deploy:
  modal deploy backend/converter/modal_app.py

After deployment, update MODAL_CONVERTER_ENDPOINT in
frontend/trim-video/edit/index.html with the printed URL.

Required Modal secret "gifwidgets-aws" with keys:
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ASSETS_BUCKET
"""

import modal

app = modal.App("gifwidgets-converter")

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
        from fastapi import FastAPI, Header
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse
        from pydantic import BaseModel
        from typing import Optional

        expected_api_key = os.environ.get("MODAL_API_KEY", "")

        web_app = FastAPI()
        web_app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["POST", "OPTIONS"],
            allow_headers=["Content-Type", "X-Modal-Api-Key"],
        )

        def _check_api_key(key):
            if expected_api_key and key != expected_api_key:
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
            return None

        class ConvertRequest(BaseModel):
            job_id: str
            filename: str = "converted.mp4"

        class TrimRequest(BaseModel):
            job_id: str
            start: float = 0.0
            end: float | None = None
            format: str = "mp4"  # "mp4", "webm", or "gif"

        @web_app.post("/convert")
        async def convert(req: ConvertRequest, x_modal_api_key: Optional[str] = Header(None)):
            auth_error = _check_api_key(x_modal_api_key)
            if auth_error:
                return auth_error
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

        @web_app.post("/trim")
        async def trim(req: TrimRequest, x_modal_api_key: Optional[str] = Header(None)):
            """Trim a video uploaded to S3 and return a presigned download URL."""
            auth_error = _check_api_key(x_modal_api_key)
            if auth_error:
                return auth_error
            if not re.match(r"^[a-f0-9]{12}$", req.job_id):
                return JSONResponse({"error": "Invalid job_id"}, status_code=400)
            if req.format not in ("mp4", "webm", "gif"):
                return JSONResponse({"error": "Format must be mp4, webm, or gif"}, status_code=400)

            input_key = f"convert/{req.job_id}/input.webm"
            out_ext = req.format
            output_key = f"convert/{req.job_id}/trimmed.{out_ext}"
            content_type_map = {"mp4": "video/mp4", "webm": "video/webm", "gif": "image/gif"}
            content_type = content_type_map[out_ext]

            with tempfile.TemporaryDirectory() as tmpdir:
                input_path = os.path.join(tmpdir, "input.webm")
                output_path = os.path.join(tmpdir, f"trimmed.{out_ext}")

                try:
                    self.s3.download_file(self.bucket, input_key, input_path)
                except Exception:
                    return JSONResponse(
                        {"error": "Input file not found — upload may have expired"},
                        status_code=400,
                    )

                cmd = ["/opt/bin/ffmpeg", "-y"]
                if req.start > 0:
                    cmd += ["-ss", str(req.start)]
                cmd += ["-i", input_path]
                if req.end is not None:
                    cmd += ["-to", str(req.end - req.start)]

                if out_ext == "gif":
                    # Two-pass GIF: generate palette then encode
                    palette_path = os.path.join(tmpdir, "palette.png")
                    palette_cmd = cmd + [
                        "-vf", "fps=15,scale='min(480,iw)':-1:flags=lanczos,palettegen",
                        palette_path,
                    ]
                    subprocess.run(palette_cmd, capture_output=True, timeout=120)

                    gif_cmd = ["/opt/bin/ffmpeg", "-y"]
                    if req.start > 0:
                        gif_cmd += ["-ss", str(req.start)]
                    gif_cmd += ["-i", input_path, "-i", palette_path]
                    if req.end is not None:
                        gif_cmd += ["-to", str(req.end - req.start)]
                    gif_cmd += [
                        "-lavfi", "fps=15,scale='min(480,iw)':-1:flags=lanczos[x];[x][1:v]paletteuse",
                        "-loop", "0",
                        output_path,
                    ]
                    result = subprocess.run(gif_cmd, capture_output=True, timeout=240)
                elif out_ext == "mp4":
                    cmd += [
                        "-c:v", "h264_nvenc", "-preset", "p4",
                        "-movflags", "+faststart", "-c:a", "aac",
                    ]
                    cmd.append(output_path)
                    result = subprocess.run(cmd, capture_output=True, timeout=240)
                else:
                    cmd += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-c:a", "libopus"]
                    cmd.append(output_path)
                    result = subprocess.run(cmd, capture_output=True, timeout=240)

                # Fallback to CPU for MP4 if NVENC fails
                if result.returncode != 0 and out_ext == "mp4":
                    cmd2 = ["/opt/bin/ffmpeg", "-y"]
                    if req.start > 0:
                        cmd2 += ["-ss", str(req.start)]
                    cmd2 += ["-i", input_path]
                    if req.end is not None:
                        cmd2 += ["-to", str(req.end - req.start)]
                    cmd2 += [
                        "-c:v", "libx264", "-preset", "fast",
                        "-movflags", "+faststart", "-c:a", "aac",
                        output_path,
                    ]
                    result = subprocess.run(cmd2, capture_output=True, timeout=240)

                if result.returncode != 0:
                    return JSONResponse(
                        {
                            "error": "Trim failed",
                            "detail": result.stderr.decode("utf-8", errors="replace")[-500:],
                        },
                        status_code=500,
                    )

                self.s3.upload_file(
                    output_path, self.bucket, output_key,
                    ExtraArgs={"ContentType": content_type},
                )

            download_url = self.s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": self.bucket, "Key": output_key},
                ExpiresIn=3600,
            )

            # Clean up input
            try:
                self.s3.delete_object(Bucket=self.bucket, Key=input_key)
            except Exception:
                pass

            return {"download_url": download_url, "content_type": content_type}

        @web_app.post("/warmup")
        async def warmup():
            return {"ok": True}

        return web_app

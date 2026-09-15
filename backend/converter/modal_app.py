"""
gifwidgets-converter — Modal GPU endpoint for WebM→MP4 conversion

Uses NVIDIA T4 GPU with NVENC for hardware-accelerated H.264 encoding.
Memory snapshots reduce cold start time by pre-loading imports.

This app holds no AWS credentials. Callers presign one GET URL for the input
and one PUT URL for the output and pass both in the request body.

Deploy:
  modal deploy backend/converter/modal_app.py

Required Modal secret "gifwidgets-modal-api-key" with key MODAL_API_KEY,
matching modal_api_key in terraform/secrets.auto.tfvars.
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
    .pip_install("fastapi[standard]", "pydantic")
)


@app.cls(
    gpu="T4",
    image=image,
    timeout=300,
    scaledown_window=300,
    enable_memory_snapshot=True,
    secrets=[modal.Secret.from_name("gifwidgets-modal-api-key")],
)
class Converter:
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
        import shutil
        import tempfile
        import urllib.request
        import subprocess
        from fastapi import FastAPI, Header
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse
        from pydantic import BaseModel
        from typing import Optional

        expected_api_key = os.environ.get("MODAL_API_KEY", "").strip()
        if not expected_api_key:
            raise RuntimeError("MODAL_API_KEY must be configured")

        web_app = FastAPI()
        web_app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["POST", "OPTIONS"],
            allow_headers=["Content-Type", "X-Modal-Api-Key"],
        )

        def _fetch_to_file(url, dest_path):
            """Download a presigned GET URL to disk."""
            with urllib.request.urlopen(url, timeout=120) as r, open(dest_path, "wb") as f:
                shutil.copyfileobj(r, f)

        def _put_file(url, src_path, content_type):
            """Upload a file to a presigned PUT URL. Content-Type must match the
            type the URL was signed with, or S3 rejects the signature."""
            with open(src_path, "rb") as f:
                body = f.read()
            put = urllib.request.Request(
                url, data=body, method="PUT",
                headers={"Content-Type": content_type, "Content-Length": str(len(body))},
            )
            urllib.request.urlopen(put, timeout=180)

        def _check_api_key(key):
            if not expected_api_key or key != expected_api_key:
                return JSONResponse({"error": "Unauthorized"}, status_code=401)
            return None

        # This app holds no AWS credentials. The caller presigns one GET for the
        # input and one PUT for the output and passes both in; each grants access
        # to a single object for a few minutes.
        class ConvertRequest(BaseModel):
            input_url: str
            output_url: str

        class TrimRequest(BaseModel):
            input_url: str
            output_url: str
            start: float = 0.0
            end: float | None = None
            format: str = "mp4"  # "mp4", "webm", or "gif"

        @web_app.post("/convert")
        async def convert(req: ConvertRequest, x_modal_api_key: Optional[str] = Header(None)):
            auth_error = _check_api_key(x_modal_api_key)
            if auth_error:
                return auth_error
            with tempfile.TemporaryDirectory() as tmpdir:
                input_path = os.path.join(tmpdir, "input.webm")
                output_path = os.path.join(tmpdir, "output.mp4")

                try:
                    _fetch_to_file(req.input_url, input_path)
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

                try:
                    _put_file(req.output_url, output_path, "video/mp4")
                except Exception as e:
                    return JSONResponse(
                        {"error": f"Failed to upload result: {e}"}, status_code=502
                    )

            # The caller presigns the user-facing download URL and deletes the
            # input; the bucket lifecycle rule expires convert/* after a day.
            return {"ok": True, "content_type": "video/mp4"}

        @web_app.post("/trim")
        async def trim(req: TrimRequest, x_modal_api_key: Optional[str] = Header(None)):
            """Trim a video uploaded to S3 and return a presigned download URL."""
            auth_error = _check_api_key(x_modal_api_key)
            if auth_error:
                return auth_error
            if req.format not in ("mp4", "webm", "gif"):
                return JSONResponse({"error": "Format must be mp4, webm, or gif"}, status_code=400)

            out_ext = req.format
            content_type_map = {"mp4": "video/mp4", "webm": "video/webm", "gif": "image/gif"}
            content_type = content_type_map[out_ext]

            with tempfile.TemporaryDirectory() as tmpdir:
                input_path = os.path.join(tmpdir, "input.webm")
                output_path = os.path.join(tmpdir, f"trimmed.{out_ext}")

                try:
                    _fetch_to_file(req.input_url, input_path)
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

                try:
                    _put_file(req.output_url, output_path, content_type)
                except Exception as e:
                    return JSONResponse(
                        {"error": f"Failed to upload result: {e}"}, status_code=502
                    )

            return {"ok": True, "content_type": content_type}

        @web_app.post("/warmup")
        async def warmup(x_modal_api_key: Optional[str] = Header(None)):
            auth_error = _check_api_key(x_modal_api_key)
            if auth_error:
                return auth_error
            return {"ok": True}

        return web_app

"""
gifwidgets-tracker — Modal serverless GPU endpoint

Deploy:
  pip install modal
  modal setup          # one-time auth
  modal deploy backend/tracker/modal_app.py

Paste the printed URL into gif-tracker-worker.js as MODAL_ENDPOINT.
"""

import modal

app = modal.App("gifwidgets-tracker")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("wget", "git")
    .pip_install(
        "torch==2.3.1",
        "torchvision==0.18.1",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "git+https://github.com/facebookresearch/segment-anything-2.git",
        "Pillow",
        "numpy",
        "fastapi[standard]",
        "pydantic",
        "boto3",
    )
    .run_commands(
        "wget -q -O /root/sam2_tiny.pt "
        "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
    )
)


@app.function(
    gpu="L4",
    image=image,
    timeout=120,
    scaledown_window=240,  # scale to zero after 4 min idle
    secrets=[modal.Secret.from_name("gifwidgets-tracker-aws")],
)
@modal.asgi_app()
def fastapi_app():
    # All imports here run inside the container where dependencies are installed.
    import os, tempfile, base64, json as _json
    import numpy as np
    from PIL import Image
    import torch
    import boto3
    from fastapi import FastAPI, Header
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel
    from typing import List, Optional

    s3_client = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    assets_bucket = os.environ["ASSETS_BUCKET"]
    expected_api_key = os.environ.get("MODAL_API_KEY", "")

    web_app = FastAPI()
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Modal-Api-Key"],
    )

    _predictor = {}  # mutable container so the inner function can cache

    def _load_predictor():
        if "model" in _predictor:
            return _predictor["model"]
        from sam2.build_sam import build_sam2_video_predictor
        _predictor["model"] = build_sam2_video_predictor(
            "configs/sam2.1/sam2.1_hiera_t.yaml",
            "/root/sam2_tiny.pt",
            device="cuda",
        )
        return _predictor["model"]

    class TrackRequest(BaseModel):
        frames: List[str] = []    # base64-encoded JPEG per sampled frame (legacy)
        s3_key: str = ""          # S3 key for uploaded frames JSON
        frame_indices: List[int] = []
        click_x: float = 0.0     # normalized 0–1
        click_y: float = 0.0
        click_frame: int = 0
        warmup: bool = False

    @web_app.post("/track")
    async def track(req: TrackRequest, x_modal_api_key: Optional[str] = Header(None)):
        if expected_api_key and x_modal_api_key != expected_api_key:
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

        predictor = _load_predictor()

        if req.warmup:
            return {"ok": True}

        # Fetch frames from S3 if s3_key provided, otherwise use direct frames
        if req.s3_key:
            try:
                obj = s3_client.get_object(Bucket=assets_bucket, Key=req.s3_key)
                payload = _json.loads(obj["Body"].read())
                frames_b64 = payload["frames"]
                frame_indices = req.frame_indices or payload.get("frame_indices", [])
                click_x = req.click_x or payload.get("click_x", 0.0)
                click_y = req.click_y or payload.get("click_y", 0.0)
            except Exception as e:
                return JSONResponse({"error": f"Failed to fetch frames from S3: {e}"}, status_code=400)
            # Clean up S3 object after fetching
            try:
                s3_client.delete_object(Bucket=assets_bucket, Key=req.s3_key)
            except Exception:
                pass
        else:
            frames_b64 = req.frames
            frame_indices = req.frame_indices
            click_x = float(req.click_x)
            click_y = float(req.click_y)

        if not frames_b64 or not frame_indices:
            return JSONResponse({"error": "missing frames or frame_indices"}, status_code=400)
        if len(frames_b64) != len(frame_indices):
            return JSONResponse({"error": "frames and frame_indices length mismatch"}, status_code=400)

        with tempfile.TemporaryDirectory() as tmpdir:
            for i, b64 in enumerate(frames_b64):
                img_bytes = base64.b64decode(b64)
                with open(os.path.join(tmpdir, f"{i:05d}.jpg"), "wb") as f:
                    f.write(img_bytes)

            first = Image.open(os.path.join(tmpdir, "00000.jpg"))
            w, h  = first.size
            first.close()

            click_frame = req.click_frame
            start_idx = min(
                range(len(frame_indices)),
                key=lambda i: abs(frame_indices[i] - click_frame),
            )

            click_px     = np.array([[click_x * w, click_y * h]], dtype=np.float32)
            click_labels = np.array([1], dtype=np.int32)

            motion = {}

            with torch.inference_mode():
                # Forward pass
                inf_state = predictor.init_state(video_path=tmpdir)
                predictor.add_new_points_or_box(
                    inf_state, frame_idx=start_idx, obj_id=1,
                    points=click_px, labels=click_labels,
                )
                for out_idx, _obj_ids, mask_logits in predictor.propagate_in_video(inf_state):
                    orig_frame = frame_indices[out_idx]
                    mask = (mask_logits[0, 0].cpu().numpy() > 0)
                    if mask.any():
                        ys, xs = np.where(mask)
                        cx = round(float(xs.mean()) / w, 4)
                        cy = round(float(ys.mean()) / h, 4)
                    else:
                        cx, cy = round(click_x, 4), round(click_y, 4)
                    motion[orig_frame] = {"frame": orig_frame, "x": cx, "y": cy}
                predictor.reset_state(inf_state)

                # Backward pass
                if start_idx > 0:
                    inf_state2 = predictor.init_state(video_path=tmpdir)
                    predictor.add_new_points_or_box(
                        inf_state2, frame_idx=start_idx, obj_id=1,
                        points=click_px, labels=click_labels,
                    )
                    for out_idx, _obj_ids, mask_logits in predictor.propagate_in_video(
                        inf_state2, reverse=True
                    ):
                        if out_idx == start_idx:
                            continue
                        orig_frame = frame_indices[out_idx]
                        mask = (mask_logits[0, 0].cpu().numpy() > 0)
                        if mask.any():
                            ys, xs = np.where(mask)
                            cx = round(float(xs.mean()) / w, 4)
                            cy = round(float(ys.mean()) / h, 4)
                        else:
                            cx, cy = round(click_x, 4), round(click_y, 4)
                        motion[orig_frame] = {"frame": orig_frame, "x": cx, "y": cy}
                    predictor.reset_state(inf_state2)

        motion_list = sorted(motion.values(), key=lambda kf: kf["frame"])
        return {"motion": motion_list}

    return web_app

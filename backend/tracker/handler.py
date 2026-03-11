"""
gifcaption-tracker — SAM2 object tracking Lambda handler

Accepts a POST body with sampled GIF frames and a click point.
Returns motion keyframes (normalized x/y per sampled frame) for
plugging directly into caption.motion[].

Request body (JSON):
  {
    "warmup": true          ← optional: just pre-loads the model
  }
  or
  {
    "frames":        [base64_jpeg, ...],   // up to 30 sampled frames
    "frame_indices": [0, 4, 8, ...],       // original GIF frame index for each
    "click_x":       0.42,                 // normalized x of user click (0–1)
    "click_y":       0.31,                 // normalized y of user click (0–1)
    "click_frame":   12                    // original GIF frame where user clicked
  }

Response body (JSON):
  {
    "motion": [
      {"frame": 0,  "x": 0.42, "y": 0.31},
      {"frame": 4,  "x": 0.44, "y": 0.32},
      ...
    ]
  }
"""

import json
import os
import tempfile
import base64

import numpy as np
from PIL import Image
import torch

# ── Global model cache (survives across warm invocations) ────────────────────
_predictor = None


def _load_predictor():
    global _predictor
    if _predictor is not None:
        return _predictor

    from sam2.build_sam import build_sam2_video_predictor

    ckpt_path = os.path.join(os.path.dirname(__file__), "sam2_tiny.pt")
    _predictor = build_sam2_video_predictor(
        "configs/sam2.1/sam2.1_hiera_t.yaml",
        ckpt_path,
        device="cpu",
    )
    return _predictor


# ── Response helpers ──────────────────────────────────────────────────────────

def _cors_headers():
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }


def _ok(body):
    return {"statusCode": 200, "headers": _cors_headers(), "body": json.dumps(body)}


def _err(status, msg):
    return {"statusCode": status, "headers": _cors_headers(), "body": json.dumps({"error": msg})}


# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    # CORS preflight
    method = (
        event.get("requestContext", {})
             .get("http", {})
             .get("method", "")
             .upper()
    )
    if method == "OPTIONS":
        return _ok({})

    # Parse body
    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return _err(400, "Invalid JSON body")

    # Warm-up: load model and return immediately
    if body.get("warmup"):
        _load_predictor()
        return _ok({"ok": True})

    # Validate required fields
    frames_b64 = body.get("frames")
    frame_indices = body.get("frame_indices")
    click_x = body.get("click_x")
    click_y = body.get("click_y")
    click_frame = int(body.get("click_frame", 0))

    if not frames_b64 or not frame_indices:
        return _err(400, "Missing required field: frames, frame_indices")
    if click_x is None or click_y is None:
        return _err(400, "Missing required field: click_x, click_y")
    if len(frames_b64) != len(frame_indices):
        return _err(400, "frames and frame_indices must have the same length")

    click_x = float(click_x)
    click_y = float(click_y)
    predictor = _load_predictor()

    with tempfile.TemporaryDirectory() as tmpdir:
        # Write sampled frames as sorted JPEGs (00000.jpg, 00001.jpg, …)
        for i, b64 in enumerate(frames_b64):
            img_bytes = base64.b64decode(b64)
            with open(os.path.join(tmpdir, f"{i:05d}.jpg"), "wb") as f:
                f.write(img_bytes)

        # Get pixel dimensions from first frame
        first = Image.open(os.path.join(tmpdir, "00000.jpg"))
        w, h = first.size
        first.close()

        # Find which sampled frame is closest to where the user clicked
        start_idx = min(
            range(len(frame_indices)),
            key=lambda i: abs(frame_indices[i] - click_frame),
        )

        click_px = np.array([[click_x * w, click_y * h]], dtype=np.float32)
        click_labels = np.array([1], dtype=np.int32)  # 1 = foreground point

        motion = {}  # original_frame → {frame, x, y}

        with torch.inference_mode():
            # Forward propagation covers all frames (SAM2 uses annotation as an
            # anchor and predicts masks for all frames in sequence).
            inf_state = predictor.init_state(video_path=tmpdir)
            predictor.add_new_points_or_box(
                inf_state,
                frame_idx=start_idx,
                obj_id=1,
                points=click_px,
                labels=click_labels,
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

            # Backward propagation covers frames before the annotation point
            if start_idx > 0:
                inf_state2 = predictor.init_state(video_path=tmpdir)
                predictor.add_new_points_or_box(
                    inf_state2,
                    frame_idx=start_idx,
                    obj_id=1,
                    points=click_px,
                    labels=click_labels,
                )
                for out_idx, _obj_ids, mask_logits in predictor.propagate_in_video(
                    inf_state2, reverse=True
                ):
                    if out_idx == start_idx:
                        continue  # forward pass already handled this frame
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
    return _ok({"motion": motion_list})

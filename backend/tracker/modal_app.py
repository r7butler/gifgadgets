"""
gifwidgets-tracker — Modal serverless GPU endpoint

Deploy:
  pip install modal
  modal setup          # one-time auth
  modal deploy backend/tracker/modal_app.py

This app holds no AWS credentials. Callers presign a GET URL for the frames
JSON and pass it as frames_url.

Required Modal secret "gifwidgets-modal-api-key" with key MODAL_API_KEY.

Background removal additionally needs "gifwidgets-huggingface-token" with key
HF_TOKEN. The SAM 3 weights are gated, so that token's account must have been
granted access at https://huggingface.co/facebook/sam3.1 or the image build
fails while fetching them.
"""

import time
from pathlib import Path

import modal

app = modal.App("gifwidgets-tracker")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("wget", "git")
    .pip_install(
        "torch==2.5.1",
        "torchvision==0.20.1",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    .pip_install(
        "git+https://github.com/facebookresearch/sam2.git@2b90b9f5ceec907a1c18123530e92e794ad901a4",
        "Pillow",
        "numpy",
        "fastapi[standard]",
        "pydantic",
    )
    .run_commands(
        "wget -q -O /root/sam2_tiny.pt "
        "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
    )
)

# Background removal runs SAM 3.1, which shares nothing with the motion tracker's
# SAM 2 stack — different torch, different weights, 848M parameters against 39M.
# A separate image keeps the tracker's cold start cheap and its pins undisturbed.
SEGMENT_CHECKPOINT = "facebook/sam3.1"
SEGMENT_WEIGHTS = "/models/sam3.1_multiplex.pt"
SAM3_REVISION = "2345a4ad109ac29c569da749c91d84f10dc08c40"


def _fetch_segment_weights():
    # Baked into the image so a cold container never waits on a 3 GB download.
    from huggingface_hub import hf_hub_download
    hf_hub_download(SEGMENT_CHECKPOINT, "sam3.1_multiplex.pt", local_dir="/models")


segment_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install(
        "torch==2.7.1",
        "torchvision==0.22.1",
        extra_index_url="https://download.pytorch.org/whl/cu126",
    )
    .pip_install(
        f"git+https://github.com/facebookresearch/sam3.git@{SAM3_REVISION}",
        "setuptools<81", "huggingface-hub", "Pillow", "numpy<2",
        "einops", "decord", "opencv-python-headless<4.12", "pycocotools", "scipy", "psutil",
    )
    .env({"HF_HOME": "/models/hf",
          "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"})
    .run_function(_fetch_segment_weights,
                  secrets=[modal.Secret.from_name("gifwidgets-huggingface-token")])
    .add_local_file(str(Path(__file__).with_name("segmentation.py")), "/root/segmentation.py")
)


@app.function(
    gpu="L4",
    image=image,
    timeout=120,
    scaledown_window=240,  # scale to zero after 4 min idle
    secrets=[modal.Secret.from_name("gifwidgets-modal-api-key")],
)
@modal.asgi_app()
def fastapi_app():
    # All imports here run inside the container where dependencies are installed.
    import os, tempfile, base64, json as _json
    import urllib.request
    import numpy as np
    from PIL import Image
    import torch
    from fastapi import FastAPI, Header
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel
    from typing import List, Optional

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
        frames_url: str = ""      # presigned GET URL for the uploaded frames JSON
        frame_indices: List[int] = []
        click_x: float = 0.0     # normalized 0–1
        click_y: float = 0.0
        click_frame: int = 0
        warmup: bool = False

    @web_app.post("/track")
    async def track(req: TrackRequest, x_modal_api_key: Optional[str] = Header(None)):
        if not expected_api_key or x_modal_api_key != expected_api_key:
            return JSONResponse({"error": "Unauthorized"}, status_code=401)

        predictor = _load_predictor()

        if req.warmup:
            return {"ok": True}

        # Fetch frames via the caller-supplied presigned URL. This app holds no
        # AWS credentials; the URL grants read access to exactly one object for
        # a few minutes. Deleting the object afterwards is the caller's job.
        if req.frames_url:
            try:
                with urllib.request.urlopen(req.frames_url, timeout=30) as r:
                    payload = _json.loads(r.read())
                frames_b64 = payload["frames"]
                frame_indices = req.frame_indices or payload.get("frame_indices", [])
                click_x = req.click_x or payload.get("click_x", 0.0)
                click_y = req.click_y or payload.get("click_y", 0.0)
            except Exception as e:
                return JSONResponse({"error": f"Failed to fetch frames: {e}"}, status_code=400)
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


# Separate CPU broker so polling never occupies a GPU. Long jobs run asynchronously
# and write masks directly to private S3, avoiding Lambda response-size/time limits.
_segment_model = None

# Progress for /status, keyed by Modal call ID. A call with no entry is still
# waiting for a GPU container and model load. Modal drops entries after 7 days
# without reads or writes, which is all the cleanup this needs.
segment_progress = modal.Dict.from_name("gifwidgets-segment-progress", create_if_missing=True)


def _progress_reporter(call_id):
    """Publish progress at most every 2 s, the browser's polling interval.
    Progress is cosmetic, so a failed write never fails the paid job."""
    last = float('-inf')

    def report(done, total):
        nonlocal last
        now = time.monotonic()
        if done and now - last < 2:
            return
        last = now
        try:
            segment_progress[call_id] = {'frame': done, 'frames': total}
        except Exception:
            pass
    return report


@app.function(gpu="H100", image=segment_image, timeout=3600, scaledown_window=120)
def segment_media(input_url: str, output_url: str, objects: list, job_id: str, text: str = ""):
    import json
    import tempfile
    import urllib.request
    import torch
    from segmentation import ConceptSegmenter, SelectionError, TrackerSegmenter, segment_file
    torch.cuda.reset_peak_memory_stats()
    started = time.monotonic()
    # Both prompt types use the same SAM 3.1 detector/tracker weights.
    concept = bool(text)
    print(json.dumps({"event": "segmentation_started", "job_id": job_id,
                      "prompt": "text" if concept else "points"}))
    try:
        global _segment_model
        if _segment_model is None:
            from sam3.model_builder import build_sam3_multiplex_video_predictor
            predictor = build_sam3_multiplex_video_predictor(
                checkpoint_path=SEGMENT_WEIGHTS, max_num_objects=32,
                use_fa3=False, compile=False, warm_up=False,
                async_loading_frames=False,
            )
            # Use the model API to avoid the upstream session-wrapper mismatch
            # (see segmentation.py). The dedicated worker retains bf16 inference.
            _segment_model = predictor.model
        build = ConceptSegmenter if concept else TrackerSegmenter
        segmenter = build(_segment_model)
        report = _progress_reporter(modal.current_function_call_id())
        report(0, None)
        with tempfile.TemporaryDirectory() as work:
            source, output = work + '/source', work + '/masks.gz'
            # Payload limit protects memory/disk; there is deliberately no frame limit.
            with urllib.request.urlopen(input_url, timeout=60) as response, open(source, 'wb') as f:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 100 * 1024 * 1024:
                        raise SelectionError('Choose a file up to 100 MB.')
                    f.write(chunk)
            with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
                stats = segment_file(source, output, text if concept else objects, segmenter,
                                     progress=report)
            with open(output, 'rb') as f:
                request = urllib.request.Request(output_url, data=f.read(), method='PUT',
                                                 headers={'Content-Type': 'application/gzip'})
            with urllib.request.urlopen(request, timeout=120) as response:
                response.read()
            stats['total_seconds'] = round(time.monotonic() - started, 3)
            stats['peak_gpu_allocated_mb'] = round(torch.cuda.max_memory_allocated() / 1024**2)
            stats['peak_gpu_reserved_mb'] = round(torch.cuda.max_memory_reserved() / 1024**2)
            print(json.dumps({'event': 'segmentation_complete', 'job_id': job_id,
                              'input_bytes': total, **stats}))
            return stats
    except Exception as error:
        print(json.dumps({"event": "segmentation_failed", "job_id": job_id,
                          "error_type": type(error).__name__,
                          # User-facing messages never contain the prompt or URLs.
                          "message": str(error) if isinstance(error, SelectionError) else None,
                          "peak_gpu_allocated_mb": round(torch.cuda.max_memory_allocated() / 1024**2),
                          "peak_gpu_reserved_mb": round(torch.cuda.max_memory_reserved() / 1024**2),
                          "total_seconds": round(time.monotonic() - started, 3)}))
        # The broker cannot unpickle this module's exception types, so return a
        # message the user can act on rather than raising it.
        if isinstance(error, SelectionError):
            return {'error': str(error)}
        raise


@app.function(image=modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]"),
              secrets=[modal.Secret.from_name("gifwidgets-modal-api-key")])
@modal.asgi_app()
def segment_api():
    import os
    from fastapi import FastAPI, Header
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel
    from typing import Optional
    expected = os.environ.get('MODAL_API_KEY', '').strip()
    if not expected:
        raise RuntimeError('MODAL_API_KEY must be configured')
    api = FastAPI()

    class Submit(BaseModel):
        input_url: str
        output_url: str
        objects: list
        job_id: str
        text: str = ""

    class Poll(BaseModel):
        call_id: str

    @api.post('/segment')
    async def submit(req: Submit, x_modal_api_key: Optional[str] = Header(None)):
        if x_modal_api_key != expected:
            return JSONResponse({'error': 'Unauthorized'}, status_code=401)
        call = await segment_media.spawn.aio(req.input_url, req.output_url, req.objects,
                                            req.job_id, req.text)
        return {'call_id': call.object_id}

    @api.post('/status')
    async def status(req: Poll, x_modal_api_key: Optional[str] = Header(None)):
        if x_modal_api_key != expected:
            return JSONResponse({'error': 'Unauthorized'}, status_code=401)
        try:
            result = await modal.FunctionCall.from_id(req.call_id).get.aio(timeout=0)
            if isinstance(result, dict) and result.get('error'):
                return {'state': 'failed', 'error': result['error']}
            return {'state': 'complete', 'stats': result}
        except TimeoutError:
            try:
                progress = await segment_progress.get.aio(req.call_id)
            except Exception:
                return {'state': 'running'}
            if progress is None:
                return {'state': 'running', 'phase': 'starting'}
            return {'state': 'running', 'phase': 'processing', **progress}
        except Exception:
            return {'state': 'failed', 'error': 'Segmentation failed. Try a smaller file or different selection.'}

    @api.post('/cancel')
    async def cancel(req: Poll, x_modal_api_key: Optional[str] = Header(None)):
        if x_modal_api_key != expected:
            return JSONResponse({'error': 'Unauthorized'}, status_code=401)
        await modal.FunctionCall.from_id(req.call_id).cancel.aio(terminate_containers=True)
        return {'state': 'cancelled'}

    return api

"""SAM 3 mask generation. No fixed frame-count limit; frames are never sampled.

The model-facing part is deliberately one small class. Everything else here —
validation, frame extraction, mask packing — is plain Pillow and numpy so it can
be tested without a GPU or model weights.
"""
import gzip
import json
import math
import os
import struct
import tempfile
import time

# Masks are produced at this resolution at most; the browser scales them back up
# over the full-size image, so this caps GPU work without capping output quality.
MAX_SIDE = 1024

# Keeping frames and tracking state off the GPU is what lets a long GIF run on a
# small card. Named here because it is the first thing to change if memory bites.
SESSION_OPTIONS = {'video_storage_device': 'cpu', 'inference_state_device': 'cpu'}


def validate_objects(objects):
    if not isinstance(objects, list) or not objects:
        raise ValueError('Select at least one object.')
    # Bound prompt payload complexity, not media frame count.
    if len(objects) > 32:
        raise ValueError('Select at most 32 objects.')
    for obj in objects:
        points = obj.get('points') if isinstance(obj, dict) else None
        if not isinstance(points, list) or not 1 <= len(points) <= 128:
            raise ValueError('Each object needs between 1 and 128 points.')
        if not any(p.get('label') == 1 for p in points if isinstance(p, dict)):
            raise ValueError('Each object needs a keep point.')
        for p in points:
            if not isinstance(p, dict) or p.get('label') not in (0, 1):
                raise ValueError('Invalid point label.')
            for key in ('x', 'y'):
                value = p.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                    raise ValueError('Point coordinates must be between zero and one.')
    return objects


def load_frames(source):
    """Every frame of the source as an RGB image, downscaled for the model.

    Returns (frames, original_size). Transparency is flattened onto white because
    the model wants three channels; the alpha that matters is the one the browser
    applies from the mask afterwards.
    """
    from PIL import Image, ImageOps

    frames, original = [], None
    with Image.open(source) as media:
        if media.format not in ('GIF', 'PNG', 'JPEG', 'WEBP'):
            raise ValueError('Choose a GIF, PNG, JPG or WebP file.')
        count = getattr(media, 'n_frames', 1) if media.format == 'GIF' else 1
        for index in range(count):
            media.seek(index)
            frame = ImageOps.exif_transpose(media.copy()).convert('RGBA')
            original = frame.size
            frame.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
            rgb = Image.new('RGB', frame.size, 'white')
            rgb.paste(frame, mask=frame.getchannel('A'))
            frames.append(rgb)
    return frames, original


class TrackerSegmenter:
    """Point prompts through the SAM 3 tracker — the SAM 2-compatible path.

    One selection becomes one tracked object, prompted on frame zero and carried
    through the rest by the tracker's memory. Model and processor are injected so
    the prompt arithmetic can be tested without loading 848M parameters.
    """

    def __init__(self, model, processor, device='cuda'):
        self.model, self.processor, self.device = model, processor, device
        self.session = None

    def masks(self, frames, objects):
        import numpy as np

        width, height = frames[0].size
        self.session = self.processor.init_video_session(
            video=frames, inference_device=self.device, **SESSION_OPTIONS)
        # Selections arrive normalised so they survive the browser's downscaled
        # preview; the model wants pixels in the frame it is actually given.
        self.processor.add_inputs_to_inference_session(
            inference_session=self.session,
            frame_idx=0,
            obj_ids=list(range(1, len(objects) + 1)),
            input_points=[[[[p['x'] * width, p['y'] * height] for p in obj['points']] for obj in objects]],
            input_labels=[[[p['label'] for p in obj['points']] for obj in objects]],
        )
        for output in self.model.propagate_in_video_iterator(self.session):
            logits = self.processor.post_process_masks(
                [output.pred_masks], original_sizes=[[height, width]], binarize=False)[0]
            # Every selected object is foreground, so the frame's mask is their union.
            yield output.frame_idx, np.any(logits.cpu().numpy() > 0, axis=(0, 1))

    def release(self):
        """Drop tracking state so the next job on this warm container starts clean."""
        if self.session is not None:
            self.session.reset_inference_session()
            self.session = None


def segment_file(source, output, objects, segmenter):
    import numpy as np

    validate_objects(objects)
    started = time.monotonic()
    frames, original = load_frames(source)
    count = len(frames)
    width, height = frames[0].size
    with tempfile.TemporaryDirectory() as work:
        seen = set()
        try:
            for index, union in segmenter.masks(frames, objects):
                if index < 0 or index >= count or index in seen:
                    raise ValueError('The segmenter returned an invalid frame sequence.')
                if union.shape != (height, width):
                    raise ValueError('The segmenter returned unexpected mask dimensions.')
                packed = np.packbits(union.reshape(-1), bitorder='big').tobytes()
                with open(os.path.join(work, f'{index}.mask'), 'wb') as f:
                    f.write(packed)
                seen.add(index)
            if len(seen) != count:
                raise ValueError('Segmentation did not return every frame. Please try again.')
            header = json.dumps({'version': 1, 'width': width, 'height': height, 'frames': count}).encode()
            with gzip.open(output, 'wb') as f:
                f.write(struct.pack('<I', len(header)))
                f.write(header)
                for index in range(count):
                    with open(os.path.join(work, f'{index}.mask'), 'rb') as mask:
                        f.write(mask.read())
        finally:
            segmenter.release()
    return {'frames': count, 'width': original[0], 'height': original[1],
            'objects': len(objects), 'processing_seconds': round(time.monotonic() - started, 3),
            'mask_bytes': os.path.getsize(output)}

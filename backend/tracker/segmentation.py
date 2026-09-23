"""SAM 3.1 mask generation. No fixed frame-count limit; frames are never sampled.

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

# SAM 3 concept prompts are short noun phrases. The cap is generous for that and
# still bounds what an anonymous caller can push into a GPU job and our logs.
MAX_PROMPT = 120


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


def validate_prompt(text):
    """A concept prompt, normalised. Returned so the caller uses the clean value."""
    if not isinstance(text, str):
        raise ValueError('Describe what to keep.')
    # Collapse whitespace so " a  dog " and "a dog" are one prompt, not two.
    prompt = ' '.join(text.split())
    if not prompt:
        raise ValueError('Describe what to keep.')
    if len(prompt) > MAX_PROMPT:
        raise ValueError(f'Keep the description under {MAX_PROMPT} characters.')
    # This string reaches a GPU job and the logs; control characters do neither any good.
    if any(ord(character) < 32 or ord(character) == 127 for character in prompt):
        raise ValueError('Remove control characters from the description.')
    return prompt


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


class Sam3Segmenter:
    """Adapter for Meta's pinned SAM 3.1 multiplex model.

    Use the model API directly: the upstream predictor's start_session passes
    offload_state_to_cpu, which the multiplex model does not accept.
    """

    def __init__(self, model):
        self.model = model
        self.session = None
        self.work = None

    def open(self, frames):
        self.work = tempfile.TemporaryDirectory()
        # A still image must use the image path so short-track filtering does not
        # discard detections. GIFs use all coalesced frames, in numeric order.
        if len(frames) == 1:
            resource = os.path.join(self.work.name, 'image.png')
            frames[0].save(resource)
        else:
            resource = self.work.name
            for index, frame in enumerate(frames):
                frame.save(os.path.join(resource, f'{index:08d}.jpg'), quality=100,
                           subsampling=0)
        self.session = self.model.init_state(
            resource_path=resource, offload_video_to_cpu=True,
            async_loading_frames=False)

    @staticmethod
    def union(output):
        import numpy as np

        masks = output['out_binary_masks']
        if hasattr(masks, 'cpu'):
            masks = masks.cpu().numpy()
        masks = np.asarray(masks)
        if masks.ndim != 3:
            raise ValueError('The segmenter returned unexpected mask dimensions.')
        return (masks > 0).any(axis=0)

    def propagate(self):
        # This is the entire GIF, so flush the model's buffered short tracks.
        for index, output in self.model.propagate_in_video(
                self.session, start_frame_idx=0, reverse=False, is_last_batch=True):
            yield index, self.union(output)
            self.session.get('cached_frame_outputs', {}).pop(index, None)

    def release(self):
        """Release state and extracted frames even when inference fails."""
        try:
            if self.session is not None:
                self.model.reset_state(self.session)
        finally:
            self.session = None
            if self.work is not None:
                self.work.cleanup()
                self.work = None


class TrackerSegmenter(Sam3Segmenter):
    """Keep/exclude clicks select separate objects and track their union."""

    validate = staticmethod(validate_objects)

    @staticmethod
    def stats(objects):
        return {'objects': len(objects)}

    def masks(self, frames, objects):
        import torch

        self.open(frames)
        # Upstream point propagation merges into this per-frame cache and returns
        # an empty mask if the frame has no entry. Point-only jobs have no prior
        # text detections, so seed empty entries before adding the selected objects.
        self.session['cached_frame_outputs'] = {index: {} for index in range(len(frames))}
        for obj_id, obj in enumerate(objects, 1):
            index, output = self.model.add_prompt(
                inference_state=self.session, frame_idx=0, obj_id=obj_id,
                points=torch.tensor([[p['x'], p['y']] for p in obj['points']],
                                    dtype=torch.float32),
                point_labels=torch.tensor([p['label'] for p in obj['points']],
                                          dtype=torch.int32),
                rel_coordinates=True,
            )
        if len(frames) == 1:
            yield index, self.union(output)
        else:
            yield from self.propagate()


class ConceptSegmenter(Sam3Segmenter):
    """A short text prompt selects every matching instance."""

    validate = staticmethod(validate_prompt)

    @staticmethod
    def stats(prompt):
        return {'objects': 0, 'prompt_length': len(prompt)}

    def masks(self, frames, prompt):
        self.open(frames)
        index, output = self.model.add_prompt(inference_state=self.session, frame_idx=0,
                                              text_str=prompt)
        if len(frames) == 1:
            # Video track-confirmation filters can discard a valid still-image
            # detection. The prompt result is already the final image mask.
            yield index, self.union(output)
        else:
            yield from self.propagate()


def segment_file(source, output, prompt, segmenter):
    import numpy as np

    # Revalidated here because this is the paid path and can be called directly.
    prompt = segmenter.validate(prompt)
    started = time.monotonic()
    frames, original = load_frames(source)
    count = len(frames)
    width, height = frames[0].size
    with tempfile.TemporaryDirectory() as work:
        seen = set()
        try:
            found = False
            for index, union in segmenter.masks(frames, prompt):
                if index < 0 or index >= count or index in seen:
                    raise ValueError('The segmenter returned an invalid frame sequence.')
                if union.shape != (height, width):
                    raise ValueError('The segmenter returned unexpected mask dimensions.')
                found = found or bool(union.any())
                packed = np.packbits(union.reshape(-1), bitorder='big').tobytes()
                with open(os.path.join(work, f'{index}.mask'), 'wb') as f:
                    f.write(packed)
                seen.add(index)
            if len(seen) != count:
                raise ValueError('Segmentation did not return every frame. Please try again.')
            # An empty mask everywhere exports a blank file. Say so instead.
            if not found:
                raise ValueError('Nothing matched that selection. Try describing the subject differently, or click it directly.')
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
            'processing_seconds': round(time.monotonic() - started, 3),
            'mask_bytes': os.path.getsize(output), **segmenter.stats(prompt)}

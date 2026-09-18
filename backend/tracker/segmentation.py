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
    """Shared session handling for the two ways of prompting SAM 3.

    Model and processor are injected rather than loaded here, so the prompt
    arithmetic stays testable without 848M parameters or a GPU.
    """

    def __init__(self, model, processor, device='cuda'):
        self.model, self.processor, self.device = model, processor, device
        self.session = None

    def open(self, frames):
        self.session = self.processor.init_video_session(
            video=frames, inference_device=self.device, **SESSION_OPTIONS)
        return self.session

    def release(self):
        """Drop tracking state so the next job on this warm container starts clean."""
        if self.session is not None:
            self.session.reset_inference_session()
            self.session = None


class TrackerSegmenter(Sam3Segmenter):
    """Point prompts through the SAM 3 tracker — the SAM 2-compatible path.

    One selection becomes one tracked object, prompted on frame zero and carried
    through the rest by the tracker's memory.
    """

    validate = staticmethod(validate_objects)

    @staticmethod
    def stats(objects):
        return {'objects': len(objects)}

    def masks(self, frames, objects):
        import numpy as np

        width, height = frames[0].size
        self.open(frames)
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


class ConceptSegmenter(Sam3Segmenter):
    """Text prompts through the SAM 3 concept model.

    A concept prompt matches every instance at once rather than one object per
    prompt, so there is nothing to click and nothing to number: the frame's mask
    is the union of whatever the phrase found, and keeping those instances
    together across frames is the model's job rather than ours.
    """

    validate = staticmethod(validate_prompt)

    @staticmethod
    def stats(prompt):
        # The phrase itself is the user's content and never leaves this process.
        return {'objects': 0, 'prompt_length': len(prompt)}

    def masks(self, frames, prompt):
        import numpy as np

        self.open(frames)
        self.processor.add_text_prompt(inference_session=self.session, text=prompt)
        for output in self.model.propagate_in_video_iterator(inference_session=self.session):
            processed = self.processor.postprocess_outputs(self.session, output)
            masks = processed['masks']
            # Already binary and at frame resolution; every match is foreground.
            yield output.frame_idx, np.asarray(masks.cpu().numpy() > 0).any(axis=0)


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

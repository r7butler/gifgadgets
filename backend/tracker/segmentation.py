"""SAM2 mask generation. No fixed frame-count limit; frames are never sampled."""
import gzip
import json
import math
import os
import struct
import tempfile
import time


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


def segment_file(source, output, objects, predictor):
    import numpy as np
    from PIL import Image, ImageOps

    validate_objects(objects)
    started = time.monotonic()
    with tempfile.TemporaryDirectory() as work:
        frames_dir = os.path.join(work, 'frames')
        os.mkdir(frames_dir)
        with Image.open(source) as media:
            if media.format not in ('GIF', 'PNG', 'JPEG', 'WEBP'):
                raise ValueError('Choose a GIF, PNG, JPG or WebP file.')
            count = getattr(media, 'n_frames', 1) if media.format == 'GIF' else 1
            for index in range(count):
                media.seek(index)
                frame = ImageOps.exif_transpose(media.copy()).convert('RGBA')
                original = frame.size
                frame.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
                rgb = Image.new('RGB', frame.size, 'white')
                rgb.paste(frame, mask=frame.getchannel('A'))
                rgb.save(os.path.join(frames_dir, f'{index:08d}.jpg'), quality=90)
            width, height = rgb.size
        state = predictor.init_state(video_path=frames_dir, offload_video_to_cpu=True, offload_state_to_cpu=True)
        seen = set()
        try:
            for obj_id, obj in enumerate(objects, 1):
                predictor.add_new_points_or_box(
                    state, frame_idx=0, obj_id=obj_id,
                    points=np.array([[p['x'] * width, p['y'] * height] for p in obj['points']], dtype=np.float32),
                    labels=np.array([p['label'] for p in obj['points']], dtype=np.int32),
                )
            for index, _, logits in predictor.propagate_in_video(state):
                if index < 0 or index >= count or index in seen:
                    raise ValueError('The segmenter returned an invalid frame sequence.')
                union = np.any(logits.cpu().numpy() > 0, axis=(0, 1))
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
            predictor.reset_state(state)
    return {'frames': count, 'width': original[0], 'height': original[1],
            'objects': len(objects), 'processing_seconds': round(time.monotonic() - started, 3),
            'mask_bytes': os.path.getsize(output)}

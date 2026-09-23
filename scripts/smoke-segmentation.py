#!/usr/bin/env python3
"""Run a paid, real-model smoke test through the public segmentation API.

Usage: python scripts/smoke-segmentation.py image.png --text truck
       python scripts/smoke-segmentation.py clip.gif --point .5 .5
Requires Pillow and numpy. Files and masks stay in the normal service lifecycle.
"""
import argparse
import gzip
import hashlib
import json
import mimetypes
from pathlib import Path
import struct
import time
import urllib.request

import numpy as np
from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--base-url', default='https://gifgadgets.com')
    prompt = parser.add_mutually_exclusive_group(required=True)
    prompt.add_argument('--text')
    prompt.add_argument('--point', type=float, nargs=2, metavar=('X', 'Y'))
    parser.add_argument('--output', type=Path, help='Optional mask bundle output')
    parser.add_argument('--require-every-frame', action='store_true',
                        help='Assert foreground on every frame for continuously visible test subjects')
    args = parser.parse_args()

    def api(route, body):
        data = json.dumps(body).encode()
        request = urllib.request.Request(
            args.base_url.rstrip('/') + '/api/segment/' + route, data=data,
            headers={'Content-Type': 'application/json',
                     'x-amz-content-sha256': hashlib.sha256(data).hexdigest()})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    with Image.open(args.source) as source:
        count = getattr(source, 'n_frames', 1) if source.format == 'GIF' else 1
    content_type = mimetypes.guess_type(args.source)[0]
    issued = api('presign', {'content_type': content_type})
    job_id = issued['job_id']
    started = time.monotonic()
    submitted = False
    try:
        upload = urllib.request.Request(issued['upload_url'], method='PUT',
            data=args.source.read_bytes(), headers={'Content-Type': content_type})
        with urllib.request.urlopen(upload, timeout=120) as response:
            response.read()
        body = {'job_id': job_id}
        if args.text:
            body['text'] = args.text
        else:
            body['objects'] = [{'points': [dict(zip(('x', 'y'), args.point), label=1)]}]
        submitted = True
        api('submit', body)
        print('Submitted', job_id, flush=True)
        while time.monotonic() - started < 1800:
            result = api('status', {'job_id': job_id})
            if result['state'] == 'complete':
                break
            if result['state'] != 'running':
                raise RuntimeError(result)
            time.sleep(3)
        else:
            raise TimeoutError('Segmentation did not finish within 30 minutes')
        with urllib.request.urlopen(result['mask_url'], timeout=60) as response:
            packed = response.read()
        raw = gzip.decompress(packed)
        header_size = struct.unpack('<I', raw[:4])[0]
        header = json.loads(raw[4:4 + header_size])
        assert header['version'] == 1 and header['frames'] == count, header
        pixels = header['width'] * header['height']
        stride = (pixels + 7) // 8
        data = raw[4 + header_size:]
        assert len(data) == stride * count
        coverage = []
        for index in range(count):
            bits = np.unpackbits(np.frombuffer(data[index*stride:(index+1)*stride], dtype=np.uint8))[:pixels]
            coverage.append(round(float(bits.mean()), 4))
        assert any(0 < fraction < 1 for fraction in coverage), coverage
        if args.require_every_frame:
            assert all(0 < fraction < 1 for fraction in coverage), coverage
        if args.output:
            args.output.write_bytes(packed)
        print(json.dumps({'header': header, 'coverage': coverage, 'stats': result.get('stats'),
                          'elapsed_seconds': round(time.monotonic() - started, 1)}))
        submitted = False
    finally:
        if submitted:
            api('cancel', {'job_id': job_id})


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Jinja2 build script — renders src/pages/**/*.html into frontend/."""

import os
import sys
import time

try:
    from jinja2 import Environment, FileSystemLoader
except ImportError:
    print("ERROR: jinja2 is not installed. Run: pip3 install jinja2", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES_DIR = os.path.join(ROOT, "src", "pages")
TEMPLATES_DIR = os.path.join(ROOT, "src", "templates")
OUTPUT_DIR = os.path.join(ROOT, "frontend")


def build():
    start = time.time()

    env = Environment(
        loader=FileSystemLoader([PAGES_DIR, TEMPLATES_DIR]),
        keep_trailing_newline=True,
    )

    count = 0
    for dirpath, _dirnames, filenames in os.walk(PAGES_DIR):
        for fname in filenames:
            if not fname.endswith(".html"):
                continue

            src_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(src_path, PAGES_DIR)
            out_path = os.path.join(OUTPUT_DIR, rel_path)

            os.makedirs(os.path.dirname(out_path), exist_ok=True)

            template = env.get_template(rel_path)
            rendered = template.render()

            with open(out_path, "w", encoding="utf-8") as f:
                f.write(rendered)

            count += 1

    elapsed = time.time() - start
    print(f"Built {count} pages in {elapsed:.2f}s")


if __name__ == "__main__":
    build()

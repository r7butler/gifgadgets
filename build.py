#!/usr/bin/env python3
"""Jinja2 build script — renders src/pages/**/*.html into frontend/."""

from datetime import datetime, timezone
import json
from urllib.parse import urlsplit
import os
import sys
import time

try:
    from jinja2 import Environment, FileSystemLoader, StrictUndefined
except ImportError:
    print("ERROR: jinja2 is not installed. Run: pip3 install jinja2", file=sys.stderr)
    sys.exit(1)

ROOT = os.path.dirname(os.path.abspath(__file__))
PAGES_DIR = os.path.join(ROOT, "src", "pages")
TEMPLATES_DIR = os.path.join(ROOT, "src", "templates")
OUTPUT_DIR = os.path.join(ROOT, "frontend")


def build():
    start = time.time()

    with open(os.path.join(ROOT, "site.config.json")) as f:
        config = json.load(f)
    site_url = os.environ.get("SITE_URL", config["site_url"]).rstrip("/")
    parsed = urlsplit(site_url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.path or
            parsed.query or parsed.fragment or parsed.username or parsed.password or
            any(c in site_url for c in '\"<> \n\r')):
        raise ValueError("SITE_URL must be an HTTPS origin without a path or credentials")

    # Brand name. site_brand_accent is the trailing span the logo highlights, so the
    # two must stay consistent: site_brand_lead + site_brand_accent == site_brand.
    site_brand = os.environ.get("SITE_BRAND", config["site_brand"])
    site_brand_accent = os.environ.get("SITE_BRAND_ACCENT", config["site_brand_accent"])
    if not site_brand or any(c in site_brand for c in '<>"\n\r'):
        raise ValueError("site_brand must be non-empty and free of markup characters")
    if not site_brand.endswith(site_brand_accent):
        raise ValueError(
            f"site_brand_accent {site_brand_accent!r} must be the tail of site_brand {site_brand!r}"
        )
    site_brand_lead = site_brand[: len(site_brand) - len(site_brand_accent)]

    # Text burned into watermarked exports. Display text, so it is configured
    # explicitly rather than derived from the lowercase hostname.
    site_watermark = os.environ.get(
        "SITE_WATERMARK", config.get("site_watermark") or parsed.hostname)
    if any(c in site_watermark for c in '\'"\\\n\r'):
        raise ValueError("site_watermark must not contain quotes, backslashes or newlines")

    env = Environment(
        loader=FileSystemLoader([PAGES_DIR, TEMPLATES_DIR]),
        keep_trailing_newline=True,
        undefined=StrictUndefined,
    )

    env.globals.update(
        site_url=site_url,
        site_brand=site_brand,
        site_brand_lead=site_brand_lead,
        site_brand_accent=site_brand_accent,
        site_watermark=site_watermark,
        active_nav=None,
        current_year=datetime.now(timezone.utc).year,
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

    for filename in ("robots.txt", "sitemap.xml"):
        rendered = env.get_template("site/" + filename).render()
        with open(os.path.join(OUTPUT_DIR, filename), "w", encoding="utf-8") as f:
            f.write(rendered)

    elapsed = time.time() - start
    print(f"Built {count} pages in {elapsed:.2f}s")


if __name__ == "__main__":
    build()

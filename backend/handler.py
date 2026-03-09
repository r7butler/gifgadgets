import json
import os
import re
import uuid
import base64
from datetime import datetime, timezone

import boto3

ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]
SITE_BUCKET = os.environ["SITE_BUCKET"]
TABLE_NAME = os.environ["TABLE_NAME"]
ASSETS_CDN_URL = os.environ.get("ASSETS_CDN_URL", "").rstrip("/")
SITE_CDN_URL = os.environ.get("SITE_CDN_URL", "").rstrip("/")

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


def _slugify(text):
    """Convert text to a URL-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:60]


def _build_share_page(title, gif_url, slug):
    """Return an HTML string for a shareable GIF page with OG meta tags."""
    safe_title = title.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    site_root = SITE_CDN_URL or ""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{safe_title} — GifCaption</title>
<meta name="description" content="{safe_title} — made with GifCaption, the free online GIF caption editor.">
<meta property="og:type" content="video.other">
<meta property="og:title" content="{safe_title}">
<meta property="og:description" content="Made with GifCaption — the free GIF caption editor">
<meta property="og:image" content="{gif_url}">
<meta property="og:image:type" content="image/gif">
<meta property="og:url" content="{site_root}/g/{slug}.html">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{safe_title}">
<meta name="twitter:image" content="{gif_url}">
<meta name="theme-color" content="#6366f1">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{background:#0c0c14;color:#e4e4e7;font-family:system-ui,-apple-system,sans-serif;
display:flex;flex-direction:column;align-items:center;min-height:100dvh;padding:1.5rem}}
.gif-wrap{{max-width:min(600px,100%);margin:2rem auto}}
.gif-wrap img{{width:100%;border-radius:8px;display:block}}
h1{{font-size:1.5rem;margin-top:1.5rem;text-align:center;max-width:600px}}
.actions{{display:flex;gap:.75rem;margin-top:1.5rem;flex-wrap:wrap;justify-content:center}}
.btn{{display:inline-flex;align-items:center;gap:.4rem;padding:.65rem 1.2rem;border-radius:8px;
border:none;font-size:.95rem;font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}}
.btn-primary{{background:#6366f1;color:#fff}}.btn-primary:hover{{opacity:.85}}
.btn-outline{{background:transparent;border:1px solid #3f3f46;color:#e4e4e7}}
.btn-outline:hover{{border-color:#6366f1;color:#6366f1}}
.brand{{margin-top:auto;padding-top:2rem;opacity:.5;font-size:.85rem}}
.brand a{{color:#6366f1;text-decoration:none}}
</style>
</head>
<body>
<div class="gif-wrap"><img src="{gif_url}" alt="{safe_title}"></div>
<h1>{safe_title}</h1>
<div class="actions">
<a class="btn btn-primary" href="{site_root}/editor.html">Make Your Own GIF</a>
<a class="btn btn-outline" href="{gif_url}" download>Download</a>
</div>
<p class="brand">Made with <a href="{site_root}/">GifCaption</a></p>
</body>
</html>"""


def handler(event, context):
    """Main Lambda handler — routes requests based on method and path."""
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")

    if method == "POST" and path == "/upload":
        return handle_upload(event)
    elif method == "POST" and path == "/share":
        return handle_share(event)
    elif method == "GET" and path.startswith("/gif/"):
        gif_id = path.split("/gif/", 1)[1]
        return handle_get_gif(gif_id)
    elif method == "OPTIONS":
        return _cors_response(200, {})
    else:
        return _cors_response(404, {"error": "Not found"})


def handle_upload(event):
    """Handle POST /upload — accept base64-encoded GIF, store in S3 + DynamoDB."""
    try:
        body = event.get("body", "")
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        payload = json.loads(body)
    except (json.JSONDecodeError, Exception):
        return _cors_response(400, {"error": "Invalid JSON body"})

    file_data = payload.get("file")
    if not file_data:
        return _cors_response(400, {"error": "Missing 'file' field (base64-encoded GIF)"})

    try:
        gif_bytes = base64.b64decode(file_data)
    except Exception:
        return _cors_response(400, {"error": "Invalid base64 data"})

    # Validate that the data looks like a GIF (magic bytes: GIF87a or GIF89a)
    if not gif_bytes[:3] == b"GIF":
        return _cors_response(400, {"error": "Uploaded file does not appear to be a GIF"})

    gif_id = str(uuid.uuid4())
    s3_key = f"gifs/{gif_id}.gif"
    created_at = datetime.now(timezone.utc).isoformat()

    # Upload to S3
    s3.put_object(
        Bucket=ASSETS_BUCKET,
        Key=s3_key,
        Body=gif_bytes,
        ContentType="image/gif",
    )

    # Write metadata to DynamoDB (store the S3 key, not a direct URL)
    table.put_item(
        Item={
            "id": gif_id,
            "created_at": created_at,
            "s3_key": s3_key,
        }
    )

    gif_url = f"{ASSETS_CDN_URL}/{s3_key}"
    return _cors_response(200, {"id": gif_id, "gif_url": gif_url, "created_at": created_at})


def handle_share(event):
    """Handle POST /share — accept captioned GIF + title, create a shareable page."""
    try:
        body = event.get("body", "")
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        payload = json.loads(body)
    except (json.JSONDecodeError, Exception):
        return _cors_response(400, {"error": "Invalid JSON body"})

    file_data = payload.get("file")
    title = (payload.get("title") or "").strip()[:200]
    if not file_data:
        return _cors_response(400, {"error": "Missing 'file' field (base64-encoded GIF)"})
    if not title:
        title = "Captioned GIF"

    try:
        gif_bytes = base64.b64decode(file_data)
    except Exception:
        return _cors_response(400, {"error": "Invalid base64 data"})

    if gif_bytes[:3] != b"GIF":
        return _cors_response(400, {"error": "Uploaded file does not appear to be a GIF"})

    # Limit file size to 15 MB
    if len(gif_bytes) > 15 * 1024 * 1024:
        return _cors_response(400, {"error": "GIF too large (max 15 MB)"})

    # Generate slug from title + short unique suffix
    slug = _slugify(title)
    short_id = uuid.uuid4().hex[:8]
    slug = f"{slug}-{short_id}" if slug else short_id
    created_at = datetime.now(timezone.utc).isoformat()

    # Upload captioned GIF to assets bucket
    s3_key = f"shared/{slug}.gif"
    s3.put_object(
        Bucket=ASSETS_BUCKET,
        Key=s3_key,
        Body=gif_bytes,
        ContentType="image/gif",
        CacheControl="public, max-age=31536000, immutable",
    )
    gif_url = f"{ASSETS_CDN_URL}/{s3_key}"

    # Generate share page HTML and upload to site bucket
    share_html = _build_share_page(title, gif_url, slug)
    s3.put_object(
        Bucket=SITE_BUCKET,
        Key=f"g/{slug}.html",
        Body=share_html.encode("utf-8"),
        ContentType="text/html; charset=utf-8",
        CacheControl="public, max-age=86400",
    )

    # Store in DynamoDB
    table.put_item(
        Item={
            "id": slug,
            "title": title,
            "s3_key": s3_key,
            "gif_url": gif_url,
            "created_at": created_at,
            "type": "shared",
        }
    )

    share_url = f"{SITE_CDN_URL}/g/{slug}.html"
    return _cors_response(200, {
        "slug": slug,
        "share_url": share_url,
        "gif_url": gif_url,
    })


def handle_get_gif(gif_id):
    """Handle GET /gif/{id} — return metadata from DynamoDB."""
    if not gif_id:
        return _cors_response(400, {"error": "Missing GIF ID"})

    response = table.get_item(Key={"id": gif_id})
    item = response.get("Item")

    if not item:
        return _cors_response(404, {"error": "GIF not found"})

    # Support both old records (gif_url) and new records (s3_key)
    s3_key = item.get("s3_key") or f"gifs/{gif_id}.gif"
    gif_url = f"{ASSETS_CDN_URL}/{s3_key}"

    return _cors_response(200, {
        "id": item["id"],
        "gif_url": gif_url,
        "created_at": item["created_at"],
    })


def _cors_response(status_code, body):
    """Return a JSON response. CORS headers are handled by the Function URL config."""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(body),
    }

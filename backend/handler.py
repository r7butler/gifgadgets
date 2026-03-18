import json
import os
import re
import subprocess
import tempfile
import uuid
import base64
import urllib.request
import urllib.error

import boto3

ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]
SITE_BUCKET = os.environ["SITE_BUCKET"]
ASSETS_CDN_URL = os.environ.get("ASSETS_CDN_URL", "").rstrip("/")
SITE_CDN_URL = os.environ.get("SITE_CDN_URL", "").rstrip("/")
GITHUB_SECRET_ARN = os.environ.get("GITHUB_SECRET_ARN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")

s3 = boto3.client("s3")
secretsmanager = boto3.client("secretsmanager")




def _sanitize_slug_base(filename):
    """Turn an original filename into a safe slug base (no extension, url-safe)."""
    base = re.sub(r"\.gif$", "", filename or "", flags=re.IGNORECASE).strip()
    base = base.lower()
    base = re.sub(r"[^\w\s-]", "", base)
    base = re.sub(r"[\s_]+", "-", base)
    base = re.sub(r"-+", "-", base).strip("-")
    return base[:60] or "gif"


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
<meta property="og:type" content="website">
<meta property="og:title" content="{safe_title}">
<meta property="og:description" content="Made with GifCaption — the free GIF caption editor">
<meta property="og:image" content="{gif_url}">
<meta property="og:image:type" content="image/gif">
<meta property="og:image:width" content="600">
<meta property="og:image:height" content="600">
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
    elif method == "POST" and path == "/share/upload":
        return handle_share_upload(event)
    elif method == "POST" and path == "/share/presign":
        return handle_share_presign(event)
    elif method == "POST" and path == "/share/finalize":
        return handle_share_finalize(event)
    elif method == "POST" and path == "/report-issue":
        return handle_report_issue(event)
    elif method == "POST" and path == "/convert/presign-upload":
        return handle_presign_upload(event)
    elif method == "POST" and path == "/convert-to-mp4":
        return handle_convert_to_mp4(event)
    elif method == "OPTIONS":
        return _cors_response(200, {})
    else:
        return _cors_response(404, {"error": "Not found"})


def handle_upload(event):
    """Handle POST /upload — accept a base64-encoded GIF and store it in S3."""
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

    # Upload to S3
    s3.put_object(
        Bucket=ASSETS_BUCKET,
        Key=s3_key,
        Body=gif_bytes,
        ContentType="image/gif",
    )

    gif_url = f"{ASSETS_CDN_URL}/{s3_key}"
    return _cors_response(200, {"id": gif_id, "gif_url": gif_url})


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
    filename = payload.get("filename") or None
    if not file_data:
        return _cors_response(400, {"error": "Missing 'file' field (base64-encoded GIF)"})
    if not title:
        title = "Captioned GIF"

    slug_base = _sanitize_slug_base(filename)
    short_id = uuid.uuid4().hex[:8]
    slug = f"{slug_base}-captioned-{short_id}"

    try:
        gif_bytes = base64.b64decode(file_data)
    except Exception:
        return _cors_response(400, {"error": "Invalid base64 data"})

    if gif_bytes[:3] != b"GIF":
        return _cors_response(400, {"error": "Uploaded file does not appear to be a GIF"})

    # Limit file size to 15 MB
    if len(gif_bytes) > 15 * 1024 * 1024:
        return _cors_response(400, {"error": "GIF too large (max 15 MB)"})

    # Upload captioned GIF to assets bucket
    s3_key = f"share/{slug}.gif"
    s3.put_object(
        Bucket=ASSETS_BUCKET,
        Key=s3_key,
        Body=gif_bytes,
        ContentType="image/gif",
        CacheControl="public, max-age=31536000, immutable",
    )
    gif_url = f"{SITE_CDN_URL}/{s3_key}"

    # Generate share page HTML and upload to site bucket
    share_html = _build_share_page(title, gif_url, slug)
    s3.put_object(
        Bucket=SITE_BUCKET,
        Key=f"g/{slug}.html",
        Body=share_html.encode("utf-8"),
        ContentType="text/html; charset=utf-8",
        CacheControl="public, max-age=86400",
    )

    share_url = f"{SITE_CDN_URL}/g/{slug}.html"
    return _cors_response(200, {
        "slug": slug,
        "share_url": share_url,
        "gif_url": gif_url,
    })


def handle_share_upload(event):
    """POST /share/upload — accept raw binary GIF with title/filename in headers."""
    title = (event.get("headers", {}).get("x-title") or "").strip()[:200] or "Captioned GIF"
    filename = event.get("headers", {}).get("x-filename") or None

    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        gif_bytes = base64.b64decode(body)
    else:
        gif_bytes = body.encode("latin-1") if isinstance(body, str) else body

    if not gif_bytes or gif_bytes[:3] != b"GIF":
        return _cors_response(400, {"error": "Uploaded file does not appear to be a GIF"})
    if len(gif_bytes) > 15 * 1024 * 1024:
        return _cors_response(400, {"error": "GIF too large (max 15 MB)"})

    slug_base = _sanitize_slug_base(filename)
    short_id = uuid.uuid4().hex[:8]
    slug = f"{slug_base}-captioned-{short_id}"
    s3_key = f"share/{slug}.gif"

    s3.put_object(
        Bucket=ASSETS_BUCKET,
        Key=s3_key,
        Body=gif_bytes,
        ContentType="image/gif",
        CacheControl="public, max-age=31536000, immutable",
    )
    gif_url = f"{SITE_CDN_URL}/{s3_key}"

    share_html = _build_share_page(title, gif_url, slug)
    s3.put_object(
        Bucket=SITE_BUCKET,
        Key=f"g/{slug}.html",
        Body=share_html.encode("utf-8"),
        ContentType="text/html; charset=utf-8",
        CacheControl="public, max-age=86400",
    )

    share_url = f"{SITE_CDN_URL}/g/{slug}.html"
    return _cors_response(200, {
        "slug": slug,
        "share_url": share_url,
        "gif_url": gif_url,
    })


def handle_share_presign(event):
    """POST /share/presign — return a presigned PUT URL for direct GIF upload."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    filename = body.get("filename") or None
    title = (body.get("title") or "").strip()[:200] or "Captioned GIF"

    slug_base = _sanitize_slug_base(filename)
    short_id = uuid.uuid4().hex[:8]
    slug = f"{slug_base}-captioned-{short_id}"
    s3_key = f"share/{slug}.gif"

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": ASSETS_BUCKET,
            "Key": s3_key,
            "ContentType": "image/gif",
        },
        ExpiresIn=300,
    )

    return _cors_response(200, {
        "upload_url": presigned_url,
        "slug": slug,
        "title": title,
    })


def handle_share_finalize(event):
    """POST /share/finalize — create the share page after GIF was uploaded via presigned URL."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    slug = body.get("slug")
    title = (body.get("title") or "").strip()[:200] or "Captioned GIF"
    if not slug:
        return _cors_response(400, {"error": "Missing 'slug' field"})

    s3_key = f"share/{slug}.gif"
    gif_url = f"{SITE_CDN_URL}/{s3_key}"

    share_html = _build_share_page(title, gif_url, slug)
    s3.put_object(
        Bucket=SITE_BUCKET,
        Key=f"g/{slug}.html",
        Body=share_html.encode("utf-8"),
        ContentType="text/html; charset=utf-8",
        CacheControl="public, max-age=86400",
    )

    share_url = f"{SITE_CDN_URL}/g/{slug}.html"
    return _cors_response(200, {
        "slug": slug,
        "share_url": share_url,
        "gif_url": gif_url,
    })


def handle_report_issue(event):
    """Handle POST /report-issue — post a GitHub issue using the stored PAT."""
    try:
        body = event.get("body", "")
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        payload = json.loads(body)
    except (json.JSONDecodeError, Exception):
        return _cors_response(400, {"error": "Invalid JSON body"})

    title = (payload.get("title") or "").strip()[:200]
    body_text = (payload.get("body") or "").strip()[:5000]

    if not title:
        return _cors_response(400, {"error": "Missing 'title' field"})

    try:
        secret = secretsmanager.get_secret_value(SecretId=GITHUB_SECRET_ARN)
        token = secret["SecretString"]
    except Exception:
        return _cors_response(500, {"error": "Failed to retrieve credentials"})

    issue_payload = json.dumps({"title": title, "body": body_text}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/issues",
        data=issue_payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gifcaption-app",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
        return _cors_response(200, {"url": result.get("html_url", "")})
    except urllib.error.HTTPError:
        return _cors_response(500, {"error": "Failed to create issue"})


def _parse_body(event):
    """Parse JSON body, handling base64-encoded payloads."""
    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body)


def handle_presign_upload(event):
    """POST /convert/presign-upload — return a presigned PUT URL for WebM upload."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    job_id = uuid.uuid4().hex[:12]
    s3_key = f"convert/{job_id}/input.webm"

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": ASSETS_BUCKET,
            "Key": s3_key,
            "ContentType": "video/webm",
        },
        ExpiresIn=300,
    )

    return _cors_response(200, {
        "upload_url": presigned_url,
        "job_id": job_id,
    })


def handle_convert_to_mp4(event):
    """POST /convert-to-mp4 — convert an uploaded WebM to MP4 using ffmpeg."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    job_id = body.get("job_id")
    filename = body.get("filename", "converted.mp4")
    if not job_id or not re.match(r"^[a-f0-9]{12}$", job_id):
        return _cors_response(400, {"error": "Invalid job_id"})

    input_key = f"convert/{job_id}/input.webm"
    output_key = f"convert/{job_id}/output.mp4"

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, "input.webm")
        output_path = os.path.join(tmpdir, "output.mp4")

        try:
            s3.download_file(ASSETS_BUCKET, input_key, input_path)
        except Exception:
            return _cors_response(400, {"error": "Input file not found — upload may have expired"})

        result = subprocess.run(
            ["/opt/bin/ffmpeg", "-y",
             "-i", input_path,
             "-c:v", "libx264", "-preset", "fast",
             "-movflags", "+faststart",
             "-c:a", "aac",
             output_path],
            capture_output=True, timeout=90,
        )

        if result.returncode != 0:
            return _cors_response(500, {
                "error": "Conversion failed",
                "detail": result.stderr.decode("utf-8", errors="replace")[-500:],
            })

        s3.upload_file(
            output_path, ASSETS_BUCKET, output_key,
            ExtraArgs={"ContentType": "video/mp4"},
        )

    # Sanitize filename for Content-Disposition
    safe_filename = re.sub(r'[^\w\s.\-]', '', filename).strip() or "converted.mp4"
    if not safe_filename.endswith(".mp4"):
        safe_filename += ".mp4"

    download_url = s3.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": ASSETS_BUCKET,
            "Key": output_key,
            "ResponseContentDisposition": f'attachment; filename="{safe_filename}"',
        },
        ExpiresIn=3600,
    )

    # Clean up input file
    try:
        s3.delete_object(Bucket=ASSETS_BUCKET, Key=input_key)
    except Exception:
        pass

    return _cors_response(200, {"download_url": download_url})


def _cors_response(status_code, body):
    """Return a JSON response. CORS headers are handled by the Function URL config."""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(body),
    }

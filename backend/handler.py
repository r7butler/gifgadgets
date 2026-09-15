import json
import os
import re
import subprocess
import tempfile
import uuid
import base64
import hashlib
import logging
import time
import urllib.request
import urllib.error

import boto3

# ---------- Configuration ----------

ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]
SITE_BUCKET = os.environ["SITE_BUCKET"]
ASSETS_CDN_URL = os.environ.get("ASSETS_CDN_URL", "").rstrip("/")
SITE_CDN_URL = os.environ.get("SITE_CDN_URL", "").rstrip("/")
GITHUB_SECRET_ARN = os.environ.get("GITHUB_SECRET_ARN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
FEATURES_DISABLED = set(filter(None, os.environ.get("FEATURES_DISABLED", "").split(",")))
MODAL_API_KEY = os.environ.get("MODAL_API_KEY", "")
MODAL_TRACKER_URL = os.environ.get("MODAL_TRACKER_URL", "")
MODAL_CONVERTER_URL = os.environ.get("MODAL_CONVERTER_URL", "")

s3 = boto3.client("s3")
secretsmanager = boto3.client("secretsmanager")
dynamodb = boto3.resource("dynamodb")

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Lazy-init DynamoDB table reference
_jobs_table = None


def _get_jobs_table():
    global _jobs_table
    if _jobs_table is None and JOBS_TABLE:
        _jobs_table = dynamodb.Table(JOBS_TABLE)
    return _jobs_table


CONTENT_TYPE_TO_EXT = {
    "image/gif": ".gif",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "image/webp": ".webp",
}


def _sanitize_slug_base(filename):
    """Turn an original filename into a safe slug base (no extension, url-safe)."""
    base = re.sub(r"\.(gif|png|jpe?g|mp4|webm|webp)$", "", filename or "", flags=re.IGNORECASE).strip()
    base = base.lower()
    base = re.sub(r"[^\w\s-]", "", base)
    base = re.sub(r"[\s_]+", "-", base)
    base = re.sub(r"-+", "-", base).strip("-")
    return base[:60] or "gif"


def _build_share_page(title, gif_url, slug, content_type="image/gif"):
    """Return an HTML string for a shareable page with OG meta tags."""
    safe_title = title.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    site_root = SITE_CDN_URL or ""
    is_video = content_type.startswith("video/")

    if is_video:
        og_meta = (
            f'<meta property="og:type" content="video.other">\n'
            f'<meta property="og:video" content="{gif_url}">\n'
            f'<meta property="og:video:type" content="{content_type}">'
        )
        media_tag = f'<video src="{gif_url}" controls autoplay muted loop playsinline style="width:100%;border-radius:8px;display:block"></video>'
    else:
        og_meta = (
            f'<meta property="og:type" content="website">\n'
            f'<meta property="og:image" content="{gif_url}">\n'
            f'<meta property="og:image:type" content="{content_type}">\n'
            f'<meta property="og:image:width" content="600">\n'
            f'<meta property="og:image:height" content="600">'
        )
        media_tag = f'<img src="{gif_url}" alt="{safe_title}">'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{safe_title} — GifWidgets</title>
<meta name="description" content="{safe_title} — made with GifWidgets, free online media tools.">
{og_meta}
<meta property="og:title" content="{safe_title}">
<meta property="og:description" content="Made with GifWidgets — free online media tools">
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
.gif-wrap img,.gif-wrap video{{width:100%;border-radius:8px;display:block}}
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
<div class="gif-wrap">{media_tag}</div>
<h1>{safe_title}</h1>
<div class="actions">
<a class="btn btn-primary" href="{site_root}/editor.html">Make Your Own</a>
<a class="btn btn-outline" href="{gif_url}" download>Download</a>
</div>
<p class="brand">Made with <a href="{site_root}/">GifWidgets</a></p>
</body>
</html>"""


# ---------- Helpers ----------


def _get_client_ip(event):
    """Extract client IP, handling CloudFront X-Forwarded-For."""
    xff = event.get("headers", {}).get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return event.get("requestContext", {}).get("http", {}).get("sourceIp", "unknown")


def _check_quota(event, limit=20, window=3600):
    """Check per-IP rate quota via DynamoDB. Returns (allowed, ip_hash)."""
    table = _get_jobs_table()
    if not table:
        return True, ""
    ip = _get_client_ip(event)
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:16]
    cutoff = int(time.time()) - window
    try:
        resp = table.query(
            IndexName="ip_hash-created_at-index",
            KeyConditionExpression="ip_hash = :h AND created_at > :c",
            ExpressionAttributeValues={":h": ip_hash, ":c": cutoff},
            Select="COUNT",
        )
        if resp["Count"] >= limit:
            return False, ip_hash
    except Exception as e:
        logger.error(json.dumps({"event": "quota_check_failed", "error": str(e)}))
        return False, ip_hash  # Fail closed — deny if we can't verify quota
    return True, ip_hash


def _record_job(job_id, job_type, ip_hash):
    """Record a job in DynamoDB for quota tracking."""
    table = _get_jobs_table()
    if not table:
        return
    now = int(time.time())
    try:
        table.put_item(Item={
            "job_id": job_id,
            "job_type": job_type,
            "ip_hash": ip_hash,
            "created_at": now,
            "ttl": now + 3600,
        })
    except Exception as e:
        logger.error(json.dumps({"event": "record_job_failed", "job_id": job_id, "error": str(e)}))


def _parse_body(event):
    """Parse JSON body, handling base64-encoded payloads."""
    body = event.get("body", "")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    return json.loads(body)


def _cors_response(status_code, body):
    """Return a JSON response with CORS headers."""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Title, X-Filename",
        },
        "body": json.dumps(body),
    }


# ---------- Router ----------


def handler(event, context):
    """Main Lambda handler — routes requests based on method and path."""
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")

    # Strip /api prefix (CloudFront routes /api/* to this Lambda)
    if path.startswith("/api"):
        path = path[4:]

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
    elif method == "POST" and path == "/track/presign":
        return handle_track_presign(event)
    elif method == "POST" and path == "/track/submit":
        return handle_track_submit(event)
    elif method == "POST" and path == "/track/warmup":
        return handle_track_warmup(event)
    elif method == "OPTIONS":
        return _cors_response(200, {})
    else:
        return _cors_response(404, {"error": "Not found"})


# ---------- Existing Handlers ----------


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

    if len(gif_bytes) > 15 * 1024 * 1024:
        return _cors_response(400, {"error": "GIF too large (max 15 MB)"})

    if not gif_bytes[:3] == b"GIF":
        return _cors_response(400, {"error": "Uploaded file does not appear to be a GIF"})

    gif_id = str(uuid.uuid4())
    s3_key = f"gifs/{gif_id}.gif"

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

    if len(gif_bytes) > 15 * 1024 * 1024:
        return _cors_response(400, {"error": "GIF too large (max 15 MB)"})

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
    """POST /share/presign — return a presigned PUT URL for direct upload."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    filename = body.get("filename") or None
    title = (body.get("title") or "").strip()[:200] or "Captioned GIF"
    content_type = body.get("content_type") or "image/gif"

    ext = CONTENT_TYPE_TO_EXT.get(content_type, ".gif")
    slug_base = _sanitize_slug_base(filename)
    short_id = uuid.uuid4().hex[:8]
    slug = f"{slug_base}-captioned-{short_id}"
    s3_key = f"share/{slug}{ext}"

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": ASSETS_BUCKET,
            "Key": s3_key,
            "ContentType": content_type,
        },
        ExpiresIn=300,
    )

    return _cors_response(200, {
        "upload_url": presigned_url,
        "slug": slug,
        "title": title,
        "content_type": content_type,
    })


def handle_share_finalize(event):
    """POST /share/finalize — create the share page after file was uploaded via presigned URL."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    slug = body.get("slug")
    title = (body.get("title") or "").strip()[:200] or "Captioned GIF"
    content_type = body.get("content_type") or "image/gif"
    if not slug:
        return _cors_response(400, {"error": "Missing 'slug' field"})

    ext = CONTENT_TYPE_TO_EXT.get(content_type, ".gif")
    s3_key = f"share/{slug}{ext}"
    media_url = f"{SITE_CDN_URL}/{s3_key}"

    share_html = _build_share_page(title, media_url, slug, content_type)
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
        "gif_url": media_url,
    })


def _get_recent_jobs(ip_hash, limit=10):
    """Fetch recent job IDs for an IP hash from DynamoDB."""
    table = _get_jobs_table()
    if not table or not ip_hash:
        return []
    try:
        cutoff = int(time.time()) - 3600
        resp = table.query(
            IndexName="ip_hash-created_at-index",
            KeyConditionExpression="ip_hash = :h AND created_at > :c",
            ExpressionAttributeValues={":h": ip_hash, ":c": cutoff},
            ScanIndexForward=False,
            Limit=limit,
        )
        # GSI is KEYS_ONLY, so we only get job_id and ip_hash/created_at
        return [item["job_id"] for item in resp.get("Items", [])]
    except Exception:
        return []


def handle_report_issue(event):
    """Handle POST /report-issue — post a GitHub issue using the stored PAT."""
    # Rate limit: max 3 issues per IP per hour
    allowed, ip_hash = _check_quota(event, limit=3, window=3600)
    if not allowed:
        return _cors_response(429, {"error": "Too many reports. Please try again later."})

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

    # Enrich issue body with server-side context
    client_ip = _get_client_ip(event)
    recent_jobs = _get_recent_jobs(ip_hash)
    context_lines = [
        "",
        "---",
        f"**Client IP:** `{client_ip}`",
        f"**IP Hash:** `{ip_hash}`",
    ]
    if recent_jobs:
        context_lines.append(f"**Recent Job IDs:** {', '.join(f'`{j}`' for j in recent_jobs)}")
    body_text += "\n".join(context_lines)

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
            "User-Agent": "gifwidgets-app",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
        return _cors_response(200, {"url": result.get("html_url", "")})
    except urllib.error.HTTPError:
        return _cors_response(500, {"error": "Failed to create issue"})


def handle_presign_upload(event):
    """POST /convert/presign-upload — return a presigned PUT URL for video upload."""
    # Kill switch
    if "trim" in FEATURES_DISABLED:
        return _cors_response(503, {"error": "Video processing is temporarily disabled"})

    # Quota check (gates access to the entire trim pipeline)
    allowed, ip_hash = _check_quota(event, limit=20, window=3600)
    if not allowed:
        return _cors_response(429, {"error": "Rate limit exceeded. Please try again later."})

    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    content_type = body.get("content_type") or "video/webm"
    job_id = uuid.uuid4().hex[:12]
    s3_key = f"convert/{job_id}/input.webm"

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": ASSETS_BUCKET,
            "Key": s3_key,
            "ContentType": content_type,
        },
        ExpiresIn=300,
    )

    _record_job(job_id, "trim", ip_hash)

    logger.info(json.dumps({
        "event": "presign_upload",
        "job_id": job_id,
        "ip_hash": ip_hash,
        "content_type": content_type,
    }))

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

    try:
        s3.delete_object(Bucket=ASSETS_BUCKET, Key=input_key)
    except Exception:
        pass

    return _cors_response(200, {"download_url": download_url})


# ---------- Modal Broker Endpoints ----------


def handle_track_presign(event):
    """POST /track/presign — return a presigned PUT URL for tracker frame upload."""
    if "track" in FEATURES_DISABLED:
        return _cors_response(503, {"error": "Tracking is temporarily disabled"})

    allowed, ip_hash = _check_quota(event, limit=20, window=3600)
    if not allowed:
        return _cors_response(429, {"error": "Rate limit exceeded. Please try again later."})

    job_id = uuid.uuid4().hex[:12]
    s3_key = f"track/{job_id}.json"

    presigned_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": ASSETS_BUCKET,
            "Key": s3_key,
            "ContentType": "application/json",
        },
        ExpiresIn=300,
    )

    _record_job(job_id, "track", ip_hash)

    logger.info(json.dumps({
        "event": "track_presign",
        "job_id": job_id,
        "ip_hash": ip_hash,
    }))

    return _cors_response(200, {
        "upload_url": presigned_url,
        "job_id": job_id,
        "s3_key": s3_key,
    })


def handle_track_submit(event):
    """Broker for Modal SAM2 tracker — passes S3 key to Modal for processing."""
    if "track" in FEATURES_DISABLED:
        return _cors_response(503, {"error": "Tracking is temporarily disabled"})

    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    s3_key = body.get("s3_key")
    if not s3_key or not s3_key.startswith("track/"):
        return _cors_response(400, {"error": "Missing or invalid s3_key"})

    if not MODAL_TRACKER_URL:
        return _cors_response(503, {"error": "Tracker not configured"})

    job_id = s3_key.split("/")[-1].replace(".json", "")

    logger.info(json.dumps({
        "event": "track_submit",
        "job_id": job_id,
        "s3_key": s3_key,
    }))

    # Hand the tracker a short-lived presigned GET for exactly this object
    # instead of an S3 key it would need its own AWS credentials to read.
    # Expiry comfortably exceeds the 110s call timeout so a Modal cold start
    # cannot outlive the URL.
    try:
        frames_url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": ASSETS_BUCKET, "Key": s3_key},
            ExpiresIn=600,
        )
    except Exception as e:
        logger.error(json.dumps({
            "event": "track_error", "job_id": job_id,
            "error": f"presign failed: {e}",
        }))
        return _cors_response(500, {"error": "Could not prepare tracking job"})

    try:
        url = MODAL_TRACKER_URL + "/track"
        payload = json.dumps({
            "frames_url": frames_url,
            "click_x": body.get("click_x"),
            "click_y": body.get("click_y"),
            "click_frame": body.get("click_frame"),
            "frame_indices": body.get("frame_indices"),
        }).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if MODAL_API_KEY:
            headers["X-Modal-Api-Key"] = MODAL_API_KEY
        req = urllib.request.Request(
            url,
            data=payload,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=110) as resp:
            result = json.loads(resp.read())
        return _cors_response(200, result)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        logger.error(json.dumps({
            "event": "track_error", "job_id": job_id,
            "status": e.code, "detail": detail,
        }))
        return _cors_response(502, {"error": "Tracker processing failed"})
    except Exception as e:
        logger.error(json.dumps({
            "event": "track_error", "job_id": job_id, "error": str(e),
        }))
        return _cors_response(502, {"error": "Tracker unavailable"})
    finally:
        # The tracker used to delete this itself. Best-effort: the bucket
        # lifecycle rule expires track/* after a day regardless.
        try:
            s3.delete_object(Bucket=ASSETS_BUCKET, Key=s3_key)
        except Exception:
            pass


def handle_track_warmup(event):
    """Best-effort warmup for Modal tracker — no quota check."""
    if not MODAL_TRACKER_URL:
        return _cors_response(200, {"ok": True})
    try:
        url = MODAL_TRACKER_URL + "/track"
        payload = json.dumps({"warmup": True}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if MODAL_API_KEY:
            headers["X-Modal-Api-Key"] = MODAL_API_KEY
        req = urllib.request.Request(
            url, data=payload,
            headers=headers,
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception:
        pass
    return _cors_response(200, {"ok": True})

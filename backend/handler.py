import json
import html
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
from botocore.exceptions import ClientError

# ---------- Configuration ----------

ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]
SITE_BUCKET = os.environ["SITE_BUCKET"]
ASSETS_CDN_URL = os.environ.get("ASSETS_CDN_URL", "").rstrip("/")
SITE_CDN_URL = os.environ.get("SITE_CDN_URL", "").rstrip("/")
GITHUB_SECRET_ARN = os.environ.get("GITHUB_SECRET_ARN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
FEATURES_DISABLED = set(filter(None, os.environ.get("FEATURES_DISABLED", "").split(",")))
IP_HASH_SALT = os.environ.get("IP_HASH_SALT", "")
SITE_BRAND = os.environ.get("SITE_BRAND", "GifGadgets")

# Shown when AI tracking cannot run at all — no credit, endpoint down, throttled.
# Names the manual alternative so the editor stays usable instead of dead-ending.
TRACKER_UNAVAILABLE_MESSAGE = (
    "AI tracking is temporarily unavailable. You can still add moving captions "
    "using manual keyframes."
)
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
    safe_title = html.escape(title, quote=True)
    gif_url = html.escape(gif_url, quote=True)
    slug = html.escape(slug, quote=True)
    content_type = html.escape(content_type, quote=True)
    site_root = html.escape(SITE_CDN_URL or "", quote=True)
    brand = html.escape(SITE_BRAND, quote=True)
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
<title>{safe_title} — {brand}</title>
<meta name="description" content="{safe_title} — made with {brand}, free online media tools.">
{og_meta}
<meta property="og:title" content="{safe_title}">
<meta property="og:description" content="Made with {brand} — free online media tools">
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
<p class="brand">Made with <a href="{site_root}/">{brand}</a></p>
</body>
</html>"""


# ---------- Helpers ----------


def _get_client_ip(event):
    """Extract client IP, handling CloudFront X-Forwarded-For."""
    xff = event.get("headers", {}).get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[-1].strip()
    return event.get("requestContext", {}).get("http", {}).get("sourceIp", "unknown")


def _hash_ip(ip):
    """Salted hash of a client IP for rate-limit keys.

    IPv4 has only ~4.3 billion values, so an unsalted digest can be reversed by
    exhausting the space. The salt is a secret held in the Lambda environment and
    never stored alongside the hash, which makes that table impossible to build.
    The same IP still maps to the same key, so quota counting is unaffected.
    """
    if not IP_HASH_SALT:
        # Fail closed: a missing salt would silently restore reversible hashes.
        raise RuntimeError("IP_HASH_SALT is not configured")
    return hashlib.sha256(IP_HASH_SALT.encode() + b"|" + ip.encode()).hexdigest()[:16]


def _check_quota(event, limit=20, window=3600, operation="compute"):
    """Atomically reserve a request; reporting does not consume compute quota."""
    table = _get_jobs_table()
    if not table:
        return False, ""
    ip_hash = _hash_ip(_get_client_ip(event))
    now = int(time.time())
    bucket = now // window
    try:
        table.update_item(
            Key={"job_id": f"quota:{operation}:{ip_hash}:{bucket}"},
            UpdateExpression="SET #ttl = :ttl ADD requests :one",
            ConditionExpression="attribute_not_exists(requests) OR requests < :limit",
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={":ttl": (bucket + 2) * window, ":one": 1, ":limit": limit},
        )
        return True, ip_hash
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            logger.exception("Quota reservation failed")
        return False, ip_hash


def _record_job(job_id, job_type, ip_hash):
    """Record a job in DynamoDB for quota tracking."""
    table = _get_jobs_table()
    if not table:
        raise RuntimeError("Job storage is not configured")
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
        raise


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
    elif method == "POST" and path == "/segment/presign":
        return handle_segment_presign(event)
    elif method == "POST" and path in ("/segment/submit", "/segment/status", "/segment/cancel"):
        return handle_segment_job(event, path.rsplit("/", 1)[-1])
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
    """Keep the PUT client contract; the random slug is a publication capability.

    Only server-issued metadata can be published. The PUT URL reaches a private
    temporary object, never the immutable public object.
    """
    try:
        body = _parse_body(event)
        filename = body.get("filename") or None
        title = (body.get("title") or "").strip()[:200] or "Captioned GIF"
        content_type = body.get("content_type") or "image/gif"
        if content_type not in CONTENT_TYPE_TO_EXT:
            return _cors_response(400, {"error": "Unsupported media type"})
        slug = f"{_sanitize_slug_base(filename)}-captioned-{uuid.uuid4().hex}"
    except (ValueError, TypeError, AttributeError):
        return _cors_response(400, {"error": "Invalid share metadata"})
    table = _get_jobs_table()
    if not table:
        return _cors_response(503, {"error": "Sharing is temporarily unavailable"})
    key = f"pending-share/{slug}{CONTENT_TYPE_TO_EXT[content_type]}"
    table.put_item(Item={
        "job_id": "share:" + slug, "job_type": "share", "title": title,
        "content_type": content_type, "input_key": key,
        "ttl": int(time.time()) + 86400,
    }, ConditionExpression="attribute_not_exists(job_id)")
    url = s3.generate_presigned_url("put_object", Params={
        "Bucket": ASSETS_BUCKET, "Key": key, "ContentType": content_type,
    }, ExpiresIn=300)
    return _cors_response(200, {"upload_url": url, "slug": slug,
                                "title": title, "content_type": content_type})


def _valid_media(data, content_type):
    """Signature check, not a full decoder. CDN headers also prohibit scripts."""
    return {
        "image/gif": data.startswith((b"GIF87a", b"GIF89a")),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/webp": data.startswith(b"RIFF") and data[8:12] == b"WEBP",
        "video/mp4": data[4:8] == b"ftyp",
        "video/webm": data.startswith(b"\x1aE\xdf\xa3"),
    }.get(content_type, False)


def _run_once(job_id, job_type, result_key, work, retry_errors=False, retry_event=None):
    """Claim an issued job, and return saved responses on network retries.

    Responses live in private S3 (tracking results can exceed DynamoDB's item
    limit). Concurrent requests wait for the first result without rerunning work.
    Failed shares can be retried. Known conversion failures can also be retried,
    consuming an existing compute-quota allowance rather than another upload.
    Ambiguous remote failures are cached to avoid running the same GPU job twice.
    """
    table = _get_jobs_table()
    if not table:
        return _cors_response(503, {"error": "Job storage unavailable"})
    item = table.get_item(Key={"job_id": job_id}, ConsistentRead=True).get("Item", {})
    if item.get("job_type") != job_type or item.get("ttl", 0) <= int(time.time()):
        return _cors_response(400, {"error": "Unknown or expired job"})
    deadline = time.monotonic() + 115
    while True:
        try:
            claim = table.update_item(Key={"job_id": job_id},
                UpdateExpression="SET running = :yes ADD attempts :one",
                ConditionExpression="attribute_exists(job_id) AND attribute_not_exists(running)",
                ExpressionAttributeValues={":yes": True, ":one": 1},
                ReturnValues="ALL_NEW")
            break
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            try:
                response = s3.get_object(Bucket=ASSETS_BUCKET, Key=result_key)
                with response["Body"] as stream:
                    return json.loads(stream.read())
            except ClientError as err:
                if err.response["Error"]["Code"] not in ("NoSuchKey", "404"):
                    raise
            if time.monotonic() >= deadline:
                return _cors_response(504, {"error": "Processing has not completed. Please retry."})
            time.sleep(1)
    if retry_event and claim.get("Attributes", {}).get("attempts", 1) > 1:
        allowed, _ = _check_quota(retry_event)
        if not allowed:
            table.update_item(Key={"job_id": job_id}, UpdateExpression="REMOVE running")
            return _cors_response(429, {"error": "Rate limit exceeded. Please try again later."})
    try:
        result = work(item)
    except Exception:
        logger.exception("Job failed: %s", job_id)
        result = _cors_response(502, {"error": "Processing failed. Please try again."})
    if ((retry_errors and result["statusCode"] >= 400)
            or (retry_event and result["statusCode"] in (400, 500))):
        table.update_item(Key={"job_id": job_id}, UpdateExpression="REMOVE running")
    else:
        try:
            s3.put_object(Bucket=ASSETS_BUCKET, Key=result_key,
                          Body=json.dumps(result).encode(), ContentType="application/json")
        except Exception:
            logger.exception("Could not save job response: %s", job_id)
            if retry_errors:
                # Publication can reconstruct its result from immutable objects.
                table.update_item(Key={"job_id": job_id}, UpdateExpression="REMOVE running")
            # Deliver completed work even if caching is unavailable. Compute
            # remains claimed so a retry cannot silently rerun expensive work.
    return result


def handle_share_finalize(event):
    try:
        slug = _parse_body(event).get("slug")
        if not isinstance(slug, str) or not re.fullmatch(r"[\w-]+-captioned-[a-f0-9]{32}", slug):
            return _cors_response(400, {"error": "Invalid slug"})
    except (ValueError, AttributeError):
        return _cors_response(400, {"error": "Invalid JSON body"})

    def publish(item):
        content_type = item["content_type"]
        key = f"share/{slug}{CONTENT_TYPE_TO_EXT[content_type]}"
        try:
            s3.head_object(Bucket=ASSETS_BUCKET, Key=key)
        except ClientError as exc:
            if exc.response["Error"]["Code"] not in ("404", "NoSuchKey"):
                raise
            # Inspect a small header and copy only that exact object version.
            # A completed copy is never overwritten, including after a page-write failure.
            obj = s3.get_object(Bucket=ASSETS_BUCKET, Key=item["input_key"], Range="bytes=0-31")
            with obj["Body"] as stream:
                if not _valid_media(stream.read(), content_type):
                    return _cors_response(400, {"error": "File does not match its media type"})
            s3.copy_object(Bucket=ASSETS_BUCKET, Key=key,
                CopySource={"Bucket": ASSETS_BUCKET, "Key": item["input_key"]},
                CopySourceIfMatch=obj["ETag"], MetadataDirective="REPLACE",
                ContentType=content_type, CacheControl="public, max-age=31536000, immutable")
        media_url = f"{SITE_CDN_URL}/{key}"
        page = _build_share_page(item["title"], media_url, slug, content_type)
        try:
            s3.put_object(Bucket=SITE_BUCKET, Key=f"g/{slug}.html",
                Body=page.encode(), ContentType="text/html; charset=utf-8",
                CacheControl="public, max-age=86400", IfNoneMatch="*")
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "PreconditionFailed":
                raise
            # A previous attempt published the same immutable media and metadata.
        return _cors_response(200, {"slug": slug,
            "share_url": f"{SITE_CDN_URL}/g/{slug}.html", "gif_url": media_url})

    return _run_once("share:" + slug, "share", f"pending-share/{slug}.result.json", publish, retry_errors=True)


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
    allowed, ip_hash = _check_quota(event, limit=3, window=3600, operation="report")
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
    # Never put the client IP — or its hash — in the issue body. Issue trackers are
    # long-lived and may be public, and ip_hash is an unsalted SHA-256 of an IPv4
    # address, so it is brute-forceable and not a pseudonym. Recent job IDs are
    # enough to correlate a report with server-side logs.
    recent_jobs = _get_recent_jobs(ip_hash)
    context_lines = ["", "---"]
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
    job_id = uuid.uuid4().hex
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


def _convert_to_mp4(event):
    """POST /convert-to-mp4 — convert an uploaded WebM to MP4 using ffmpeg."""
    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    job_id = body.get("job_id")
    filename = body.get("filename", "converted.mp4")
    if not job_id or not re.match(r"^(?:[a-f0-9]{12}|[a-f0-9]{32})$", job_id):
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


# ---------- Background segmentation jobs ----------

MODAL_SEGMENTER_URL = os.environ.get("MODAL_SEGMENTER_URL", "").rstrip("/")


def _segment_remote(route, payload):
    request = urllib.request.Request(MODAL_SEGMENTER_URL + route,
        data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Modal-Api-Key": MODAL_API_KEY})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def handle_segment_presign(event):
    if "segment" in FEATURES_DISABLED or not MODAL_SEGMENTER_URL:
        return _cors_response(503, {"error": "Background removal is temporarily unavailable."})
    try:
        body = _parse_body(event)
        content_type = body.get("content_type")
        if content_type not in ("image/gif", "image/png", "image/jpeg", "image/webp"):
            raise ValueError()
    except (ValueError, AttributeError):
        return _cors_response(400, {"error": "Choose a GIF, PNG, JPG or WebP file."})
    allowed, ip_hash = _check_quota(event, limit=20, window=3600)
    if not allowed:
        return _cors_response(429, {"error": "Rate limit exceeded. Please try again later."})
    job_id = uuid.uuid4().hex
    key = f"track/segment-{job_id}.input"
    _record_job(job_id, "segment", ip_hash)
    _get_jobs_table().update_item(Key={"job_id": job_id},
        UpdateExpression="SET content_type = :type, #ttl = :ttl",
        ExpressionAttributeNames={"#ttl": "ttl"},
        ExpressionAttributeValues={":type": content_type, ":ttl": int(time.time()) + 7200})
    url = s3.generate_presigned_url("put_object", Params={"Bucket": ASSETS_BUCKET,
        "Key": key, "ContentType": content_type}, ExpiresIn=300)
    return _cors_response(200, {"job_id": job_id, "upload_url": url})


def handle_segment_job(event, action):
    if "segment" in FEATURES_DISABLED and action == "submit" or not MODAL_SEGMENTER_URL:
        return _cors_response(503, {"error": "Background removal is temporarily unavailable."})
    try:
        body = _parse_body(event)
        job_id = body.get("job_id")
        if not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise ValueError()
    except (ValueError, AttributeError):
        return _cors_response(400, {"error": "Invalid segmentation job."})
    table = _get_jobs_table()
    item = table.get_item(Key={"job_id": job_id}, ConsistentRead=True).get("Item", {})
    if item.get("job_type") != "segment" or item.get("ttl", 0) <= int(time.time()):
        return _cors_response(400, {"error": "Unknown or expired job."})
    # The unguessable issued job ID is the capability; caller-supplied URLs and
    # Modal call IDs are never accepted from the browser.
    prefix = f"track/segment-{job_id}"
    input_key, mask_key = prefix + ".input", prefix + ".masks.gz"

    def cleanup():
        try:
            s3.delete_object(Bucket=ASSETS_BUCKET, Key=input_key)
        except Exception:
            logger.exception("Segmentation input cleanup failed")

    def submit(_):
        # Validate before launching paid work. There is no frame-count cap.
        try:
            from segmentation import validate_objects, validate_prompt
        except ImportError:
            from backend.tracker.segmentation import validate_objects, validate_prompt
        try:
            # A description and a set of clicks are alternative prompts; a job
            # carries one. Text wins when both arrive so the request is never
            # ambiguous about which half of the model it is paying for.
            text = body.get("text")
            describing = isinstance(text, str) and text.strip()
            text = validate_prompt(text) if describing else ""
            objects = [] if describing else validate_objects(body.get("objects"))
            head = s3.head_object(Bucket=ASSETS_BUCKET, Key=input_key)
            if not 0 < head["ContentLength"] <= 100 * 1024 * 1024:
                raise ValueError("Choose a file up to 100 MB.")
        except (ValueError, TypeError, KeyError) as error:
            return _cors_response(400, {"error": str(error) or "Invalid input."})
        # Freeze the upload so a still-valid PUT URL cannot change a running job.
        frozen_key = prefix + ".source"
        s3.copy_object(Bucket=ASSETS_BUCKET, Key=frozen_key,
                       CopySource={"Bucket": ASSETS_BUCKET, "Key": input_key})
        payload = {"job_id": job_id, "objects": objects, "text": text,
            "input_url": s3.generate_presigned_url("get_object", Params={"Bucket": ASSETS_BUCKET, "Key": frozen_key}, ExpiresIn=7200),
            "output_url": s3.generate_presigned_url("put_object", Params={"Bucket": ASSETS_BUCKET, "Key": mask_key, "ContentType": "application/gzip"}, ExpiresIn=7200)}
        result = _segment_remote("/segment", payload)
        call_id = result.get("call_id")
        if not isinstance(call_id, str) or not call_id:
            raise ValueError("Missing job reference")
        table.update_item(Key={"job_id": job_id}, UpdateExpression="SET call_id = :call",
                          ExpressionAttributeValues={":call": call_id})
        cleanup()
        # The description itself is the user's content and is never logged.
        logger.info(json.dumps({"event": "segment_submitted", "job_id": job_id,
                                "objects": len(objects),
                                "prompt": "text" if text else "points"}))
        return _cors_response(202, {"state": "running", "job_id": job_id})

    try:
        if action == "submit":
            return _run_once(job_id, "segment", prefix + ".submitted.json", submit)
        if item.get("cancelled"):
            return _cors_response(200, {"state": "cancelled"})
        if not item.get("call_id"):
            # Do not claim cancellation succeeded before an in-flight submit
            # has saved its call reference. The browser retries this response.
            return _cors_response(409, {"error": "The job is still starting. Please retry."})
        result = _segment_remote("/cancel" if action == "cancel" else "/status", {"call_id": item["call_id"]})
        if action == "cancel":
            table.update_item(Key={"job_id": job_id}, UpdateExpression="SET cancelled = :yes",
                              ExpressionAttributeValues={":yes": True})
        if result.get("state") in ("complete", "failed", "cancelled"):
            cleanup()
            s3.delete_object(Bucket=ASSETS_BUCKET, Key=prefix + ".source")
        if result.get("state") == "complete":
            result["mask_url"] = s3.generate_presigned_url("get_object",
                Params={"Bucket": ASSETS_BUCKET, "Key": mask_key}, ExpiresIn=600)
        if action == "cancel":
            s3.delete_object(Bucket=ASSETS_BUCKET, Key=mask_key)
        return _cors_response(200, result)
    except Exception:
        logger.exception("Segmentation request failed: %s", job_id)
        return _cors_response(503, {"error": "Background removal is temporarily unavailable. Please retry."})


# ---------- Modal Broker Endpoints ----------


def handle_track_presign(event):
    """POST /track/presign — return a presigned PUT URL for tracker frame upload."""
    if "track" in FEATURES_DISABLED:
        return _cors_response(503, {"error": "Tracking is temporarily disabled"})

    allowed, ip_hash = _check_quota(event, limit=20, window=3600)
    if not allowed:
        return _cors_response(429, {"error": "Rate limit exceeded. Please try again later."})

    job_id = uuid.uuid4().hex
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


def _track_submit(event):
    """Broker for Modal SAM2 tracker — passes S3 key to Modal for processing."""
    if "track" in FEATURES_DISABLED:
        return _cors_response(503, {"error": "Tracking is temporarily disabled"})

    try:
        body = _parse_body(event)
    except Exception:
        return _cors_response(400, {"error": "Invalid JSON body"})

    s3_key = body.get("s3_key")
    if not isinstance(s3_key, str) or not re.fullmatch(r"track/(?:[a-f0-9]{12}|[a-f0-9]{32})\.json", s3_key):
        return _cors_response(400, {"error": "Missing or invalid s3_key"})

    if not MODAL_TRACKER_URL:
        return _cors_response(503, {
            "error": TRACKER_UNAVAILABLE_MESSAGE, "unavailable": True,
        })

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
        # Distinguish "the service cannot run right now" from "this job failed".
        # Exhausted Modal credit, a suspended app, throttling or an upstream
        # outage are all service-level and say nothing about the user's file, so
        # they get a 503 and a message that points at the manual alternative.
        if e.code in (401, 402, 403, 404, 429) or e.code >= 500:
            return _cors_response(503, {
                "error": TRACKER_UNAVAILABLE_MESSAGE,
                "unavailable": True,
            })
        return _cors_response(502, {"error": "Tracking could not process this GIF."})
    except Exception as e:
        # Timeouts, DNS failures, a torn-down endpoint — also service-level.
        logger.error(json.dumps({
            "event": "track_error", "job_id": job_id, "error": str(e),
        }))
        return _cors_response(503, {
            "error": TRACKER_UNAVAILABLE_MESSAGE,
            "unavailable": True,
        })
    finally:
        # The tracker used to delete this itself. Best-effort: the bucket
        # lifecycle rule expires track/* after a day regardless.
        try:
            s3.delete_object(Bucket=ASSETS_BUCKET, Key=s3_key)
        except Exception:
            pass


def handle_track_warmup(event):
    """Coalesce warmups globally; repeat calls still succeed without GPU work."""
    if "track" in FEATURES_DISABLED:
        return _cors_response(200, {"ok": True})
    allowed, _ = _check_quota({"headers": {}, "requestContext": {}},
                             limit=1, window=60, operation="warmup")
    if not allowed:
        return _cors_response(200, {"ok": True})
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


def handle_track_submit(event):
    if "track" in FEATURES_DISABLED or not MODAL_TRACKER_URL:
        return _track_submit(event)
    try:
        key = _parse_body(event).get("s3_key")
        if not isinstance(key, str) or not re.fullmatch(r"track/(?:[a-f0-9]{12}|[a-f0-9]{32})\.json", key):
            return _cors_response(400, {"error": "Missing or invalid s3_key"})
    except (ValueError, AttributeError):
        return _cors_response(400, {"error": "Invalid JSON body"})
    return _run_once(key[6:-5], "track", key + ".result.json", lambda _: _track_submit(event))


def handle_convert_to_mp4(event):
    if "trim" in FEATURES_DISABLED:
        return _cors_response(503, {"error": "Video processing is temporarily disabled"})
    try:
        job_id = _parse_body(event).get("job_id")
        if not isinstance(job_id, str) or not re.fullmatch(r"(?:[a-f0-9]{12}|[a-f0-9]{32})", job_id):
            return _cors_response(400, {"error": "Invalid job_id"})
    except (ValueError, AttributeError):
        return _cors_response(400, {"error": "Invalid JSON body"})
    return _run_once(job_id, "trim", f"convert/{job_id}/result.json",
                     lambda _: _convert_to_mp4(event), retry_event=event)

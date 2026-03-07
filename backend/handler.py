import json
import os
import uuid
import base64
from datetime import datetime, timezone

import boto3

ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]
TABLE_NAME = os.environ["TABLE_NAME"]
ASSETS_CDN_URL = os.environ.get("ASSETS_CDN_URL", "").rstrip("/")

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)


def handler(event, context):
    """Main Lambda handler — routes requests based on method and path."""
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")

    if method == "POST" and path == "/upload":
        return handle_upload(event)
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

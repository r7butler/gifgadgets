"""Shared fixtures for backend unit tests.

Mocks all AWS services and environment variables so tests run
without real credentials.
"""

import os
import json
import base64
import pytest

# Set environment variables BEFORE importing handler
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("ASSETS_BUCKET", "test-assets")
os.environ.setdefault("SITE_BUCKET", "test-site")
os.environ.setdefault("ASSETS_CDN_URL", "https://cdn.test.com")
os.environ.setdefault("SITE_CDN_URL", "https://site.test.com")
os.environ.setdefault("GITHUB_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123456789012:secret:test")
os.environ.setdefault("GITHUB_REPO", "testuser/testrepo")
os.environ.setdefault("JOBS_TABLE", "test-jobs")
os.environ.setdefault("FEATURES_DISABLED", "")
os.environ.setdefault("MODAL_API_KEY", "test-api-key-12345")
os.environ.setdefault("MODAL_TRACKER_URL", "https://tracker.test.com")
os.environ.setdefault("MODAL_CONVERTER_URL", "https://converter.test.com")


@pytest.fixture(autouse=True)
def mock_aws(monkeypatch):
    """Mock all AWS clients used in handler.py."""
    from unittest.mock import MagicMock

    mock_s3 = MagicMock()
    mock_secretsmanager = MagicMock()
    mock_dynamodb = MagicMock()
    mock_table = MagicMock()

    # Default: quota check returns count=0 (allowed)
    mock_table.query.return_value = {"Count": 0, "Items": []}
    mock_dynamodb.Table.return_value = mock_table

    # Default: presigned URL
    mock_s3.generate_presigned_url.return_value = "https://s3.test.com/presigned"

    # Default: secrets manager returns a token
    mock_secretsmanager.get_secret_value.return_value = {"SecretString": "ghp_testtoken"}

    import backend.handler as h
    monkeypatch.setattr(h, "s3", mock_s3)
    monkeypatch.setattr(h, "secretsmanager", mock_secretsmanager)
    monkeypatch.setattr(h, "dynamodb", mock_dynamodb)
    monkeypatch.setattr(h, "_jobs_table", mock_table)

    return {
        "s3": mock_s3,
        "secretsmanager": mock_secretsmanager,
        "dynamodb": mock_dynamodb,
        "table": mock_table,
    }


# --- Minimal valid GIF (1x1 pixel, 2 frames) ---
# GIF89a header + minimal image data
MINIMAL_GIF = (
    b"GIF89a"  # header
    b"\x01\x00\x01\x00"  # 1x1
    b"\x80\x00\x00"  # GCT flag
    b"\xff\xff\xff"  # white
    b"\x00\x00\x00"  # black
    b"\x21\xf9\x04\x00\x00\x00\x00\x00"  # GCE
    b"\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00"  # image descriptor
    b"\x02\x02\x44\x01\x00"  # LZW data
    b"\x3b"  # trailer
)


@pytest.fixture
def minimal_gif():
    return MINIMAL_GIF


@pytest.fixture
def minimal_gif_b64():
    return base64.b64encode(MINIMAL_GIF).decode()


def make_event(path, body=None, method="POST", headers=None, base64_encode=False):
    """Build a Lambda Function URL event dict."""
    event = {
        "requestContext": {
            "http": {
                "method": method,
                "sourceIp": "1.2.3.4",
            }
        },
        "rawPath": path,
        "headers": headers or {},
        "isBase64Encoded": base64_encode,
    }
    if body is not None:
        if base64_encode:
            event["body"] = base64.b64encode(json.dumps(body).encode()).decode()
        else:
            event["body"] = json.dumps(body)
    return event

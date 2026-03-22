"""Tests for API route handlers in handler.py."""

import json
import base64
from unittest.mock import patch, MagicMock
import urllib.error

import backend.handler as h
from conftest import make_event, MINIMAL_GIF


class TestRouter:
    def test_unknown_route_returns_404(self):
        event = make_event("/api/unknown")
        resp = h.handler(event, None)
        assert resp["statusCode"] == 404

    def test_options_returns_cors(self):
        event = make_event("/api/anything", method="OPTIONS")
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        assert resp["headers"]["Access-Control-Allow-Origin"] == "*"

    def test_strips_api_prefix(self):
        event = make_event("/api/upload", {"file": base64.b64encode(MINIMAL_GIF).decode()})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200


class TestUpload:
    def test_valid_gif(self, minimal_gif_b64, mock_aws):
        event = make_event("/api/upload", {"file": minimal_gif_b64})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "id" in body
        assert "gif_url" in body
        mock_aws["s3"].put_object.assert_called_once()

    def test_missing_file_field(self):
        event = make_event("/api/upload", {"other": "data"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "Missing" in json.loads(resp["body"])["error"]

    def test_invalid_base64(self):
        event = make_event("/api/upload", {"file": "not-valid-base64!!!"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_non_gif_bytes(self):
        png_bytes = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode()
        event = make_event("/api/upload", {"file": png_bytes})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "GIF" in json.loads(resp["body"])["error"]

    def test_oversized_gif(self, minimal_gif_b64):
        big_data = base64.b64encode(b"GIF" + b"\x00" * (16 * 1024 * 1024)).decode()
        event = make_event("/api/upload", {"file": big_data})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "too large" in json.loads(resp["body"])["error"]

    def test_invalid_json_body(self):
        event = make_event("/api/upload")
        event["body"] = "not json"
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_base64_encoded_event(self, minimal_gif_b64):
        event = make_event("/api/upload", {"file": minimal_gif_b64}, base64_encode=True)
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200


class TestShare:
    def test_valid_share(self, minimal_gif_b64, mock_aws):
        event = make_event("/api/share", {
            "file": minimal_gif_b64,
            "title": "My Cool GIF",
            "filename": "cool.gif",
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "slug" in body
        assert "share_url" in body
        assert "gif_url" in body
        # Should upload GIF and share page (2 put_object calls)
        assert mock_aws["s3"].put_object.call_count == 2

    def test_missing_title_defaults(self, minimal_gif_b64):
        event = make_event("/api/share", {
            "file": minimal_gif_b64,
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200

    def test_missing_file(self):
        event = make_event("/api/share", {"title": "test"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_oversized_gif(self):
        big_data = base64.b64encode(b"GIF" + b"\x00" * (16 * 1024 * 1024)).decode()
        event = make_event("/api/share", {"file": big_data, "title": "big"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400


class TestShareUpload:
    """Tests for POST /share/upload — raw binary GIF upload via headers."""

    def test_valid_upload(self, mock_aws):
        event = {
            "requestContext": {"http": {"method": "POST", "sourceIp": "1.2.3.4"}},
            "rawPath": "/api/share/upload",
            "headers": {"x-title": "My GIF", "x-filename": "cool.gif"},
            "isBase64Encoded": True,
            "body": base64.b64encode(MINIMAL_GIF).decode(),
        }
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "slug" in body
        assert "share_url" in body
        assert "gif_url" in body
        assert mock_aws["s3"].put_object.call_count == 2

    def test_missing_title_defaults(self, mock_aws):
        event = {
            "requestContext": {"http": {"method": "POST", "sourceIp": "1.2.3.4"}},
            "rawPath": "/api/share/upload",
            "headers": {},
            "isBase64Encoded": True,
            "body": base64.b64encode(MINIMAL_GIF).decode(),
        }
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200

    def test_non_gif_rejected(self):
        event = {
            "requestContext": {"http": {"method": "POST", "sourceIp": "1.2.3.4"}},
            "rawPath": "/api/share/upload",
            "headers": {},
            "isBase64Encoded": True,
            "body": base64.b64encode(b"\x89PNG\r\n\x1a\n").decode(),
        }
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "GIF" in json.loads(resp["body"])["error"]

    def test_oversized_rejected(self):
        big_gif = b"GIF" + b"\x00" * (16 * 1024 * 1024)
        event = {
            "requestContext": {"http": {"method": "POST", "sourceIp": "1.2.3.4"}},
            "rawPath": "/api/share/upload",
            "headers": {},
            "isBase64Encoded": True,
            "body": base64.b64encode(big_gif).decode(),
        }
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "too large" in json.loads(resp["body"])["error"]

    def test_non_base64_body(self, mock_aws):
        """When isBase64Encoded is False, body is treated as latin-1 string."""
        event = {
            "requestContext": {"http": {"method": "POST", "sourceIp": "1.2.3.4"}},
            "rawPath": "/api/share/upload",
            "headers": {"x-title": "Test"},
            "isBase64Encoded": False,
            "body": MINIMAL_GIF.decode("latin-1"),
        }
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200


class TestSharePresign:
    def test_returns_upload_url_and_slug(self, mock_aws):
        event = make_event("/api/share/presign", {
            "filename": "test.gif",
            "title": "Test",
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "upload_url" in body
        assert "slug" in body
        assert "title" in body

    def test_defaults_content_type(self, mock_aws):
        event = make_event("/api/share/presign", {"filename": "test.gif"})
        resp = h.handler(event, None)
        body = json.loads(resp["body"])
        assert body["content_type"] == "image/gif"


class TestShareFinalize:
    def test_valid_slug(self, mock_aws):
        event = make_event("/api/share/finalize", {
            "slug": "test-captioned-abc12345",
            "title": "Test",
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "share_url" in body
        mock_aws["s3"].put_object.assert_called_once()

    def test_missing_slug(self):
        event = make_event("/api/share/finalize", {"title": "Test"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "slug" in json.loads(resp["body"])["error"].lower()


class TestPresignUpload:
    def test_normal_response(self, mock_aws):
        event = make_event("/api/convert/presign-upload", {"content_type": "video/webm"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "upload_url" in body
        assert "job_id" in body

    def test_feature_disabled(self, monkeypatch):
        monkeypatch.setattr(h, "FEATURES_DISABLED", {"trim"})
        event = make_event("/api/convert/presign-upload", {"content_type": "video/webm"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 503

    def test_rate_limited(self, mock_aws):
        mock_aws["table"].query.return_value = {"Count": 20, "Items": []}
        event = make_event("/api/convert/presign-upload", {"content_type": "video/webm"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 429


class TestConvertToMp4:
    """Tests for POST /convert-to-mp4 — WebM to MP4 conversion via ffmpeg."""

    @patch("backend.handler.subprocess.run")
    def test_successful_conversion(self, mock_run, mock_aws):
        mock_run.return_value = MagicMock(returncode=0)
        event = make_event("/api/convert-to-mp4", {
            "job_id": "abcdef123456",
            "filename": "my-video.mp4",
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "download_url" in body
        mock_aws["s3"].download_file.assert_called_once()
        mock_aws["s3"].upload_file.assert_called_once()
        # Cleanup: input file deleted
        mock_aws["s3"].delete_object.assert_called_once()

    def test_invalid_job_id(self):
        event = make_event("/api/convert-to-mp4", {"job_id": "bad!"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "job_id" in json.loads(resp["body"])["error"]

    def test_missing_job_id(self):
        event = make_event("/api/convert-to-mp4", {"filename": "test.mp4"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_input_not_found(self, mock_aws):
        mock_aws["s3"].download_file.side_effect = Exception("NoSuchKey")
        event = make_event("/api/convert-to-mp4", {"job_id": "abcdef123456"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "not found" in json.loads(resp["body"])["error"]

    @patch("backend.handler.subprocess.run")
    def test_ffmpeg_failure(self, mock_run, mock_aws):
        mock_run.return_value = MagicMock(
            returncode=1,
            stderr=b"ffmpeg error: codec not found",
        )
        event = make_event("/api/convert-to-mp4", {"job_id": "abcdef123456"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 500
        assert "Conversion failed" in json.loads(resp["body"])["error"]

    @patch("backend.handler.subprocess.run")
    def test_default_filename(self, mock_run, mock_aws):
        """When filename is omitted, defaults to converted.mp4."""
        mock_run.return_value = MagicMock(returncode=0)
        event = make_event("/api/convert-to-mp4", {"job_id": "abcdef123456"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200

    @patch("backend.handler.subprocess.run")
    def test_cleanup_failure_ignored(self, mock_run, mock_aws):
        """delete_object failure during cleanup should not break the response."""
        mock_run.return_value = MagicMock(returncode=0)
        mock_aws["s3"].delete_object.side_effect = Exception("AccessDenied")
        event = make_event("/api/convert-to-mp4", {
            "job_id": "abcdef123456",
            "filename": "test.mp4",
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200


class TestReportIssue:
    @patch("backend.handler.urllib.request.urlopen")
    def test_valid_report(self, mock_urlopen, mock_aws):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"html_url": "https://github.com/issue/1"}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        event = make_event("/api/report-issue", {
            "title": "Bug report",
            "body": "Something is broken",
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        assert "url" in json.loads(resp["body"])

    def test_missing_title(self):
        event = make_event("/api/report-issue", {"body": "no title"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_rate_limited(self, mock_aws):
        mock_aws["table"].query.return_value = {"Count": 3, "Items": []}
        event = make_event("/api/report-issue", {"title": "Bug", "body": "text"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 429

    def test_secret_fetch_failure(self, mock_aws):
        mock_aws["secretsmanager"].get_secret_value.side_effect = Exception("AccessDenied")
        event = make_event("/api/report-issue", {"title": "Bug", "body": "details"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 500
        assert "credentials" in json.loads(resp["body"])["error"]

    @patch("backend.handler.urllib.request.urlopen")
    def test_github_api_error(self, mock_urlopen, mock_aws):
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url="https://api.github.com",
            code=422,
            msg="Validation Failed",
            hdrs={},
            fp=MagicMock(read=lambda: b"error"),
        )
        event = make_event("/api/report-issue", {"title": "Bug", "body": "details"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 500
        assert "create issue" in json.loads(resp["body"])["error"]


class TestTrackWarmup:
    def test_always_returns_200(self):
        event = make_event("/api/track/warmup", {})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        assert json.loads(resp["body"])["ok"] is True

    def test_returns_200_without_modal_url(self, monkeypatch):
        monkeypatch.setattr(h, "MODAL_TRACKER_URL", "")
        event = make_event("/api/track/warmup", {})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200


class TestTrackPresign:
    def test_feature_disabled(self, monkeypatch):
        monkeypatch.setattr(h, "FEATURES_DISABLED", {"track"})
        event = make_event("/api/track/presign", {})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 503

    def test_rate_limited(self, mock_aws):
        mock_aws["table"].query.return_value = {"Count": 20, "Items": []}
        event = make_event("/api/track/presign", {})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 429

    def test_success(self, mock_aws):
        mock_aws["s3"].generate_presigned_url.return_value = "https://s3.example.com/presigned"
        event = make_event("/api/track/presign", {})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "upload_url" in body
        assert body["s3_key"].startswith("track/")
        assert "job_id" in body


class TestTrackSubmit:
    def test_feature_disabled(self, monkeypatch):
        monkeypatch.setattr(h, "FEATURES_DISABLED", {"track"})
        event = make_event("/api/track/submit", {"s3_key": "track/abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 503

    def test_missing_s3_key(self):
        event = make_event("/api/track/submit", {"frames": ["f1"]})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "s3_key" in json.loads(resp["body"])["error"].lower()

    def test_invalid_s3_key(self):
        event = make_event("/api/track/submit", {"s3_key": "other/bad.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_tracker_not_configured(self, monkeypatch):
        monkeypatch.setattr(h, "MODAL_TRACKER_URL", "")
        event = make_event("/api/track/submit", {"s3_key": "track/abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 503
        assert "not configured" in json.loads(resp["body"])["error"]

    @patch("backend.handler.urllib.request.urlopen")
    def test_successful_proxy(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"motion": [{"frame": 0, "x": 0.5, "y": 0.5}]}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        event = make_event("/api/track/submit", {
            "s3_key": "track/abc123.json",
            "frame_indices": [0, 3, 6],
            "click_x": 0.5,
            "click_y": 0.5,
            "click_frame": 0,
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200
        body = json.loads(resp["body"])
        assert "motion" in body

    @patch("backend.handler.urllib.request.urlopen")
    def test_modal_http_error(self, mock_urlopen):
        error_body = MagicMock()
        error_body.read.return_value = b"internal error"
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url="https://tracker.test.com/track",
            code=500,
            msg="Internal Server Error",
            hdrs={},
            fp=error_body,
        )
        event = make_event("/api/track/submit", {"s3_key": "track/abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 502
        assert "failed" in json.loads(resp["body"])["error"].lower()

    @patch("backend.handler.urllib.request.urlopen")
    def test_modal_connection_error(self, mock_urlopen):
        mock_urlopen.side_effect = ConnectionError("Connection refused")
        event = make_event("/api/track/submit", {"s3_key": "track/abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 502
        assert "unavailable" in json.loads(resp["body"])["error"].lower()

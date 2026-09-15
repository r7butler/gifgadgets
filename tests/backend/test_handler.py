"""Tests for API route handlers in handler.py."""

import json
import base64
from botocore.exceptions import ClientError
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
    def test_unissued_slug_rejected(self, mock_aws):
        event = make_event("/api/share/finalize", {"slug": "test-captioned-" + "a" * 32})
        assert h.handler(event, None)["statusCode"] == 400
        mock_aws["s3"].put_object.assert_not_called()

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
        mock_aws["table"].update_item.side_effect = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
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
        mock_aws["table"].update_item.side_effect = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
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
        mock_aws["table"].update_item.side_effect = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
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
        assert body["s3_key"].endswith(".json")
        assert "job_id" in body

    def test_s3_key_matches_job_id(self, mock_aws):
        """The s3_key should contain the job_id so submit can extract it."""
        mock_aws["s3"].generate_presigned_url.return_value = "https://s3.example.com/presigned"
        event = make_event("/api/track/presign", {})
        resp = h.handler(event, None)
        body = json.loads(resp["body"])
        assert body["s3_key"] == f"track/{body['job_id']}.json"

    def test_presigned_url_uses_json_content_type(self, mock_aws):
        """Presigned URL should require application/json so only frame JSON can be uploaded."""
        event = make_event("/api/track/presign", {})
        h.handler(event, None)
        call_args = mock_aws["s3"].generate_presigned_url.call_args
        assert call_args[1]["Params"]["ContentType"] == "application/json"

    def test_records_job_in_dynamodb(self, mock_aws):
        """Quota tracking should happen at presign time, not submit time."""
        event = make_event("/api/track/presign", {})
        h.handler(event, None)
        mock_aws["table"].put_item.assert_called_once()
        item = mock_aws["table"].put_item.call_args[1]["Item"]
        assert item["job_type"] == "track"


class TestTrackSubmit:
    def test_feature_disabled(self, monkeypatch):
        monkeypatch.setattr(h, "FEATURES_DISABLED", {"track"})
        event = make_event("/api/track/submit", {"s3_key": "track/abc123abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 503

    def test_missing_s3_key(self):
        event = make_event("/api/track/submit", {"frames": ["f1"]})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400
        assert "s3_key" in json.loads(resp["body"])["error"].lower()

    def test_invalid_s3_key_wrong_prefix(self):
        event = make_event("/api/track/submit", {"s3_key": "other/bad.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_empty_s3_key(self):
        event = make_event("/api/track/submit", {"s3_key": ""})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 400

    def test_tracker_not_configured(self, monkeypatch):
        monkeypatch.setattr(h, "MODAL_TRACKER_URL", "")
        event = make_event("/api/track/submit", {"s3_key": "track/abc123abc123.json"})
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
            "s3_key": "track/abc123abc123.json",
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
    def test_forwards_s3_key_and_metadata_to_modal(self, mock_urlopen):
        """Submit should forward the s3_key and click metadata (not raw frames) to Modal."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"motion": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        event = make_event("/api/track/submit", {
            "s3_key": "track/abc123abc123.json",
            "frame_indices": [0, 5, 10],
            "click_x": 0.3,
            "click_y": 0.7,
            "click_frame": 5,
        })
        h.handler(event, None)

        # Inspect what was sent to Modal
        call_args = mock_urlopen.call_args
        req_obj = call_args[0][0]
        sent = json.loads(req_obj.data.decode("utf-8"))
        assert sent["frames_url"] == "https://s3.test.com/presigned"
        assert "s3_key" not in sent
        assert sent["frame_indices"] == [0, 5, 10]
        assert sent["click_x"] == 0.3
        assert sent["click_y"] == 0.7
        assert sent["click_frame"] == 5
        # No raw frames should be in the payload
        assert "frames" not in sent

    @patch("backend.handler.urllib.request.urlopen")
    def test_submit_payload_is_small(self, mock_urlopen):
        """The payload sent to Modal should be well under 6MB since frames are in S3."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"motion": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        event = make_event("/api/track/submit", {
            "s3_key": "track/abc123abc123.json",
            "frame_indices": list(range(200)),  # 200 frame indices
            "click_x": 0.5,
            "click_y": 0.5,
            "click_frame": 0,
        })
        h.handler(event, None)

        req_obj = mock_urlopen.call_args[0][0]
        payload_size = len(req_obj.data)
        # Even with 200 frame indices, the payload should be tiny (< 10KB)
        assert payload_size < 10_000

    @patch("backend.handler.urllib.request.urlopen")
    def test_no_quota_check_on_submit(self, mock_urlopen, mock_aws):
        """Submit should NOT check quota — that already happened at presign time."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"motion": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        # Set quota to exceeded — submit should still succeed
        mock_aws["table"].query.return_value = {"Count": 999, "Items": []}
        event = make_event("/api/track/submit", {
            "s3_key": "track/abc123abc123.json",
            "frame_indices": [0],
            "click_x": 0.5,
            "click_y": 0.5,
            "click_frame": 0,
        })
        resp = h.handler(event, None)
        assert resp["statusCode"] == 200

    @patch("backend.handler.urllib.request.urlopen")
    def test_sends_api_key_header_to_modal(self, mock_urlopen):
        """Lambda should authenticate to Modal with the X-Modal-Api-Key header."""
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"motion": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        event = make_event("/api/track/submit", {
            "s3_key": "track/abc123abc123.json",
            "frame_indices": [0],
            "click_x": 0.5,
            "click_y": 0.5,
            "click_frame": 0,
        })
        h.handler(event, None)

        req_obj = mock_urlopen.call_args[0][0]
        assert req_obj.get_header("X-modal-api-key") == "test-api-key-12345"

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
        event = make_event("/api/track/submit", {"s3_key": "track/abc123abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 502
        assert "failed" in json.loads(resp["body"])["error"].lower()

    @patch("backend.handler.urllib.request.urlopen")
    def test_modal_connection_error(self, mock_urlopen):
        mock_urlopen.side_effect = ConnectionError("Connection refused")
        event = make_event("/api/track/submit", {"s3_key": "track/abc123abc123.json"})
        resp = h.handler(event, None)
        assert resp["statusCode"] == 502
        assert "unavailable" in json.loads(resp["body"])["error"].lower()


class TestTrackPresignSubmitFlow:
    """End-to-end tests for the presign → S3 upload → submit flow."""

    @patch("backend.handler.urllib.request.urlopen")
    def test_presign_then_submit_round_trip(self, mock_urlopen, mock_aws):
        """Presign returns an s3_key that submit accepts and forwards to Modal."""
        mock_aws["s3"].generate_presigned_url.return_value = "https://s3.test.com/presigned"

        # Step 1: Presign
        presign_resp = h.handler(make_event("/api/track/presign", {}), None)
        assert presign_resp["statusCode"] == 200
        presign_body = json.loads(presign_resp["body"])
        s3_key = presign_body["s3_key"]

        # Step 2: Submit with the s3_key from presign
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "motion": [{"frame": 0, "x": 0.5, "y": 0.5}]
        }).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        submit_resp = h.handler(make_event("/api/track/submit", {
            "s3_key": s3_key,
            "frame_indices": [0, 3, 6],
            "click_x": 0.5,
            "click_y": 0.5,
            "click_frame": 0,
        }), None)
        assert submit_resp["statusCode"] == 200
        assert "motion" in json.loads(submit_resp["body"])

    @patch("backend.handler.urllib.request.urlopen")
    def test_presign_records_quota_submit_does_not(self, mock_urlopen, mock_aws):
        """Only presign should write to DynamoDB for quota; submit should not."""
        mock_aws["s3"].generate_presigned_url.return_value = "https://s3.test.com/presigned"

        # Presign
        h.handler(make_event("/api/track/presign", {}), None)
        presign_put_count = mock_aws["table"].put_item.call_count
        assert presign_put_count == 1

        # Submit
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"motion": []}).encode()
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_urlopen.return_value = mock_response

        h.handler(make_event("/api/track/submit", {
            "s3_key": "track/abc123abc123.json",
            "frame_indices": [0],
            "click_x": 0.5,
            "click_y": 0.5,
            "click_frame": 0,
        }), None)
        # put_item count should not have increased
        assert mock_aws["table"].put_item.call_count == presign_put_count

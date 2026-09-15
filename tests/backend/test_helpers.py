"""Tests for pure helper functions in handler.py."""

import json
import base64

import backend.handler as h


class TestSanitizeSlugBase:
    def test_simple_filename(self):
        assert h._sanitize_slug_base("my-cool-gif.gif") == "my-cool-gif"

    def test_spaces_become_hyphens(self):
        assert h._sanitize_slug_base("my cool gif.gif") == "my-cool-gif"

    def test_special_chars_removed(self):
        assert h._sanitize_slug_base("hello@world!.gif") == "helloworld"

    def test_multiple_extensions(self):
        assert h._sanitize_slug_base("test.png") == "test"
        assert h._sanitize_slug_base("test.jpg") == "test"
        assert h._sanitize_slug_base("test.jpeg") == "test"
        assert h._sanitize_slug_base("test.mp4") == "test"
        assert h._sanitize_slug_base("test.webm") == "test"
        assert h._sanitize_slug_base("test.webp") == "test"

    def test_uppercase_normalized(self):
        assert h._sanitize_slug_base("MY_GIF.GIF") == "my-gif"

    def test_truncated_to_60_chars(self):
        long_name = "a" * 100 + ".gif"
        result = h._sanitize_slug_base(long_name)
        assert len(result) <= 60

    def test_empty_or_none_returns_gif(self):
        assert h._sanitize_slug_base("") == "gif"
        assert h._sanitize_slug_base(None) == "gif"
        assert h._sanitize_slug_base(".gif") == "gif"

    def test_consecutive_hyphens_collapsed(self):
        assert h._sanitize_slug_base("a---b---c.gif") == "a-b-c"

    def test_underscores_become_hyphens(self):
        assert h._sanitize_slug_base("my_cool_gif.gif") == "my-cool-gif"


class TestBuildSharePage:
    def test_contains_og_tags(self):
        html = h._build_share_page("Test Title", "https://cdn.com/gif.gif", "test-slug")
        assert '<meta property="og:title" content="Test Title">' in html
        assert '<meta property="og:image" content="https://cdn.com/gif.gif">' in html
        assert "test-slug" in html

    def test_html_escapes_title(self):
        html = h._build_share_page('Title with "quotes" & <tags>', "https://cdn.com/gif.gif", "slug")
        assert "&amp;" in html
        assert "&lt;" in html
        assert "&quot;" in html

    def test_video_content_type(self):
        html = h._build_share_page("Video", "https://cdn.com/vid.mp4", "slug", "video/mp4")
        assert '<meta property="og:type" content="video.other">' in html
        assert "<video" in html
        assert "og:video" in html

    def test_image_content_type(self):
        html = h._build_share_page("Image", "https://cdn.com/img.gif", "slug", "image/gif")
        assert '<meta property="og:type" content="website">' in html
        assert "<img" in html

    def test_contains_site_links(self):
        html = h._build_share_page("Test", "https://cdn.com/gif.gif", "slug")
        assert "GifWidgets" in html
        assert "Make Your Own" in html


class TestCorsResponse:
    def test_structure(self):
        resp = h._cors_response(200, {"ok": True})
        assert resp["statusCode"] == 200
        assert resp["headers"]["Content-Type"] == "application/json"
        assert resp["headers"]["Access-Control-Allow-Origin"] == "*"
        assert json.loads(resp["body"]) == {"ok": True}

    def test_error_status(self):
        resp = h._cors_response(400, {"error": "bad"})
        assert resp["statusCode"] == 400
        assert json.loads(resp["body"])["error"] == "bad"


class TestParseBody:
    def test_plain_json(self):
        event = {"body": '{"key": "value"}', "isBase64Encoded": False}
        assert h._parse_body(event) == {"key": "value"}

    def test_base64_encoded(self):
        raw = json.dumps({"key": "value"})
        event = {"body": base64.b64encode(raw.encode()).decode(), "isBase64Encoded": True}
        assert h._parse_body(event) == {"key": "value"}

    def test_invalid_json_raises(self):
        import pytest
        with pytest.raises(json.JSONDecodeError):
            h._parse_body({"body": "not json", "isBase64Encoded": False})


class TestGetClientIp:
    def test_xff_header(self):
        event = {"headers": {"x-forwarded-for": "5.6.7.8, 10.0.0.1"}}
        assert h._get_client_ip(event) == "10.0.0.1"

    def test_source_ip_fallback(self):
        event = {"headers": {}, "requestContext": {"http": {"sourceIp": "9.9.9.9"}}}
        assert h._get_client_ip(event) == "9.9.9.9"

    def test_no_headers_returns_unknown(self):
        event = {"headers": {}, "requestContext": {"http": {}}}
        assert h._get_client_ip(event) == "unknown"

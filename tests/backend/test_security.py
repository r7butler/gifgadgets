"""Exercise security boundaries against emulated S3 and DynamoDB, not mocks."""
import json
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws as moto_aws

import backend.handler as h
from conftest import make_event, MINIMAL_GIF


@pytest.fixture
def storage(monkeypatch, mock_aws):
    with moto_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        for bucket in (h.ASSETS_BUCKET, h.SITE_BUCKET):
            s3.create_bucket(Bucket=bucket)
        table = boto3.resource("dynamodb", region_name="us-east-1").create_table(
            TableName="security-jobs", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "job_id", "AttributeType": "S"}],
        )
        monkeypatch.setattr(h, "s3", s3)
        monkeypatch.setattr(h, "_jobs_table", table)
        # Emulate DynamoDB's atomic conditional UpdateItem operation. Moto's
        # in-process read/modify/write can interleave across Python test threads.
        update = table.update_item
        lock = threading.Lock()
        def atomic_update(**kwargs):
            with lock:
                return update(**kwargs)
        monkeypatch.setattr(table, "update_item", atomic_update)
        yield s3, table


def grant(storage, data=MINIMAL_GIF, content_type="image/gif"):
    result = h.handle_share_presign(make_event("/share/presign", {
        "title": '你好 🐱 " <script>alert(1)</script>', "filename": "猫.gif",
        "content_type": content_type,
    }))
    body = json.loads(result["body"])
    item = storage[1].get_item(Key={"job_id": "share:" + body["slug"]})["Item"]
    storage[0].put_object(Bucket=h.ASSETS_BUCKET, Key=item["input_key"], Body=data)
    return body, item


def finalize(body):
    return h.handle_share_finalize(make_event("/share/finalize", body))


def test_share_legacy_client_contract_and_immutable_retries(storage):
    body, item = grant(storage)
    # Existing web and iOS clients send slug/title/content_type, without a new token.
    first = finalize(body)
    assert first["statusCode"] == 200
    result = json.loads(first["body"])
    key = result["gif_url"].split("/share/")[1]
    page = storage[0].get_object(Bucket=h.SITE_BUCKET, Key=f'g/{body["slug"]}.html')["Body"].read().decode()
    assert "<script>alert" not in page
    assert "你好 🐱" in page
    # A reused presigned PUT and altered finalization metadata cannot replace a share.
    storage[0].put_object(Bucket=h.ASSETS_BUCKET, Key=item["input_key"], Body=b"replacement")
    assert finalize({**body, "title": "tampered", "content_type": "text/html"}) == first
    assert storage[0].get_object(Bucket=h.ASSETS_BUCKET, Key="share/" + key)["Body"].read() == MINIMAL_GIF


def test_reject_unissued_and_expired_publication(storage):
    assert finalize({"slug": "test-captioned-" + "f" * 32})["statusCode"] == 400
    body, item = grant(storage)
    item["ttl"] = 1
    storage[1].put_item(Item=item)
    assert finalize(body)["statusCode"] == 400


def test_html_rejected_and_bad_upload_can_be_corrected(storage):
    assert h.handle_share_presign(make_event("/share/presign", {"content_type": "text/html"}))["statusCode"] == 400
    body, item = grant(storage, b"<html><script>alert(1)</script>")
    assert finalize(body)["statusCode"] == 400
    storage[0].put_object(Bucket=h.ASSETS_BUCKET, Key=item["input_key"], Body=MINIMAL_GIF)
    assert finalize(body)["statusCode"] == 200


def test_large_share_remains_supported(storage):
    body, _ = grant(storage, MINIMAL_GIF + bytes(39 * 1024 * 1024))
    assert finalize(body)["statusCode"] == 200


@pytest.mark.parametrize("content_type,data", [
    ("image/png", b"\x89PNG\r\n\x1a\n" + bytes(32)),
    ("image/jpeg", b"\xff\xd8\xff" + bytes(32)),
    ("image/webp", b"RIFF0000WEBP" + bytes(32)),
    ("video/webm", b"\x1aE\xdf\xa3" + bytes(32)),
    ("video/mp4", b"0000ftyp" + bytes(32)),
])
def test_existing_media_types(storage, content_type, data):
    body, _ = grant(storage, data, content_type)
    assert finalize(body)["statusCode"] == 200


def test_partial_publication_failure_does_not_replace_copied_media(storage, monkeypatch):
    body, item = grant(storage)
    original = storage[0].put_object
    def fail_page(**kwargs):
        if kwargs["Bucket"] == h.SITE_BUCKET:
            raise RuntimeError("temporary site write failure")
        return original(**kwargs)
    monkeypatch.setattr(storage[0], "put_object", fail_page)
    assert finalize(body)["statusCode"] == 502
    monkeypatch.setattr(storage[0], "put_object", original)
    original(Bucket=h.ASSETS_BUCKET, Key=item["input_key"], Body=b"changed after copy")
    assert finalize(body)["statusCode"] == 200
    key = f'share/{body["slug"]}.gif'
    assert storage[0].get_object(Bucket=h.ASSETS_BUCKET, Key=key)["Body"].read() == MINIMAL_GIF


def test_copy_is_conditional_on_inspected_content(storage, monkeypatch):
    body, _ = grant(storage)
    copy = Mock(side_effect=ClientError({"Error": {"Code": "PreconditionFailed"}}, "CopyObject"))
    monkeypatch.setattr(storage[0], "copy_object", copy)
    assert finalize(body)["statusCode"] == 502
    assert copy.call_args.kwargs["CopySourceIfMatch"]
    assert not storage[0].list_objects_v2(Bucket=h.SITE_BUCKET).get("Contents")


def test_share_recovers_when_result_cache_write_fails(storage, monkeypatch):
    body, _ = grant(storage)
    original = storage[0].put_object
    def fail_cache(**kwargs):
        if kwargs["Key"].endswith(".result.json"):
            raise RuntimeError("temporary cache failure")
        return original(**kwargs)
    monkeypatch.setattr(storage[0], "put_object", fail_cache)
    first = finalize(body)
    assert first["statusCode"] == 200
    monkeypatch.setattr(storage[0], "put_object", original)
    assert finalize(body) == first


def test_concurrent_compute_runs_once_and_retries_return_result(storage):
    h._record_job("a" * 12, "track", "")
    def work(_):
        time.sleep(0.05)
        return h._cors_response(200, {"motion": [{"x": 0.5}]})
    callback = Mock(side_effect=work)
    def run(_):
        return h._run_once("a" * 12, "track", "track/result.json", callback)
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(run, range(3)))
    assert all(result == results[0] for result in results)
    assert results[0]["statusCode"] == 200
    callback.assert_called_once()


def test_compute_requires_issued_correct_type_unexpired_job(storage):
    work = Mock()
    for item in ({}, {"job_type": "trim", "ttl": int(time.time()) + 60}, {"job_type": "track", "ttl": 1}):
        storage[1].put_item(Item={"job_id": "bad", **item})
        assert h._run_once("bad", "track", "track/result.json", work)["statusCode"] == 400
    work.assert_not_called()


def test_conversion_can_retry_known_failure_without_uploading_again(storage):
    h._record_job("a" * 12, "trim", "")
    work = Mock(side_effect=[h._cors_response(400, {"error": "Input not found"}),
                             h._cors_response(200, {"download_url": "saved-result"})])
    def run():
        return h._run_once("a" * 12, "trim", "convert/result.json", work,
                           retry_event=make_event("/convert-to-mp4", {}))
    assert run()["statusCode"] == 400
    assert run()["statusCode"] == 200
    assert run()["statusCode"] == 200
    assert work.call_count == 2


def test_quota_atomic_and_reports_separate(storage):
    event = make_event("/track/presign", {})
    with ThreadPoolExecutor(max_workers=8) as pool:
        allowed = list(pool.map(lambda _: h._check_quota(event, limit=3)[0], range(12)))
    assert sum(allowed) == 3
    assert h._check_quota(event, limit=3, operation="report")[0]


def test_kill_switches_and_warmup_coalescing(storage, monkeypatch):
    remote = Mock()
    monkeypatch.setattr(h.urllib.request, "urlopen", remote)
    event = make_event("/track/warmup", {})
    assert h.handle_track_warmup(event)["statusCode"] == 200
    assert h.handle_track_warmup(event)["statusCode"] == 200
    remote.assert_called_once()
    monkeypatch.setattr(h, "FEATURES_DISABLED", {"track", "trim"})
    assert h.handle_track_warmup(event)["statusCode"] == 200
    assert h.handle_convert_to_mp4(make_event("/convert-to-mp4", {}))["statusCode"] == 503
    remote.assert_called_once()

"""Run the actual FastAPI routes with Modal/GPU dependencies stubbed out."""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def apps(monkeypatch):
    identity = lambda **kwargs: lambda obj: obj
    monkeypatch.setitem(sys.modules, "modal", SimpleNamespace(
        App=lambda *args: SimpleNamespace(cls=identity, function=identity),
        Image=MagicMock(), Secret=MagicMock(), asgi_app=identity, enter=identity,
    ))
    for name in ("torch", "numpy", "PIL"):
        monkeypatch.setitem(sys.modules, name, MagicMock())
    build = Mock()
    monkeypatch.setitem(sys.modules, "sam2.build_sam", SimpleNamespace(build_sam2_video_predictor=build))
    # Background removal uses Meta SAM 3.1; motion tracking still runs SAM 2.
    segment_build = SimpleNamespace(build_sam3_multiplex_video_predictor=Mock())
    monkeypatch.setitem(sys.modules, "sam3.model_builder", segment_build)
    modules = {}
    for name in ("tracker", "converter"):
        path = Path(__file__).parents[2] / "backend" / name / "modal_app.py"
        spec = importlib.util.spec_from_file_location(f"test_{name}_app", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules[name] = module
    return modules, build, segment_build


@pytest.mark.parametrize("secret", ["", "   "])
def test_missing_secret_refuses_startup(apps, monkeypatch, secret):
    monkeypatch.setenv("MODAL_API_KEY", secret)
    with pytest.raises(RuntimeError, match="MODAL_API_KEY"):
        apps[0]["tracker"].fastapi_app()
    with pytest.raises(RuntimeError, match="MODAL_API_KEY"):
        apps[0]["converter"].Converter().web()


def test_tracker_rejects_unauthorized_before_model_load(apps):
    client = TestClient(apps[0]["tracker"].fastapi_app())
    for headers in ({}, {"X-Modal-Api-Key": "wrong"}):
        assert client.post("/track", json={"warmup": True}, headers=headers).status_code == 401
    apps[1].assert_not_called()
    response = client.post("/track", json={"warmup": True}, headers={"X-Modal-Api-Key": "test-api-key-12345"})
    assert response.status_code == 200
    apps[1].assert_called_once()


def test_converter_authenticates_every_route_and_keeps_warmup_working(apps):
    client = TestClient(apps[0]["converter"].Converter().web())
    for route in ("/convert", "/trim", "/warmup"):
        for headers in ({}, {"X-Modal-Api-Key": "wrong"}):
            response = client.post(route, json={"input_url": "unused", "output_url": "unused"}, headers=headers)
            assert response.status_code == 401
    assert client.post("/warmup", headers={"X-Modal-Api-Key": "test-api-key-12345"}).status_code == 200


def test_segmentation_broker_authenticates_all_routes(apps):
    client = TestClient(apps[0]['tracker'].segment_api())
    for route, payload in [('/segment', {'input_url':'unused','output_url':'unused','objects':[],'job_id':'test'}),
                           ('/status', {'call_id':'fc-test'}), ('/cancel', {'call_id':'fc-test'})]:
        for headers in ({}, {'X-Modal-Api-Key':'wrong'}):
            assert client.post(route, json=payload, headers=headers).status_code == 401


def test_segmentation_logs_failed_runtime_without_request_urls(apps, capsys, monkeypatch):
    import json
    sys.modules['torch'].cuda.max_memory_allocated.return_value = 2 * 1024**2
    sys.modules['torch'].cuda.max_memory_reserved.return_value = 3 * 1024**2
    monkeypatch.setitem(sys.modules, 'segmentation',
                        SimpleNamespace(segment_file=Mock(), TrackerSegmenter=Mock(),
                                        ConceptSegmenter=Mock(), SelectionError=ValueError))
    apps[2].build_sam3_multiplex_video_predictor.side_effect = RuntimeError('model loading failed')
    with pytest.raises(RuntimeError, match='model loading'):
        apps[0]['tracker'].segment_media('https://private-source', 'https://private-output', [], 'test-job')
    lines = capsys.readouterr().out.splitlines()
    failed = json.loads(lines[-1])
    assert failed['event'] == 'segmentation_failed'
    assert failed['job_id'] == 'test-job'
    assert failed['total_seconds'] >= 0
    assert failed['error_type'] == 'RuntimeError'
    assert failed['peak_gpu_allocated_mb'] == 2
    assert failed['peak_gpu_reserved_mb'] == 3
    assert 'private-source' not in ''.join(lines)
    assert failed['message'] is None


def test_segmentation_returns_selection_errors_for_the_user(apps, capsys, monkeypatch):
    import json

    class SelectionError(ValueError):
        pass
    message = 'Nothing matched that selection.'
    sys.modules['torch'].cuda.max_memory_allocated.return_value = 0
    sys.modules['torch'].cuda.max_memory_reserved.return_value = 0
    monkeypatch.setitem(sys.modules, 'segmentation',
                        SimpleNamespace(segment_file=Mock(side_effect=SelectionError(message)),
                                        TrackerSegmenter=Mock(), ConceptSegmenter=Mock(),
                                        SelectionError=SelectionError))
    import urllib.request
    monkeypatch.setattr(urllib.request, 'urlopen', MagicMock(**{
        'return_value.__enter__.return_value.read.side_effect': [b'gif', b'']}))
    tracker = apps[0]['tracker']
    monkeypatch.setattr(tracker, '_segment_model', Mock())
    result = tracker.segment_media('https://private-source', 'https://private-output', [],
                                   'test-job', 'secret prompt')
    assert result == {'error': message}
    out = capsys.readouterr().out
    assert json.loads(out.splitlines()[-1])['message'] == message
    assert 'secret prompt' not in out and 'private-source' not in out


@pytest.mark.parametrize('result, expected', [
    ({'error': 'Nothing matched that selection.'},
     {'state': 'failed', 'error': 'Nothing matched that selection.'}),
    ({'frames': 2}, {'state': 'complete', 'stats': {'frames': 2}}),
])
def test_segmentation_status_relays_user_errors(apps, monkeypatch, result, expected):
    from unittest.mock import AsyncMock
    tracker = apps[0]['tracker']
    call = SimpleNamespace(get=SimpleNamespace(aio=AsyncMock(return_value=result)))
    monkeypatch.setattr(tracker.modal, 'FunctionCall',
                        SimpleNamespace(from_id=lambda call_id: call), raising=False)
    client = TestClient(tracker.segment_api())
    response = client.post('/status', json={'call_id': 'fc-test'},
                           headers={'X-Modal-Api-Key': 'test-api-key-12345'})
    assert response.json() == expected

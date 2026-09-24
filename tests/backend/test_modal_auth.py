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
        Image=MagicMock(), Secret=MagicMock(), Dict=MagicMock(), asgi_app=identity, enter=identity,
        current_function_call_id=lambda: "fc-test",
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


class _Progress(dict):
    """The slice of modal.Dict that /status reads, backed by a plain dict."""
    def __init__(self, *args, fail=False):
        super().__init__(*args)
        self.get = SimpleNamespace(aio=self._get)
        self.fail = fail

    async def _get(self, key):
        if self.fail:
            raise ConnectionError('Dict unavailable')
        return dict.get(self, key)


@pytest.mark.parametrize('progress, expected', [
    (_Progress(), {'state': 'running', 'phase': 'starting'}),
    (_Progress({'fc-test': {'frame': 0, 'frames': None}}),
     {'state': 'running', 'phase': 'processing', 'frame': 0, 'frames': None}),
    (_Progress({'fc-test': {'frame': 12, 'frames': 40}}),
     {'state': 'running', 'phase': 'processing', 'frame': 12, 'frames': 40}),
    # Progress is cosmetic; an unreadable store still reports a live job.
    (_Progress(fail=True), {'state': 'running'}),
])
def test_segmentation_status_reports_cold_start_and_frame_progress(apps, monkeypatch, progress, expected):
    from unittest.mock import AsyncMock
    tracker = apps[0]['tracker']
    call = SimpleNamespace(get=SimpleNamespace(aio=AsyncMock(side_effect=TimeoutError)))
    monkeypatch.setattr(tracker.modal, 'FunctionCall',
                        SimpleNamespace(from_id=lambda call_id: call), raising=False)
    monkeypatch.setattr(tracker, 'segment_progress', progress)
    client = TestClient(tracker.segment_api())
    response = client.post('/status', json={'call_id': 'fc-test'},
                           headers={'X-Modal-Api-Key': 'test-api-key-12345'})
    assert response.json() == expected


def test_progress_writes_are_throttled_and_never_fail_the_job(apps, monkeypatch):
    tracker = apps[0]['tracker']
    clock = iter([0.0, 0.1, 0.5, 2.5, 2.6, 5.0])
    monkeypatch.setattr(tracker, 'time', SimpleNamespace(monotonic=lambda: next(clock)))
    writes = []
    store = MagicMock()
    store.__setitem__.side_effect = lambda key, value: writes.append((key, value))
    monkeypatch.setattr(tracker, 'segment_progress', store)
    report = tracker._progress_reporter('fc-test')
    # Setup milestones (frame 0) always publish; frames publish at most every 2 s.
    for done, total in [(0, None), (0, 3), (1, 3), (2, 3), (3, 3)]:
        report(done, total)
    assert [value for _, value in writes] == [
        {'frame': 0, 'frames': None}, {'frame': 0, 'frames': 3}, {'frame': 2, 'frames': 3}]
    assert {key for key, _ in writes} == {'fc-test'}
    store.__setitem__.side_effect = ConnectionError('Dict unavailable')
    report(0, 3)

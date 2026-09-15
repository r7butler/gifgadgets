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
    modules = {}
    for name in ("tracker", "converter"):
        path = Path(__file__).parents[2] / "backend" / name / "modal_app.py"
        spec = importlib.util.spec_from_file_location(f"test_{name}_app", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        modules[name] = module
    return modules, build


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

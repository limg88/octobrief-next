from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer

import pytest
from conftest import body, envelope

from renderer import isolation, service
from renderer.server import Handler


@pytest.fixture
def server():
    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def call(
    url: str, data: bytes | None = None, method: str = "POST", content_type="application/json"
):
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_renders_through_post_render(server, status):
    code, payload = call(f"{server}/render", body(envelope(status, "docx")))
    assert code == 200
    assert payload["outcome"] == "rendered"


def test_has_no_other_method_or_path(server, status):
    assert call(f"{server}/render", method="GET")[0] == 405
    assert call(f"{server}/other", body(envelope(status, "docx")))[0] == 404
    assert call(f"{server}/render", b"{}", content_type="text/plain")[0] == 415


def test_answers_a_refusal_with_its_outcomes(server):
    code, payload = call(f"{server}/render", b"{}")
    assert code == 400
    assert payload["checks"][0]["findings"] == ["request_invalid"]


def test_stops_a_request_that_takes_too_long(monkeypatch):
    monkeypatch.setattr(service, "handle", lambda b: time.sleep(30))
    started = time.monotonic()
    code, payload = isolation.handle_isolated(b"{}", timeout=1)
    assert time.monotonic() - started < 10
    assert code == 422
    assert payload["checks"][0]["findings"] == ["render_timeout"]


def test_a_request_over_the_memory_cap_fails_alone(monkeypatch):
    monkeypatch.setattr(service, "handle", lambda b: bytearray(512 * 1024 * 1024))
    code, payload = isolation.handle_isolated(b"{}", memory=256 * 1024 * 1024)
    assert code == 422
    assert payload["checks"][0]["findings"] == ["render_failed"]


def test_answers_in_a_child_process_as_the_service_does(status):
    code, payload = isolation.handle_isolated(body(envelope(status, "pptx")))
    assert code == 200
    assert payload["outcome"] == "rendered"

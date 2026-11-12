"""The HTTP server of the renderer: one method, `POST /render`, one request at a time. It has no
network out, no database, no secret and no volume: it reads only the request."""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from .isolation import handle_isolated
from .limits import MAX_REQUEST_BYTES

PORT = 8080


class Handler(BaseHTTPRequestHandler):
    server_version = "octobrief-renderer"
    sys_version = ""
    # A client that stops sending does not hold the only worker for long.
    timeout = 30

    def _answer(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _not_allowed(self) -> None:
        self._answer(405 if self.path == "/render" else 404, {"outcome": "refused", "checks": []})

    do_GET = do_PUT = do_DELETE = do_PATCH = do_HEAD = _not_allowed  # noqa: N815 (http.server API)

    def do_POST(self) -> None:
        if self.path != "/render":
            self._not_allowed()
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._answer(415, {"outcome": "refused", "checks": []})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = -1
        if length < 0:
            self._answer(411, {"outcome": "refused", "checks": []})
            return
        if length > MAX_REQUEST_BYTES:
            self._answer(413, handle_too_large())
            return
        body = self.rfile.read(length)
        status, payload = handle_isolated(body)
        self._answer(status, payload)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 (http.server API)
        # Only the request line and the status: never a body, never a document.
        sys.stderr.write(f"{self.log_date_time_string()} {format % args}\n")


def handle_too_large() -> dict:
    return {
        "outcome": "refused",
        "checks": [
            {
                "subject": "request",
                "check": "request",
                "passed": False,
                "findings": ["request_too_large"],
            }
        ],
    }


def main() -> None:
    server = HTTPServer(("0.0.0.0", PORT), Handler)  # noqa: S104 (inside its own network)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

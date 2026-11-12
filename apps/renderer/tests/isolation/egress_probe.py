"""Run inside the renderer container of the compose stack by `scripts/renderer.sh isolation`
(read from stdin): it must reach no network outside, run as a user that is not root on a
read-only filesystem, and still answer on its own port. Prints what it found; exits 1 on any
breach."""

import json
import os
import socket
import sys
import urllib.error
import urllib.request

found = {}

try:
    socket.getaddrinfo("example.com", 443)
    found["resolves_outside_names"] = True
except OSError:
    found["resolves_outside_names"] = False

# Names of the host and of the other services: none may resolve from the internal network.
# `postgres` is not started by the check (its project runs only the renderer and its gateway), so
# that name not resolving proves nothing about the network; it guards only against the renderer
# being put on the default network of a stack where the database runs. The addresses below are the
# real test of the way out.
resolved = []
for name in ("host.docker.internal", "gateway.docker.internal", "postgres"):
    try:
        socket.getaddrinfo(name, 80)
        resolved.append(name)
    except OSError:
        pass
found["resolves_host_or_services"] = resolved

reached = []
# Outside addresses, the default bridge gateway (the host on Linux) and the address Docker
# Desktop gives the host, on the ports of the web and of the development database.
for host, port in (
    ("1.1.1.1", 443),
    ("8.8.8.8", 53),
    ("9.9.9.9", 443),
    ("172.17.0.1", 80),
    ("172.17.0.1", 5440),
    ("192.168.65.254", 80),
    ("192.168.65.254", 5440),
):
    try:
        socket.create_connection((host, port), timeout=3).close()
        reached.append(f"{host}:{port}")
    except OSError:
        pass
found["reached_outside_addresses"] = reached

found["uid"] = os.getuid()
try:
    with open("/app/written-by-probe", "w") as f:
        f.write("x")
    found["root_filesystem_writable"] = True
except OSError:
    found["root_filesystem_writable"] = False

request = urllib.request.Request(
    "http://127.0.0.1:8080/render",
    data=b"{}",
    method="POST",
    headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(request, timeout=30)
    found["answers_locally"] = "unexpected success"
except urllib.error.HTTPError as error:
    found["answers_locally"] = error.code == 400
except OSError as error:
    found["answers_locally"] = str(error)

print(json.dumps(found))
ok = (
    not found["resolves_outside_names"]
    and not resolved
    and not reached
    and found["uid"] != 0
    and not found["root_filesystem_writable"]
    and found["answers_locally"] is True
)
sys.exit(0 if ok else 1)

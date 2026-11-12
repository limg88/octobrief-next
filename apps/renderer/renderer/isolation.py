"""Each request is handled in a child process of its own, with caps on its address space and CPU
time and a wall-clock limit: a hostile template costs at most one request, never the service."""

from __future__ import annotations

import multiprocessing
import resource

from . import service
from .limits import RENDER_CPU_SECONDS, RENDER_MEMORY_BYTES, RENDER_TIMEOUT_SECONDS

_CONTEXT = multiprocessing.get_context("fork")


def _child(body: bytes, connection, memory: int, cpu: int) -> None:
    try:
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        connection.send(service.handle(body))
    except MemoryError:
        connection.send(service._refused([service._outcome("file", "render", ["render_failed"])]))
    finally:
        connection.close()


def _timeout() -> tuple[int, dict]:
    return service._refused([service._outcome("file", "render", ["render_timeout"])])


def handle_isolated(
    body: bytes,
    timeout: float = RENDER_TIMEOUT_SECONDS,
    memory: int = RENDER_MEMORY_BYTES,
    cpu: int = RENDER_CPU_SECONDS,
) -> tuple[int, dict]:
    receiver, sender = _CONTEXT.Pipe(duplex=False)
    child = _CONTEXT.Process(target=_child, args=(body, sender, memory, cpu), daemon=True)
    child.start()
    sender.close()
    try:
        if receiver.poll(timeout):
            try:
                return receiver.recv()
            except EOFError:
                # The child died without answering: over a cap, or killed by the kernel.
                return service._refused([service._outcome("file", "render", ["render_failed"])])
        return _timeout()
    finally:
        receiver.close()
        if child.is_alive():
            child.kill()
        child.join(5)

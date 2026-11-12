"""The entrance of the renderer for a worker outside the compose network (development): it accepts
connections on its port and forwards each one to the renderer, nothing else. The renderer stays on
its internal network without a way out; only this gateway is also on a network the host reaches,
and it only ever connects to the renderer. The upstream is infrastructure (`RENDERER_UPSTREAM`,
`host:port`), never a secret."""

from __future__ import annotations

import asyncio
import os

PORT = 8080
CHUNK = 64 * 1024
IDLE_SECONDS = 120
# The renderer serves one request at a time: a few waiting connections are enough, and the
# gateway never holds more (it is for development only).
MAX_CONNECTIONS = 8


def upstream() -> tuple[str, int]:
    host, _, port = os.environ.get("RENDERER_UPSTREAM", "renderer:8080").rpartition(":")
    return host, int(port)


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """One direction: at its end only this direction is closed, so the answer still comes back."""
    try:
        while data := await asyncio.wait_for(reader.read(CHUNK), IDLE_SECONDS):
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except (TimeoutError, ConnectionError, OSError):
        writer.close()


def forwarder(host: str, port: int, limit: int = MAX_CONNECTIONS):
    """The handler of a connection: forwarded to the upstream, or closed at once over `limit`."""
    open_connections = 0

    async def forward(client_reader, client_writer) -> None:
        nonlocal open_connections
        if open_connections >= limit:
            client_writer.close()
            return
        open_connections += 1
        try:
            try:
                up_reader, up_writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port), 10
                )
            except (OSError, TimeoutError):
                client_writer.close()
                return
            try:
                await asyncio.gather(
                    _pipe(client_reader, up_writer), _pipe(up_reader, client_writer)
                )
            finally:
                up_writer.close()
                client_writer.close()
        finally:
            open_connections -= 1

    return forward


async def serve() -> None:
    host, port = upstream()
    server = await asyncio.start_server(forwarder(host, port), "0.0.0.0", PORT)  # noqa: S104
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(serve())

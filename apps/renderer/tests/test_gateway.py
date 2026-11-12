from __future__ import annotations

import asyncio

from renderer.gateway import forwarder


async def _echo(reader, writer) -> None:
    writer.write(b"renderer:" + await reader.read(100))
    await writer.drain()
    writer.close()


async def _scenario() -> tuple[bytes, list[bytes]]:
    upstream = await asyncio.start_server(_echo, "127.0.0.1", 0)
    up_port = upstream.sockets[0].getsockname()[1]
    gateway = await asyncio.start_server(forwarder("127.0.0.1", up_port, limit=2), "127.0.0.1", 0)
    port = gateway.sockets[0].getsockname()[1]

    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(b"ping")
    writer.write_eof()
    forwarded = await reader.read()
    writer.close()

    # Two connections held open, a third one is closed without reaching the renderer.
    held = [await asyncio.open_connection("127.0.0.1", port) for _ in range(2)]
    await asyncio.sleep(0.2)
    extra_reader, extra_writer = await asyncio.open_connection("127.0.0.1", port)
    extra = await asyncio.wait_for(extra_reader.read(), 5)
    extra_writer.close()
    for _, w in held:
        w.close()
    gateway.close()
    upstream.close()
    return forwarded, [extra]


def test_forwards_to_the_renderer_and_refuses_connections_over_the_cap():
    forwarded, [extra] = asyncio.run(_scenario())
    assert forwarded == b"renderer:ping"
    assert extra == b""

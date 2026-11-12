import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ReceivedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
}

export type FakeRoute = (req: IncomingMessage, res: ServerResponse) => void

/** A loopback HTTP server for tests: it records every request it receives. */
export interface FakeServer {
  /** `127.0.0.1:<port>`. */
  host: string
  /** `http://127.0.0.1:<port>`. */
  origin: string
  received: ReceivedRequest[]
  route(handler: FakeRoute): void
  close(): Promise<void>
}

export async function startFakeServer(handler?: FakeRoute): Promise<FakeServer> {
  let current: FakeRoute =
    handler ??
    ((_req, res) => {
      res.writeHead(404).end()
    })
  const received: ReceivedRequest[] = []
  const server = createServer((req, res) => {
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    current(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    received,
    route(next) {
      current = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

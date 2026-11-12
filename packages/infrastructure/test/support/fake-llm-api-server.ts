import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string | undefined
  path: string | undefined
  headers: IncomingHttpHeaders
  body: unknown
}

export interface ScriptStep {
  status: number
  json?: unknown
  body?: string
  delayMs?: number
}

export interface FakeLlmApiServer {
  url: string
  requests: RecordedRequest[]
  stop(): Promise<void>
}

export async function startFakeLlmApi(script: ScriptStep[]): Promise<FakeLlmApiServer> {
  const requests: RecordedRequest[] = []
  const timers = new Set<NodeJS.Timeout>()
  let i = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        // keep the raw text
      }
      requests.push({ method: req.method, path: req.url, headers: req.headers, body })
      const step = script[i++] ?? { status: 500, body: 'script exhausted' }
      const send = () => {
        if (res.destroyed) return
        if (step.json !== undefined) {
          res.writeHead(step.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(step.json))
        } else {
          res.writeHead(step.status, { 'content-type': 'text/plain' })
          res.end(step.body ?? '')
        }
      }
      if (step.delayMs) timers.add(setTimeout(send, step.delayMs))
      else send()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async stop() {
      for (const t of timers) clearTimeout(t)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

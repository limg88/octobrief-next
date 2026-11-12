import { type Renderer, RendererUnavailable } from '@octobrief/application'
import {
  RENDER_CHECKS,
  RENDER_FINDINGS,
  type RenderCheckOutcome,
  type RenderResponse,
  TEMPLATE_REFUSALS,
} from '@octobrief/domain/recipe'

// The worker's side of the container that makes the binary files: one POST with the approved
// document, the template and the counts, and an answer read strictly. The worker is its only
// caller; the address is of the infrastructure (`RENDERER_URL`). Whatever is not a well-formed
// answer of the renderer (no answer, a timeout, a status of a proxy, a body that does not read)
// is «the renderer did not answer»: the approval fails with that reason and can be asked again.

/** The statuses of an answer of the renderer: a file, or a refusal with its checks. */
const RENDERED = 200
const REFUSALS = new Set([400, 413, 422])

/** Larger than any file the renderer gives (10 MiB, in base64) with its checks. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024

const CHECKS = new Set<string>(RENDER_CHECKS)
const FINDINGS = new Set<string>([...RENDER_FINDINGS, ...TEMPLATE_REFUSALS])
const SUBJECTS = new Set(['request', 'template', 'file'])

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function checksOf(raw: unknown): RenderCheckOutcome[] | null {
  if (!Array.isArray(raw) || raw.length > 64) return null
  const out: RenderCheckOutcome[] = []
  for (const c of raw) {
    if (!isRecord(c)) return null
    const { subject, check, passed, findings } = c
    if (typeof subject !== 'string' || !SUBJECTS.has(subject)) return null
    if (typeof check !== 'string' || !CHECKS.has(check)) return null
    if (typeof passed !== 'boolean' || !Array.isArray(findings) || findings.length > 64) return null
    if (!findings.every((f) => typeof f === 'string' && FINDINGS.has(f))) return null
    if (passed !== (findings.length === 0)) return null
    out.push({
      subject: subject as RenderCheckOutcome['subject'],
      check: check as RenderCheckOutcome['check'],
      passed,
      findings: findings as RenderCheckOutcome['findings'],
    })
  }
  return out
}

/** The answer of the renderer, read strictly; null when it is not one. */
export function readRenderAnswer(status: number, body: unknown): RenderResponse | null {
  if (!isRecord(body)) return null
  const checks = checksOf(body.checks)
  if (checks === null) return null
  if (status === RENDERED && body.outcome === 'rendered') {
    const { file, sha256 } = body
    if (typeof file !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file)) return null
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
    if (!checks.every((c) => c.passed)) return null
    return { outcome: 'rendered', file, sha256, checks }
  }
  if (REFUSALS.has(status) && body.outcome === 'refused') {
    // A refusal says which check refused.
    if (checks.every((c) => c.passed)) return null
    return { outcome: 'refused', checks }
  }
  return null
}

/** The renderer at `baseUrl`, each request bounded by `timeoutMs`. */
export function httpRenderer(
  baseUrl: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Renderer {
  const endpoint = new URL('/render', baseUrl)
  const call = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 90_000
  return {
    async render(envelope, signal) {
      let response: Response
      try {
        response = await call(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        })
      } catch {
        if (signal.aborted) throw signal.reason
        throw new RendererUnavailable()
      }
      const length = Number(response.headers.get('content-length') ?? '0')
      if (length > MAX_ANSWER_BYTES) {
        await response.body?.cancel().catch(() => undefined)
        throw new RendererUnavailable()
      }
      let body: unknown
      try {
        const text = await response.text()
        if (text.length > MAX_ANSWER_BYTES) throw new RendererUnavailable()
        body = JSON.parse(text)
      } catch {
        if (signal.aborted) throw signal.reason
        throw new RendererUnavailable()
      }
      const answer = readRenderAnswer(response.status, body)
      if (answer === null) throw new RendererUnavailable()
      return answer
    },
  }
}

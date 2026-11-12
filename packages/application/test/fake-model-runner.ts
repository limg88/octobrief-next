import type { BackendId } from '@octobrief/domain'
import {
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type ModelRunner,
} from '../src/ports/model-runner.ts'

export type FakeStep = ModelResponse | ((req: ModelRequest) => ModelResponse)

export interface FakeModelRunner extends ModelRunner {
  readonly requests: ModelRequest[]
}

export function fakeModelRunner(script: FakeStep[], backend: BackendId = 'fake'): FakeModelRunner {
  const requests: ModelRequest[] = []
  let i = 0
  return {
    backend,
    requests,
    async run(req) {
      // The llm-api gateway refuses both in one turn: no caller may ever send them together.
      if (req.tools?.length && req.responseSchema) {
        throw new Error('fakeModelRunner: tools and responseSchema in the same request')
      }
      requests.push(structuredClone(req))
      const step = script[i++]
      if (!step) throw new Error('fakeModelRunner: script exhausted')
      return typeof step === 'function' ? step(req) : step
    },
  }
}

/**
 * A step that keeps the lease contract of the Claude seat behind llm-api: after a refusal at the
 * output budget the lease is closed, and a request that still carries tool calls or tool results
 * of that conversation is refused as the gateway does (410 `mcp_lease_expired`).
 */
export function afterClosedLease(answer: FakeStep): FakeStep {
  return (req) => {
    const replays = req.messages.some(
      (m) => m.role === 'tool' || (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0),
    )
    if (replays) {
      throw new ModelError(
        'rejected',
        'llm-api rejected the request (HTTP 410)',
        410,
        undefined,
        'mcp_lease_expired',
      )
    }
    return typeof answer === 'function' ? answer(req) : answer
  }
}

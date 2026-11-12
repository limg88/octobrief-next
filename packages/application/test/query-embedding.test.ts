import {
  createReadLog,
  type KnowledgeReader,
  newId,
  type ProjectId,
  type QueryVector,
  type UserId,
} from '@octobrief/domain'
import { describe, expect, it } from 'vitest'
import {
  type EmbedRequest,
  ModelError,
  type ModelRunner,
  projectTools,
  QUERY_EMBEDDING_BUDGET_MS,
  QUERY_EMBEDDING_TIMEOUT_MS,
  queryEmbedder,
} from '../src/index.ts'
import { unitVector } from './vectors.ts'

const projectId = newId<ProjectId>()
const userId = newId<UserId>()
const encoder = { model: 'enc', digest: 'd1', backend: 'local' }

function searchTool(embedQuery?: (q: string) => Promise<QueryVector | null>) {
  const seen: Array<{ query: string; opts: unknown }> = []
  const reader: KnowledgeReader<null> = {
    async search(_tx, _p, query, opts) {
      seen.push({ query, opts })
      return []
    },
    listSources: async () => [],
    readEvidence: async () => null,
    readFact: async () => null,
  }
  const tools = projectTools({
    projectId,
    lang: 'it',
    log: createReadLog(),
    reader,
    withTx: (fn) => fn(null),
    ...(embedQuery ? { embedQuery } : {}),
  })
  const tool = tools.find((t) => t.spec.name === 'search_knowledge')
  if (!tool) throw new Error('no search tool')
  return { seen, run: (query: string) => tool.execute({ query }, { projectId, userId }) }
}

function embeddingRunner(embed: (req: EmbedRequest, signal?: AbortSignal) => Promise<number[]>) {
  const requests: EmbedRequest[] = []
  const runner: ModelRunner = {
    backend: 'llm-api',
    run: async () => {
      throw new Error('no chat here')
    },
    embedding: encoder,
    async embed(req, signal) {
      requests.push(req)
      return {
        vectors: [await embed(req, signal)],
        encoder: { model: encoder.model, digest: encoder.digest },
        usage: { inputTokens: 1 },
        backend: encoder.backend,
      }
    },
  }
  return { runner, requests }
}

describe('search by meaning in the knowledge tools', () => {
  it('searches with the vector of the query and its encoder', async () => {
    const vector = unitVector(1)
    const { seen, run } = searchTool(async () => ({ vector, model: 'enc', digest: 'd1' }))
    await run('festa di fine anno')
    expect(seen).toEqual([
      {
        query: 'festa di fine anno',
        opts: { embedding: { vector, model: 'enc', digest: 'd1' } },
      },
    ])
  })

  it('searches by words alone without a vector', async () => {
    const none = searchTool(async () => null)
    await none.run('ritardo')
    const absent = searchTool()
    await absent.run('ritardo')
    expect(none.seen[0]?.opts).toEqual({})
    expect(absent.seen[0]?.opts).toEqual({})
  })
})

describe('queryEmbedder', () => {
  it('embeds the query through the runner, for the project', async () => {
    const vector = unitVector(2)
    const { runner, requests } = embeddingRunner(async () => vector)
    const embedQuery = queryEmbedder(runner, projectId)
    expect(await embedQuery?.('Mario Rossi e il budget')).toEqual({
      vector,
      model: 'enc',
      digest: 'd1',
    })
    expect(requests).toEqual([{ texts: ['Mario Rossi e il budget'], context: { projectId } }])
  })

  it('is absent for a runner without an encoder', () => {
    const runner: ModelRunner = { backend: 'llm-api', run: async () => Promise.reject() }
    expect(queryEmbedder(runner, projectId)).toBeNull()
  })

  it('gives no vector when the call is refused or fails, so the search falls back', async () => {
    for (const error of [
      new ModelError('not_allowed', 'backend not allowed for this project'),
      new ModelError('timeout', 'llm-api request timed out'),
      new Error('db down'),
    ]) {
      const { runner } = embeddingRunner(async () => {
        throw error
      })
      expect(await queryEmbedder(runner, projectId)?.('x')).toBeNull()
    }
  })

  it('after one failed call, searches by words alone for the rest of the answer', async () => {
    let calls = 0
    const { runner } = embeddingRunner(async () => {
      calls += 1
      if (calls === 1) throw new ModelError('timeout', 'llm-api request timed out')
      return unitVector(1)
    })
    const embedQuery = queryEmbedder(runner, projectId)
    expect(await embedQuery?.('a')).toBeNull()
    expect(await embedQuery?.('b')).toBeNull()
    expect(calls).toBe(1)
  })

  it('keeps the query vectors of one answer within their budget', () => {
    expect(QUERY_EMBEDDING_TIMEOUT_MS).toBe(15_000)
    expect(QUERY_EMBEDDING_BUDGET_MS).toBe(60_000)
  })

  it('gives up with the run: an aborted signal gives no vector', async () => {
    const stop = new AbortController()
    const { runner } = embeddingRunner(
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new ModelError('timeout', 'aborted')))
        }),
    )
    const pending = queryEmbedder(runner, projectId, stop.signal)?.('x')
    stop.abort()
    expect(await pending).toBeNull()
  })
})

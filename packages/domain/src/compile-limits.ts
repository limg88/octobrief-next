// How the compile reads a document: in batches of chunks, one model call each, an answer of a
// bounded number of facts within an output budget. A batch the backend cannot answer whole (its
// answer reaches the output budget, or the call outlasts its time) is split in halves, within a
// bounded number of calls.

/** Chunks sent in one model call of the compile: a balance between context and cost. */
export const COMPILE_CHUNKS_PER_CALL = 40
/** Facts one compile answer may carry: more is a malformed answer. */
export const COMPILE_FACTS_PER_CALL = 15
/**
 * Output tokens of a compile call: room for the facts (about 4,000 tokens for a full batch) and
 * for the model's reasoning, which some backends count in the same budget, small enough to cut a
 * runaway answer.
 */
export const COMPILE_OUTPUT_TOKENS = 8000
/**
 * Most batches compiled for one piece of evidence: a cost cap in model calls (25 batches, that is
 * the first thousand chunks at 40 chunks per call).
 */
export const COMPILE_MAX_BATCHES = 25
/** How many times a batch may be halved: 40 chunks, then 20, then 10. */
export const COMPILE_SPLIT_DEPTH = 2
/** Most calls one batch may make for the halves of its splits, besides its own two. */
export const COMPILE_SPLIT_CALLS_PER_BATCH = 4
/**
 * Most calls one piece of evidence may make for the halves of its batches: two batches split in
 * full (a medium document), so the calls of a job stay bounded.
 */
export const COMPILE_SPLIT_CALLS_PER_EVIDENCE = 8

/** How the compile reads on one backend. */
export interface CompileLimits {
  chunksPerCall: number
  factsPerCall: number
  outputTokens: number
}

/** The calls the halves of one batch of `chunks` chunks may take at most, from `depth` on. */
function splitCalls(chunks: number, depth: number): number {
  if (depth >= COMPILE_SPLIT_DEPTH || chunks < 2) return 0
  return (
    2 + splitCalls(Math.ceil(chunks / 2), depth + 1) + splitCalls(Math.floor(chunks / 2), depth + 1)
  )
}

/** The model calls of a reading: without splits (`min`) and with every split allowed (`max`). */
export interface CompileCallsEstimate {
  min: number
  max: number
}

/**
 * The model calls reading these documents takes, in batches of `chunksPerCall`: one per batch of
 * chunks of each (at least one, at most the cap), and up to the calls of the halves when a batch
 * is too dense or too slow for one answer and is split (within the limits of a batch and of a
 * document). Without the retry of a malformed answer, which only happens when an answer goes
 * wrong.
 */
export function estimatedCompileCalls(
  chunksPerDocument: readonly number[],
  chunksPerCall: number = COMPILE_CHUNKS_PER_CALL,
): CompileCallsEstimate {
  const size = Math.max(1, Math.floor(chunksPerCall))
  let min = 0
  let max = 0
  for (const chunks of chunksPerDocument) {
    const batches = Math.min(COMPILE_MAX_BATCHES, Math.max(1, Math.ceil(chunks / size)))
    let halves = 0
    for (let i = 0; i < batches; i++) {
      const inBatch = Math.max(0, Math.min(size, chunks - i * size))
      halves += Math.min(COMPILE_SPLIT_CALLS_PER_BATCH, splitCalls(inBatch, 0))
    }
    min += batches
    max += batches + Math.min(COMPILE_SPLIT_CALLS_PER_EVIDENCE, halves)
  }
  return { min, max }
}

import { EMBEDDING_DIMENSIONS } from '../src/ports/model-runner.ts'

/** A synthetic unit vector of 1024 dimensions, different for each seed. */
export function unitVector(seed: number): number[] {
  const v = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed * 7.13 + i * 0.37))
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

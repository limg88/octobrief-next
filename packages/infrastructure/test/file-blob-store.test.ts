import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileBlobStore } from '../src/blob/file-blob-store.ts'

const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blobs-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('file blob store', () => {
  it('stores bytes under their hash with private permissions and reads them back', async () => {
    const store = createFileBlobStore(root)
    const project = randomUUID()
    const { key, sha256 } = await store.put(project, new TextEncoder().encode('abc'))
    expect(sha256).toBe(SHA256_OF_ABC)
    expect(key).toBe(`${project}/${SHA256_OF_ABC}`)
    expect(new TextDecoder().decode(await store.get(key))).toBe('abc')
    expect(statSync(join(root, key)).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, project)).mode & 0o777).toBe(0o700)
  })

  it('writes the same content once and leaves no temporary file', async () => {
    const store = createFileBlobStore(root)
    const project = randomUUID()
    await store.put(project, new Uint8Array([1, 2]))
    await store.put(project, new Uint8Array([1, 2]))
    expect(readdirSync(join(root, project))).toHaveLength(1)
  })

  it('deletes bytes, a missing key included', async () => {
    const store = createFileBlobStore(root)
    const { key } = await store.put(randomUUID(), new Uint8Array([9]))
    await store.delete(key)
    await store.delete(key)
    await expect(store.get(key)).rejects.toThrow()
  })

  it('refuses keys that could escape the root', async () => {
    const store = createFileBlobStore(root)
    for (const key of [
      '../x',
      `${randomUUID()}/../../etc`,
      'a/b',
      `${randomUUID()}/${'g'.repeat(64)}`,
    ]) {
      await expect(store.get(key)).rejects.toThrow('invalid blob key')
      await expect(store.delete(key)).rejects.toThrow('invalid blob key')
    }
  })
})

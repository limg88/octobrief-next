import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BlobStore } from '@octobrief/application'

/** `<project uuid>/<sha256 hex>`: content-addressed per project. */
const KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})$/
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

/** The path of a key; anything that is not a valid key (`..`, separators, NUL) throws. */
function pathOf(root: string, key: string): string {
  const match = KEY.exec(key)
  if (!match) throw new Error('invalid blob key')
  return join(root, match[1] as string, match[2] as string)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Makes a rename durable: without this a crash could lose the directory entry. */
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/**
 * Filesystem store under `root`: files mode 0600, directories 0700, atomic writes (readers see
 * all the bytes or no file). Encryption at rest is the disk's job.
 */
export function createFileBlobStore(root: string): BlobStore {
  return {
    async put(projectId, bytes) {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const key = `${projectId}/${sha256}`
      const target = pathOf(root, key)
      if (await exists(target)) return { key, sha256 }
      await mkdir(dirname(target), { recursive: true, mode: DIRECTORY_MODE })
      const temporary = join(dirname(target), `.${randomBytes(8).toString('hex')}.tmp`)
      try {
        const handle = await open(temporary, 'wx', FILE_MODE)
        try {
          await handle.writeFile(bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, target)
        await syncDirectory(dirname(target))
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      return { key, sha256 }
    },

    async get(key) {
      return new Uint8Array(await readFile(pathOf(root, key)))
    },

    async delete(key) {
      await rm(pathOf(root, key), { force: true })
    },
  }
}

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSyncFile } from '@octobrief/connectors'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFolderFeeds } from '../src/feeds/folder-feeds.ts'

let base: string
let root: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'octobrief-folders-'))
  root = join(base, 'sync')
  await mkdir(join(root, 'borea', 'jira'), { recursive: true })
  await mkdir(join(base, 'altrove'))
})
afterEach(() => rm(base, { recursive: true, force: true }))

const issue = (id: string) =>
  renderSyncFile({
    system: 'jira',
    type: 'record',
    body: `# ${id}\n`,
    record: {
      externalId: id,
      version: 'v1',
      title: id,
      originAt: null,
      url: null,
      people: [],
      record: { type: 'Bug' },
    },
  })

describe('folder feeds', () => {
  it('accepts a folder under the root and returns its real path', async () => {
    const feeds = createFolderFeeds({ root })
    expect(await feeds.check(join(root, 'borea'))).toMatch(/sync\/borea$/)
    expect(await feeds.check(root)).toMatch(/sync$/)
  })

  it('refuses a folder elsewhere, a missing one, a file, a link that leads out', async () => {
    const feeds = createFolderFeeds({ root })
    await writeFile(join(root, 'file.txt'), 'x')
    await symlink(join(base, 'altrove'), join(root, 'uscita'))
    await expect(feeds.check(join(base, 'altrove'))).rejects.toMatchObject({
      code: 'folder_not_allowed',
    })
    await expect(feeds.check(join(root, 'uscita'))).rejects.toMatchObject({
      code: 'folder_not_allowed',
    })
    await expect(feeds.check(join(root, 'manca'))).rejects.toMatchObject({
      code: 'folder_not_found',
    })
    await expect(feeds.check(join(root, 'file.txt'))).rejects.toMatchObject({
      code: 'folder_not_found',
    })
  })

  it('is off without a root, or when the root is not there', async () => {
    for (const off of [null, join(base, 'manca')]) {
      await expect(createFolderFeeds({ root: off }).check(root)).rejects.toMatchObject({
        code: 'folder_feed_disabled',
      })
    }
  })

  it('reads the subfolder of the system, from where the cursor says', async () => {
    const feeds = createFolderFeeds({ root })
    for (let n = 1; n <= 101; n++) {
      await writeFile(
        join(root, 'borea', 'jira', `BOR-${String(n).padStart(3, '0')}.md`),
        issue(`BOR-${n}`),
      )
    }
    const first = await feeds.read('jira', join(root, 'borea'), null)
    expect(first.records).toHaveLength(100)
    expect(first).toMatchObject({ done: false, nextCursor: { offset: 100 } })
    const second = await feeds.read('jira', join(root, 'borea'), first.nextCursor)
    expect(second.records.map((r) => r.externalId)).toEqual(['BOR-101'])
    expect(second).toMatchObject({ done: true, nextCursor: null })
    // A cursor of another shape starts again from the first file.
    expect((await feeds.read('jira', join(root, 'borea'), { offset: 'x' })).records).toHaveLength(
      100,
    )
  })

  it('says when the system has no subfolder', async () => {
    const feeds = createFolderFeeds({ root })
    await expect(feeds.read('ado', join(root, 'borea'), null)).rejects.toMatchObject({
      code: 'folder_not_found',
    })
  })
})

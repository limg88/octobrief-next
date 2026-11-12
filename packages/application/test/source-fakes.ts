import type {
  ExternalRecord,
  ExternalRows,
  ItemPerson,
  PullSourceKind,
  Source,
  SourceKind,
} from '@octobrief/domain'
import {
  type ExternalItemStore,
  type FeedBatch,
  FeedError,
  type FolderFeeds,
  type NewExternalDocument,
  type NewSource,
  type SealedSecret,
  type SecretVault,
  type SourceFeeds,
  type SourceRepository,
  type SourceSyncStore,
  type SourceTarget,
  type SourceToSync,
} from '../src/ports/source-stores.ts'
import type { InMemoryDocuments } from './fakes.ts'

interface StoredSource {
  source: Source
  tokenHash: string | null
  secret: SealedSecret | null
  cursor: unknown
}

/** Every view of the sources, over the in-memory documents. */
export class InMemorySources implements SourceRepository, SourceSyncStore, ExternalItemStore {
  readonly rows = new Map<string, StoredSource>()
  readonly external = new Map<string, { documentId: string; version: string }>()
  readonly records = new Map<string, ExternalRecord & { removed: boolean }>()
  readonly systemRows: ExternalRows[] = []
  readonly people: ItemPerson[] = []
  private readonly documents: InMemoryDocuments
  constructor(documents: InMemoryDocuments) {
    this.documents = documents
  }
  private patch(sourceId: string, change: Partial<Source>) {
    const row = this.rows.get(sourceId)
    if (row) this.rows.set(sourceId, { ...row, source: { ...row.source, ...change } })
  }
  async list(viewerId: string, projectId: string) {
    if (!this.documents.visible(viewerId, projectId)) return []
    return [...this.rows.values()]
      .map((row) => row.source)
      .filter((source) => source.projectId === projectId)
  }
  async find(viewerId: string, projectId: string, sourceId: string) {
    return (await this.list(viewerId, projectId)).find((source) => source.id === sourceId) ?? null
  }
  async create(viewerId: string, source: NewSource) {
    if (!this.documents.visible(viewerId, source.projectId)) throw new Error('row-level security')
    const taken = [...this.rows.values()].some(
      (row) => row.source.projectId === source.projectId && row.source.name === source.name,
    )
    if (taken) return null
    const created: Source = {
      id: source.id,
      projectId: source.projectId,
      kind: source.kind,
      feed: source.folderPath ? 'folder' : source.tokenHash ? 'push' : 'direct',
      folderPath: source.folderPath,
      name: source.name,
      config: source.config,
      perimeter: source.perimeter,
      lastSyncAt: null,
      dataAsOf: null,
      lastError: null,
      documentCount: 0,
      createdBy: source.createdBy,
      createdAt: new Date('2026-11-12T09:00:00Z'),
    }
    this.rows.set(source.id, {
      source: created,
      tokenHash: source.tokenHash,
      secret: source.secret,
      cursor: null,
    })
    return created
  }
  async remove(_viewerId: string, sourceId: string) {
    this.rows.delete(sourceId)
  }
  async setTokenHash(_viewerId: string, sourceId: string, tokenHash: string) {
    const row = this.rows.get(sourceId)
    if (row) this.rows.set(sourceId, { ...row, tokenHash })
  }
  private target(row: StoredSource): SourceTarget {
    const { id, projectId, kind, createdBy } = row.source
    return { id, projectId, kind, createdBy }
  }
  async ingestTarget(sourceId: string, tokenHash: string) {
    const row = this.rows.get(sourceId)
    return row && row.tokenHash === tokenHash ? this.target(row) : null
  }
  async pullSourceIds() {
    return [...this.rows.values()]
      .filter((row) => row.source.feed !== 'push')
      .map((row) => row.source.id)
  }
  async load(sourceId: string): Promise<SourceToSync | null> {
    const row = this.rows.get(sourceId)
    if (!row || row.source.feed === 'push') return null
    return {
      ...this.target(row),
      folderPath: row.source.folderPath,
      config: row.source.config,
      perimeter: row.source.perimeter,
      secret: row.secret,
      cursor: row.cursor,
    }
  }
  async saveCursor(sourceId: string, cursor: unknown) {
    const row = this.rows.get(sourceId)
    if (row) this.rows.set(sourceId, { ...row, cursor })
  }
  async document(target: SourceTarget, externalId: string) {
    const known = this.external.get(`${target.id}|${externalId}`)
    const row = known && this.documents.rows.get(known.documentId)
    return known && row ? { ...known, blobKey: row.blobKey } : null
  }
  async createDocument(target: SourceTarget, document: NewExternalDocument) {
    const { item, fileName, sha256, blobKey } = document
    const created = await this.documents.create(target.createdBy, {
      projectId: target.projectId,
      fileName,
      mediaType: item.mediaType,
      sizeBytes: item.bytes.length,
      sha256,
      blobKey,
      uploadedBy: target.createdBy,
    })
    if (!created) return null
    const row = this.documents.rows.get(created.id)
    if (row) {
      const sourceName = this.rows.get(target.id)?.source.name ?? null
      row.summary = { ...row.summary, sourceName, originAt: item.originAt }
      row.systemKind = item.systemKind ?? null
    }
    this.external.set(`${target.id}|${item.externalId}`, {
      documentId: created.id,
      version: item.version,
    })
    this.patch(target.id, {
      documentCount: (this.rows.get(target.id)?.source.documentCount ?? 0) + 1,
    })
    return created.id
  }
  async removeDocument(target: SourceTarget, documentId: string) {
    return this.documents.remove(target.createdBy, documentId)
  }
  async saveRecords(target: SourceTarget, records: readonly ExternalRecord[]) {
    for (const record of records) {
      this.records.set(`${target.id}|${record.externalId}`, { ...record, removed: false })
    }
  }
  async markRemoved(target: SourceTarget, externalIds: readonly string[]) {
    for (const id of externalIds) {
      const record = this.records.get(`${target.id}|${id}`)
      if (record) record.removed = true
    }
  }
  async saveRows(_target: SourceTarget, rows: ExternalRows) {
    this.systemRows.push(rows)
  }
  async savePeople(_target: SourceTarget, people: readonly ItemPerson[]) {
    this.people.push(...people)
  }
  async delivered(target: SourceTarget, dataAsOf: Date | null, error: string | null) {
    const current = this.rows.get(target.id)?.source
    this.patch(target.id, {
      lastSyncAt: new Date('2026-11-12T10:00:00Z'),
      lastError: error,
      dataAsOf: dataAsOf ?? current?.dataAsOf ?? null,
    })
  }
}

/** Seals by prefixing: enough to see that a secret is never stored as given. */
export class FakeVault implements SecretVault {
  seal(sourceId: string, value: string): SealedSecret {
    return {
      keyVersion: 1,
      iv: new Uint8Array(),
      tag: new Uint8Array(),
      ciphertext: new TextEncoder().encode(`${sourceId}:${value}`),
    }
  }
  unseal(sourceId: string, sealed: SealedSecret): string {
    const text = new TextDecoder().decode(sealed.ciphertext)
    if (!text.startsWith(`${sourceId}:`)) throw new Error('secret undecryptable')
    return text.slice(sourceId.length + 1)
  }
}

/** A source system scripted by the test: one batch per pull, in order. */
/** Folders by path: what a reading of each one gives, one batch at a time. */
export class FakeFolders implements FolderFeeds {
  /** The only place folders may be under. */
  root = '/sync'
  readonly batches = new Map<string, FeedBatch[]>()
  readonly reads: Array<{ kind: SourceKind; folderPath: string; cursor: unknown }> = []
  async check(folderPath: string) {
    if (!folderPath.startsWith(`${this.root}/`)) throw new FeedError('folder_not_allowed')
    return folderPath
  }
  async read(kind: SourceKind, folderPath: string, cursor: unknown) {
    this.reads.push({ kind, folderPath, cursor })
    const batch = this.batches.get(folderPath)?.shift()
    if (!batch) throw new FeedError('folder_not_found')
    return batch
  }
}

export class FakeFeeds implements SourceFeeds {
  batches: FeedBatch[] = []
  readonly pulls: Array<{ secret: string | null; cursor: unknown }> = []
  /** The credential the fake system accepts. */
  validSecret = 'token-ok'
  async connect(
    _kind: PullSourceKind,
    rawConfig: unknown,
    secret: string,
    scope: readonly string[],
  ) {
    if (secret !== this.validSecret) throw new FeedError('source_auth_failed')
    return {
      config: { ...(rawConfig as object) },
      perimeter: scope.length > 0 ? scope.map((s) => `project:${s}`) : ['project:all'],
    }
  }
  async pull(source: { secret: string | null }, cursor: unknown) {
    this.pulls.push({ secret: source.secret, cursor })
    const batch = this.batches.shift()
    if (!batch) throw new FeedError('source_unavailable')
    return batch
  }
}

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  canManageSources,
  type Delivery,
  type ExternalDocument,
  InvalidSourceError,
  type ItemPerson,
  isAdmin,
  isPullSource,
  itemFileName,
  MAX_ITEM_BYTES,
  MAX_ITEMS_PER_DELIVERY,
  MAX_ROWS_PER_DELIVERY,
  normalizeSourceName,
  SOURCE_KINDS,
  type Source,
  type SourceKind,
  type User,
} from '@octobrief/domain'
import { ApplicationError } from '../errors.ts'
import type { BlobStore } from '../ports/blob-store.ts'
import type { JobQueue } from '../ports/job-queue.ts'
import type { Logger } from '../ports/logger.ts'
import {
  type ExternalItemStore,
  FeedError,
  type SecretVault,
  type SourceFeeds,
  type SourceRepository,
  type SourceSyncStore,
  type SourceTarget,
} from '../ports/source-stores.ts'
import { getProject, type ProjectDependencies } from './projects.ts'

/** Bytes of entropy of an ingest token. */
const TOKEN_BYTES = 32
/** What a feeder's token starts with: easy to recognize in a leak scan. */
export const INGEST_TOKEN_PREFIX = 'obf_'
/** Batches one sync job reads at most; the next run goes on from the saved cursor. */
export const MAX_BATCHES_PER_SYNC = 10
/** Stored when a sync fails for a reason that is not the source system's. */
const UNEXPECTED_FAILURE = 'sync_failed'

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

function newIngestToken(): { token: string; hash: string } {
  const token = INGEST_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, hash: hashToken(token) }
}

export interface SourceDependencies extends ProjectDependencies {
  readonly sources: SourceRepository
  readonly feeds: SourceFeeds
  readonly vault: SecretVault
  readonly queue: JobQueue
}

export interface SourceInput {
  readonly kind: string
  readonly name: string
  /** Settings of a pulling source (site, organization, account…). */
  readonly config?: unknown
  /** The credential of a pulling source: sealed at once, never returned. */
  readonly secret?: string | undefined
  /** Project keys or names to read; empty: everything the credential sees. */
  readonly scope?: readonly string[] | undefined
}

async function manageableProject(deps: ProjectDependencies, viewer: User, slug: string) {
  const project = await getProject(deps, viewer, slug)
  if (!canManageSources({ memberRole: project.memberRole, admin: isAdmin(viewer) })) {
    throw new ApplicationError('forbidden', 'only owners and admins manage sources')
  }
  return project
}

function invalidSource(error: unknown): never {
  if (error instanceof FeedError) {
    throw new ApplicationError('invalid', error.code, { cause: error })
  }
  throw error
}

/**
 * Connects a source. A pushing one gets a token for its feeder, returned here once; a pulling
 * one is checked against its system first, and its credential is stored sealed.
 */
export async function createSource(
  deps: SourceDependencies,
  viewer: User,
  slug: string,
  input: SourceInput,
): Promise<{ source: Source; ingestToken: string | null }> {
  const project = await manageableProject(deps, viewer, slug)
  if (!(SOURCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidSourceError('invalid_kind')
  }
  const kind = input.kind as SourceKind
  const base = {
    id: randomUUID(),
    projectId: project.id,
    kind,
    name: normalizeSourceName(input.name),
    createdBy: viewer.id,
  }
  let created: Source | null
  let ingestToken: string | null = null
  if (isPullSource(kind)) {
    if (!input.secret?.trim()) throw new InvalidSourceError('secret_required')
    const { config, perimeter } = await deps.feeds
      .connect(kind, input.config ?? {}, input.secret, input.scope ?? [])
      .catch(invalidSource)
    created = await deps.sources.create(viewer.id, {
      ...base,
      config,
      perimeter,
      tokenHash: null,
      secret: deps.vault.seal(base.id, input.secret),
    })
  } else {
    const fresh = newIngestToken()
    ingestToken = fresh.token
    created = await deps.sources.create(viewer.id, {
      ...base,
      config: {},
      perimeter: [],
      tokenHash: fresh.hash,
      secret: null,
    })
  }
  if (!created) throw new ApplicationError('conflict', 'the project already has this source')
  if (isPullSource(kind)) await deps.queue.enqueue('source.sync', { sourceId: created.id })
  return { source: created, ingestToken }
}

export async function listSources(
  deps: SourceDependencies,
  viewer: User,
  slug: string,
): Promise<Source[]> {
  const project = await getProject(deps, viewer, slug)
  return deps.sources.list(viewer.id, project.id)
}

async function manageableSource(
  deps: SourceDependencies,
  viewer: User,
  slug: string,
  sourceId: string,
): Promise<Source> {
  const project = await manageableProject(deps, viewer, slug)
  const source = await deps.sources.find(viewer.id, project.id, sourceId)
  if (!source) throw new ApplicationError('not_found', 'source not found')
  return source
}

export async function deleteSource(
  deps: SourceDependencies,
  viewer: User,
  slug: string,
  sourceId: string,
): Promise<void> {
  const source = await manageableSource(deps, viewer, slug, sourceId)
  await deps.sources.remove(viewer.id, source.id)
}

/** A new token for the feeder of a pushing source; the old one stops working at once. */
export async function rotateIngestToken(
  deps: SourceDependencies,
  viewer: User,
  slug: string,
  sourceId: string,
): Promise<string> {
  const source = await manageableSource(deps, viewer, slug, sourceId)
  if (isPullSource(source.kind)) {
    throw new ApplicationError('conflict', 'this source is read by the worker, not fed')
  }
  const fresh = newIngestToken()
  await deps.sources.setTokenHash(viewer.id, source.id, fresh.hash)
  return fresh.token
}

/** Queues a reading of a pulling source now, without waiting for the next scheduled one. */
export async function requestSync(
  deps: SourceDependencies,
  viewer: User,
  slug: string,
  sourceId: string,
): Promise<void> {
  const source = await manageableSource(deps, viewer, slug, sourceId)
  if (!isPullSource(source.kind)) {
    throw new ApplicationError('conflict', 'this source is fed by its feeder')
  }
  await deps.queue.enqueue('source.sync', { sourceId: source.id })
}

export interface StoreDependencies {
  readonly items: ExternalItemStore
  readonly blobs: BlobStore
  readonly jobs: Pick<JobQueue, 'enqueue'>
}

export interface DeliveryOutcome {
  /** Documents stored for the first time, or again because their version changed. */
  created: number
  updated: number
  /** Documents the project already had in this version. */
  unchanged: number
  /** Documents whose content another document of the project already has. */
  duplicates: number
  records: number
  rows: number
  removed: number
}

function checkDelivery(delivery: Delivery): void {
  const rows = delivery.rows.reduce((sum, view) => sum + view.rows.length, 0)
  const tooMany =
    delivery.documents.length + delivery.records.length > MAX_ITEMS_PER_DELIVERY ||
    rows > MAX_ROWS_PER_DELIVERY
  const tooLarge = delivery.documents.some(
    (document) => document.bytes.length === 0 || document.bytes.length > MAX_ITEM_BYTES,
  )
  if (tooMany || tooLarge) throw new ApplicationError('invalid', 'delivery over the limits')
}

async function storeDocument(
  deps: StoreDependencies,
  target: SourceTarget,
  item: ExternalDocument,
  outcome: DeliveryOutcome,
): Promise<void> {
  const known = await deps.items.document(target, item.externalId)
  if (known?.version === item.version) {
    outcome.unchanged++
    return
  }
  // A changed item replaces its document: the old text and the facts only it stated go with it.
  if (known) {
    const oldKey = await deps.items.removeDocument(target, known.documentId)
    if (oldKey) await deps.blobs.delete(oldKey)
  }
  const { key, sha256 } = await deps.blobs.put(target.projectId, item.bytes)
  const documentId = await deps.items.createDocument(target, {
    item,
    fileName: itemFileName(item.title, item.mediaType, item.externalId),
    sha256,
    blobKey: key,
  })
  if (!documentId) {
    outcome.duplicates++
    return
  }
  await deps.jobs.enqueue('document.process', { documentId })
  if (known) outcome.updated++
  else outcome.created++
}

/**
 * Stores what a source brought: documents enter the same pipeline as uploads (extraction,
 * classification, reading), records and rows are kept as data, the people named are remembered
 * so that no model ever sees them.
 */
export async function storeDelivery(
  deps: StoreDependencies,
  target: SourceTarget,
  delivery: Delivery,
): Promise<DeliveryOutcome> {
  checkDelivery(delivery)
  const outcome: DeliveryOutcome = {
    created: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    records: delivery.records.length,
    rows: 0,
    removed: delivery.removed.length,
  }
  const people: ItemPerson[] = [...delivery.documents, ...delivery.records].flatMap(
    (item) => item.people,
  )
  // People first: a document is never read by a model before its names are known.
  if (people.length > 0) await deps.items.savePeople(target, people)
  for (const item of delivery.documents) await storeDocument(deps, target, item, outcome)
  if (delivery.records.length > 0) await deps.items.saveRecords(target, delivery.records)
  if (delivery.removed.length > 0) await deps.items.markRemoved(target, delivery.removed)
  for (const view of delivery.rows) {
    await deps.items.saveRows(target, view)
    outcome.rows += view.rows.length
  }
  await deps.items.delivered(target, delivery.dataAsOf, null)
  return outcome
}

export interface IngestDependencies extends StoreDependencies {
  readonly sources: Pick<SourceRepository, 'ingestTarget'>
}

/** A delivery of a feeder: the token names the source; a wrong one says nothing more. */
export async function ingestDelivery(
  deps: IngestDependencies,
  sourceId: string,
  token: string,
  delivery: Delivery,
): Promise<DeliveryOutcome> {
  const target = await deps.sources.ingestTarget(sourceId, hashToken(token))
  if (!target) throw new ApplicationError('unauthenticated', 'unknown source or token')
  return storeDelivery(deps, target, delivery)
}

export interface SyncDependencies extends StoreDependencies {
  readonly sync: SourceSyncStore
  readonly feeds: SourceFeeds
  readonly vault: SecretVault
  readonly logger: Logger
  readonly signal?: AbortSignal
}

/**
 * Worker job: reads a pulling source from where the last run stopped. A failure is recorded on
 * the source with a stable code and not raised: the next scheduled run tries again.
 */
export function createSyncSourceHandler(deps: SyncDependencies) {
  return async ({ sourceId }: { sourceId: string }): Promise<void> => {
    const source = await deps.sync.load(sourceId)
    if (!source) return
    const totals = { created: 0, updated: 0, records: 0 }
    try {
      const secret = source.secret ? deps.vault.unseal(source.id, source.secret) : null
      let cursor = source.cursor
      for (let batch = 0; batch < MAX_BATCHES_PER_SYNC; batch++) {
        const read = await deps.feeds.pull(
          { kind: source.kind, config: source.config, perimeter: source.perimeter, secret },
          cursor,
          deps.signal ?? new AbortController().signal,
        )
        const outcome = await storeDelivery(deps, source, read)
        cursor = read.nextCursor
        await deps.sync.saveCursor(source.id, cursor)
        totals.created += outcome.created
        totals.updated += outcome.updated
        totals.records += outcome.records
        if (read.done) break
      }
      deps.logger.info('source synced', { sourceId, ...totals })
    } catch (error) {
      const code = error instanceof FeedError ? error.code : UNEXPECTED_FAILURE
      await deps.items.delivered(source, null, code)
      deps.logger.error('source sync failed', { sourceId, code })
    }
  }
}

/** Queues a reading of every pulling source; run by the worker on a timer. */
export function createScheduleSyncHandler(deps: {
  sync: Pick<SourceSyncStore, 'pullSourceIds'>
  jobs: Pick<JobQueue, 'enqueue'>
}) {
  return async (): Promise<void> => {
    for (const sourceId of await deps.sync.pullSourceIds()) {
      await deps.jobs.enqueue('source.sync', { sourceId })
    }
  }
}

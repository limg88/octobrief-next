import type {
  Delivery,
  ExternalDocument,
  ExternalRecord,
  ExternalRows,
  ItemPerson,
  PullSourceKind,
  Source,
  SourceKind,
} from '@octobrief/domain'

/** A credential as stored: what the cipher produced and the version of the key that did it. */
export interface SealedSecret {
  readonly keyVersion: number
  readonly iv: Uint8Array
  readonly tag: Uint8Array
  readonly ciphertext: Uint8Array
}

/** Seals and opens the credentials of the sources; bound to the id of the source. */
export interface SecretVault {
  seal(sourceId: string, value: string): SealedSecret
  /** Throws when the secret was not sealed for this source with this key. */
  unseal(sourceId: string, sealed: SealedSecret): string
}

export interface NewSource {
  readonly id: string
  readonly projectId: string
  readonly kind: SourceKind
  readonly name: string
  readonly config: Readonly<Record<string, unknown>>
  readonly perimeter: readonly string[]
  readonly tokenHash: string | null
  readonly secret: SealedSecret | null
  /** The synchronized folder the worker reads this source from, if it is fed that way. */
  readonly folderPath: string | null
  readonly createdBy: string
}

/** The source a delivery belongs to, and the person its documents are stored as. */
export interface SourceTarget {
  readonly id: string
  readonly projectId: string
  readonly kind: SourceKind
  readonly createdBy: string
}

/** Sources as a signed-in person sees them: every call but `ingestTarget` runs as `viewerId`. */
export interface SourceRepository {
  list(viewerId: string, projectId: string): Promise<Source[]>
  find(viewerId: string, projectId: string, sourceId: string): Promise<Source | null>
  /** Null when the project already has a source of that name. */
  create(viewerId: string, source: NewSource): Promise<Source | null>
  /** Its documents stay, no longer tied to a source. */
  remove(viewerId: string, sourceId: string): Promise<void>
  setTokenHash(viewerId: string, sourceId: string, tokenHash: string): Promise<void>
  /** The pushing source a token belongs to; null for an unknown source or a wrong token. */
  ingestTarget(sourceId: string, tokenHash: string): Promise<SourceTarget | null>
}

export interface SourceToSync extends SourceTarget {
  /** Set when the source is read from a synchronized folder instead of its system. */
  readonly folderPath: string | null
  readonly config: Readonly<Record<string, unknown>>
  readonly perimeter: readonly string[]
  readonly secret: SealedSecret | null
  readonly cursor: unknown
}

/** The worker's view of the pulling sources. */
export interface SourceSyncStore {
  /** Ids of every source the worker reads by itself: from its system or from a folder. */
  pullSourceIds(): Promise<string[]>
  load(sourceId: string): Promise<SourceToSync | null>
  saveCursor(sourceId: string, cursor: unknown): Promise<void>
}

export interface StoredExternalDocument {
  readonly documentId: string
  readonly version: string
  readonly blobKey: string
}

export interface NewExternalDocument {
  readonly item: ExternalDocument
  readonly fileName: string
  readonly sha256: string
  readonly blobKey: string
}

/**
 * Where the items of a source are stored. On the web every call runs as the person who connected
 * the source (row-level security still applies); on the worker, as the worker.
 */
export interface ExternalItemStore {
  document(target: SourceTarget, externalId: string): Promise<StoredExternalDocument | null>
  /** The new document's id; null when the project already holds a file with the same content. */
  createDocument(target: SourceTarget, document: NewExternalDocument): Promise<string | null>
  /** Removes a document of the source and its text; returns the key of its bytes. */
  removeDocument(target: SourceTarget, documentId: string): Promise<string | null>
  saveRecords(target: SourceTarget, records: readonly ExternalRecord[]): Promise<void>
  /** Marks tracker items as gone at their source. */
  markRemoved(target: SourceTarget, externalIds: readonly string[]): Promise<void>
  saveRows(target: SourceTarget, rows: ExternalRows): Promise<void>
  savePeople(target: SourceTarget, people: readonly ItemPerson[]): Promise<void>
  /** Records a delivery: when it happened, how fresh its data is, what went wrong (a code). */
  delivered(target: SourceTarget, dataAsOf: Date | null, error: string | null): Promise<void>
}

export class FeedError extends Error {
  /** A stable code: shown to the PM through a message of its own, never a text of the system. */
  readonly code: string
  constructor(code: string) {
    super(`source feed failure: ${code}`)
    this.name = 'FeedError'
    this.code = code
  }
}

export interface FeedBatch extends Delivery {
  readonly nextCursor: unknown
  /** Whether the source has nothing more to give for now. */
  readonly done: boolean
}

export interface FeedSource {
  readonly kind: PullSourceKind
  readonly config: Readonly<Record<string, unknown>>
  readonly perimeter: readonly string[]
  readonly secret: string | null
}

/** A batch of a folder: the cursor is how far the listing of its files has been read. */
export interface FolderFeeds {
  /**
   * Checks that the folder may be read (it is under the root the installation allows and it
   * exists) and returns its path as it will be stored. Throws a `FeedError` otherwise.
   */
  check(folderPath: string): Promise<string>
  read(kind: SourceKind, folderPath: string, cursor: unknown): Promise<FeedBatch>
}

/**
 * The systems the worker reads by itself. Read-only; failures are `FeedError`s with a code. A
 * system reached tomorrow in another way (Graph, the warehouse) implements this same port.
 */
export interface SourceFeeds {
  /**
   * Checks the settings and the credential against the system and returns the settings to store
   * with the perimeter to read: the entries of the system that match `scope` (project keys or
   * names), or all of them when it is empty.
   */
  connect(
    kind: PullSourceKind,
    rawConfig: unknown,
    secret: string,
    scope: readonly string[],
  ): Promise<{ config: Record<string, unknown>; perimeter: string[] }>
  pull(source: FeedSource, cursor: unknown, signal: AbortSignal): Promise<FeedBatch>
}

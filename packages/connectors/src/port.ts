import type { DocumentKind } from '@octobrief/domain'
import type { SyncErrorCode } from './errors.ts'
import type { NetGuard } from './net-guard.ts'
import type { HttpRule } from './rules.ts'
import type { SafeHttp } from './safe-http.ts'
import type { SecretValue } from './secret-value.ts'

/** A JSON value: what a cursor is, since it is stored as such. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** The source systems a connector reads. */
export const CONNECTOR_KINDS = ['jira', 'ado', 'netsuite_dwsi'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/** What a connector works with, built by the job for one source. */
export interface ConnectorContext<Cfg> {
  config: Cfg
  /** The perimeter option ids the PM chose: never empty during a sync. */
  perimeter: readonly string[]
  /** The credential of the source, or null when it has none. */
  secret: SecretValue | null
  /** The only way to the network: allowlisted, read-only, without redirects. */
  http: SafeHttp
  /**
   * The only way to a connection that is not HTTP (a database): vets the host's addresses with
   * the same policy as `http` and the Admin's private hosts, and says how to secure it.
   */
  net: NetGuard
  signal: AbortSignal
  now(): Date
  /**
   * A source that reads with the identity of the PM who connected it (Microsoft 365): the
   * application the PM consented to, and how to store the refresh token the system gives in
   * exchange for the one used. Absent for the other sources.
   */
  delegation?: Delegation
  /**
   * The PM who owns the source, as their login gave them (the email and the UPN of the
   * organization's tenant): what a source read with a shared account (the warehouse) binds its
   * perimeter to. Absent when not known.
   */
  owner?: { email: string | null; upn?: string | null }
  /**
   * The folders of the Mac the Admin allows a folder source to read under, as configured now:
   * a folder source reads nothing outside them. Absent for the other sources.
   */
  folderRoots?: readonly string[]
  /**
   * The external ids of the items the source recorded that are not removed: what a source that
   * lists its whole perimeter at each look (a folder) compares with what it finds, to report
   * what is gone. Absent for the other sources.
   */
  currentItems?: () => Promise<string[]>
}

/** The application a PM consented to, for a source that reads with the PM's own identity. */
export interface Delegation {
  clientId: string
  clientSecret: SecretValue
  /**
   * Stores `next`, the refresh token the token endpoint gave, in place of the credential of the
   * source, at once and atomically: a job that fails afterwards keeps it.
   */
  rotate(next: SecretValue): Promise<void>
  /**
   * The credential of the source as stored now, when it is not the one this job read (another
   * job rotated it meanwhile); null otherwise.
   */
  latest(): Promise<SecretValue | null>
}

export type ConnectorCheck = { ok: true } | { ok: false; code: SyncErrorCode }

/** One entry of a list the PM chooses the perimeter from (an area, a project key, a PRJ code). */
export interface PerimeterOption {
  id: string
  label: string
  parentId?: string
  /**
   * The address of the entry as the system writes it (a SharePoint site, `sites/<Name>`): what
   * the configuration takes when the PM chooses the entry, so that the calls of the connector
   * name it as the system does.
   */
  canonical?: string
}

export interface SyncLimits {
  /** At most this many items in the batch. */
  maxItems: number
  signal: AbortSignal
}

/** A person an item names (assignee, author, participant): never shown to the model in clear. */
export interface ExternalPerson {
  displayName: string
  email?: string
  /** An application or service account of the system, not a person: not kept as one. */
  app?: true
  /**
   * A name chosen outside the organization (an external sender, a guest, a customer account):
   * only its full name is hidden, so that nobody outside can hide the words of the project.
   */
  untrusted?: true
}

interface ExternalItemBase {
  /** The id of the item in the source system. */
  externalId: string
  /** The version of the item in the source system (revision, update stamp). */
  version: string
  title: string
  mediaType: string
  /** When the source system says the item was made or changed; null when it does not say. */
  originAt: Date | null
  author: ExternalPerson | null
  /** The link to the item at the vendor: shown as a link, never as an id. */
  url: string | null
  /**
   * The perimeter option ids the item belongs to. The job keeps an item only when every one of
   * them is in the source's perimeter: what the system returns outside it never enters.
   */
  perimeter: readonly string[]
  people: ExternalPerson[]
  /**
   * When the file the item was read from was last changed, for a source of files on a disk:
   * the date of a document that has none of its own, declared as the file's (never the
   * system's). Only for an item that says its `kind`.
   */
  fileModifiedAt?: Date
  /**
   * The item names people the connector could not all list (too many mentions, a name too long
   * to be one): it is left out and counted, never stored with a name it could not hide.
   */
  peopleIncomplete?: true
}

/**
 * An item that becomes evidence (bytes) or a structured record (the tracker history). Evidence a
 * connector makes from the system's data (an export of the backlog) says its `kind`: it is
 * classified so, as system data, without guessing from its name.
 */
export type ExternalItem = ExternalItemBase &
  (
    | { bytes: Uint8Array; kind?: DocumentKind; record?: never }
    | { record: Record<string, Json>; bytes?: never; kind?: never }
  )

/** One row of a system table: its key in the extraction and its values as the system gave them. */
export interface SystemRow {
  key: string
  values: Record<string, Json>
}

/**
 * What a system source (a data warehouse) read of one view for one perimeter option: rows a tool
 * reads later, cited by the evidence of the same batch that lists them.
 */
export interface SystemExtraction {
  /** The `externalId` of the evidence item of this batch that lists these rows. */
  evidenceExternalId: string
  /** The perimeter option id the rows belong to: the job keeps them only inside the perimeter. */
  perimeter: string
  /** The view of the system the rows come from. */
  view: string
  rows: SystemRow[]
  /** When the extraction read the system. */
  extractedAt: Date
  /** When the system last synchronized the view's data from its origin; null when not deduced. */
  sourceSyncedAt: Date | null
}

/** Removals one batch reports at most. */
export const MAX_REMOVED_PER_BATCH = 1_000

/** Ids of items a listing of the perimeter gives at most: beyond, it fails, never cut short. */
export const MAX_LISTED_IDS = 20_000

/** The ids of the items in the perimeter now, as a reconciliation reads them. */
export interface ListedIds {
  ids: string[]
  /** When the system says the listing holds. */
  asOf: Date
}

export interface SyncBatch<Cursor extends Json> {
  items: ExternalItem[]
  /** Rows of system views, beside the items (they do not count as items). */
  extractions?: SystemExtraction[]
  /**
   * The `externalId`s of evidence items the system says are gone (deleted, moved out of the
   * perimeter): their removal is recorded, their evidence stays (it is immutable). At most
   * `MAX_REMOVED_PER_BATCH`.
   */
  removed?: string[]
  /**
   * How many entries of the system the batch read past without an item, by reason (a file too
   * large or of a kind that has no text): counted in the health of the run, never silent.
   */
  skipped?: Record<string, number>
  /** Where the next batch starts. Saved with this batch's items, atomically. */
  nextCursor: Cursor
  /** Whether the source has nothing more to give for now. */
  done: boolean
  /**
   * Up to when the source system's data has been read; null when the system did not say for some
   * of the batch (its age is then not deduced, never the time of the read).
   */
  dataAsOf: Date | null
}

/**
 * A read-only connector to a source system. It reaches the network only through `ctx.http`
 * (allowlisted by `rules`), never writes to the source, and filters what the system returns
 * to the perimeter again (the job checks it once more).
 */
export interface Connector<Cfg, Cursor extends Json> {
  kind: ConnectorKind
  /** Reads the stored configuration; throws `ConnectorError('source_not_configured')`. */
  parseConfig(raw: unknown): Cfg
  /**
   * Reads a stored cursor; throws when it is unreadable (the job records `source_cursor_invalid`
   * whatever the connector throws).
   */
  parseCursor(raw: unknown): Cursor
  /**
   * The calls the connector may make for this configuration: anything else is blocked. Values
   * from the configuration go into literal parts (`{ literal: value }`) and the host, never into
   * a pattern; `assertRulesConfined` (connectors test support) is the contract test.
   */
  rules(config: Cfg): readonly HttpRule[]
  test(ctx: ConnectorContext<Cfg>): Promise<ConnectorCheck>
  perimeterOptions(ctx: ConnectorContext<Cfg>): Promise<PerimeterOption[]>
  sync(
    ctx: ConnectorContext<Cfg>,
    cursor: Cursor | null,
    limits: SyncLimits,
  ): Promise<SyncBatch<Cursor>>
  /**
   * The ids (as `externalId`) of every structured item in the perimeter now, whatever its change
   * date: the items of the tracker history not among them are gone (deleted, moved out). Cheap
   * (ids only) and complete: more than `MAX_LISTED_IDS` throws `response_too_large`, never a
   * partial list. Only trackers have it.
   */
  listIds?(ctx: ConnectorContext<Cfg>): Promise<ListedIds>
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds connectors of every configuration.
export type AnyConnector = Connector<any, any>

/** The connectors an installation has, by kind. */
export type ConnectorRegistry = Partial<Record<ConnectorKind, AnyConnector>>

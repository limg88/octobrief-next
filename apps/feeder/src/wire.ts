import type { Delivery, ItemPerson } from '@octobrief/domain'

// The JSON a feeder sends to `POST /api/ingest/{sourceId}`: the delivery of the domain with
// dates as ISO strings and bytes as text or base64.

interface WireItem {
  externalId: string
  version: string
  title: string
  originAt?: string | null
  url?: string | null
  people?: ItemPerson[]
}

export interface WireDocument extends WireItem {
  mediaType: string
  text?: string
  contentBase64?: string
  kind?: string
  fileModifiedAt?: string
}

export interface WireDelivery {
  dataAsOf?: string | null
  documents?: WireDocument[]
  records?: Array<WireItem & { record: Record<string, unknown> }>
  rows?: Array<{
    view: string
    perimeter: string
    rows: Array<{ key: string; values: Record<string, unknown> }>
    extractedAt: string
    sourceSyncedAt?: string | null
  }>
  removed?: string[]
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null

const TEXT_TYPES = /^text\/|^application\/json$/

/** Text goes as text (readable in a log of the feeder), anything else as base64. */
function content(
  mediaType: string,
  bytes: Uint8Array,
): { text: string } | { contentBase64: string } {
  if (TEXT_TYPES.test(mediaType)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (!text.includes('�')) return { text }
  }
  return { contentBase64: Buffer.from(bytes).toString('base64') }
}

export function toWire(delivery: Delivery): WireDelivery {
  return {
    dataAsOf: iso(delivery.dataAsOf),
    documents: delivery.documents.map((d) => ({
      externalId: d.externalId,
      version: d.version,
      title: d.title,
      mediaType: d.mediaType,
      ...content(d.mediaType, d.bytes),
      originAt: iso(d.originAt),
      url: d.url,
      people: [...d.people],
      ...(d.systemKind ? { kind: d.systemKind } : {}),
      ...(d.fileModifiedAt ? { fileModifiedAt: d.fileModifiedAt.toISOString() } : {}),
    })),
    records: delivery.records.map((r) => ({
      externalId: r.externalId,
      version: r.version,
      title: r.title,
      record: { ...r.record },
      originAt: iso(r.originAt),
      url: r.url,
      people: [...r.people],
    })),
    rows: delivery.rows.map((view) => ({
      view: view.view,
      perimeter: view.perimeter,
      rows: view.rows.map((row) => ({ key: row.key, values: { ...row.values } })),
      extractedAt: view.extractedAt.toISOString(),
      sourceSyncedAt: iso(view.sourceSyncedAt),
    })),
    removed: [...delivery.removed],
  }
}

/** Splits a delivery so that no call carries more than `size` documents and records. */
export function inCalls(delivery: WireDelivery, size: number): WireDelivery[] {
  const documents = delivery.documents ?? []
  const records = delivery.records ?? []
  const calls: WireDelivery[] = []
  for (let at = 0; at < documents.length; at += size) {
    calls.push({ documents: documents.slice(at, at + size) })
  }
  for (let at = 0; at < records.length; at += size) {
    calls.push({ records: records.slice(at, at + size) })
  }
  // Rows, removals and the freshness travel with the last call: the data is whole by then.
  const last: WireDelivery = calls.pop() ?? {}
  calls.push({
    ...last,
    ...(delivery.rows?.length ? { rows: delivery.rows } : {}),
    ...(delivery.removed?.length ? { removed: delivery.removed } : {}),
    ...(delivery.dataAsOf ? { dataAsOf: delivery.dataAsOf } : {}),
  })
  return calls
}

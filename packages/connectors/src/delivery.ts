import type { Delivery, ExternalDocument, ExternalRecord, ItemPerson } from '@octobrief/domain'
import type { ExternalItem, ExternalPerson, Json, SyncBatch } from './port.ts'

const personOf = (person: ExternalPerson): ItemPerson => ({
  displayName: person.displayName,
  ...(person.email ? { email: person.email } : {}),
  ...(person.untrusted ? { untrusted: true } : {}),
})

function peopleOf(item: ExternalItem): ItemPerson[] {
  const named = [...(item.author ? [item.author] : []), ...item.people]
  return named.filter((person) => !person.app).map(personOf)
}

/** What a batch of a connector brings, as the product stores it, with where the next starts. */
export interface ConnectorDelivery extends Delivery {
  nextCursor: unknown
  done: boolean
}

/**
 * A batch of a connector as a delivery: items with bytes become documents, structured ones
 * records, extractions rows. What lies outside `perimeter` never enters.
 */
export function toDelivery(
  batch: SyncBatch<Json>,
  perimeter: ReadonlySet<string>,
): ConnectorDelivery {
  const documents: ExternalDocument[] = []
  const records: ExternalRecord[] = []
  for (const item of batch.items) {
    // What the system returns outside the perimeter never enters; neither does an item whose
    // people could not all be listed (a name that could not be hidden).
    if (!item.perimeter.every((id) => perimeter.has(id)) || item.peopleIncomplete) continue
    const common = {
      externalId: item.externalId,
      version: item.version,
      title: item.title,
      originAt: item.originAt,
      url: item.url,
      people: peopleOf(item),
    }
    if (item.bytes) {
      documents.push({
        ...common,
        mediaType: item.mediaType,
        bytes: item.bytes,
        ...(item.kind ? { systemKind: item.kind } : {}),
        ...(item.fileModifiedAt ? { fileModifiedAt: item.fileModifiedAt } : {}),
      })
    } else {
      records.push({ ...common, record: item.record })
    }
  }
  return {
    documents,
    records,
    rows: (batch.extractions ?? [])
      .filter((extraction) => perimeter.has(extraction.perimeter))
      .map((extraction) => ({
        view: extraction.view,
        perimeter: extraction.perimeter,
        rows: extraction.rows,
        extractedAt: extraction.extractedAt,
        sourceSyncedAt: extraction.sourceSyncedAt,
      })),
    removed: batch.removed ?? [],
    dataAsOf: batch.dataAsOf,
    nextCursor: batch.nextCursor,
    done: batch.done,
  }
}

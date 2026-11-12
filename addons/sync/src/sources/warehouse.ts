import type { Delivery } from '@octobrief/domain'
import type { Provider } from '../feeder.ts'
import { fromWire } from '../wire.ts'
import type { SystemSource } from './source.ts'

/**
 * The view a start day applies to, and its date column. Orders, invoices and revenue are always
 * read whole: the residuals and the totals of the economic reports need all of them.
 */
export const DATED_VIEWS: Readonly<Record<string, string>> = { v_timesheet_all: 'timesheetdate' }

/** The rows of the dated views from a day on; every other view as it is. */
export function fromDay(delivery: Delivery, since: Date | null): Delivery {
  if (since === null) return delivery
  return {
    ...delivery,
    rows: delivery.rows.map((view) => {
      const column = DATED_VIEWS[view.view]
      if (!column) return view
      const rows = view.rows.filter((row) => {
        const at = new Date(String(row.values[column]))
        // A row without a readable date is kept: leaving it out would hide data.
        return Number.isNaN(at.getTime()) || at.getTime() >= since.getTime()
      })
      return { ...view, rows }
    }),
  }
}

/**
 * The data warehouse through its provider. It has no cursor of its own: each run reads the
 * perimeter again and writes only what changed. The "cursor" carries the start day to the read.
 */
export function warehouseSource(provider: Provider): SystemSource {
  return {
    system: 'dwsi',
    startCursor: (since) => (since ? { since: since.toISOString() } : null),
    async *batches(cursor) {
      const day = (cursor as { since?: string } | null)?.since
      const since = day ? new Date(day) : null
      for await (const wire of provider.deliveries()) {
        yield { delivery: fromDay(fromWire(wire), since), cursor }
      }
    },
  }
}

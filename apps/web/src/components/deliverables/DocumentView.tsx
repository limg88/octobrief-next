'use client'
import { useTranslations } from 'next-intl'
import type { DeliverableBlockDto, DeliverableDocumentDto } from '@/lib/api-types'

const notes = (sources: readonly number[] | undefined) =>
  sources && sources.length > 0 ? ` [${sources.join(', ')}]` : ''

function Rows({
  columns,
  rows,
}: {
  columns: ReadonlyArray<{ id: string; title: string }>
  rows: ReadonlyArray<{ key: string; cells: ReadonlyArray<{ text: string | null }> }>
}) {
  const t = useTranslations('deliverables')
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t('noRows')}</p>
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" className="px-2 py-1 font-medium">
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border">
              {row.cells.map((cell, index) => (
                // The cells of a row follow its columns: the position is a stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <td key={index} className="px-2 py-1">
                  {cell.text ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Block({ block }: { block: DeliverableBlockDto }) {
  switch (block.kind) {
    case 'static':
      return <p className="text-sm">{block.text}</p>
    case 'value':
      return (
        <p className="text-sm">
          <span className="font-medium">{block.label}:</span> {block.cell.text ?? '—'}
          <span className="text-xs text-muted-foreground">{notes(block.cell.sources)}</span>
        </p>
      )
    case 'text':
      return (
        <div className="flex flex-col gap-1">
          {block.title && <h4 className="text-sm font-medium">{block.title}</h4>}
          <p className="text-sm">
            {block.segments.map((segment, index) => (
              // Sentences keep the order they were written in.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <span key={index}>
                {segment.text}
                <span className="text-xs text-muted-foreground">{notes(segment.sources)}</span>{' '}
              </span>
            ))}
          </p>
        </div>
      )
    case 'table':
      return (
        <div className="flex flex-col gap-1">
          {block.title && <h4 className="text-sm font-medium">{block.title}</h4>}
          <Rows columns={block.columns} rows={block.rows} />
        </div>
      )
    case 'list':
      return (
        <div className="flex flex-col gap-1">
          {block.title && <h4 className="text-sm font-medium">{block.title}</h4>}
          <Rows columns={block.columns} rows={block.items} />
        </div>
      )
    default:
      return null
  }
}

/** The document of a run as the PM reviews it: sections, values, texts, tables and notes. */
export function DocumentView({ document }: { document: DeliverableDocumentDto }) {
  const t = useTranslations('deliverables')
  return (
    <article className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <h3 className="text-lg font-semibold">{document.title}</h3>
      {document.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">{section.title}</h4>
          {section.blocks.map((block) => (
            <Block key={block.id} block={block} />
          ))}
        </section>
      ))}
      {document.sourceNotes.length > 0 && (
        <section
          aria-label={t('notes')}
          className="flex flex-col gap-1 border-t border-border pt-2"
        >
          <h4 className="text-xs font-medium text-muted-foreground">{t('notes')}</h4>
          <ol className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {document.sourceNotes.map((note) => (
              <li key={note.n}>
                [{note.n}] {note.label}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  )
}

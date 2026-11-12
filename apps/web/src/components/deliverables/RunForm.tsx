'use client'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DocumentDto, RecipeDto, RecipeParameterDto } from '@/lib/api-types'

type Row = Record<string, string>
/** What the PM typed for each parameter, before it becomes the value the recipe expects. */
export type FormState = Record<string, string | string[] | Row[] | { from: string; to: string }>

const FIELD = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

const empty = (parameter: RecipeParameterDto): FormState[string] => {
  if (parameter.type === 'period') return { from: '', to: '' }
  if (parameter.type === 'rows' || parameter.type === 'evidence_selection') return []
  return ''
}

/**
 * The values of a run as the recipe expects them. A parameter left empty is left out (the
 * recipe says which ones are required); a cell of a table is a number when its column is one.
 */
export function parameterValues(
  parameters: readonly RecipeParameterDto[],
  state: FormState,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const parameter of parameters) {
    const raw = state[parameter.id]
    switch (parameter.type) {
      case 'text':
      case 'choice':
        if (typeof raw === 'string' && raw.trim() !== '') {
          values[parameter.id] = { type: parameter.type, value: raw.trim() }
        }
        break
      case 'date':
        if (typeof raw === 'string' && raw !== '') values[parameter.id] = { type: 'date', day: raw }
        break
      case 'number':
        if (typeof raw === 'string' && raw.trim() !== '') {
          values[parameter.id] = { type: 'number', value: Number(raw.replace(',', '.')) }
        }
        break
      case 'period': {
        const period = raw as { from: string; to: string } | undefined
        if (period?.from && period.to) values[parameter.id] = { type: 'period', ...period }
        break
      }
      case 'evidence_selection':
        if (Array.isArray(raw) && raw.length > 0) {
          values[parameter.id] = { type: 'evidence_selection', evidenceIds: raw }
        }
        break
      case 'rows': {
        const rows = (Array.isArray(raw) ? (raw as Row[]) : []).map((row) =>
          Object.fromEntries(
            (parameter.columns ?? []).map((column) => {
              const cell = row[column.id] ?? ''
              return [column.id, column.kind === 'number' ? Number(cell.replace(',', '.')) : cell]
            }),
          ),
        )
        if (rows.length > 0) values[parameter.id] = { type: 'rows', rows }
        break
      }
      default:
        break
    }
  }
  return values
}

function RowsField({
  parameter,
  rows,
  onChange,
}: {
  parameter: RecipeParameterDto
  rows: Row[]
  onChange: (rows: Row[]) => void
}) {
  const t = useTranslations('deliverables')
  const columns = parameter.columns ?? []
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        // Rows are edited in place and only appended or removed at the end.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={index} className="flex flex-wrap gap-2">
          {columns.map((column) => (
            <Input
              key={column.id}
              aria-label={`${parameter.label} ${index + 1}: ${column.label}`}
              placeholder={column.label}
              type={column.kind === 'date' ? 'date' : 'text'}
              inputMode={column.kind === 'number' ? 'decimal' : undefined}
              className="w-40"
              value={row[column.id] ?? ''}
              onChange={(event) =>
                onChange(
                  rows.map((other, at) =>
                    at === index ? { ...other, [column.id]: event.target.value } : other,
                  ),
                )
              }
            />
          ))}
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, {}])}>
          {t('addRow')}
        </Button>
        {rows.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange(rows.slice(0, -1))}
          >
            {t('removeRow')}
          </Button>
        )}
      </div>
    </div>
  )
}

function Field({
  parameter,
  value,
  documents,
  onChange,
}: {
  parameter: RecipeParameterDto
  value: FormState[string]
  documents: readonly DocumentDto[]
  onChange: (value: FormState[string]) => void
}) {
  const t = useTranslations('deliverables')
  const label = parameter.label
  switch (parameter.type) {
    case 'choice':
      return (
        <select
          aria-label={label}
          className={FIELD}
          value={value as string}
          required={parameter.required}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(parameter.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )
    case 'period': {
      const period = value as { from: string; to: string }
      return (
        <div className="flex gap-2">
          <Input
            aria-label={`${label}: ${t('from')}`}
            type="date"
            required={parameter.required}
            value={period.from}
            onChange={(event) => onChange({ ...period, from: event.target.value })}
          />
          <Input
            aria-label={`${label}: ${t('to')}`}
            type="date"
            required={parameter.required}
            value={period.to}
            onChange={(event) => onChange({ ...period, to: event.target.value })}
          />
        </div>
      )
    }
    case 'evidence_selection': {
      const kinds = parameter.documentKinds
      const choices = documents.filter(
        (document) =>
          document.status === 'ready' &&
          (!kinds || (document.kind && kinds.includes(document.kind))),
      )
      return (
        <select
          aria-label={label}
          className={`${FIELD} ${parameter.multiple ? 'h-24' : ''}`}
          multiple={parameter.multiple === true}
          required={parameter.required}
          value={parameter.multiple ? (value as string[]) : ((value as string[])[0] ?? '')}
          onChange={(event) =>
            onChange([...event.target.selectedOptions].map((o) => o.value).filter(Boolean))
          }
        >
          {!parameter.multiple && <option value="">—</option>}
          {choices.map((document) => (
            <option key={document.id} value={document.id}>
              {document.fileName}
            </option>
          ))}
        </select>
      )
    }
    case 'rows':
      return <RowsField parameter={parameter} rows={value as Row[]} onChange={onChange} />
    case 'text':
    case 'date':
    case 'number':
      return (
        <Input
          aria-label={label}
          type={parameter.type === 'date' ? 'date' : 'text'}
          inputMode={parameter.type === 'number' ? 'decimal' : undefined}
          maxLength={parameter.maxLength}
          required={parameter.required}
          value={value as string}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    default:
      return <p className="text-xs text-muted-foreground">{t('unsupportedParameter')}</p>
  }
}

/** The form of a recipe: one field per parameter, as the recipe declares them. */
export function RunForm({
  recipe,
  documents,
  pending,
  onSubmit,
  onCancel,
}: {
  recipe: RecipeDto
  documents: readonly DocumentDto[]
  pending: boolean
  onSubmit: (parameters: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const t = useTranslations('deliverables')
  const [state, setState] = useState<FormState>(() =>
    Object.fromEntries(recipe.parameters.map((parameter) => [parameter.id, empty(parameter)])),
  )

  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit(parameterValues(recipe.parameters, state))
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div>
        <h2 className="text-lg font-semibold">{recipe.title}</h2>
        <p className="text-sm text-muted-foreground">{recipe.purpose}</p>
      </div>
      {recipe.parameters.map((parameter) => (
        <div key={parameter.id} className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            {parameter.label}
            {parameter.required ? ' *' : ''}
          </span>
          {parameter.help && (
            <span className="text-xs text-muted-foreground">{parameter.help}</span>
          )}
          <Field
            parameter={parameter}
            value={state[parameter.id] ?? empty(parameter)}
            documents={documents}
            onChange={(value) => setState((current) => ({ ...current, [parameter.id]: value }))}
          />
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {t('prepare')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

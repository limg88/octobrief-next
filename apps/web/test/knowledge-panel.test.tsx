import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { factsByKind, KnowledgePanel } from '@/components/memory/KnowledgePanel'
import type { FactDto, KnowledgeDto } from '@/lib/api-types'
import { mockApi, renderWithProviders } from './support/render'

const PATH = 'GET /api/projects/alpha/knowledge'

const BUDGET: FactDto = {
  id: 'f-1',
  kind: 'economics',
  key: 'economics:budget',
  statement: 'Il budget è 120.000 euro.',
  value: '120.000 euro',
  state: 'contested',
  createdAt: '2026-11-12T09:00:00.000Z',
  sources: [
    {
      documentId: 'd-1',
      fileName: 'SAL-Aurora.md',
      locator: { kind: 'page', page: 2 },
      excerpt: 'Budget: 120.000 euro',
    },
  ],
}
const RISK: FactDto = {
  ...BUDGET,
  id: 'f-2',
  kind: 'risk',
  key: 'risk:fornitore',
  statement: 'Il fornitore è in ritardo.',
  value: null,
  state: 'active',
}

const show = (knowledge: KnowledgeDto) => {
  mockApi({ [PATH]: () => Response.json(knowledge) })
  renderWithProviders(<KnowledgePanel slug="alpha" />)
}

describe('KnowledgePanel', () => {
  it('groups the facts by kind, risks before economics', () => {
    expect(factsByKind([BUDGET, RISK]).map(([kind]) => kind)).toEqual(['risk', 'economics'])
  })

  it('shows each fact with its value, its contradiction and the text it comes from', async () => {
    show({ facts: [BUDGET, RISK], progress: { reading: 0, failed: 0, compiled: 1 } })
    const item = (await screen.findByText('Il budget è 120.000 euro.')).closest('li') as HTMLElement
    expect(within(item).getByText('120.000 euro')).toBeTruthy()
    expect(within(item).getByText('in contraddizione')).toBeTruthy()
    expect(within(item).getByText(/SAL-Aurora\.md/)).toBeTruthy()
    expect(within(item).getByText('Budget: 120.000 euro')).toBeTruthy()
    expect(screen.getByText('Rischi')).toBeTruthy()
    expect(screen.queryByText(/ancora in lettura/)).toBeNull()
  })

  it('says how many documents are still being read or failed', async () => {
    show({ facts: [], progress: { reading: 2, failed: 1, compiled: 0 } })
    expect(await screen.findByText('2 documenti ancora in lettura…')).toBeTruthy()
    expect(screen.getByText('La lettura di 1 documento non è riuscita.')).toBeTruthy()
    expect(screen.queryByText(/Nessun fatto ancora/)).toBeNull()
  })

  it('invites to upload when nothing is known', async () => {
    show({ facts: [], progress: { reading: 0, failed: 0, compiled: 0 } })
    expect(await screen.findByText('Nessun fatto ancora: carica un documento.')).toBeTruthy()
  })
})

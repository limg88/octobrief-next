import { afterEach, describe, expect, it } from 'vitest'
import { createConnectorReader } from '../src/index.ts'
import { type FakeAdo, nodeIds, startFakeAdo, workItem } from './support/fake-ado.ts'

const PROJECT = 'Borea'
const OPTIONS = {
  organization: 'contoso',
  projectId: '6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c',
  projectName: PROJECT,
  pat: 'pat-ok',
  areas: [{ name: 'Team A', children: [{ name: 'Backend' }] }, { name: 'Team B' }],
  iterations: [{ name: 'Sprint 1' }, { name: 'Sprint 2' }],
  items: [],
}
const CONFIG = { organization: 'contoso', host: 'dev.azure.com', readOnlyToken: true }

describe('Azure DevOps through the connector reader', () => {
  let fake: FakeAdo
  afterEach(() => fake?.server.close())

  it('takes the whole project as its root area, however many nodes it has', async () => {
    const changedAt = '2026-11-04T10:00:00Z'
    const items = [
      workItem(1, {
        area: `${PROJECT}\\Team A\\Backend`,
        iteration: `${PROJECT}\\Sprint 2`,
        changedAt,
      }),
      workItem(2, { area: PROJECT, iteration: PROJECT, changedAt }),
    ]
    fake = await startFakeAdo({ ...OPTIONS, items })
    const reader = createConnectorReader({ devEndpoints: { ado: fake.server.origin } })
    const { config, perimeter } = await reader.connect('ado', CONFIG, 'pat-ok', [PROJECT])
    expect(perimeter).toEqual([nodeIds({ ...OPTIONS, items }).get(`area ${PROJECT}`)])
    const read = await reader.pull(
      { kind: 'ado', config, perimeter, secret: 'pat-ok' },
      null,
      new AbortController().signal,
    )
    expect(read.records.map((record) => record.externalId).sort()).toEqual(['1', '2'])
  })

  it('reads only the areas named, by their path with or without the project', async () => {
    const changedAt = '2026-11-04T10:00:00Z'
    const items = [
      workItem(1, { area: `${PROJECT}\\Team A\\Backend`, iteration: PROJECT, changedAt }),
      workItem(2, { area: `${PROJECT}\\Team B`, iteration: PROJECT, changedAt }),
      workItem(3, { area: PROJECT, iteration: PROJECT, changedAt }),
    ]
    fake = await startFakeAdo({ ...OPTIONS, items })
    const ids = nodeIds({ ...OPTIONS, items })
    const reader = createConnectorReader({ devEndpoints: { ado: fake.server.origin } })
    const connect = (...areas: string[]) =>
      reader.connect('ado', CONFIG, 'pat-ok', [PROJECT, ...areas])
    const { config, perimeter } = await connect(' team a ')
    expect(perimeter).toEqual([ids.get(`area ${PROJECT}\\Team A`)])
    const read = await reader.pull(
      { kind: 'ado', config, perimeter, secret: 'pat-ok' },
      null,
      new AbortController().signal,
    )
    expect(read.records.map((record) => record.externalId)).toEqual(['1'])
    expect((await connect('Borea/Team A/Backend', 'Team B')).perimeter).toEqual([
      ids.get(`area ${PROJECT}\\Team A\\Backend`),
      ids.get(`area ${PROJECT}\\Team B`),
    ])
    expect((await connect('borea')).perimeter).toEqual([ids.get(`area ${PROJECT}`)])
    // An area the project does not have: an error, never the rest read in its place.
    await expect(connect('Team A', 'Team Z')).rejects.toMatchObject({ code: 'source_not_found' })
  })
})

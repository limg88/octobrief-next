import { checkHealth } from '@octobrief/application'
import { getContainer } from '../server/container.ts'

export const dynamic = 'force-dynamic'

// Placeholder home until the Studio shell lands (increment 1).
export default async function HomePage() {
  const { probes } = await getContainer()
  const report = await checkHealth(probes)
  return (
    <main>
      <h1>Octobrief</h1>
      <p>
        System status: <strong>{report.status}</strong>
      </p>
      <ul>
        {report.components.map((component) => (
          <li key={component.name}>
            {component.name}: {component.status}
          </li>
        ))}
      </ul>
      <p>
        API: <a href="/api/openapi.json">/api/openapi.json</a>
      </p>
    </main>
  )
}

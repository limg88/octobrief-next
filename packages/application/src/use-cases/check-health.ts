import { type ComponentHealth, type HealthReport, summarizeHealth } from '@octobrief/domain'
import type { HealthProbe } from '../ports/health-probe.ts'

export const PROBE_TIMEOUT_MS = 2_000

/** Runs every probe in parallel; a probe that throws, answers false or is too slow counts as down. */
export async function checkHealth(
  probes: readonly HealthProbe[],
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<HealthReport> {
  const components = await Promise.all(probes.map((probe) => runProbe(probe, timeoutMs)))
  return summarizeHealth(components)
}

async function runProbe(probe: HealthProbe, timeoutMs: number): Promise<ComponentHealth> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    const up = await Promise.race([probe.check(), timeout])
    return { name: probe.name, status: up ? 'up' : 'down' }
  } catch {
    return { name: probe.name, status: 'down' }
  } finally {
    clearTimeout(timer)
  }
}

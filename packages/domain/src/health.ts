export type HealthStatus = 'up' | 'down'

export interface ComponentHealth {
  readonly name: string
  readonly status: HealthStatus
}

export interface HealthReport {
  readonly status: HealthStatus
  readonly components: readonly ComponentHealth[]
}

/** The system is up only when every component is up; with no components it is down. */
export function summarizeHealth(components: readonly ComponentHealth[]): HealthReport {
  const allUp = components.length > 0 && components.every((c) => c.status === 'up')
  return { status: allUp ? 'up' : 'down', components }
}

/** Checks one component the system needs (database, queue, …). Throws or resolves false when down. */
export interface HealthProbe {
  readonly name: string
  check(): Promise<boolean>
}

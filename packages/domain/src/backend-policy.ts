import { DomainError } from './errors.ts'

export const DATA_NATURES = ['synthetic', 'real'] as const
export type DataNature = (typeof DATA_NATURES)[number]

export type BackendId = string

/** The model behind each alias the organisation knows, to the backend it runs on. */
export type ModelBackends = Readonly<Record<string, BackendId>>

/**
 * The providers whose backends never receive real data, whatever the Admin chooses: Groq. A name
 * names one of them when one of its parts starts with it, the parts being split at anything but a
 * letter or a digit: `groq`, `Groq-Cloud`, `llm-api:groq`, `gateway/groq-eu`, a model
 * `groq/llama-3.1`. The database repeats the same test (`app_names_never_for_real`).
 */
export const NEVER_FOR_REAL_PROVIDERS = ['groq'] as const

const NEVER_FOR_REAL = new RegExp(`(^|[^a-z0-9])(${NEVER_FOR_REAL_PROVIDERS.join('|')})`)

/** Whether a backend id, a provider or a model alias names a provider never admitted for real data. */
export function namesNeverForReal(name: string): boolean {
  return NEVER_FOR_REAL.test(name.trim().toLowerCase())
}

/**
 * Refuses with `backend_never_for_real` a backend that may never receive real data: its id or its
 * provider names Groq, or a model of Groq (`groq/*`) is mapped to it, whatever alias the backend
 * has. Every other backend may be admitted by the Admin.
 */
export function assertBackendAdmissible(backend: BackendId, models: ModelBackends): void {
  if (namesNeverForReal(backend)) throw new DomainError('backend_never_for_real')
  for (const [model, target] of Object.entries(models)) {
    if (target === backend && namesNeverForReal(model)) {
      throw new DomainError('backend_never_for_real')
    }
  }
}

/**
 * Synthetic projects may use any backend; real ones only those explicitly allowed, and never one
 * that names a provider excluded from real data, even if it were listed.
 */
export function assertBackendAllowed(
  project: { readonly dataNature: DataNature },
  backend: BackendId,
  allowedForReal: readonly BackendId[],
): void {
  if (project.dataNature === 'synthetic') return
  if (!allowedForReal.includes(backend) || namesNeverForReal(backend)) {
    throw new DomainError('backend_not_allowed_for_real_data')
  }
}

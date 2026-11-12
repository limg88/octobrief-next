import { DomainError } from '../errors.ts'
import { DATA_CATEGORIES, type DataCategory } from '../recipe/categories.ts'

// Which categories of data may reach the version of a deliverable for the client. The default of
// the organization is the widest list there is: the Admin can only take categories out of it,
// never add one. Story points are not in any list: they follow their own rule (a warning the PM
// confirms explicitly), and they never count as estimates.

/** Ordered amounts, invoiced amounts and project data (states, counts, titles, dates). */
export const DEFAULT_CLIENT_CATEGORIES: readonly DataCategory[] = Object.freeze([
  'contract_amounts',
  'invoiced_amounts',
  'other',
])

declare const policyBrand: unique symbol

/** The categories admitted in a client version; only `clientPolicy` makes one. */
export interface ClientPolicy {
  readonly allowed: readonly DataCategory[]
  readonly [policyBrand]: true
}

/**
 * The client policy of the organization: the default, or the narrower list the Admin chose.
 * Throws `client_categories_widened` when the list names a category the default does not admit
 * (costs, margins, rates, estimates, hours, story points, personal data) or one that does not
 * exist: the list can only be restricted.
 */
export function clientPolicy(adminAllowed?: readonly string[]): ClientPolicy {
  const chosen = adminAllowed ?? DEFAULT_CLIENT_CATEGORIES
  for (const c of chosen) {
    if (!(DEFAULT_CLIENT_CATEGORIES as readonly string[]).includes(c)) {
      throw new DomainError('client_categories_widened')
    }
  }
  const allowed = DATA_CATEGORIES.filter((c) => chosen.includes(c))
  return Object.freeze({ allowed: Object.freeze(allowed) }) as ClientPolicy
}

/** How a category is treated in a client version. */
export type ClientTreatment = 'allowed' | 'story_points' | 'internal'

/**
 * The treatment of a category under a policy. A category outside the default is internal even
 * in a policy that lists it: a policy object not made by `clientPolicy` cannot widen anything.
 */
export function clientTreatment(policy: ClientPolicy, category: DataCategory): ClientTreatment {
  if (category === 'story_points') return 'story_points'
  const allowed = DEFAULT_CLIENT_CATEGORIES.includes(category) && policy.allowed.includes(category)
  return allowed ? 'allowed' : 'internal'
}

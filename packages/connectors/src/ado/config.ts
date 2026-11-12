import { ConnectorError } from '../errors.ts'
import type { HttpRule, PathPart } from '../rules.ts'

/** The two public hosts of Azure DevOps Services. */
export const ADO_HOSTS = ['dev.azure.com', 'visualstudio.com'] as const
export type AdoHost = (typeof ADO_HOSTS)[number]

/**
 * How a source reads one Azure DevOps project. The PM declares, when linking, that the personal
 * access token has read scopes only (Work Items Read, Project and Team Read): Azure DevOps gives
 * no way to read the scopes of a token with the token itself.
 */
export interface AdoConfig {
  /** The organization name, as in `dev.azure.com/<organization>`. */
  organization: string
  /** `dev.azure.com` (`https://dev.azure.com/<org>`) or `visualstudio.com` (`https://<org>.visualstudio.com`). */
  host: AdoHost
  /** The id of the project chosen from the list; null until the PM chooses it. */
  projectId: string | null
  /** The PM declared the token read-only. */
  readOnlyToken: true
}

/** Where the API of an organization is: origin, host for the rules, path before the project. */
export interface AdoEndpoint {
  origin: string
  host: string
  prefix: readonly string[]
}

// Organization names: letters, digits and hyphens, starting and ending with a letter or a digit.
const ORGANIZATION = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function organizationOf(value: unknown): string {
  if (typeof value !== 'string' || !ORGANIZATION.test(value)) {
    throw new ConnectorError('source_not_configured')
  }
  return value
}

function projectIdOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !GUID.test(value.toLowerCase())) {
    throw new ConnectorError('source_not_configured')
  }
  return value.toLowerCase()
}

export function parseAdoConfig(raw: unknown): AdoConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConnectorError('source_not_configured')
  }
  const cfg = raw as Record<string, unknown>
  if (!(ADO_HOSTS as readonly unknown[]).includes(cfg.host) || cfg.readOnlyToken !== true) {
    throw new ConnectorError('source_not_configured')
  }
  return {
    organization: organizationOf(cfg.organization),
    host: cfg.host as AdoHost,
    projectId: projectIdOf(cfg.projectId),
    readOnlyToken: true,
  }
}

/** The public endpoint of the organization: never anything the configuration could widen. */
export function publicEndpoint(cfg: AdoConfig): AdoEndpoint {
  const organization = organizationOf(cfg.organization)
  if (cfg.host === 'dev.azure.com') {
    return { origin: 'https://dev.azure.com', host: 'dev.azure.com', prefix: [organization] }
  }
  if (cfg.host === 'visualstudio.com') {
    const host = `${organization.toLowerCase()}.visualstudio.com`
    return { origin: `https://${host}`, host, prefix: [] }
  }
  throw new ConnectorError('source_not_configured')
}

const lit = (...names: readonly string[]): PathPart[] => names.map((literal) => ({ literal }))

/**
 * The calls of the connector: the list of projects and one project (GET), the classification
 * nodes (GET), the WIQL query and the batch read of work items (POST, both read). Nothing else,
 * and never a path with a name in it: area and iteration paths travel in the query body.
 */
export function adoRules(endpoint: AdoEndpoint, cfg: AdoConfig): HttpRule[] {
  const host = endpoint.host
  const at = (...names: string[]) => lit(...endpoint.prefix, ...names)
  const rules: HttpRule[] = [{ method: 'GET', host, path: at('_apis', 'projects') }]
  const projectId = projectIdOf(cfg.projectId)
  if (projectId !== null) {
    rules.push(
      { method: 'GET', host, path: at('_apis', 'projects', projectId) },
      { method: 'GET', host, path: at(projectId, '_apis', 'wit', 'classificationnodes') },
      { method: 'POST', host, path: at(projectId, '_apis', 'wit', 'wiql') },
      { method: 'POST', host, path: at(projectId, '_apis', 'wit', 'workitemsbatch') },
    )
  }
  return rules
}

/** A URL of the API: the endpoint, its prefix, the given segments and the query. */
export function apiUrl(
  endpoint: AdoEndpoint,
  segments: readonly string[],
  query: Record<string, string> = {},
): string {
  const path = [...endpoint.prefix, ...segments].map(encodeURIComponent).join('/')
  const search = new URLSearchParams({ ...query, 'api-version': '7.1' })
  return `${endpoint.origin}/${path}?${search.toString()}`
}

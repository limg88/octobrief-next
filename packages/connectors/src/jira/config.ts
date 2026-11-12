import { ConnectorError } from '../errors.ts'
import type { HttpRule, PathPart } from '../rules.ts'

/**
 * How a source reads Jira Cloud. The credentials are the email of the service account and an
 * API token (the secret): the PM declares, when linking, that the token has read scopes only
 * (`read:jira-work`, `read:jira-user`), since Jira gives no way to read the scopes of a token
 * with the token itself. A token with scopes is used through the Atlassian API gateway
 * (`api.atlassian.com/ex/jira/<cloudId>`): the configuration then names the site's cloud id.
 */
export interface JiraConfig {
  /** The site name, as in `<site>.atlassian.net`. */
  site: string
  /** The cloud id of the site, to reach it through the API gateway; null for the site itself. */
  cloudId: string | null
  /** The email of the account the token belongs to. */
  email: string
  /** The field holding story points (`customfield_<n>`), or null when none is read. */
  storyPointsField: string | null
  /** The field holding sprints (`customfield_<n>`), or null when none is read. */
  sprintField: string | null
  /** The PM declared the token read-only. */
  readOnlyToken: true
}

/** Where the API of a site is: origin, host for the rules, path before `rest`, links' origin. */
export interface JiraEndpoint {
  origin: string
  host: string
  prefix: readonly string[]
  /** The origin of the links to issues (`<origin>/browse/<key>`). */
  browse: string
}

// Site names: lowercase letters, digits and hyphens, starting and ending with a letter or digit.
const SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CUSTOM_FIELD = /^customfield_\d{1,10}$/
// The user of Basic authorization never holds a colon.
const EMAIL = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/

function siteOf(value: unknown): string {
  const site = typeof value === 'string' ? value.toLowerCase() : null
  if (site === null || !SITE.test(site)) throw new ConnectorError('source_not_configured')
  return site
}

function cloudIdOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !GUID.test(value.toLowerCase())) {
    throw new ConnectorError('source_not_configured')
  }
  return value.toLowerCase()
}

function fieldOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !CUSTOM_FIELD.test(value)) {
    throw new ConnectorError('source_not_configured')
  }
  return value
}

function emailOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !EMAIL.test(value)) {
    throw new ConnectorError('source_not_configured')
  }
  return value
}

export function parseJiraConfig(raw: unknown): JiraConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConnectorError('source_not_configured')
  }
  const cfg = raw as Record<string, unknown>
  if (cfg.readOnlyToken !== true) throw new ConnectorError('source_not_configured')
  return {
    site: siteOf(cfg.site),
    cloudId: cloudIdOf(cfg.cloudId),
    email: emailOf(cfg.email),
    storyPointsField: fieldOf(cfg.storyPointsField),
    sprintField: fieldOf(cfg.sprintField),
    readOnlyToken: true,
  }
}

/** The public endpoint of the site: never anything the configuration could widen. */
export function publicEndpoint(cfg: JiraConfig): JiraEndpoint {
  const site = `${siteOf(cfg.site)}.atlassian.net`
  const cloudId = cloudIdOf(cfg.cloudId)
  if (cloudId === null) {
    return { origin: `https://${site}`, host: site, prefix: [], browse: `https://${site}` }
  }
  return {
    origin: 'https://api.atlassian.com',
    host: 'api.atlassian.com',
    prefix: ['ex', 'jira', cloudId],
    browse: `https://${site}`,
  }
}

const lit = (...names: readonly string[]): PathPart[] => names.map((literal) => ({ literal }))

/**
 * The calls of the connector, all GET: the account (connection test), the project
 * list, the issue search and the comments of one issue (its id in the path). Nothing else, and
 * never a POST: the project ids travel in the query string of the search.
 */
export function jiraRules(endpoint: JiraEndpoint): HttpRule[] {
  const host = endpoint.host
  const api = (...names: PathPart[]): PathPart[] => [
    ...lit(...endpoint.prefix, 'rest', 'api', '3'),
    ...names,
  ]
  return [
    { method: 'GET', host, path: api(...lit('myself')) },
    { method: 'GET', host, path: api(...lit('project', 'search')) },
    { method: 'GET', host, path: api(...lit('search', 'jql')) },
    { method: 'GET', host, path: api(...lit('issue'), 'segment', ...lit('comment')) },
  ]
}

/** A URL of the API: the endpoint, its prefix, `rest/api/3`, the segments and the query. */
export function apiUrl(
  endpoint: JiraEndpoint,
  segments: readonly string[],
  query: [string, string][] = [],
): string {
  const path = [...endpoint.prefix, 'rest', 'api', '3', ...segments]
    .map(encodeURIComponent)
    .join('/')
  const search = new URLSearchParams(query).toString()
  return `${endpoint.origin}/${path}${search === '' ? '' : `?${search}`}`
}

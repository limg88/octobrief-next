import { ConnectorError } from '../errors.ts'
import { privateHostName } from '../private-hosts.ts'

/** A NetSuite project code as the warehouse writes it in `projectid`. */
export const PRJ_CODE = /^PRJ\d{6}$/
/** Project codes a PM declares for one source at most. */
export const MAX_PROJECT_CODES = 50
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/

/**
 * How to reach the warehouse: never a credential (the password is in the secret store). The
 * host is a name (TLS checks the certificate against it), never an IP address; the project codes
 * are those the PM declared, the list the perimeter is chosen from.
 */
export interface DwsiConfig {
  host: string
  port: number
  database: string
  user: string
  projectCodes: string[]
}

const notConfigured = (): never => {
  throw new ConnectorError('source_not_configured')
}

/** The id of the perimeter option of a project code. */
export const prjOption = (code: string) => `prj:${code}`

/** The project code of a perimeter option id, or null when it is not one. */
export function codeOfOption(id: string): string | null {
  const code = id.startsWith('prj:') ? id.slice(4) : ''
  return PRJ_CODE.test(code) ? code : null
}

export function parseDwsiConfig(raw: unknown): DwsiConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return notConfigured()
  const c = raw as Record<string, unknown>
  let host: string
  try {
    host = privateHostName(c.host)
  } catch {
    return notConfigured()
  }
  const port = c.port ?? 5432
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return notConfigured()
  }
  for (const name of [c.database, c.user]) {
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) return notConfigured()
  }
  const codes = c.projectCodes
  if (
    !Array.isArray(codes) ||
    codes.length === 0 ||
    codes.length > MAX_PROJECT_CODES ||
    !codes.every((code) => typeof code === 'string' && PRJ_CODE.test(code)) ||
    new Set(codes).size !== codes.length
  ) {
    return notConfigured()
  }
  return {
    host,
    port,
    database: c.database as string,
    user: c.user as string,
    projectCodes: [...(codes as string[])].sort(),
  }
}

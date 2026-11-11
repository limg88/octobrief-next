const MAX_RETURN_TO = 2048
const PROBE_ORIGIN = 'http://return-to.invalid'
const HOME = '/'

/** A same-origin relative path to go back to after login; `/` for anything else. */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > MAX_RETURN_TO) return HOME
  // Browsers treat `\` like `/` and drop control characters: `/\host` would leave the site.
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\p{Cc}]/u.test(raw)) return HOME
  if (!URL.canParse(raw, PROBE_ORIGIN)) return HOME
  const url = new URL(raw, PROBE_ORIGIN)
  const path = `${url.pathname}${url.search}${url.hash}`
  // Normalization can turn `/a/..//host` into `//host`: check the result again.
  if (url.origin !== PROBE_ORIGIN || path.startsWith('//')) return HOME
  return path
}

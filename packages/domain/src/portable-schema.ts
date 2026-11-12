// The JSON Schema profile sent to a model. Gateways and backends differ in what they accept
// (llm-api refuses `pattern`, a local grammar fails on long string lengths), so a schema for the
// model only says the shape: types, closed objects, required keys, enums and unions. Every other
// limit (lengths, counts, ranges, patterns) is enforced by the code that reads the answer.

export const PORTABLE_SCHEMA_KEYWORDS = Object.freeze([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
] as const)

type Schema = Readonly<Record<string, unknown>>

const isObject = (v: unknown): v is Schema =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Keywords that change the shape and cannot be said in the portable profile: dropping them
 * would send a different contract, so `portableSchema` refuses them.
 */
const UNTRANSLATABLE: readonly string[] = [
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'not',
  'prefixItems',
]

const sub = (v: unknown): unknown => (isObject(v) ? portableSchema(v) : v)

/**
 * A copy of `schema` in the portable profile: every keyword outside `PORTABLE_SCHEMA_KEYWORDS`
 * is dropped (at every depth), `const` becomes a one-value `enum` and `oneOf` an `anyOf`. A
 * schema-valued `additionalProperties` and tuple `items` are translated too. Property names are
 * kept whatever they are. Throws on a structural keyword it cannot translate (`$ref`, `$defs`,
 * `definitions`, `allOf`, `not`, `prefixItems`).
 */
export function portableSchema(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (UNTRANSLATABLE.includes(key)) {
      throw new Error(`portableSchema: ${key} cannot be sent to the model`)
    }
    switch (key) {
      case 'properties':
        if (isObject(value)) {
          out.properties = Object.fromEntries(
            Object.entries(value).map(([name, s]) => [name, sub(s)]),
          )
        }
        break
      case 'items':
        out.items = Array.isArray(value) ? value.map(sub) : sub(value)
        break
      case 'anyOf':
      case 'oneOf':
        if (Array.isArray(value)) out.anyOf = value.map(sub)
        break
      case 'additionalProperties':
        out.additionalProperties = sub(value)
        break
      case 'const':
        out.enum = [value]
        break
      case 'type':
      case 'required':
      case 'enum':
        out[key] = value
        break
      default:
        break
    }
  }
  return out
}

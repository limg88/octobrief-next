import { describe, expect, it } from 'vitest'
import { PORTABLE_SCHEMA_KEYWORDS, portableSchema } from '../src/recipe/index.ts'

describe('portableSchema', () => {
  it('keeps only types, properties, required, items, enums, unions and closed objects', () => {
    expect(
      portableSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 20, pattern: '\\S', format: 'email' },
          tags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 0 } },
          kind: { const: 'page' },
          value: { anyOf: [{ type: 'string', maxLength: 5 }, { type: 'null' }] },
        },
        required: ['name'],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'integer' } },
        kind: { enum: ['page'] },
        value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['name'],
      additionalProperties: false,
    })
  })

  it('keeps a property whose name is a dropped keyword', () => {
    expect(
      portableSchema({ type: 'object', properties: { pattern: { type: 'string', pattern: 'x' } } }),
    ).toEqual({ type: 'object', properties: { pattern: { type: 'string' } } })
  })

  it('turns oneOf into anyOf', () => {
    expect(
      portableSchema({
        oneOf: [
          { type: 'string', maxLength: 3 },
          { type: 'integer', minimum: 1 },
        ],
      }),
    ).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] })
  })

  it('goes into a schema-valued additionalProperties and into tuple items', () => {
    expect(
      portableSchema({
        type: 'object',
        additionalProperties: { type: 'string', pattern: 'x' },
      }),
    ).toEqual({ type: 'object', additionalProperties: { type: 'string' } })
    expect(
      portableSchema({ type: 'array', items: [{ type: 'string', minLength: 1 }, { const: 2 }] }),
    ).toEqual({ type: 'array', items: [{ type: 'string' }, { enum: [2] }] })
  })

  it('refuses the structural keywords it cannot translate, at any depth', () => {
    for (const key of ['$ref', '$defs', 'definitions', 'allOf', 'not', 'prefixItems']) {
      expect(() =>
        portableSchema({ type: 'object', properties: { a: { [key]: key === 'not' ? {} : [] } } }),
      ).toThrow(key)
    }
  })

  it('lists the keywords it keeps', () => {
    expect([...PORTABLE_SCHEMA_KEYWORDS].sort()).toEqual([
      'additionalProperties',
      'anyOf',
      'enum',
      'items',
      'properties',
      'required',
      'type',
    ])
  })
})

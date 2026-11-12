import { z } from '@hono/zod-openapi'

export const ErrorSchema = z.object({ error: z.string() }).openapi('Error')

/** Where a piece of text sits in its document. */
export const LocatorSchema = z
  .union([
    z.object({ kind: z.literal('page'), page: z.number() }),
    z.object({ kind: z.literal('paragraph'), index: z.number() }),
    z.object({ kind: z.literal('slide'), slide: z.number() }),
    z.object({ kind: z.literal('cell'), sheet: z.string(), ref: z.string() }),
    z.object({ kind: z.literal('line'), from: z.number(), to: z.number() }),
  ])
  .openapi('Locator')

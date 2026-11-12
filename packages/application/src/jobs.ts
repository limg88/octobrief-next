import { z } from 'zod'

/** Every background job: its name and the shape of its payload. Payloads never carry secrets. */
export const JOB_SCHEMAS = {
  'system.ping': z.object({ requestedAt: z.iso.datetime() }),
  'document.process': z.object({ documentId: z.uuid() }),
  'document.compile': z.object({ documentId: z.uuid() }),
  'source.sync': z.object({ sourceId: z.uuid() }),
  'question.answer': z.object({ questionId: z.uuid() }),
  'deliverable.run': z.object({ runId: z.uuid() }),
  'deliverable.revise': z.object({
    runId: z.uuid(),
    slots: z.array(z.string().min(1).max(200)).min(1).max(50),
    request: z.string().min(1).max(2000),
  }),
  'deliverable.render': z.object({ runId: z.uuid() }),
} as const

export type JobName = keyof typeof JOB_SCHEMAS
export type JobData = { [N in JobName]: z.infer<(typeof JOB_SCHEMAS)[N]> }

export const JOB_NAMES = Object.keys(JOB_SCHEMAS) as JobName[]

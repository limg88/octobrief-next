// Limits of runs and model calls that processes outside the domain read as plain values (the job
// queue sizes its deadlines on them, and the migration script loads the queue under Node's
// type stripping): this module imports nothing and uses only erasable TypeScript.

/** The longest a run may last, whoever sets the caps: a slow local model needs more than 30. */
export const MAX_RUN_DURATION_MINUTES = 120

/**
 * How long one model call may take, in whole seconds, per model: the Admin sets it for a model the
 * organisation knows; a model without one waits the default. The maximum is the absolute limit of
 * the gateway (115 s, rounded up): a longer wait could never be served, and every job deadline is
 * sized on it. It goes up again only when the gateway's limit does. The duration cap of the run still
 * bounds the whole run. A call past its time fails: it is never repeated by itself.
 */
export const MODEL_TIMEOUT_SECONDS = Object.freeze({ min: 10, max: 120, default: 80 })

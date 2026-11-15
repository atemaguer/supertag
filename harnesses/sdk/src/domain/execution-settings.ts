/**
 * Execution settings choose the harness, model, and reasoning effort a Tag's Tasks run with.
 * A Role sets the default and allowed range for its Tags; a Tag's own settings override the
 * Role's. Each Task records one resolved selection when SuperTag accepts it.
 */

/** Reasoning effort levels, lowest first. Each harness maps them to its own option. */
export const EXECUTION_EFFORTS = ["low", "medium", "high"] as const;
export type ExecutionEffort = (typeof EXECUTION_EFFORTS)[number];

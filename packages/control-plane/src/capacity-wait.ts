/**
 * Task events that record the latest placement check of a queued Task, in the order they were
 * observed: whether a bound Worker Host can run it.
 */
export function isSchedulingEvent(event: { readonly type: string }): boolean {
  return (
    event.type === "task.scheduling-incompatible" || event.type === "task.scheduling-compatible"
  );
}

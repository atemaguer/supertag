import type { TaskAttempt } from "@supertag/core";
import type { DurableWorklet } from "@supertag/worker-sdk";
import { describeWorklet } from "./worklet-descriptor.js";

/** Only a connected, selected Worklet can prove a missing Attempt was never accepted. */
export async function inspectCancelledAttempt(
  durable: DurableWorklet,
  attempt: TaskAttempt,
): Promise<{
  readonly receipt: Awaited<ReturnType<DurableWorklet["inspect"]>>;
  readonly absenceConfirmed: boolean;
}> {
  const placement = attempt.workerSnapshot["placement"];
  const selected =
    placement !== null && typeof placement === "object" && !Array.isArray(placement)
      ? (placement as Record<string, unknown>)
      : undefined;
  const hostId = selected?.["workerHostId"];
  const workletId = selected?.["workletId"];
  if (typeof hostId !== "string" || typeof workletId !== "string")
    return { receipt: await durable.inspect(attempt.id), absenceConfirmed: false };
  if (durable.inspectOnHost) {
    const receipt = await durable.inspectOnHost(attempt.id, hostId, workletId);
    return { receipt, absenceConfirmed: receipt === undefined };
  }
  const descriptor = await describeWorklet(durable);
  if (descriptor.host.id !== hostId || descriptor.id !== workletId)
    return { receipt: undefined, absenceConfirmed: false };
  const receipt = await durable.inspect(attempt.id);
  return { receipt, absenceConfirmed: receipt === undefined };
}

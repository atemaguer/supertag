/**
 * What the Tag details panel shows besides the conversation: the Tag's activity, its notes, its
 * network log, and its Schedules, converted from the Gateway's messages as the Rust app did.
 */

import type { Memory } from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/memories_pb";
import type {
  Tag,
  TaskNetworkLog,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import {
  type Schedule as ProtoSchedule,
  ScheduleState,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/schedules_pb";
import type { NetworkLog, Note, Schedule, TagActivity } from "../model/gateway";
import { compact, enumName, num, optionalNum } from "./convert";

/** How the Tag's unprompted messages were received, and how often its work may start. */
export function activity(tag: Tag): TagActivity {
  const attention = tag.attention;
  const rate = tag.startRate;
  return compact({
    windowDays: attention?.windowDays ?? 0,
    posted: attention?.posted ?? 0,
    read: attention?.read ?? 0,
    answered: attention?.answered ?? 0,
    quiet: attention?.quiet ?? 0,
    startRate:
      rate !== undefined && rate.starts > 0
        ? { starts: rate.starts, perMs: num(rate.perMs), inWindow: tag.startsInWindow }
        : undefined,
    idleObjectives:
      tag.idleObjectives.length === 0
        ? undefined
        : tag.idleObjectives.map((idle) => ({
            objectiveId: idle.objectiveId,
            outcome: idle.outcome,
            idleSinceMs: num(idle.idleSinceMs),
          })),
  } as TagActivity);
}

/** One note. The window learns only that it is private, never whose it is. */
export function note(memory: Memory): Note {
  return compact({
    memoryId: memory.memoryId,
    tagId: memory.tagId,
    text: memory.text,
    private: memory.audience !== undefined,
    createdBy: memory.createdBy,
    createdAtMs: num(memory.createdAtMs),
    updatedAtMs: num(memory.updatedAtMs),
    lastSeenAtMs: optionalNum(memory.lastSeenAtMs),
  } as Note);
}

/** One Task Attempt's network log: counts, and only what the proxy recorded. */
export function networkLog(value: TaskNetworkLog): NetworkLog {
  const log = value.log;
  return {
    taskId: value.taskId,
    attemptId: value.attemptId,
    allowed: num(log?.allowed ?? 0n),
    denied: num(log?.denied ?? 0n),
    unrecorded: num(log?.unrecorded ?? 0n),
    requests: (log?.requests ?? []).map((record) =>
      compact({
        atMs: num(record.atMs),
        method: record.method,
        origin: record.origin,
        path: record.path,
        allowed: record.allowed,
        reason: record.reason === "" ? undefined : record.reason,
        status: record.status === 0 ? undefined : record.status,
        credential: record.credential === "" ? undefined : record.credential,
      } as NetworkLog["requests"][number]),
    ),
  };
}

export function schedule(value: ProtoSchedule): Schedule {
  return compact({
    scheduleId: value.scheduleId,
    tagId: value.tagId,
    note: value.note,
    state: enumName(ScheduleState, value.state) as Schedule["state"],
    atMs: optionalNum(value.atMs),
    every:
      value.every === undefined
        ? undefined
        : { cron: value.every.cron, timeZone: value.every.timeZone },
    nextDueAtMs: optionalNum(value.nextDueAtMs),
    createdBy: value.createdBy,
    fireCount: num(value.fireCount),
    missedCount: num(value.missedCount),
    lastFiredAtMs: optionalNum(value.lastFiredAtMs),
  } as Schedule);
}

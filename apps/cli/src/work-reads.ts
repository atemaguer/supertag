import { create, type JsonValue, toJson } from "@bufbuild/protobuf";
import {
  ListSessionsResponseSchema,
  ListTasksResponseSchema,
  type Session,
  SessionSchema,
  type Task,
  TaskSchema,
} from "@supertag/operator-api";
import type { workClient } from "./operator-client.js";

type WorkClient = ReturnType<typeof workClient>;

/** The most recently created Tasks, one default page of `ListTasks`, as `list task` shows them. */
export async function recentTasks(work: WorkClient): Promise<Task[]> {
  return (await work.listTasks({})).tasks;
}

/** Every Session `ListSessions` returns, most recent interaction first. */
export async function allSessions(work: WorkClient): Promise<Session[]> {
  const sessions: Session[] = [];
  let pageToken = "";
  do {
    const page = await work.listSessions({ pageSize: 500, pageToken });
    sessions.push(...page.sessions);
    pageToken = page.nextPageToken;
  } while (pageToken !== "");
  return sessions;
}

// The proto3 JSON `get` and `watch` print.

export function workTaskJson(task: Task): JsonValue {
  return toJson(TaskSchema, task);
}

export function workTasksJson(tasks: readonly Task[]): JsonValue {
  return toJson(ListTasksResponseSchema, create(ListTasksResponseSchema, { tasks: [...tasks] }));
}

export function workSessionJson(session: Session): JsonValue {
  return toJson(SessionSchema, session);
}

export function workSessionsJson(sessions: readonly Session[]): JsonValue {
  return toJson(
    ListSessionsResponseSchema,
    create(ListSessionsResponseSchema, { sessions: [...sessions] }),
  );
}

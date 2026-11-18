// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Gateway, Schedule, ScheduleAction, WatchUpdate } from "../gateway";
import { watchFeed } from "../lib/watch";
import { ScheduleList, scheduleLine } from "./schedules";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

const weekly: Schedule = {
  scheduleId: "weekly",
  tagId: "lead",
  note: "Summarise the week",
  state: "active",
  every: { cron: "0 9 * * 1", timeZone: "Europe/Berlin" },
  nextDueAtMs: Date.UTC(2026, 10, 23, 8),
  createdBy: "operator:local",
  fireCount: 2,
  missedCount: 0,
};

function plane(schedules: Schedule[], changeSchedule: Gateway["changeSchedule"]) {
  return {
    tags: async () => [],
    conversations: async () => [],
    messages: async () => ({ conversationId: "c", messages: [] }),
    send: async () => {
      throw new Error("not sent");
    },
    markRead: async () => {
      throw new Error("not read");
    },
    events: async () => [],
    schedules: vi.fn(async () => schedules),
    changeSchedule,
    scope: "test",
    readCache: async () => undefined,
    writeCache: async () => {},
  } satisfies Gateway;
}

function button(label: string) {
  return host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
}

it("lists the Tag's pending Schedules and pauses, resumes, and deletes them", async () => {
  const listed: Schedule[] = [
    weekly,
    { ...weekly, scheduleId: "old", note: "Done once", state: "done", every: undefined },
  ];
  const changeSchedule = vi.fn(async (scheduleId: string, action: ScheduleAction) => {
    const state = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
    const schedule = listed.find((item) => item.scheduleId === scheduleId) as Schedule;
    listed[listed.indexOf(schedule)] = { ...schedule, state };
    return listed.find((item) => item.scheduleId === scheduleId) as Schedule;
  });
  const gateway = plane(listed, changeSchedule);
  act(() => root.render(createElement(ScheduleList, { gateway, tagId: "lead" })));
  await flush();

  // A finished Schedule is not shown.
  expect([...host.querySelectorAll(".schedule-note")].map((n) => n.textContent)).toEqual([
    "Summarise the week",
  ]);
  expect(host.querySelector(".schedule-when")?.textContent).toContain(
    "Every 0 9 * * 1 (Europe/Berlin) · next ",
  );

  await act(async () => button("Pause")?.click());
  await flush();
  expect(changeSchedule).toHaveBeenLastCalledWith("weekly", "pause");
  expect(host.querySelector(".schedule")?.getAttribute("data-state")).toBe("paused");
  expect(button("Resume")).not.toBeNull();

  await act(async () => button("Resume")?.click());
  await flush();
  expect(changeSchedule).toHaveBeenLastCalledWith("weekly", "resume");

  await act(async () => button("Delete")?.click());
  await flush();
  expect(changeSchedule).toHaveBeenLastCalledWith("weekly", "delete");
  // With nothing left to fire, the section says so.
  expect(host.querySelector(".schedule")).toBeNull();
  expect(host.querySelector(".schedule-status")?.textContent).toBe(
    "No Schedules will wake this Tag.",
  );
});

it("rereads the list when the Watch reports a change to this Tag's Schedules", async () => {
  const listed: Schedule[] = [];
  const gateway = plane(listed, undefined);
  const feed = watchFeed();
  act(() => root.render(createElement(ScheduleList, { gateway, watch: feed, tagId: "lead" })));
  feed.publish({ kind: "ready" });
  await flush();
  expect(host.querySelector(".schedule")).toBeNull();

  listed.push(weekly);
  const other: WatchUpdate = { kind: "schedule", tagId: "reviewer" };
  feed.publish(other);
  await flush();
  expect(host.querySelector(".schedule")).toBeNull();

  feed.publish({ kind: "schedule", tagId: "lead" });
  await flush();
  expect(host.querySelector(".schedule-note")?.textContent).toBe("Summarise the week");
});

it("describes one-off and paused Schedules", () => {
  expect(
    scheduleLine({ ...weekly, every: undefined, atMs: weekly.nextDueAtMs, createdBy: "tag:lead" }),
  ).toMatch(/^Once · next .+ · by tag:lead$/);
  expect(scheduleLine({ ...weekly, state: "paused" })).toBe(
    "Every 0 9 * * 1 (Europe/Berlin) · paused · by operator:local",
  );
});

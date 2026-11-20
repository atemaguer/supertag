// @vitest-environment happy-dom

import type {
  Gateway,
  HarnessMemory,
  NetworkLog,
  Note,
  Tag,
  TagActivity,
} from "@supertag/client/model";
import { watchFeed } from "@supertag/client/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  attentionLine,
  harnessMemoryCaption,
  networkRequestLine,
  networkTotals,
  noteCaption,
  periodWords,
  startRateLine,
  TagDetails,
} from "./tag-details";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;
const tag: Tag = {
  tagId: "lead",
  name: "Lead",
  instructions: "",
  allowedActions: [],
  revision: 1,
  harnessKind: "codex",
};
const note = (memoryId: string, extra: Partial<Note> = {}): Note => ({
  memoryId,
  tagId: "lead",
  text: `Note ${memoryId}`,
  private: false,
  createdBy: "tag:lead",
  createdAtMs: Date.now() - DAY,
  updatedAtMs: Date.now() - DAY,
  ...extra,
});

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

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

it("says who sees a note, when it was kept, and when a turn last used it", () => {
  const now = Date.now();
  expect(noteCaption(note("a", { private: true, lastSeenAtMs: now }), now)).toMatch(
    /^Only you · kept .+ · last used /,
  );
  expect(noteCaption(note("b"), now)).toMatch(/^Shared · kept .+ · not used yet$/);
});

it("lists the Tag's notes, deletes one, and rereads when the watch says they changed", async () => {
  let held = [note("one", { private: true }), note("two")];
  const notes = vi.fn(async () => held);
  const deleteNote = vi.fn(async (memoryId: string) => {
    const deleted = held.find((entry) => entry.memoryId === memoryId) as Note;
    held = held.filter((entry) => entry.memoryId !== memoryId);
    return deleted;
  });
  const gateway = { notes, deleteNote } as unknown as Gateway;
  const feed = watchFeed();
  const onClose = vi.fn();
  act(() => root.render(createElement(TagDetails, { gateway, watch: feed, tag, onClose })));
  await settle();
  expect(notes).toHaveBeenCalledWith("lead");
  // The panel is the Tag's: its name heads it, and Notes is one section of it.
  expect(host.querySelector("aside h2")?.textContent).toBe("Lead");
  expect(host.querySelector("section.details-section h3")?.textContent).toBe("Notes");
  const texts = () => [...host.querySelectorAll(".note-text")].map((node) => node.textContent);
  expect(texts()).toEqual(["Note one", "Note two"]);
  expect(host.textContent).toContain("Only you");

  const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete note: Note one"]');
  await act(async () => remove?.click());
  await settle();
  expect(deleteNote).toHaveBeenCalledWith("one");
  expect(texts()).toEqual(["Note two"]);

  // Another client or the Tag changed a note: the watch names this Tag, and the list rereads.
  held = [note("three"), ...held];
  const reads = notes.mock.calls.length;
  act(() => feed.publish({ kind: "memory", tagId: "other" }));
  await settle();
  expect(notes.mock.calls.length).toBe(reads);
  act(() => feed.publish({ kind: "memory", tagId: "lead" }));
  await settle();
  expect(texts()).toEqual(["Note three", "Note two"]);

  host.querySelector<HTMLButtonElement>('[aria-label="Close Tag details"]')?.click();
  expect(onClose).toHaveBeenCalled();
});

it("says when the Tag keeps no notes you can see", async () => {
  const gateway = { notes: async () => [] } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, tag, onClose() {} })));
  await settle();
  expect(host.textContent).toContain("Lead keeps no notes you can see yet");
  expect(host.querySelector('[aria-label^="Delete note"]')).toBeNull();
});

const harness = (memoryId: string, extra: Partial<HarnessMemory> = {}): HarnessMemory => ({
  memoryId,
  tagId: "lead",
  harness: "codex",
  private: false,
  kind: "fact",
  title: `Memory ${memoryId}`,
  text: "Staging runs in eu-north-1.",
  truncated: false,
  path: "extensions/ad_hoc/notes/region.md",
  updatedAtMs: Date.now() - DAY,
  ...extra,
});

it("says whose harness keeps a memory, who sees it, and a Work Session's proposal", () => {
  const now = Date.now();
  expect(harnessMemoryCaption(harness("a", { private: true }), now)).toMatch(
    /^Codex · fact · Only you · kept /,
  );
  expect(
    harnessMemoryCaption(
      harness("b", { harness: "claude-code", kind: "feedback", trust: "proposed-only" }),
      now,
    ),
  ).toMatch(/^Claude Code · feedback · Shared · proposed by a Work Session · kept /);
});

it("lists the Tag's harness memory on this Mac and deletes one", async () => {
  let held = [harness("one"), harness("two", { private: true })];
  const harnessMemory = vi.fn(async () => ({ memories: held, keptOn: ["laptop-2"] }));
  const deleteHarnessMemory = vi.fn(async (memoryId: string) => {
    const deleted = held.find((entry) => entry.memoryId === memoryId) as HarnessMemory;
    held = held.filter((entry) => entry.memoryId !== memoryId);
    return deleted;
  });
  const gateway = {
    notes: async () => [],
    harnessMemory,
    deleteHarnessMemory,
  } as unknown as Gateway;
  const feed = watchFeed();
  act(() => root.render(createElement(TagDetails, { gateway, watch: feed, tag, onClose() {} })));
  await settle();
  expect(harnessMemory).toHaveBeenCalledWith("lead");
  const section = () => host.querySelector('[aria-label="Harness memory"]');
  const texts = () =>
    [...(section()?.querySelectorAll(".note-text") ?? [])].map((n) => n.textContent);
  expect(texts()).toEqual([
    "Memory one — Staging runs in eu-north-1.",
    "Memory two — Staging runs in eu-north-1.",
  ]);
  expect(host.textContent).toContain("More is kept on Worker Host laptop-2");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Delete harness memory: Memory one"]')
      ?.click(),
  );
  await settle();
  expect(deleteHarnessMemory).toHaveBeenCalledWith("one");
  expect(texts()).toEqual(["Memory two — Staging runs in eu-north-1."]);
  // A finished turn may have changed it: the list rereads.
  held = [harness("three"), ...held];
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  expect(texts()).toHaveLength(2);
});

it("says why a shared Gateway shows no harness memory", async () => {
  const gateway = {
    notes: async () => [],
    harnessMemory: async () => ({
      memories: [],
      keptOn: [],
      unavailable: "Harness memory is read only on the machine whose Worker Host keeps it.",
    }),
  } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, tag, onClose() {} })));
  await settle();
  expect(host.textContent).toContain("read only on the machine whose Worker Host keeps it");
  expect(host.querySelector('[aria-label^="Delete harness memory"]')).toBeNull();
});

const networkLog: NetworkLog = {
  taskId: "9f1c2d3e4b5a",
  attemptId: "attempt-1",
  allowed: 2,
  denied: 1,
  unrecorded: 0,
  requests: [
    {
      atMs: Date.now(),
      method: "GET",
      origin: "https://api.github.com",
      path: "/repos/acme",
      allowed: true,
      status: 200,
      credential: "github",
    },
    {
      atMs: Date.now(),
      method: "CONNECT",
      origin: "https://example.org",
      path: "",
      allowed: false,
      reason: "origin is not in the Task's network scope",
    },
  ],
};

it("words each network request and an Attempt's totals", () => {
  expect(networkRequestLine(networkLog.requests[0]!)).toBe(
    "GET https://api.github.com/repos/acme → 200 · with github",
  );
  expect(networkRequestLine(networkLog.requests[1]!)).toBe(
    "CONNECT https://example.org refused: origin is not in the Task's network scope",
  );
  expect(networkTotals({ ...networkLog, unrecorded: 4 })).toBe(
    "2 allowed · 1 refused · 4 more not listed",
  );
});

it("shows the Tag's network log as its own section and rereads when a turn ends", async () => {
  let held: NetworkLog[] = [];
  const networkLogs = vi.fn(async () => held);
  const gateway = { notes: async () => [], networkLogs } as unknown as Gateway;
  const feed = watchFeed();
  act(() => root.render(createElement(TagDetails, { gateway, watch: feed, tag, onClose() {} })));
  await settle();
  expect(networkLogs).toHaveBeenCalledWith("lead");
  const headings = [...host.querySelectorAll("section.details-section h3")].map(
    (node) => node.textContent,
  );
  expect(headings).toEqual(["Notes", "Network"]);
  expect(host.textContent).toContain("No network log yet.");
  held = [networkLog];
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  const lines = [...host.querySelectorAll(".network-request")].map((node) => node.textContent);
  expect(lines).toEqual([
    "GET https://api.github.com/repos/acme → 200 · with github",
    "CONNECT https://example.org refused: origin is not in the Task's network scope",
  ]);
  expect(host.textContent).toContain("Task 9f1c2d3e");
});

it("tells a person who is not an operator that only operators see the network log", async () => {
  const gateway = {
    notes: async () => [],
    networkLogs: async () => {
      throw new Error("This connection cannot access that resource.");
    },
  } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, tag, onClose() {} })));
  await settle();
  expect(host.textContent).toContain("Only operators can see the network log.");
});

it("words a period, the unprompted messages, and a start rate", () => {
  expect(periodWords(60 * 60 * 1000)).toBe("hour");
  expect(periodWords(2 * 60 * 60 * 1000)).toBe("2 hours");
  expect(periodWords(24 * 60 * 60 * 1000)).toBe("day");
  expect(periodWords(30 * 60 * 1000)).toBe("30 minutes");
  expect(attentionLine({ windowDays: 30, posted: 6, read: 4, answered: 2, quiet: 19 })).toBe(
    "6 posted · 4 read · 2 answered · 19 stayed quiet",
  );
  expect(startRateLine({ starts: 10, perMs: 60 * 60 * 1000, inWindow: 3 })).toBe(
    "At most 10 per hour · 3 started in the last hour",
  );
});

it("shows the Tag's activity first and rereads it when one of its turns ends", async () => {
  let activity: TagActivity = { windowDays: 30, posted: 0, read: 0, answered: 0, quiet: 0 };
  const tagActivity = vi.fn(async () => activity);
  const feed = watchFeed();
  const gateway = { notes: async () => [], tagActivity } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, watch: feed, tag, onClose() {} })));
  await settle();
  const section = host.querySelector('[aria-labelledby="tag-details-activity"]');
  expect(host.querySelector(".details-section")).toBe(section);
  expect(section?.textContent).toContain("Lead sent nothing unprompted.");
  expect(section?.textContent).toContain("Start rate");
  expect(section?.textContent).toContain("None");
  activity = {
    windowDays: 30,
    posted: 6,
    read: 4,
    answered: 2,
    quiet: 19,
    startRate: { starts: 10, perMs: 60 * 60 * 1000, inWindow: 3 },
  };
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  expect(tagActivity).toHaveBeenCalledTimes(2);
  expect(section?.textContent).toContain("6 posted · 4 read · 2 answered · 19 stayed quiet");
  expect(section?.textContent).toContain("At most 10 per hour · 3 started in the last hour");
  expect(section?.textContent).not.toContain("Idle Objectives");
  activity = {
    ...activity,
    idleObjectives: [
      { objectiveId: "ship", outcome: "Ship SSO\nwith tests", idleSinceMs: Date.now() },
    ],
  };
  act(() => feed.publish({ kind: "conversation", tagId: "lead" }));
  await settle();
  expect(section?.textContent).toContain("Idle Objectives");
  expect(section?.textContent).toMatch(/Ship SSO · idle since /);
});

it("closes on Esc, unless a dialog or menu is open and takes it first", async () => {
  const onClose = vi.fn();
  const gateway = { notes: async () => [] } as unknown as Gateway;
  act(() => root.render(createElement(TagDetails, { gateway, tag, onClose })));
  await settle();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).not.toHaveBeenCalled();
  dialog.remove();
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

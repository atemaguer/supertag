// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlane, NetworkLog, Note, Tag } from "../control-plane";
import { watchFeed } from "../lib/watch";
import { networkRequestLine, networkTotals, noteCaption, TagDetails } from "./tag-details";

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
  const controlPlane = { notes, deleteNote } as unknown as ControlPlane;
  const feed = watchFeed();
  const onClose = vi.fn();
  act(() => root.render(createElement(TagDetails, { controlPlane, watch: feed, tag, onClose })));
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
  const controlPlane = { notes: async () => [] } as unknown as ControlPlane;
  act(() => root.render(createElement(TagDetails, { controlPlane, tag, onClose() {} })));
  await settle();
  expect(host.textContent).toContain("Lead keeps no notes you can see yet");
  expect(host.querySelector('[aria-label^="Delete note"]')).toBeNull();
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
  const controlPlane = { notes: async () => [], networkLogs } as unknown as ControlPlane;
  const feed = watchFeed();
  act(() =>
    root.render(createElement(TagDetails, { controlPlane, watch: feed, tag, onClose() {} })),
  );
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
  const controlPlane = {
    notes: async () => [],
    networkLogs: async () => {
      throw new Error("permission denied: the call needs an operator");
    },
  } as unknown as ControlPlane;
  act(() => root.render(createElement(TagDetails, { controlPlane, tag, onClose() {} })));
  await settle();
  expect(host.textContent).toContain("Only operators can see the network log.");
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlane, Note, Tag } from "../control-plane";
import { watchFeed } from "../lib/watch";
import { noteCaption, TagDetails } from "./tag-details";

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

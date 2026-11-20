// @vitest-environment happy-dom

import type { AppearanceSave, Tag, TagAppearance } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppearance } from "../avatars/felt";
import { type AvatarEditing, AvatarEditorDialog } from "./avatar-editor";
import { TagDetails } from "./tag-details";

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

const patch: Tag = {
  tagId: "patch",
  name: "Patch",
  instructions: "",
  allowedActions: [],
  revision: 4,
  harnessKind: "codex",
  appearanceRevision: 0,
};

const reader: TagAppearance = {
  version: 1,
  catalog: "felt-v1",
  head: "pear",
  color: "moss",
  expression: "curious",
  hat: "plum-beanie",
  glasses: "round-charcoal",
  headphones: null,
};

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

function editing(
  setAppearance: AvatarEditing["admin"]["setAppearance"],
  tag: AvatarEditing["admin"]["tag"] = vi.fn(),
) {
  return { admin: { setAppearance, tag }, onTagChanged: vi.fn() };
}

async function open(tag: Tag, avatar: AvatarEditing, onOpenChange = vi.fn()) {
  await act(async () => {
    root.render(
      createElement(AvatarEditorDialog, { tag, editing: avatar, open: true, onOpenChange }),
    );
  });
  return onOpenChange;
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === name,
  ) as HTMLButtonElement;
const click = (name: string) => act(async () => button(name).click());
const pressed = () =>
  [...document.querySelectorAll('.avatar-option[aria-pressed="true"]')].map((n) => n.textContent);

it("opens on the default a Tag's ID derives, and saves a changed draft once", async () => {
  let finish: (save: AppearanceSave) => void = () => {};
  const setAppearance = vi.fn(
    () =>
      new Promise<AppearanceSave>((resolve) => {
        finish = resolve;
      }),
  );
  const avatar = editing(setAppearance);
  const onOpenChange = await open(patch, avatar);
  const start = defaultAppearance("patch");
  // Nothing changed yet, so there is nothing to save.
  expect(button("Save avatar").disabled).toBe(true);
  // A preset is a draft to edit; switching tabs keeps it.
  await click("Moss reader");
  await click("Color");
  await click("Coral red");
  await click("Shape");
  expect(pressed()).toContain("Pear");
  await click("Color");
  expect(pressed()).toContain("Coral red");
  expect(document.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Avatar preview: Pear, coral red, curious, with a plum beanie and round glasses",
  );
  await click("Save avatar");
  // A pending save can't be sent twice.
  expect(button("Saving…").disabled).toBe(true);
  await click("Saving…");
  expect(setAppearance).toHaveBeenCalledTimes(1);
  expect(setAppearance).toHaveBeenCalledWith("patch", { ...reader, color: "coral" }, 0);
  const saved = { ...patch, appearance: { ...reader, color: "coral" }, appearanceRevision: 1 };
  await act(async () => finish({ saved }));
  expect(avatar.onTagChanged).toHaveBeenCalledWith(saved);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(start.catalog).toBe("felt-v1");
});

it("explains an accessory conflict beside the option and swaps on request", async () => {
  const avatar = editing(vi.fn());
  await open({ ...patch, appearance: reader, appearanceRevision: 2 }, avatar);
  await click("Accessories");
  const headphones = button("Navy headphones");
  expect(headphones.getAttribute("aria-disabled")).toBe("true");
  expect(
    document.getElementById(headphones.getAttribute("aria-describedby") ?? "")?.textContent,
  ).toContain("can't be worn with the plum beanie");
  await click("Navy headphones");
  expect(pressed()).toContain("Plum beanie");
  await click("Remove the plum beanie and wear navy headphones");
  expect(pressed()).toEqual(["No hat", "Round glasses", "Navy headphones"]);
});

it("reloads the latest saved look after a stale save before writing again", async () => {
  const latest = { ...patch, appearance: { ...reader, head: "bean" }, appearanceRevision: 3 };
  const setAppearance = vi.fn(async (): Promise<AppearanceSave> => ({ conflict: latest }));
  const avatar = editing(setAppearance);
  await open({ ...patch, appearance: reader, appearanceRevision: 2 }, avatar);
  await click("Color");
  await click("Ocean blue");
  await click("Save avatar");
  await settle();
  expect(document.body.textContent).toContain("Someone saved another avatar for Patch");
  expect(button("Save avatar").disabled).toBe(true);
  await click("Load the latest avatar");
  await click("Shape");
  expect(pressed()).toContain("Wide bean");
  await click("Pear");
  await click("Save avatar");
  expect(setAppearance).toHaveBeenLastCalledWith("patch", reader, 3);
});

it("keeps the draft after a failed save and reads the Tag before retrying", async () => {
  const setAppearance = vi
    .fn<AvatarEditing["admin"]["setAppearance"]>()
    .mockRejectedValueOnce("The Gateway is unreachable.");
  // The first save did land: the Tag already wears the draft at the next revision.
  const tag = vi.fn(async () => ({
    ...patch,
    appearance: { ...reader, expression: "sleepy" },
    appearanceRevision: 3,
  }));
  const avatar = editing(setAppearance, tag);
  const onOpenChange = await open({ ...patch, appearance: reader, appearanceRevision: 2 }, avatar);
  await click("Expression");
  await click("Sleepy");
  await click("Save avatar");
  await settle();
  expect(document.body.textContent).toContain("The Gateway is unreachable.");
  expect(pressed()).toContain("Sleepy");
  await click("Try again");
  await settle();
  expect(tag).toHaveBeenCalledWith("patch");
  expect(setAppearance).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("shows a look from a catalog it doesn't bundle without letting it be edited", async () => {
  await open(
    { ...patch, appearance: { ...reader, catalog: "felt-v7" }, appearanceRevision: 5 },
    editing(vi.fn()),
  );
  expect(document.body.textContent).toContain("felt-v7 art catalog");
  expect(button("Save avatar").disabled).toBe(true);
  expect(document.querySelector(".portrait-fallback")?.textContent).toBe("P");
});

it("offers Edit avatar in the Tag details only where Tags can be managed", async () => {
  const gateway = {} as never;
  await act(async () =>
    root.render(createElement(TagDetails, { gateway, tag: patch, onClose: vi.fn() })),
  );
  expect(button("Edit avatar")).toBeUndefined();
  expect(host.textContent).toContain("Only an operator can change Patch's avatar.");
  await act(async () =>
    root.render(
      createElement(TagDetails, {
        gateway,
        tag: patch,
        avatar: editing(vi.fn()),
        onClose: vi.fn(),
      }),
    ),
  );
  await click("Edit avatar");
  expect(document.querySelector(".avatar-dialog")).not.toBeNull();
  // Escape discards the draft and closes only the dialog.
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await settle();
  expect(document.querySelector(".avatar-dialog")).toBeNull();
  expect(host.querySelector("#tag-details")).not.toBeNull();
});

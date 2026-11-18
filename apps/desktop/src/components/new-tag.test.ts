// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Tag } from "../gateway";
import { type TagAdmin, tagAdminRefusal, tagIdFor } from "../tag-admin";
import { NewTagDialog } from "./new-tag";

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

const created: Tag = {
  tagId: "release-bot",
  name: "Release Bot",
  instructions: "",
  allowedActions: ["commands:execute", "files:write"],
  revision: 1,
  harnessKind: "codex",
};

async function open(admin: TagAdmin, onCreated = vi.fn(), onOpenChange = vi.fn()) {
  await act(async () => {
    root.render(createElement(NewTagDialog, { admin, open: true, onOpenChange, onCreated }));
  });
  return { onCreated, onOpenChange };
}

const field = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

it("creates a Tag from a name, an offered harness, and the only Workspace", async () => {
  const admin: TagAdmin = {
    // The Worker Hosts' harnesses arrive sorted by name; Codex and Claude Code are offered first.
    options: async () => ({
      harnesses: ["claude_code", "codex", "opencode"],
      workspaces: ["supertag"],
    }),
    create: vi.fn(async () => created),
  };
  const { onCreated, onOpenChange } = await open(admin);
  const harness = field<HTMLSelectElement>("#tag-harness");
  expect([...harness.options].map((option) => option.textContent)).toEqual([
    "Codex",
    "Claude Code",
    "OpenCode",
  ]);
  expect(harness.value).toBe("codex");
  expect(field<HTMLSelectElement>("#tag-workspace").value).toBe("supertag");

  act(() => type(field<HTMLInputElement>("#tag-name"), "Release Bot"));
  expect(field("#tag-id").textContent).toContain("ID: release-bot");
  act(() => choose(harness, "opencode"));
  act(() => type(field<HTMLInputElement>("#tag-work-sessions"), "3"));
  await act(async () => {
    field<HTMLFormElement>(".workspace-dialog form").requestSubmit();
  });
  expect(admin.create).toHaveBeenCalledWith({
    tagId: "release-bot",
    name: "Release Bot",
    harness: "opencode",
    workspaceId: "supertag",
    maxWorkSessions: 3,
  });
  expect(onCreated).toHaveBeenCalledWith(created);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("offers every harness when no Worker Host is connected, and shows a refusal", async () => {
  const admin: TagAdmin = {
    options: async () => ({ harnesses: [], workspaces: [] }),
    create: vi.fn(async () => {
      throw "A Tag with that ID or name already exists.";
    }),
  };
  const { onCreated } = await open(admin);
  const harness = field<HTMLSelectElement>("#tag-harness");
  expect(harness.options.length).toBeGreaterThanOrEqual(4);
  expect(harness.value).toBe("codex");
  expect(document.querySelector("#tag-workspace")).toBeNull();
  expect(document.body.textContent).toContain("No Worker Host is connected.");

  act(() => type(field<HTMLInputElement>("#tag-name"), "lead"));
  await act(async () => {
    field<HTMLFormElement>(".workspace-dialog form").requestSubmit();
  });
  expect(admin.create).toHaveBeenCalledWith({
    tagId: "lead",
    name: "lead",
    harness: "codex",
    workspaceId: undefined,
    maxWorkSessions: 8,
  });
  expect(field('[role="alert"]').textContent).toBe("A Tag with that ID or name already exists.");
  expect(onCreated).not.toHaveBeenCalled();
});

it("derives Tag IDs as supertag init names Tags, and refuses non-operators", () => {
  expect(tagIdFor("Release Bot")).toBe("release-bot");
  expect(tagIdFor("  --Ops.Team__2 ")).toBe("ops-team-2");
  expect(tagIdFor("!!!")).toBe("");
  expect(tagIdFor("a".repeat(80))).toHaveLength(63);
  expect(tagAdminRefusal("operator:local")).toBeUndefined();
  expect(tagAdminRefusal(undefined)).toBeUndefined();
  expect(tagAdminRefusal("client:alice-laptop")).toBe(
    "Only an operator can create Tags. This app is connected as client:alice-laptop.",
  );
});

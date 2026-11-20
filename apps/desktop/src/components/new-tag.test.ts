// @vitest-environment happy-dom

import type { Tag } from "@supertag/client/model";
import { tagAdminRefusal, tagIdFor } from "@supertag/client/model";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewTagDialog, type TagCreation } from "./new-tag";

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

async function open(admin: TagCreation, onCreated = vi.fn(), onOpenChange = vi.fn()) {
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
  const admin: TagCreation = {
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
    webAccess: true,
  });
  expect(onCreated).toHaveBeenCalledWith(created);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("offers every harness when no Worker Host is connected, and shows a refusal", async () => {
  const admin: TagCreation = {
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
    webAccess: true,
  });
  expect(field('[role="alert"]').textContent).toBe("A Tag with that ID or name already exists.");
  expect(onCreated).not.toHaveBeenCalled();
});

it("offers no folder outside the local Gateway, and says when a harness runs no commands", async () => {
  const admin: TagCreation = {
    options: async () => ({
      harnesses: ["claude_code", "codex"],
      workspaces: ["supertag", "site"],
      noCommands: ["claude_code"],
    }),
    create: vi.fn(async () => created),
  };
  await open(admin);
  const workspace = field<HTMLSelectElement>("#tag-workspace");
  expect([...workspace.options].map((option) => option.textContent)).toEqual([
    "None",
    "site",
    "supertag",
  ]);
  expect(document.body.textContent).not.toContain("reads and edits files only");
  act(() => choose(field<HTMLSelectElement>("#tag-harness"), "claude_code"));
  expect(document.body.textContent).toContain(
    "Claude Code has no sandbox of its own, and no host here lets it run commands",
  );
});

it("gives web access by default, and warns when Codex is left without it", async () => {
  const admin: TagCreation = {
    options: async () => ({ harnesses: ["claude_code", "codex"], workspaces: [] }),
    create: vi.fn(async () => created),
  };
  await open(admin);
  const web = field<HTMLInputElement>("#tag-web-access");
  expect(web.checked).toBe(true);
  expect(document.body.textContent).toContain("its commands can reach the network");
  const warning = "Current Codex models may not run commands without web access.";
  act(() => web.click());
  expect(web.checked).toBe(false);
  expect(document.body.textContent).toContain(warning);
  act(() => choose(field<HTMLSelectElement>("#tag-harness"), "claude_code"));
  expect(document.body.textContent).not.toContain(warning);
  expect(document.body.textContent).not.toContain("sandboxes without network");

  act(() => type(field<HTMLInputElement>("#tag-name"), "Vault"));
  await act(async () => {
    field<HTMLFormElement>(".workspace-dialog form").requestSubmit();
  });
  expect(admin.create).toHaveBeenCalledWith(
    expect.objectContaining({ tagId: "vault", harness: "claude_code", webAccess: false }),
  );
});

it("leaves web access off where the harness's hosts have no network", async () => {
  const admin: TagCreation = {
    options: async () => ({
      harnesses: ["claude_code", "codex"],
      workspaces: [],
      noWeb: ["claude_code"],
    }),
    create: vi.fn(async () => created),
  };
  await open(admin);
  const web = field<HTMLInputElement>("#tag-web-access");
  expect(web.checked).toBe(true);
  act(() => choose(field<HTMLSelectElement>("#tag-harness"), "claude_code"));
  expect(web.checked).toBe(false);
  expect(document.body.textContent).toContain(
    "Claude Code runs here only in sandboxes without network",
  );
});

it("offers Cursor no web access", async () => {
  const admin: TagCreation = {
    options: async () => ({ harnesses: ["cursor"], workspaces: [] }),
    create: vi.fn(async () => created),
  };
  await open(admin);
  const web = field<HTMLInputElement>("#tag-web-access");
  expect(web.checked).toBe(false);
  expect(web.disabled).toBe(true);
  expect(document.body.textContent).toContain("Cursor has no tool for reading web pages.");
});

it("adds a chosen folder as a Workspace and starts the Tag on its branch", async () => {
  let finish: (added: { workspace: string; workspaceRef: string } | null) => void = () => {};
  const admin: TagCreation = {
    options: async () => ({ harnesses: ["codex"], workspaces: ["supertag"] }),
    create: vi.fn(async () => created),
    addFolder: vi.fn(
      () =>
        new Promise<{ workspace: string; workspaceRef: string } | null>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  await open(admin);
  const workspace = field<HTMLSelectElement>("#tag-workspace");
  expect([...workspace.options].map((option) => option.textContent)).toEqual([
    "None",
    "supertag",
    "Choose a folder…",
  ]);
  act(() => choose(workspace, " choose-folder"));
  expect(admin.addFolder).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Adding the folder");
  expect(field<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
  await act(async () => finish({ workspace: "site", workspaceRef: "trunk" }));
  expect(workspace.value).toBe("site");
  expect([...workspace.options].map((option) => option.textContent)).toEqual([
    "None",
    "site",
    "supertag",
    "Choose a folder…",
  ]);

  act(() => type(field<HTMLInputElement>("#tag-name"), "Site"));
  await act(async () => {
    field<HTMLFormElement>(".workspace-dialog form").requestSubmit();
  });
  expect(admin.create).toHaveBeenCalledWith({
    tagId: "site",
    name: "Site",
    harness: "codex",
    workspaceId: "site",
    workspaceRef: "trunk",
    workspaceCommit: undefined,
    maxWorkSessions: 8,
    webAccess: true,
  });
});

it("keeps the Workspace when choosing a folder is cancelled, and shows why adding failed", async () => {
  const addFolder = vi
    .fn<() => Promise<null>>()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce("/tmp/x is not in a git repository. Choose one.");
  const admin: TagCreation = {
    options: async () => ({ harnesses: ["codex"], workspaces: ["supertag"] }),
    create: vi.fn(async () => created),
    addFolder,
  };
  await open(admin);
  const workspace = field<HTMLSelectElement>("#tag-workspace");
  expect(workspace.value).toBe("supertag");
  await act(async () => choose(workspace, " choose-folder"));
  expect(workspace.value).toBe("supertag");
  await act(async () => choose(workspace, " choose-folder"));
  expect(workspace.value).toBe("supertag");
  expect(field('[role="alert"]').textContent).toBe(
    "/tmp/x is not in a git repository. Choose one.",
  );
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

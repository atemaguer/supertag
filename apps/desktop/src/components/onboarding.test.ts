// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SetupCheck, SetupHarness } from "../gateway";
import { harnessState, Onboarding, repositoryLine, type SetupApi } from "./onboarding";

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

const harness = (id: string, extra: Partial<SetupHarness> = {}): SetupHarness => ({
  harness: id,
  installed: true,
  signed_in: true,
  node: null,
  fix: null,
  ...extra,
});

const project: SetupCheck = {
  cli: "/Users/me/.local/bin/supertag",
  ready: true,
  repository: {
    directory: "/Users/me/code/app",
    git: true,
    root: "/Users/me/code/app",
    name: "app",
    has_commits: true,
    branch: "main",
    fix: null,
  },
  harnesses: [
    harness("codex", {
      signed_in: false,
      fix: "Codex: run codex login.",
      fix_command: "codex login",
    }),
    harness("claude-code", { node: { ok: true, fix: null } }),
    harness("cursor", { installed: false, signed_in: null }),
    harness("opencode", { installed: false, signed_in: null }),
  ],
  state: { directory: "/Users/me/.supertag", configured: false, repository_mapped: false },
};

const buttons = () => [...document.querySelectorAll("button")];
const button = (text: string) =>
  buttons().find((candidate) => candidate.textContent?.includes(text));

it("words a folder and a harness as the checks report them", () => {
  expect(repositoryLine(project)).toEqual({ ok: true, text: "app · main" });
  expect(
    repositoryLine({
      repository: {
        ...(project.repository as NonNullable<SetupCheck["repository"]>),
        has_commits: false,
        fix: "No commits yet: make one.",
      },
    }),
  ).toEqual({ ok: false, text: "No commits yet: make one." });
  expect(harnessState(harness("codex"))).toEqual({ ready: true, text: "Signed in" });
  expect(harnessState(harness("codex", { installed: false })).text).toBe("Not installed");
  expect(
    harnessState(harness("claude-code", { node: { ok: false, fix: "Install Node.js 22." } })).text,
  ).toBe("Needs Node.js");
  expect(harnessState(harness("codex", { signed_in: null })).ready).toBe(false);
});

it("sets SuperTag up from a chosen folder with a signed-in harness, after a re-check", async () => {
  const api: SetupApi = {
    check: vi.fn(async (_directory?: string, only?: string) =>
      only === "codex" ? { ...project, harnesses: [harness("codex")] } : project,
    ),
    chooseFolder: vi.fn(async () => "/Users/me/code/app"),
    setUp: vi.fn(async () => ({ tag: "lead" })),
  };
  const onReady = vi.fn();
  await act(async () => {
    root.render(createElement(Onboarding, { api, initial: { cli: project.cli }, onReady }));
  });
  expect(button("Set up and start")?.disabled).toBe(true);

  await act(async () => button("Choose folder")?.click());
  expect(api.check).toHaveBeenCalledWith("/Users/me/code/app", undefined);
  expect(document.body.textContent).toContain("app · main");
  // Only Codex and Claude Code are offered; Claude Code is ready, so it is chosen.
  expect(document.body.textContent).not.toContain("Cursor");
  expect(document.body.textContent).toContain("codex login");
  const radio = (value: string) =>
    document.querySelector(`input[value="${value}"]`) as HTMLInputElement;
  expect(radio("codex").disabled).toBe(true);
  expect(radio("claude-code").checked).toBe(true);

  // After signing in, Re-check that harness alone.
  await act(async () => button("Check again")?.click());
  expect(api.check).toHaveBeenLastCalledWith("/Users/me/code/app", "codex");
  expect(radio("codex").disabled).toBe(false);
  await act(async () => radio("codex").click());

  await act(async () => button("Set up and start")?.click());
  expect(api.setUp).toHaveBeenCalledWith("/Users/me/code/app", "codex");
  expect(onReady).toHaveBeenCalled();
});

it("says how to install the CLI when there is none", async () => {
  const api: SetupApi = {
    check: vi.fn(async () => ({
      cli: null,
      install: "curl -fsSL https://example.com/install.sh | sh",
    })),
    chooseFolder: vi.fn(),
    setUp: vi.fn(),
  };
  await act(async () => {
    root.render(
      createElement(Onboarding, {
        api,
        initial: { cli: null, install: "curl -fsSL https://example.com/install.sh | sh" },
        onReady: vi.fn(),
      }),
    );
  });
  expect(document.body.textContent).toContain("Install SuperTag");
  // Linux apps don't bundle the CLI, so this screen names no one platform.
  expect(document.body.textContent).toContain("SuperTag runs on this computer");
  expect(document.body.textContent).toContain("install.sh | sh");
  await act(async () => button("Check again")?.click());
  expect(api.check).toHaveBeenCalledWith(undefined, undefined);
});

it("never checks on its own, however often it renders, and runs one check at a time", async () => {
  let finish: (() => void) | undefined;
  const api: SetupApi = {
    check: vi.fn(
      () =>
        new Promise<SetupCheck>((resolve) => {
          finish = () => resolve(project);
        }),
    ),
    chooseFolder: vi.fn(async () => "/Users/me/code/app"),
    setUp: vi.fn(),
  };
  // A parent re-renders with fresh props, as App does on every state change.
  for (let render = 0; render < 5; render++)
    await act(async () => {
      root.render(createElement(Onboarding, { api, initial: { ...project }, onReady: () => {} }));
    });
  expect(api.check).not.toHaveBeenCalled();
  // Check again, pressed twice while the first check is still running, checks once.
  await act(async () => {
    button("Check again")?.click();
    button("Check again")?.click();
  });
  expect(api.check).toHaveBeenCalledTimes(1);
  await act(async () => finish?.());
  expect(api.check).toHaveBeenCalledTimes(1);
});

it("names a CLI of another version than the app and how to update it", async () => {
  const install = "curl -fsSL https://example.com/install.sh | sh";
  await act(async () => {
    root.render(
      createElement(Onboarding, {
        api: { check: vi.fn(), chooseFolder: vi.fn(), setUp: vi.fn() },
        initial: {
          cli: null,
          install,
          problem: `This SuperTag CLI is 0.2.0, the app expects 0.3.1. Update with: ${install}\n(It is /usr/local/bin/supertag.)`,
        },
        onReady: vi.fn(),
      }),
    );
  });
  expect(document.body.textContent).toContain("Update SuperTag");
  expect(document.body.textContent).toContain(
    "This SuperTag CLI is 0.2.0, the app expects 0.3.1. Run this in a terminal",
  );
});

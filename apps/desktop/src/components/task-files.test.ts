// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Gateway, TaskFileEntry } from "../gateway";
import { sizeWords, TaskFiles } from "./task-files";

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

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => {});
}

const entry = (path: string, extra: Partial<TaskFileEntry> = {}): TaskFileEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind: "file",
  size: 10,
  modifiedMs: 0,
  text: true,
  ...extra,
});

it("words a size", () => {
  expect(sizeWords(512)).toBe("512 B");
  expect(sizeWords(4096)).toBe("4.0 KB");
  expect(sizeWords(1.5 * 1024 * 1024)).toBe("1.5 MB");
});

it("lists a local Task's files, opens folders and text, and lists binaries only", async () => {
  const listTaskFiles = vi.fn(async (_task: string, path: string) =>
    path === ""
      ? [
          entry("src", { kind: "directory", text: false }),
          entry("README.md"),
          entry("logo.png", { text: false, size: 4096 }),
        ]
      : [entry("src/app.py")],
  );
  const readTaskFile = vi.fn(async (_task: string, path: string) => ({
    path,
    text: "print('hi')\n",
    size: 12,
  }));
  const gateway = {
    locateTaskFiles: async () => ({ local: true, live: false, hostId: "laptop" }),
    listTaskFiles,
    readTaskFile,
  } as unknown as Gateway;
  act(() => root.render(createElement(TaskFiles, { gateway, taskId: "t1" })));
  await settle();
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button.task-file")];
  expect(buttons().map((button) => button.textContent)).toEqual([
    "src",
    "README.md10 B",
    "logo.pngbinary · 4.0 KB",
  ]);
  expect(buttons()[2]?.disabled).toBe(true);

  act(() => buttons()[0]?.click());
  await settle();
  expect(listTaskFiles).toHaveBeenLastCalledWith("t1", "src");
  act(() => buttons()[0]?.click());
  await settle();
  expect(readTaskFile).toHaveBeenCalledWith("t1", "src/app.py");
  expect(host.querySelector(".task-file-text")?.textContent).toBe("print('hi')\n");
});

it("says why another machine's files can't be read, and lists nothing", async () => {
  const listTaskFiles = vi.fn();
  const gateway = {
    locateTaskFiles: async () => ({
      local: false,
      live: true,
      hostId: "build-1",
      reason: "Files on Worker Host build-1 are unreachable from here.",
    }),
    listTaskFiles,
  } as unknown as Gateway;
  act(() => root.render(createElement(TaskFiles, { gateway, taskId: "t2" })));
  await settle();
  expect(host.textContent).toContain("Files on Worker Host build-1 are unreachable from here.");
  expect(listTaskFiles).not.toHaveBeenCalled();
});

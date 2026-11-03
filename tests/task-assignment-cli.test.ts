import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { isTaskCommand, runTaskCommand } from "../apps/cli/src/tasks.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const base = [
  "task-1",
  "--objective",
  "objective-1",
  "--team",
  "team-1",
  "--tag",
  "tag-1",
  "--criterion",
  "Exact bytes",
];
function client() {
  return {
    request: vi.fn(async <T>(_path: string, _init?: RequestInit) => ({ taskId: "task-1" }) as T),
  };
}
it("submits file instructions through the existing administrator assignment route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-assign-"));
  directories.push(dir);
  const path = join(dir, "instructions.txt");
  await writeFile(path, "Preserve these\nexact instructions.\n");
  const api = client();
  await runTaskCommand(api, "assign", [
    ...base,
    "--instruction-file",
    path,
    "--criterion",
    "Review result",
    "--profile",
    "codex",
    "--profile-revision",
    "1",
    "--max-cost-minor",
    "0",
  ]);
  expect(api.request).toHaveBeenCalledWith("/api/v1/coordination/assign_task", {
    method: "POST",
    body: JSON.stringify({
      taskId: "task-1",
      objectiveId: "objective-1",
      teamId: "team-1",
      assignedTagId: "tag-1",
      instruction: "Preserve these\nexact instructions.\n",
      acceptanceCriteria: ["Exact bytes", "Review result"],
      execution: { profile: { id: "codex", revision: "1" } },
      maxCostMinor: 0,
    }),
  });
});
it("reads piped instructions and leaves optional placement and budget unset", async () => {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([Buffer.from("Piped instructions\n")]) as typeof process.stdin,
  );
  const api = client();
  await runTaskCommand(api, "assign", [...base, "--instruction-file", "-"]);
  const body = JSON.parse(
    (api.request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
  );
  expect(body.instruction).toBe("Piped instructions\n");
  expect(body).not.toHaveProperty("execution");
  expect(body).not.toHaveProperty("maxCostMinor");
});
it("sends repeated --item values as the statement items the Task serves", async () => {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([Buffer.from("Build it\n")]) as typeof process.stdin,
  );
  const api = client();
  await runTaskCommand(api, "assign", [
    ...base,
    "--instruction-file",
    "-",
    "--item",
    "1",
    "--item",
    " 3 ",
  ]);
  const body = JSON.parse(
    (api.request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
  );
  expect(body.items).toEqual(["1", "3"]);
  expect(await runTaskCommand(api, "assign", ["--help"])).toContain("--item N");
});
it.each([
  [],
  [...base, "--instruction-file", "missing", "--profile", "codex"],
  [...base, "--instruction-file", "missing", "--profile-revision", "1"],
  ...["-1", "1.5", "1e3", "9007199254740992", " "].map((cost) => [
    ...base,
    "--instruction-file",
    "missing",
    "--max-cost-minor",
    cost,
  ]),
  [...base, "--instruction-file", "missing", "--criterion", " "],
  ...["0", "1a", "item 2", ""].map((item) => [
    ...base,
    "--instruction-file",
    "missing",
    "--item",
    item,
  ]),
  [...base, "--instruction-file", "missing", "--unknown", "x"],
  ["task-1", "--objective", "o", "--team", "t", "--tag", "g", "--instruction-file", "missing"],
])(
  "rejects invalid assignment arguments before requesting or reading instructions: %j",
  async (args) => {
    const api = client();
    await expect(runTaskCommand(api, "assign", args)).rejects.toThrow();
    expect(api.request).not.toHaveBeenCalled();
  },
);
it("rejects blank instructions before sending an assignment", async () => {
  vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([" \n"]) as typeof process.stdin);
  const api = client();
  await expect(runTaskCommand(api, "assign", [...base, "--instruction-file", "-"])).rejects.toThrow(
    "Instruction text",
  );
  expect(api.request).not.toHaveBeenCalled();
});
it("provides assignment help without a request", async () => {
  const api = client();
  expect(isTaskCommand("assign")).toBe(true);
  expect(await runTaskCommand(api, "assign", ["--help"])).toContain("supertag assign task ID");
  expect(api.request).not.toHaveBeenCalled();
});
it.each(["get", "events", "execution", "cancel"] as const)(
  "preserves %s Task operations",
  async (command) => {
    const api = client();
    await runTaskCommand(api, command, ["task/id"]);
    expect(api.request.mock.calls[0]?.[0]).toBe(
      `/api/v1/tasks/task%2Fid${command === "get" ? "" : `/${command}`}`,
    );
  },
);
it("composes declared outputs and admitted artifact selections with a profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-artifacts-"));
  directories.push(dir);
  const instructions = join(dir, "instructions");
  const selections = join(dir, "inputs.json");
  await writeFile(instructions, "Consume input, write output.");
  await writeFile(
    selections,
    JSON.stringify([{ artifactId: "artifact-1", paths: ["outputs/source.txt"] }]),
  );
  const api = client();
  await runTaskCommand(api, "assign", [
    ...base,
    "--instruction-file",
    instructions,
    "--input-artifacts",
    selections,
    "--output-file",
    "outputs/a.txt",
    "--output-file",
    "outputs/nested/b.txt",
    "--profile",
    "codex",
    "--profile-revision",
    "1",
  ]);
  const body = JSON.parse(api.request.mock.calls[0]?.[1]?.body as string);
  expect(body.execution).toEqual({
    profile: { id: "codex", revision: "1" },
    outputs: {
      directory: "outputs",
      required: ["outputs/a.txt", "outputs/nested/b.txt"],
      include: ["outputs/a.txt", "outputs/nested/b.txt"],
    },
  });
  expect(body.inputArtifacts).toEqual([
    { artifactId: "artifact-1", paths: ["outputs/source.txt"] },
  ]);
});
it.each(["/outputs/a", "outputs/../a", "a.txt", "outputs/", "outputs/*.txt"])(
  "rejects unsafe or inexact output file %s before request",
  async (path) => {
    const api = client();
    await expect(
      runTaskCommand(api, "assign", [
        ...base,
        "--instruction-file",
        "missing",
        "--output-file",
        path,
      ]),
    ).rejects.toThrow();
    expect(api.request).not.toHaveBeenCalled();
  },
);
it.each([
  {},
  [],
  [{ artifactId: "a", paths: ["../a"] }],
  [{ artifactId: "a", paths: ["a"], unexpected: true }],
  [{ artifactId: "a", paths: ["a", "a"] }],
])("rejects invalid artifact selection JSON %j", async (input) => {
  const dir = await mkdtemp(join(tmpdir(), "task-inputs-"));
  directories.push(dir);
  const path = join(dir, "inputs.json");
  await writeFile(path, JSON.stringify(input));
  const api = client();
  await expect(
    runTaskCommand(api, "assign", [
      ...base,
      "--instruction-file",
      "missing",
      "--input-artifacts",
      path,
    ]),
  ).rejects.toThrow();
  expect(api.request).not.toHaveBeenCalled();
});

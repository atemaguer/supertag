import { expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { runTeamCommand, teamHelp } from "./src/teams.js";

it("reads bounded Team revision history through the operator endpoint", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    projectionVersion: 1,
    team: { id: "research", revision: 4 },
    changes: [],
    nextAfterRevision: null,
  });
  try {
    expect(teamHelp()).toContain("supertag events team");
    expect(
      await runTeamCommand({ url: "http://gateway.invalid", token: "test" }, [
        "history",
        "research/primary",
        "--objective",
        "objective-a",
        "--after-revision",
        "2",
        "--limit",
        "25",
      ]),
    ).toContain('"projectionVersion": 1');
    expect(request).toHaveBeenCalledWith(
      "/api/v1/coordination/teams/research%2Fprimary/history?objectiveId=objective-a&afterRevision=2&limit=25",
    );
  } finally {
    request.mockRestore();
  }
});

it.each([
  [
    "create",
    [
      "--name",
      "Research",
      "--lead",
      "lead",
      "--concurrency",
      "2",
      "--max-breadth",
      "0",
      "--max-depth",
      "3",
    ],
    { maxBreadth: 0, maxDepth: 3 },
  ],
  ["update", ["--revision", "4", "--max-depth", "0"], { maxDepth: 0 }],
  ["update", ["--revision", "4", "--max-breadth", "2"], { maxBreadth: 2 }],
] as const)("sends only specified Team scaling fields on %s", async (command, flags, scaling) => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({});
  const getTag = vi
    .spyOn(ControlPlaneClient.prototype, "getTag")
    .mockResolvedValue({ metadata: { id: "lead-id" } } as Awaited<
      ReturnType<ControlPlaneClient["getTag"]>
    >);
  try {
    await runTeamCommand({ url: "http://control.invalid", token: "test" }, [
      command,
      "research",
      "--objective",
      "goal",
      ...flags,
    ]);
    expect(request).toHaveBeenCalledOnce();
    const call = request.mock.calls[0];
    if (!call) throw new Error("Expected Team mutation request");
    const [path, options] = call;
    expect(path).toBe(`/api/v1/coordination/${command}_team`);
    expect(JSON.parse(options?.body as string)).toMatchObject({ objectiveId: "goal", scaling });
    expect(JSON.parse(options?.body as string).scaling).toEqual(scaling);
  } finally {
    request.mockRestore();
    getTag.mockRestore();
  }
});

it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992", ""])(
  "rejects invalid scaling value %j before sending a request",
  async (value) => {
    const request = vi.spyOn(ControlPlaneClient.prototype, "request");
    try {
      for (const flag of ["max-breadth", "max-depth"])
        await expect(
          runTeamCommand({ url: "http://control.invalid", token: "test" }, [
            "update",
            "research",
            "--objective",
            "goal",
            "--revision",
            "1",
            `--${flag}=${value}`,
          ]),
        ).rejects.toThrow(`--${flag} must be a nonnegative safe integer`);
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  },
);

it("keeps Objective selection required when setting Team scaling", async () => {
  await expect(
    runTeamCommand({ url: "http://control.invalid", token: "test" }, [
      "update",
      "research",
      "--revision",
      "1",
      "--max-depth",
      "0",
    ]),
  ).rejects.toThrow("--objective ID");
});

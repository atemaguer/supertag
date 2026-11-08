import { expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "./src/action-command.js";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { runTeamCommand, teamHelp } from "./src/teams.js";

const TEAMS = "/api/v1/tag-messaging/teams";

const client = () => new ControlPlaneClient({ url: "http://control.invalid", token: "test" });

/** The internal command the public, action-first `supertag ... team` form normalizes to. */
function teamArgs(...args: string[]): string[] {
  const [, command, ...rest] = normalizeActionFirstCommand(args);
  return [command as string, ...rest];
}

function tagIds() {
  return vi
    .spyOn(ControlPlaneClient.prototype, "getTag")
    .mockImplementation(
      async (name: string) =>
        ({ metadata: { id: `${name}-id` } }) as Awaited<ReturnType<ControlPlaneClient["getTag"]>>,
    );
}

it("documents only the flat Team commands", () => {
  const help = teamHelp();
  for (const usage of [
    "supertag create team NAME --member TAG [--member TAG ...] [--max-concurrency N]",
    "supertag list team",
    "supertag get team NAME",
    "supertag update team NAME [--member TAG ...] [--max-concurrency N] [--name TEXT] [--revision N]",
    "supertag delete team NAME",
  ])
    expect(help).toContain(usage);
  // A Team stands alone: no Objective selection, lead, hierarchy, scaling or revision history.
  for (const removed of [
    "--objective",
    "--lead",
    "--parent",
    "--max-breadth",
    "--max-depth",
    "events team",
    "dissolve team",
  ])
    expect(help).not.toContain(removed);
});

it("creates a Team from repeated --member and an optional --max-concurrency", async () => {
  const request = vi.spyOn(ControlPlaneClient.prototype, "request").mockResolvedValue({
    id: "research",
    name: "research",
    memberTagIds: ["backend-id", "frontend-id"],
    maxConcurrency: 2,
    revision: 1,
  });
  const getTag = tagIds();
  try {
    expect(
      await runTeamCommand(
        client(),
        teamArgs(
          "create",
          "team",
          "research",
          "--member",
          "backend",
          "--member",
          "frontend",
          "--max-concurrency",
          "2",
        ),
      ),
    ).toBe("team/research created.\n");
    const [path, options] = request.mock.calls[0] ?? [];
    expect(path).toBe(TEAMS);
    expect(JSON.parse(String(options?.body))).toEqual({
      id: "research",
      name: "research",
      memberTagIds: ["backend-id", "frontend-id"],
      maxConcurrency: 2,
    });
  } finally {
    request.mockRestore();
    getTag.mockRestore();
  }
});

it("leaves maxConcurrency out when no limit is given and clears it with an empty value", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockImplementation(async (_path, init) =>
      init === undefined
        ? ({ id: "research", name: "research", revision: 4 } as never)
        : ({ id: "research", name: "research", maxConcurrency: null, revision: 5 } as never),
    );
  const getTag = tagIds();
  try {
    await runTeamCommand(client(), teamArgs("create", "team", "research", "--member", "backend"));
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      "maxConcurrency",
    );
    request.mockClear();
    expect(
      await runTeamCommand(
        client(),
        teamArgs("update", "team", "research", "--max-concurrency", ""),
      ),
    ).toBe("team/research updated (revision 5).\n");
    const write = request.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(write?.[0]).toBe(`${TEAMS}/research`);
    // Without --revision the command reads the current revision and fences the write with it.
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      maxConcurrency: null,
      expectedRevision: 4,
    });
  } finally {
    request.mockRestore();
    getTag.mockRestore();
  }
});

it("replaces the whole member list on update and fences with an explicit revision", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockResolvedValue({ id: "research", name: "Research", revision: 8 });
  const getTag = tagIds();
  try {
    await runTeamCommand(
      client(),
      teamArgs(
        "update",
        "team",
        "research",
        "--member",
        "qa",
        "--member",
        "backend",
        "--name",
        "Research",
        "--revision",
        "7",
      ),
    );
    const write = request.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      name: "Research",
      memberTagIds: ["qa-id", "backend-id"],
      expectedRevision: 7,
    });
  } finally {
    request.mockRestore();
    getTag.mockRestore();
  }
});

it.each(["-1", "1.5", "0", "NaN", "9007199254740992"])(
  "rejects --max-concurrency %j before sending a request",
  async (value) => {
    const request = vi.spyOn(ControlPlaneClient.prototype, "request");
    const getTag = tagIds();
    try {
      await expect(
        runTeamCommand(
          client(),
          teamArgs(
            "create",
            "team",
            "research",
            "--member",
            "backend",
            `--max-concurrency=${value}`,
          ),
        ),
      ).rejects.toThrow("--max-concurrency must be a positive integer");
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      getTag.mockRestore();
    }
  },
);

it("deletes a Team by name and reports the help for an unknown command", async () => {
  const request = vi
    .spyOn(ControlPlaneClient.prototype, "request")
    .mockImplementation(async (_path, init) =>
      init?.method === "DELETE"
        ? ({ deleted: true } as never)
        : ({ id: "research-id", name: "research", revision: 1 } as never),
    );
  try {
    expect(await runTeamCommand(client(), ["delete", "research"])).toBe("team/research deleted.\n");
    expect(request.mock.calls.at(-1)).toEqual([`${TEAMS}/research-id`, { method: "DELETE" }]);
    await expect(runTeamCommand(client(), ["history", "research"])).rejects.toThrow(
      "supertag create team NAME",
    );
  } finally {
    request.mockRestore();
  }
});

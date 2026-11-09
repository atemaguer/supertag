import { afterEach, expect, it, vi } from "vitest";
import { fakeOperatorRpc } from "../../tests/support/fake-operator-rpc.js";
import { normalizeActionFirstCommand } from "./src/action-command.js";
import { ControlPlaneClient } from "./src/control-plane-client.js";
import { runTeamCommand, teamHelp } from "./src/teams.js";

const client = () => new ControlPlaneClient({ url: "http://control.invalid", token: "test" });

afterEach(() => {
  vi.restoreAllMocks();
});

/** The internal command the public, action-first `supertag ... team` form normalizes to. */
function teamArgs(...args: string[]): string[] {
  const [, command, ...rest] = normalizeActionFirstCommand(args);
  return [command as string, ...rest];
}

const team = (revision: number, extra: Record<string, unknown> = {}) => ({
  id: "research",
  name: "research",
  members: [{ tagId: "backend-id", tag: "backend" }],
  revision: String(revision),
  ...extra,
});

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
  const rpc = fakeOperatorRpc({ "TeamService/CreateTeam": () => team(1, { maxConcurrency: 2 }) });
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
  expect(rpc.called("TeamService/CreateTeam").map((call) => call.body)).toEqual([
    { id: "research", name: "research", members: ["backend", "frontend"], maxConcurrency: 2 },
  ]);
});

it("leaves maxConcurrency out when no limit is given and clears it with an empty value", async () => {
  const rpc = fakeOperatorRpc({
    "TeamService/CreateTeam": () => team(1),
    "TeamService/GetTeam": () => team(4, { maxConcurrency: 3 }),
    "TeamService/UpdateTeam": () => team(5),
  });
  await runTeamCommand(client(), teamArgs("create", "team", "research", "--member", "backend"));
  expect(rpc.called("TeamService/CreateTeam")[0]?.body).not.toHaveProperty("maxConcurrency");
  expect(
    await runTeamCommand(client(), teamArgs("update", "team", "research", "--max-concurrency", "")),
  ).toBe("team/research updated (revision 5).\n");
  // Without --revision the command reads the current revision and fences the write with it.
  expect(rpc.called("TeamService/UpdateTeam").map((call) => call.body)).toEqual([
    { team: "research", expectedRevision: "4", concurrency: {} },
  ]);
});

it("replaces the whole member list on update and fences with an explicit revision", async () => {
  const rpc = fakeOperatorRpc({ "TeamService/UpdateTeam": () => team(8, { name: "Research" }) });
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
  expect(rpc.called("TeamService/UpdateTeam").map((call) => call.body)).toEqual([
    {
      team: "research",
      expectedRevision: "7",
      name: "Research",
      members: { tags: ["qa", "backend"] },
    },
  ]);
});

it.each(["-1", "1.5", "0", "NaN", "9007199254740992"])(
  "rejects --max-concurrency %j before sending a request",
  async (value) => {
    const rpc = fakeOperatorRpc({});
    await expect(
      runTeamCommand(
        client(),
        teamArgs("create", "team", "research", "--member", "backend", `--max-concurrency=${value}`),
      ),
    ).rejects.toThrow("--max-concurrency must be a positive integer");
    expect(rpc.calls).toEqual([]);
  },
);

it("deletes a Team by name and reports the help for an unknown command", async () => {
  const rpc = fakeOperatorRpc({
    "TeamService/DeleteTeam": () => ({ id: "research-id", name: "research" }),
  });
  expect(await runTeamCommand(client(), ["delete", "research"])).toBe("team/research deleted.\n");
  expect(rpc.called("TeamService/DeleteTeam").map((call) => call.body)).toEqual([
    { team: "research" },
  ]);
  await expect(runTeamCommand(client(), ["history", "research"])).rejects.toThrow(
    "supertag create team NAME",
  );
});

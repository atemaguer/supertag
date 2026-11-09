import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeActionFirstCommand } from "../apps/cli/src/action-command.js";
import { ControlPlaneClient } from "../apps/cli/src/control-plane-client.js";
import { startControlPlaneRuntime } from "../apps/cli/src/control-plane-runtime.js";
import { runTagMessagingCommand } from "../apps/cli/src/messaging.js";
import { runObjectiveCommand } from "../apps/cli/src/objectives.js";
import { mailboxClient, teamClient } from "../apps/cli/src/operator-client.js";
import { runTeamCommand } from "../apps/cli/src/teams.js";
import { listWorkstreamPosts } from "../apps/cli/src/workstreams.js";
import type { Objective } from "../packages/core/src/index.js";
import {
  DrizzleStore,
  FileGatewayCredentialVault,
  migrateDatabase,
} from "../packages/store/src/index.js";

describe("Tag messaging over the operator RPCs and the CLI", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "supertag-mailbox-http-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const databaseUrl = `file:${join(directory, "state.db")}`;
    await migrateDatabase({ url: databaseUrl });
    const store = new DrizzleStore({ url: databaseUrl });
    await store.connect();
    cleanups.push(() => store.disconnect());
    const lead = await store.createTag({ name: "leadership" });
    const marketing = await store.createTag({ name: "marketing" });
    const outsider = await store.createTag({ name: "outsider" });
    const runtime = await startControlPlaneRuntime({
      host: "127.0.0.1",
      port: 0,
      databaseUrl,
      workletTransport: "embedded",
      adminToken: "test-admin",
      credentialVault: new FileGatewayCredentialVault(join(directory, "vault.json")),
    });
    cleanups.push(() => runtime.close());
    const target = { url: runtime.url, token: "test-admin" };
    const client = new ControlPlaneClient(target);
    /**
     * The internal form of a public `supertag ... team` command. `create` and `update` carry
     * flags the action-first layer normalizes; the others reach the handler as they are.
     */
    const team = (action: string, _resource: "team", ...rest: string[]) => {
      if (action !== "create" && action !== "update")
        return runTeamCommand(client, [action, ...rest]);
      const [, command, ...args] = normalizeActionFirstCommand([action, "team", ...rest]);
      return runTeamCommand(client, [command as string, ...args]);
    };
    const api = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, runtime.url), {
        ...init,
        headers: { authorization: "Bearer test-admin", ...(init.headers ?? {}) },
      });
    return { directory, store, lead, marketing, outsider, runtime, target, client, team, api };
  }

  it("creates and reads flat Teams and their Workstream posts", async () => {
    const f = await fixture();
    expect(
      await f.team("create", "team", "launch", "--member", "leadership", "--member", "marketing"),
    ).toBe("team/launch created.\n");
    const created = JSON.parse(await f.team("get", "team", "launch")) as {
      id: string;
      members: { tagId: string; tag: string }[];
    };
    expect(created).toMatchObject({ id: "launch", name: "launch", revision: "1" });
    expect(created).not.toHaveProperty("maxConcurrency");
    expect(created.members).toEqual(
      [
        { tagId: f.lead.id, tag: "leadership" },
        { tagId: f.marketing.id, tag: "marketing" },
      ].toSorted((left, right) => left.tagId.localeCompare(right.tagId)),
    );
    expect(JSON.parse(await f.team("list", "team")).teams).toHaveLength(1);
    // Creating the same Team again returns it.
    const again = await teamClient(f.client.operator).createTeam({
      id: "launch",
      name: "launch",
      members: ["marketing", "leadership"],
    });
    expect(again.revision).toBe(1n);
    // Posts are the Team's shared record; the operator reads them, nobody is woken.
    await f.store.post({
      teamId: created.id,
      authorTagId: f.lead.id,
      body: "Launch date is set.",
      to: [f.marketing.id],
    });
    await f.store.post({ teamId: created.id, authorTagId: f.marketing.id, body: "Copy drafted." });
    const posts = (await listWorkstreamPosts(f.client, ["--team", "launch"])) as {
      posts: { sequence: string; body: string; toTagIds?: string[] }[];
      tagNames: Record<string, string>;
    };
    expect(posts.posts.map((post) => [post.sequence, post.body])).toEqual([
      ["1", "Launch date is set."],
      ["2", "Copy drafted."],
    ]);
    expect(posts.posts[0]?.toTagIds).toEqual([f.marketing.id]);
    expect(posts.tagNames).toEqual({ [f.lead.id]: "leadership", [f.marketing.id]: "marketing" });
    const later = (await listWorkstreamPosts(f.client, [
      "--team",
      "launch",
      "--after-sequence",
      "1",
    ])) as { posts: { sequence: string }[] };
    expect(later.posts.map((post) => post.sequence)).toEqual(["2"]);
    const widest = (await listWorkstreamPosts(f.client, [
      "--team",
      "launch",
      "--after-sequence",
      "0",
      "--limit",
      "200",
    ])) as { posts: unknown[]; nextPageToken?: string };
    expect(widest.posts).toHaveLength(2);
    expect(widest.nextPageToken).toBeUndefined();
    const mailbox = mailboxClient(f.client.operator);
    const clamped = await mailbox.listWorkstreamPosts({
      team: "launch",
      afterSequence: 0n,
      pageSize: 500,
    });
    expect(clamped.posts).toHaveLength(2);
    const first = await mailbox.listWorkstreamPosts({
      team: "launch",
      afterSequence: 0n,
      pageSize: 1,
    });
    expect(first.posts.map((post) => post.sequence)).toEqual([1n]);
    const rest = await mailbox.listWorkstreamPosts({
      team: "launch",
      pageToken: first.nextPageToken,
      pageSize: 1,
    });
    expect(rest.posts.map((post) => post.sequence)).toEqual([2n]);
    expect(rest.nextPageToken).toBe("");
  });

  it("grants and revokes a Mailbox as a pair of Tags, with no message types", async () => {
    const f = await fixture();
    const messaging = (...args: string[]) => {
      const [, , ...rest] = normalizeActionFirstCommand(args);
      return runTagMessagingCommand(f.target, rest);
    };
    expect(await messaging("grant", "mailbox", "marketing", "--sender", "leadership")).toBe(
      "marketing accepts messages from leadership.\n",
    );
    expect(JSON.parse(await messaging("list", "mailbox-grant", "--mailbox", "marketing"))).toEqual({
      grants: [{ senderTagId: f.lead.id, recipientTagId: f.marketing.id }],
      tagNames: { [f.lead.id]: "leadership", [f.marketing.id]: "marketing" },
    });
    // Granting it again changes nothing.
    const mailbox = mailboxClient(f.client.operator);
    expect(
      await mailbox.grantMailbox({ sender: "leadership", recipient: "marketing" }),
    ).toMatchObject({ changed: false });
    expect(await f.store.mayMessage(f.lead.id, f.marketing.id)).toBe(true);
    expect(await messaging("revoke", "mailbox", "marketing", "--sender", "leadership")).toContain(
      "no longer accepts messages from leadership",
    );
    expect(await f.store.mayMessage(f.lead.id, f.marketing.id)).toBe(false);
    expect(
      await mailbox.revokeMailbox({ sender: "leadership", recipient: "marketing" }),
    ).toMatchObject({ changed: false });
    await expect(
      mailbox.grantMailbox({ sender: "leadership", recipient: "nobody" }),
    ).rejects.toMatchObject({ code: Code.NotFound });
  });

  it("lists a Tag's messages, newest first, with the status of the turn that took each", async () => {
    const f = await fixture();
    await f.store.deliverTagMessage({
      senderTagId: f.lead.id,
      recipientTagId: f.marketing.id,
      text: "Draft the announcement.",
      hops: 0,
    });
    const page = JSON.parse(
      await runTagMessagingCommand(f.target, ["messages", "marketing", "--limit", "10"]),
    ) as { messages: { text: string; status: string; hops?: number }[] };
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      text: "Draft the announcement.",
      status: "TAG_MESSAGE_STATUS_PENDING",
    });
    expect(page.messages[0]).not.toHaveProperty("hops");
  });

  it("creates an Objective that names a Team and starts it through the same route", async () => {
    const f = await fixture();
    await f.team("create", "team", "launch", "--member", "leadership", "--member", "marketing");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const created = JSON.parse(
      await runObjectiveCommand(f.target, [
        "create",
        "ship",
        "--outcome",
        "Ship the launch",
        "--owner",
        "leadership",
        "--team",
        "launch",
        "--output",
        "json",
      ]),
    ) as Objective;
    expect(created).toMatchObject({ id: "ship", teamId: "launch", ownerTagId: f.lead.id });
    expect(JSON.parse(await runObjectiveCommand(f.target, ["get", "ship"]))).toMatchObject({
      id: "ship",
      teamId: "launch",
    });
    // A Team an open Objective names cannot be deleted.
    await expect(f.team("delete", "team", "launch")).rejects.toThrow("cannot be deleted");
  });

  it("offers no route for credentials, pruning, or a Worker's own mailbox", async () => {
    const f = await fixture();
    for (const [method, path] of [
      ["GET", "/api/v1/tag-messaging/teams"],
      ["PUT", "/api/v1/tag-messaging/grants"],
      ["GET", "/api/v1/tag-messaging/messages"],
      ["POST", "/internal/v1/mailbox/receive"],
      ["POST", "/internal/v1/mailbox/send"],
      ["GET", "/api/v1/tag-messaging/workstreams/launch/posts"],
    ] as const) {
      const response = await f.api(path, method === "GET" ? { method } : { method, body: "{}" });
      expect([404, 405], `${method} ${path}`).toContain(response.status);
    }
    // The operator RPCs need an operator credential.
    await expect(teamClient({ url: f.runtime.url }).listTeams({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it("refuses a post from a Tag outside the Team and one addressed outside it", async () => {
    const f = await fixture();
    const team = await f.store.createTeam({
      id: randomUUID(),
      name: "launch",
      memberTagIds: [f.lead.id],
    });
    await expect(
      f.store.post({ teamId: team.id, authorTagId: f.outsider.id, body: "Hello" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      f.store.post({
        teamId: team.id,
        authorTagId: f.lead.id,
        body: "Hello",
        to: [f.outsider.id],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

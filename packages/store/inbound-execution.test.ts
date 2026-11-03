import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmitInboundEventInput } from "@supertag/core";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { DrizzleStore, migrateDatabase } from "./src/index.js";

it("retains admitted execution requirements across restart and duplicate delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supertag-inbound-execution-"));
  const path = join(directory, "state.db");
  const url = `file:${path}`;
  const store = new DrizzleStore({ url });
  const reopened = new DrizzleStore({ url });
  try {
    await migrateDatabase({ url });
    const seed = new Database(path);
    seed.exec(
      `INSERT INTO SurfaceAccount (id,provider,externalAccountId,displayName,authMethod,credentialId,status,configuration,lastVerifiedAt,createdAt,updatedAt) VALUES ('account','slack','external','account','token','credential','active','{}','now','now','now')`,
    );
    seed.close();
    await store.connect();
    const at = new Date().toISOString();
    const input: AdmitInboundEventInput = {
      surfaceAccountId: "account",
      tagRouteId: "route",
      tagId: "tag",
      execution: {
        harness: "codex",
        requires: [{ id: "repository", version: 1 }],
        profile: { id: "engineering", revision: "3" },
      },
      authorization: {
        version: 5,
        capturedAt: at,
        tag: { id: "tag", name: "Engineer" },
        origin: {
          tagRouteId: "route",
          surfaceAccountId: "account",
          provider: "slack",
          scope: "channel:test",
        },
        requester: { id: "user", kind: "user" },
        permissionSets: [],
        resources: [],
        runtimeActions: [],
      },
      contextPlan: { version: 7, capturedAt: at, sets: [] },
      event: {
        eventId: "delivery",
        logicalEventId: "logical",
        provider: "slack",
        externalAccountId: "external",
        kind: "mention",
        scope: "channel:test",
        sessionKey: "session",
        actor: { id: "user", kind: "user" },
        text: "Implement feature",
        occurredAt: at,
        callback: {
          provider: "slack",
          mode: "slack_thread",
          threadKey: "thread",
          target: { channelId: "test", threadTs: "1" },
        },
        source: {},
        metadata: {},
      },
    };
    const admitted = await store.admitInboundEvent(input);
    expect(admitted.status).toBe("admitted");
    await store.disconnect();
    await reopened.connect();
    expect((await reopened.findInboundEventById(admitted.work.id))?.execution).toEqual(
      input.execution,
    );
    const duplicate = await reopened.admitInboundEvent({
      ...input,
      execution: { harness: "opencode" },
    });
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.work.execution).toEqual(input.execution);
    const claimed = await reopened.claimNextInboundEvent({
      leaseOwner: "replacement",
      now: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(claimed?.execution).toEqual(input.execution);
  } finally {
    await store.disconnect();
    await reopened.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});

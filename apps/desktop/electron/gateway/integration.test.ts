/**
 * The Gateway backend against real deployments run by this repository's CLI, ported from the
 * Tauri app's `gateway/tests.rs` and `gateway/watch/tests.rs`. Set `SUPERTAG_RUST_TEST_CLI` to a
 * built `supertag` to run them; every deployment gets throwaway directories and system-picked
 * ports.
 */

import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttp2Server, type Http2Server } from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  type ConnectRouter,
  Code as ServerCode,
  ConnectError as ServerError,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProtocolNegotiation,
  ServiceRole,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/negotiation_pb";
import {
  OperatorEvents,
  type WatchEvent,
  WatchEventSchema,
  WatchKind,
  WatchReason,
  type WatchRequest,
} from "../../../../harnesses/sdk/src/rust-harness/gen/supertag/runtime/v2/runtime_pb";
import type { FollowUpdate, WatchUpdate } from "../../src/gateway";
import { gatewayStore } from "../paths";
import { entryPath } from "./cache";
import {
  baseEnv,
  CLI,
  eventually,
  holdLock,
  next,
  privateCertificates,
  runCli,
  Stack,
  tlsEdge,
} from "./fixture";
import { readLocalGateway } from "./local";
import { createGatewayClient, PROTOCOL_VERSIONS } from "./sdk";
import { GatewayState, type GatewayStateOptions, type Subscriber } from "./state";
import { runWatch } from "./watch";

const VERSION = "0.3.2";
const CHANGED = "The connection changed. Refresh this view.";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-desktop-gateway-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let directories = 0;
async function directory(name: string): Promise<string> {
  directories += 1;
  const made = path.join(root, `${directories}-${name}`);
  await mkdir(made, { recursive: true, mode: 0o700 });
  return made;
}

/** An app's Gateway backend with its store and cache in `home`. */
function app(home: string, options: Partial<GatewayStateOptions> = {}): GatewayState {
  return new GatewayState({
    store: path.join(home, "config", "gateways.json"),
    cache: path.join(home, "cache"),
    buildVersion: VERSION,
    deviceName: () => "test-device",
    discoverLocal: async () => {
      throw "No local Gateway in this test.";
    },
    ...options,
  });
}

/** Updates a stream receives, collected in order. */
function collect<U>(): { received: U[]; subscriber: Subscriber<U>; ended: () => boolean } {
  const received: U[] = [];
  const stops: (() => void)[] = [];
  let ended = false;
  return {
    received,
    ended: () => ended,
    subscriber: {
      send(update) {
        if (ended) return false;
        received.push(update);
        return true;
      },
      onEnd(stop) {
        stops.push(stop);
      },
      end() {
        if (ended) return;
        ended = true;
        for (const stop of stops.splice(0)) stop();
      },
    },
  };
}

/** A Gateway stand-in that only negotiates, as another release would. */
async function negotiationServer(
  answer: { build: string; versions: number[] } | { refuse: string },
): Promise<{ url: string; server: Http2Server }> {
  const routes = (router: ConnectRouter) =>
    router.service(ProtocolNegotiation, {
      negotiate() {
        if ("refuse" in answer) throw new ServerError(answer.refuse, ServerCode.FailedPrecondition);
        return {
          role: ServiceRole.GATEWAY,
          protocolVersion: answer.versions[0] ?? 0,
          protocolVersions: answer.versions,
          buildVersion: answer.build,
        };
      },
    });
  const server = createHttp2Server(connectNodeAdapter({ routes, grpc: true, connect: false }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, server };
}

// Restarts wait out the backoff of the streams they interrupt.
describe.skipIf(CLI === undefined)(
  "the Gateway backend against the built CLI",
  { timeout: 120_000 },
  () => {
    it("connects with an authenticated Gateway and keeps message operations durable", async () => {
      const home = await directory("native");
      const stack = await Stack.start({ root: home, name: "state", token: "operator-test-token" });
      try {
        await stack.putTag("engineer");
        const client = app(home);
        const store = path.join(home, "config", "gateways.json");
        await expect(client.tags("0")).rejects.toBe("Connect to a Gateway first.");
        await expect(client.saveGateway(stack.url, "Engineering", "wrong-token")).rejects.toBe(
          "The Gateway rejected the saved credential.",
        );
        await expect(stat(store)).rejects.toThrow();
        const first = await client.saveGateway(stack.url, "Engineering", "operator-test-token");
        const id = first.connectionId;
        expect(first.principal).toMatch(/^operator:/u);
        const tags = await client.tags(id);
        expect(tags).toHaveLength(1);
        expect(tags[0]).toMatchObject({ tagId: "engineer", harnessKind: "codex", lead: true });
        const sent = await client.send(id, "engineer", "Explain the change", "desktop-operation");
        const replay = await client.send(id, "engineer", "Explain the change", "desktop-operation");
        expect(replay.task.taskId).toBe(sent.task.taskId);
        expect(sent.task.state).toBe("queued");
        await expect(
          client.send(id, "engineer", "Different content", "desktop-operation"),
        ).rejects.toBeTypeOf("string");
        const conversations = await client.conversations(id);
        expect(conversations).toHaveLength(1);
        expect(conversations[0]).toMatchObject({
          tagId: "engineer",
          preview: "Explain the change",
          working: true,
        });
        const page = await client.messages(id, { tagId: "engineer" });
        expect(page.messages).toHaveLength(1);
        expect(page.nextCursor).toBe("");
        expect(page.conversationId).toBe(sent.task.sessionId);
        // The copy the app keeps is current: nothing changed after its latest message.
        const changes = await client.messages(id, {
          tagId: "engineer",
          after: sent.order,
          conversationId: page.conversationId,
        });
        expect(changes.incremental).toBe(true);
        expect(changes.messages).toEqual([]);
        expect((await client.markRead(id, "engineer", sent.order)).readOrder).toBe(sent.order);
        expect((await client.message(id, "engineer", sent.task.taskId)).task.prompt).toBe(
          "Explain the change",
        );
        expect(await client.events(id, sent.task.taskId, 0)).toEqual([]);

        client.disconnect();
        await expect(client.tags(id)).rejects.toBeTypeOf("string");
        const replacement = await client.selectGateway(stack.url);
        expect(replacement.connectionId).not.toBe(id);
        await expect(client.tags(id)).rejects.toBe(CHANGED);
        await expect(
          client.saveGateway(stack.url, "Engineering", "wrong-token"),
        ).rejects.toBeTypeOf("string");
        expect((await client.tags(replacement.connectionId))[0]?.tagId).toBe("engineer");

        // The CLI reads the Gateways the app saved, by name, from the same store.
        const env = baseEnv(home);
        const shared = app(home, { store: gatewayStore(env) });
        await shared.saveGateway(stack.url, "Engineering", "operator-test-token");
        expect(await runCli(["get", "tag", "--gateway", "Engineering"], env)).toContain("engineer");
      } finally {
        await stack.stop();
      }
    });

    it("switches saved Gateways, one through a ws:// tunnel, and scopes late requests", async () => {
      const home = await directory("switch");
      const first = await Stack.start({ root: home, name: "first", token: "first-operator" });
      const second = await Stack.start({ root: home, name: "second", token: "second-operator" });
      try {
        await first.putTag("first-tag");
        await second.putTag("second-tag");
        const state = app(home);
        const store = path.join(home, "config", "gateways.json");
        const a = await state.saveGateway(`${first.url}/`, "First", "first-operator");
        const b = await state.saveGateway(second.tunnelUrl, "Second", "second-operator");
        expect((await state.tags(b.connectionId))[0]?.tagId).toBe("second-tag");
        await expect(
          state.send(a.connectionId, "second-tag", "Old workspace", "stale"),
        ).rejects.toBe(CHANGED);
        expect(await state.conversations(b.connectionId)).toEqual([]);

        const snapshot = await state.savedGateways();
        expect(snapshot.active).toBe(second.tunnelUrl);
        expect(snapshot.profiles).toEqual([
          { name: "First", origin: first.url },
          { name: "Second", origin: second.tunnelUrl },
        ]);
        const resumed = app(home);
        const again = await resumed.selectGateway(first.url);
        expect((await resumed.tags(again.connectionId))[0]?.tagId).toBe("first-tag");
        const edited = await resumed.saveGateway(first.url, "Renamed", "");
        expect((await resumed.tags(edited.connectionId))[0]?.tagId).toBe("first-tag");
        const forgotten = await resumed.clearGateway(second.tunnelUrl);
        expect(forgotten.active).toBe(first.url);
        await expect(resumed.selectGateway(second.tunnelUrl)).rejects.toBe(
          "That Gateway is no longer saved.",
        );
        await resumed.clearGateway(undefined);
        await expect(resumed.tags(edited.connectionId)).rejects.toBeTypeOf("string");
        expect((await resumed.savedGateways()).active).toBeNull();

        expect((await stat(store)).mode & 0o777).toBe(0o600);
        const alias = path.join(home, "config", "alias.json");
        await symlink(store, alias);
        await expect(app(home, { store: alias }).savedGateways()).rejects.toBe(
          "Could not read or save your Gateway connections.",
        );
      } finally {
        await first.stop();
        await second.stop();
      }
    });

    it("enrolls this device with a client Auth Key and saves only its credential", async () => {
      const home = await directory("auth-key");
      const stack = await Stack.start({ root: home, name: "state", token: "join-operator" });
      try {
        await stack.putTag("allowed-tag");
        await stack.putTag("hidden-tag", undefined, false);
        const created = await runCli(
          [
            "auth-key",
            "create",
            "--role",
            "client",
            "--tag",
            "allowed-tag",
            "--gateway",
            stack.url,
            "laptops",
          ],
          { ...baseEnv(home), SUPERTAG_OPERATOR_TOKEN: "join-operator" },
        );
        const key = (JSON.parse(created) as { auth_key: string }).auth_key;
        expect(key).toMatch(/^stak_/u);

        const state = app(home);
        const joined = await state.saveGateway(stack.url, "Work", key);
        expect(joined.principal).toBe("client:test-device");
        expect((await state.tags(joined.connectionId)).map((tag) => tag.tagId)).toEqual([
          "allowed-tag",
        ]);
        // A client device converses with its Tags but cannot create one or list hosts.
        await expect(
          state.createTag(joined.connectionId, { tagId: "device-tag", harness: "codex" }),
        ).rejects.toBe("Only an operator can create Tags.");
        await expect(state.tagOptions(joined.connectionId)).rejects.toBeTypeOf("string");
        const saved = await readFile(path.join(home, "config", "gateways.json"), "utf8");
        expect(saved).not.toContain(key);
        expect(saved).toContain("stcr_");
        // The one-time key admits no second device.
        await expect(
          app(home, { store: path.join(home, "other", "gateways.json") }).saveGateway(
            stack.url,
            "Again",
            key,
          ),
        ).rejects.toBe(
          "The Gateway refused this Auth Key. Ask an operator for a new client Auth Key.",
        );
      } finally {
        await stack.stop();
      }
    });

    it("connects to the local Gateway with its current token and never saves it", async () => {
      const home = await directory("local");
      const operator = "e".repeat(64);
      const stack = await Stack.start({ root: home, name: "state", token: operator });
      try {
        await stack.putTag("local-tag");
        const stateDirectory = path.join(home, "supertag");
        const env = { ...baseEnv(home), SUPERTAG_STATE_DIR: stateDirectory };
        const state = app(home, {
          discoverLocal: () => readLocalGateway(CLI as string, env),
        });
        const listed = await state.savedGateways();
        expect(listed.local?.origin).toBeUndefined();
        expect(listed.local?.problem).toContain("supertag init");

        await mkdir(stateDirectory, { mode: 0o700 });
        const write = async (name: string, contents: string) => {
          const file = path.join(stateDirectory, name);
          await writeFile(file, contents);
          await chmod(file, 0o600);
        };
        const credentials = (token: string) =>
          JSON.stringify({
            gateway_credential: `stcr_${"a".repeat(64)}`,
            operator_token: token,
            host_credential: `stcr_${"b".repeat(64)}`,
          });
        await write("gateway-endpoint", `${stack.url}\n`);
        await write("credentials.json", credentials(operator));
        await write(".lock", "");
        // Stands in for the supervisor `supertag up` runs, which holds this lock.
        const lock = await holdLock(path.join(stateDirectory, ".lock"));
        try {
          const local = await state.connectLocalGateway();
          expect(local.principal).toMatch(/^operator:/u);
          expect((await state.tags(local.connectionId))[0]?.tagId).toBe("local-tag");
          expect(local.origin).toBe("local");
          expect(local.gateways.active).toBeNull();
          expect(local.gateways.local?.origin).toBe(stack.url);
          const saved = await readFile(path.join(home, "config", "gateways.json"), "utf8");
          expect(saved).not.toContain(operator);
          // What the app keeps for it outlives the port `supertag up` gave the Gateway this time.
          const discovered = await readLocalGateway(CLI as string, env);
          await state.cache(local.connectionId, "roster", ["local-tag"]);
          const scope = {
            gateway: `local ${discovered.stateDirectory}`,
            principal: local.principal,
          };
          await expect(
            stat(entryPath(path.join(home, "cache"), scope, "roster")),
          ).resolves.toBeTruthy();
          // Only the local Gateway has a state directory to add a folder to.
          expect(await state.localStateOf(local.connectionId)).toBe(discovered.stateDirectory);

          // A replaced token is read at the next connect.
          await write("credentials.json", credentials("f".repeat(64)));
          await expect(state.connectLocalGateway()).rejects.toBe(
            "The Gateway rejected the saved credential.",
          );
          await write("credentials.json", credentials(operator));
          await state.connectLocalGateway();
        } finally {
          await lock.release();
        }
        await expect(state.connectLocalGateway()).rejects.toContain("supertag up");

        const remote = app(home);
        const saved = await remote.saveGateway(stack.url, "Remote", operator);
        await expect(remote.localStateOf(saved.connectionId)).rejects.toBe(
          "Only the local Gateway can add a folder of this Mac as a Workspace.",
        );
      } finally {
        await stack.stop();
      }
    });

    it("refuses a Gateway of another release on connect, naming both and the fix", async () => {
      const home = await directory("older");
      const older = await negotiationServer({ build: "0.3.0", versions: [2] });
      const newer = await negotiationServer({ build: "9.0.0", versions: [99] });
      const refusing = await negotiationServer({ refuse: "incompatible SuperTag protocol" });
      try {
        const state = app(home);
        const ours = PROTOCOL_VERSIONS.join(", ");
        await expect(state.saveGateway(older.url, "Old", "operator-test-token")).rejects.toBe(
          `This app speaks SuperTag protocol ${ours}, but the Gateway at ${older.url} runs SuperTag 0.3.0 (protocol 2). Upgrade the Gateway.`,
        );
        await expect(state.saveGateway(newer.url, "New", "operator-test-token")).rejects.toBe(
          `This app speaks SuperTag protocol ${ours}, but the Gateway at ${newer.url} runs SuperTag 9.0.0 (protocol 99). Upgrade this client.`,
        );
        await expect(state.saveGateway(refusing.url, "Odd", "operator-test-token")).rejects.toBe(
          "This Gateway runs an incompatible SuperTag release. Use the same release for the Gateway and this app.",
        );
        const closed = older.url.replace(/:[0-9]+$/u, ":1");
        await expect(state.saveGateway(closed, "Closed", "operator-test-token")).rejects.toBe(
          "Could not connect to the Gateway. Check its address and TLS certificate.",
        );
        await expect(stat(path.join(home, "config", "gateways.json"))).rejects.toThrow();
      } finally {
        for (const { server } of [older, newer, refusing]) server.close();
      }
    });

    it("lets an operator create a Tag once with the lead Tag defaults", async () => {
      const home = await directory("create-tag");
      const stack = await Stack.start({ root: home, name: "state", token: "operator-test-token" });
      try {
        await stack.putTag("engineer");
        const client = app(home);
        const { connectionId: id } = await client.saveGateway(
          stack.url,
          "Engineering",
          "operator-test-token",
        );
        // No Worker Host has connected, so nothing is offered yet.
        expect(await client.tagOptions(id)).toEqual({
          harnesses: [],
          workspaces: [],
          noCommands: [],
        });
        const newTag = { tagId: "reviewer", name: "Reviewer", harness: "claude_code" };
        const created = await client.createTag(id, newTag);
        expect(created).toMatchObject({
          tagId: "reviewer",
          name: "Reviewer",
          harnessKind: "claude_code",
          revision: 1,
          lead: false,
          allowedActions: ["commands:execute", "files:read", "files:write", "schedule:create"],
        });
        await expect(client.createTag(id, newTag)).rejects.toBe(
          "A Tag with that ID or name already exists.",
        );
        expect((await client.tags(id)).map((tag) => tag.tagId)).toEqual(["engineer", "reviewer"]);
        // The details panel's reads reach the services the SDK added.
        expect(await client.notes(id, "engineer")).toEqual([]);
        expect(await client.networkLogs(id, "engineer")).toEqual([]);
        expect(await client.schedules(id, "engineer")).toEqual([]);
        expect((await client.tagActivity(id, "engineer")).windowDays).toBeTypeOf("number");
        const sent = await client.send(id, "engineer", "Where are your files?", "files-operation");
        const place = await client.locateTaskFiles(id, sent.task.taskId);
        expect(place.local).toBe(false);
        await expect(client.changeSchedule(id, "missing", "pause")).rejects.toBeTypeOf("string");
      } finally {
        await stack.stop();
      }
    });

    it("pushes a followed conversation's sent messages, and follows on after a Gateway restart", async () => {
      const home = await directory("follow");
      const stack = await Stack.start({ root: home, name: "state", token: "operator-test-token" });
      try {
        await stack.putTag("engineer");
        const client = app(home);
        const { connectionId: id } = await client.saveGateway(
          stack.url,
          "Engineering",
          "operator-test-token",
        );
        const { received, subscriber, ended } = collect<FollowUpdate>();
        const follow = client.startFollow(id, { tagId: "engineer" }, subscriber);
        expect(await next(received, () => true)).toEqual({ kind: "ready" });
        const sent = await client.send(id, "engineer", "Explain the change", "follow-operation");
        const changed = await next(received, (update) => update.kind === "changed");
        if (changed.kind !== "changed") throw new Error("expected a change");
        expect(changed.messages?.incremental).toBe(false);
        expect(changed.messages?.messages[0]?.task).toMatchObject({
          taskId: sent.task.taskId,
          state: "queued",
        });

        await stack.stopGateway();
        expect(await next(received, (update) => update.kind !== "changed")).toEqual({
          kind: "lost",
        });
        await stack.startGateway();
        expect(await next(received, () => true, 30_000)).toEqual({ kind: "ready" });
        const after = await client.send(id, "engineer", "Still there?", "after-restart");
        const resumed = await next(
          received,
          (update) =>
            update.kind === "changed" &&
            (update.messages?.messages.some((m) => m.task.taskId === after.task.taskId) ?? false),
        );
        expect(resumed.kind).toBe("changed");
        client.stopFollow(follow);
        await eventually(ended);
        expect(client.openFollows).toBe(0);
      } finally {
        await stack.stop();
      }
    });

    it("switches between two Gateways without leaking state, and reconnects after restarts", async () => {
      const home = await directory("two");
      const alpha = await Stack.start({ root: home, name: "alpha", token: "alpha-operator" });
      const beta = await Stack.start({ root: home, name: "beta", token: "beta-operator" });
      try {
        await alpha.putTag("alpha-tag");
        await beta.putTag("beta-tag");
        expect(alpha.url).not.toBe(beta.url);
        const state = app(home);
        const a = await state.saveGateway(alpha.url, "Alpha", "alpha-operator");
        expect((await state.tags(a.connectionId)).map((tag) => tag.tagId)).toEqual(["alpha-tag"]);
        await state.send(a.connectionId, "alpha-tag", "Only Alpha hears this", "alpha-operation");
        await state.cache(a.connectionId, "roster", ["alpha-tag"]);
        const alphaWatch = collect<WatchUpdate>();
        state.startWatch(a.connectionId, 1, alphaWatch.subscriber);

        // Adding the second Gateway switches to it.
        const b = await state.saveGateway(beta.url, "Beta", "beta-operator");
        expect(b.connectionId).not.toBe(a.connectionId);
        expect((await state.tags(b.connectionId)).map((tag) => tag.tagId)).toEqual(["beta-tag"]);
        expect(await state.conversations(b.connectionId)).toEqual([]);
        expect(await state.cached(b.connectionId, "roster")).toBeNull();
        await expect(
          state.send(a.connectionId, "beta-tag", "stale", "stale-operation"),
        ).rejects.toBe(CHANGED);
        await expect(state.tags(a.connectionId)).rejects.toBeTypeOf("string");
        // Switching ended Alpha's Watch.
        await eventually(alphaWatch.ended);
        alphaWatch.received.length = 0;
        const betaWatch = collect<WatchUpdate>();
        state.startWatch(b.connectionId, 2, betaWatch.subscriber);
        await next(betaWatch.received, (update) => update.kind === "ready");
        await state.send(b.connectionId, "beta-tag", "Only Beta hears this", "beta-operation");
        const update = await next(betaWatch.received, (u) => u.kind === "conversation");
        expect(update).toEqual({ kind: "conversation", tagId: "beta-tag" });
        expect(alphaWatch.received).toEqual([]);
        expect((await state.conversations(b.connectionId))[0]?.tagId).toBe("beta-tag");
        await state.cache(b.connectionId, "roster", ["beta-tag"]);

        // Switching back shows Alpha's own Tags, conversation, and cache.
        const back = await state.selectGateway(alpha.url);
        expect((await state.tags(back.connectionId))[0]?.tagId).toBe("alpha-tag");
        const conversations = await state.conversations(back.connectionId);
        expect(conversations.map((c) => c.tagId)).toEqual(["alpha-tag"]);
        expect(await state.cached(back.connectionId, "roster")).toEqual(["alpha-tag"]);
        expect(betaWatch.ended()).toBe(true);
        // Each saved Gateway keeps only its own credential.
        const saved = JSON.parse(
          await readFile(path.join(home, "config", "gateways.json"), "utf8"),
        );
        for (const entry of saved.gateways as { profile: { origin: string }; token: string }[]) {
          expect(entry.token).toBe(
            entry.profile.origin === alpha.url ? "alpha-operator" : "beta-operator",
          );
        }

        // Both deployments restart on their own databases at the same Gateway addresses; a fresh
        // app (as after a relaunch) reconnects to each and finds what it left there.
        await alpha.restart();
        await beta.restart();
        const relaunched = app(home);
        for (const [url, tag] of [
          [beta.url, "beta-tag"],
          [alpha.url, "alpha-tag"],
        ] as const) {
          const activation = await relaunched.selectGateway(url);
          const id = activation.connectionId;
          expect((await relaunched.tags(id))[0]?.tagId).toBe(tag);
          expect((await relaunched.conversations(id)).map((c) => c.tagId)).toEqual([tag]);
          expect(await relaunched.cached(id, "roster")).toEqual([tag]);
        }
      } finally {
        await alpha.stop();
        await beta.stop();
      }
    });

    it("keeps the Watch through a Gateway restart", async () => {
      const home = await directory("watch-restart");
      const stack = await Stack.start({ root: home, name: "state", token: "operator-test-token" });
      try {
        await stack.putTag("engineer");
        const state = app(home);
        const { connectionId: id } = await state.saveGateway(stack.url, "E", "operator-test-token");
        const watch = collect<WatchUpdate>();
        const watchId = state.startWatch(id, 1, watch.subscriber);
        expect(await next(watch.received, () => true)).toEqual({ kind: "ready" });
        await stack.stopGateway();
        expect(await next(watch.received, () => true)).toEqual({ kind: "lost" });
        await stack.startGateway();
        await next(watch.received, (u) => u.kind === "ready", 30_000);
        await state.send(id, "engineer", "After the restart", "watch-restart");
        expect(await next(watch.received, (u) => u.kind === "conversation")).toEqual({
          kind: "conversation",
          tagId: "engineer",
        });
        state.stopWatch(watchId);
        await eventually(watch.ended);
      } finally {
        await stack.stop();
      }
    });

    it("reaches a saved wss:// Gateway, and an https:// one, with the Gateway's own TLS", async () => {
      const home = await directory("tls");
      const certificates = await privateCertificates(home);
      if (certificates === undefined) return;
      const stack = await Stack.start({
        root: home,
        name: "state",
        token: "operator-test-token",
        tls: { cert: certificates.cert, key: certificates.key },
      });
      const edge = await tlsEdge(certificates, Number(stack.tunnel.split(":")[1]));
      try {
        await stack.putTag("engineer", certificates.ca);
        const wss = `wss://127.0.0.1:${(edge.address() as { port: number }).port}/edge/supertag`;
        // The system's roots do not trust the private authority.
        await expect(app(home).saveGateway(wss, "Hosted", "operator-test-token")).rejects.toBe(
          "Could not connect to the Gateway. Check its address and TLS certificate.",
        );
        const state = app(home, { ca: certificates.ca });
        for (const url of [wss, stack.url]) {
          const activation = await state.saveGateway(url, url, "operator-test-token");
          expect(activation.origin).toBe(url);
          expect((await state.tags(activation.connectionId))[0]?.tagId).toBe("engineer");
          const follow = collect<FollowUpdate>();
          state.startFollow(activation.connectionId, { tagId: "engineer" }, follow.subscriber);
          expect(await next(follow.received, () => true)).toEqual({ kind: "ready" });
        }
        expect((await state.savedGateways()).profiles.map((p) => p.origin)).toEqual([
          wss,
          stack.url,
        ]);
      } finally {
        edge.close();
        await stack.stop();
      }
    });
  },
);

/** A scripted Watch, as `watch/tests.rs` serves it: a token to resume from, then a resync. */
describe("the Watch against a scripted Gateway", () => {
  it("resumes and stops the real stream without a unary deadline", async () => {
    const tokens: string[] = [];
    let closed = 0;
    const frame = (resumeToken: string, update: WatchEvent["update"]) =>
      create(WatchEventSchema, { resumeToken, update });
    const change = (init: Record<string, unknown>) =>
      ({ case: "change", value: init }) as unknown as WatchEvent["update"];
    const routes = (router: ConnectRouter) => {
      router.service(ProtocolNegotiation, {
        negotiate: () => ({
          role: ServiceRole.GATEWAY,
          protocolVersion: PROTOCOL_VERSIONS[0] ?? 0,
          protocolVersions: [...PROTOCOL_VERSIONS],
          buildVersion: "scripted",
        }),
      });
      router.service(OperatorEvents, {
        async *watch(request: WatchRequest, context) {
          expect(context.requestHeader.get("authorization")).toBe("Bearer operator-token");
          expect(context.requestHeader.get("grpc-timeout")).toBeNull();
          expect(request.kinds).toEqual([
            WatchKind.TAG,
            WatchKind.CONVERSATION_MESSAGE,
            WatchKind.TASK,
            WatchKind.SCHEDULE,
            WatchKind.MEMORY,
          ]);
          tokens.push(request.resumeToken);
          if (request.resumeToken === "") {
            yield frame("start", { case: "heartbeat", value: {} } as WatchEvent["update"]);
            yield frame("after-tag", change({ kind: WatchKind.TAG, id: "engineer" }));
            yield frame(
              "after-public-task",
              change({
                kind: WatchKind.TASK,
                id: "public-task",
                tagId: "engineer",
                reason: WatchReason.CHANGED,
              }),
            );
            throw new ServerError("fixture stream stopped", ServerCode.Unavailable);
          }
          if (request.resumeToken !== "after-public-task") {
            throw new ServerError("unexpected resume token", ServerCode.InvalidArgument);
          }
          yield frame("new-head", { case: "resync", value: {} } as WatchEvent["update"]);
          yield frame(
            "task-created",
            change({
              kind: WatchKind.TASK,
              id: "created-task",
              tagId: "engineer",
              sessionId: "conversation/creation-notice",
              reason: WatchReason.CREATED,
            }),
          );
          yield frame(
            "message",
            change({
              kind: WatchKind.CONVERSATION_MESSAGE,
              id: "message",
              tagId: "engineer",
              reason: WatchReason.CREATED,
            }),
          );
          yield frame(
            "thread-task",
            change({
              kind: WatchKind.TASK,
              id: "thread",
              tagId: "engineer",
              sessionId: "slack:T1/C1/1.0",
              reason: WatchReason.CHANGED,
            }),
          );
          yield frame(
            "task-finished",
            change({
              kind: WatchKind.TASK,
              id: "message",
              tagId: "engineer",
              sessionId: "conversation/planning",
              reason: WatchReason.CHANGED,
            }),
          );
          for (const [token, tag] of [
            ["note", "engineer"],
            ["tagless-note", ""],
          ] as const) {
            yield frame(
              token,
              change({
                kind: WatchKind.MEMORY,
                id: "mem_1",
                tagId: tag,
                reason: WatchReason.DELETED,
              }),
            );
          }
          try {
            await new Promise((_, reject) =>
              context.signal.addEventListener("abort", () => reject(context.signal.reason)),
            );
          } finally {
            closed += 1;
          }
        },
      });
    };
    const server = createHttp2Server(connectNodeAdapter({ routes, grpc: true, connect: false }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = createGatewayClient({ url, token: "operator-token" });
    try {
      const received: WatchUpdate[] = [];
      const stop = new AbortController();
      const run = runWatch(
        client,
        stop.signal,
        {
          send(update) {
            received.push(update);
            return true;
          },
        },
        { firstRetryMs: 1, idleMs: 4_000 },
      );
      const expected: WatchUpdate[] = [
        { kind: "ready" },
        { kind: "tag" },
        { kind: "lost" },
        { kind: "resync" },
        { kind: "conversation", tagId: "engineer" },
        { kind: "conversation", tagId: "engineer" },
        { kind: "memory", tagId: "engineer" },
      ];
      for (let waited = 0; received.length < expected.length && waited < 200; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(received).toEqual(expected);
      expect(tokens).toEqual(["", "after-public-task"]);
      stop.abort();
      await run;
      for (let waited = 0; closed === 0 && waited < 200; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(closed).toBe(1);
    } finally {
      client.close();
      server.close();
    }
  });
});

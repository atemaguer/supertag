/**
 * The local services at launch, as the desktop app's startup handles them: stopped services that
 * were set up start with `supertag up`, a failed start says what the CLI printed, an unset
 * machine says how to set SuperTag up, an older local Gateway is offered a restart, and the
 * chooser settles at once. The CLI is a shell script that keeps its state in files.
 * Run with `bun test` in apps/tui.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Connections } from "../src/connection";
import { Controller } from "../src/controller";
import type { Launch } from "../src/launch";
import { defaults } from "../src/preferences";
import { FakeGateway } from "./fake-gateway";
import { render, reset, type Setup, TAGS } from "./harness";

/** Generous: the stand-in CLI is a shell script, slow on a busy machine. */
const ROUNDS = 1_500;
const TIMEOUT = 60_000;

let current: Setup | undefined;
afterEach(() => {
  reset(current);
  current = undefined;
});

/**
 * A stand-in `supertag`: `__local-gateway` reports the services running when `running` exists
 * and set up when `setup` exists; `up` starts them (or fails with `up-fails`'s text), `down`
 * stops them, and both drop `older`, the mark of an older release. Every call is logged.
 */
function fakeCli(root: string): string {
  const state = path.join(root, "state");
  const cli = path.join(root, "supertag");
  writeFileSync(
    cli,
    `#!/bin/sh
r='${root}'
echo "$*" >> "$r/calls"
case "$1" in
  __local-gateway)
    if [ -f "$r/cli-fails" ]; then echo "Error: $(cat "$r/cli-fails")" >&2; exit 1; fi
    if [ -f "$r/running" ]; then
      echo '{"protocol":"local-gateway.v2","running":true,"state_directory":"${state}","set_up":true,"machine_id":null,"url":"http://127.0.0.1:1","token":"t"}'
    elif [ -f "$r/setup" ]; then
      echo '{"protocol":"local-gateway.v2","running":false,"state_directory":"${state}","set_up":true,"machine_id":null,"message":"No local Gateway is running."}'
    else
      echo '{"protocol":"local-gateway.v2","running":false,"state_directory":"${state}","set_up":false,"machine_id":null,"message":"No local Gateway is running."}'
    fi ;;
  up)
    sleep 0.3
    echo 'Starting SuperTag'
    if [ -f "$r/up-fails" ]; then cat "$r/up-fails" >&2; exit 1; fi
    rm -f "$r/older"; touch "$r/running" ;;
  down)
    rm -f "$r/running" "$r/older" ;;
esac
`,
  );
  chmodSync(cli, 0o755);
  return cli;
}

/** The terminal UI as `run.tsx` starts it, against the stand-in CLI and an in-memory Gateway. */
async function launch(
  files: string[],
  given: Launch = {},
  options: { saved?: boolean; choose?: boolean } = {},
): Promise<Setup & { calls(): string[] }> {
  const root = mkdtempSync(path.join(tmpdir(), "supertag-tui-local-"));
  for (const file of files) writeFileSync(path.join(root, file), "");
  const fake = new FakeGateway(TAGS);
  const desktopStore = path.join(root, "config/desktop/gateways.json");
  if (options.saved) {
    mkdirSync(path.dirname(desktopStore), { recursive: true, mode: 0o700 });
    writeFileSync(
      desktopStore,
      JSON.stringify({
        active: null,
        gateways: [{ profile: { name: "work", origin: "https://gw.example.com" }, token: "x" }],
      }),
      { mode: 0o600 },
    );
  }
  const connections: Connections = new Connections({
    env: { HOME: root, PATH: "/usr/bin:/bin" },
    cli: fakeCli(root),
    buildVersion: "0.3.4",
    release: "0.3.4",
    cacheRoot: path.join(root, "cache"),
    cliStore: path.join(root, "config/supertag/gateways.json"),
    desktopStore,
    probe: async () =>
      existsSync(path.join(root, "older")) ? { build: "0.3.0", versions: [1] } : undefined,
    connectTo: async (connection) => {
      if (existsSync(path.join(root, "older"))) {
        throw "This client 0.3.4 speaks protocol 7; the Gateway 0.3.0 speaks 1. Upgrade the Gateway.";
      }
      const scope = { gateway: connection.gateway, principal: fake.principal };
      const connectionId = connections.state.adopt(
        fake.session(),
        connection.shown,
        scope,
        connection.localState,
      );
      return { connectionId, principal: fake.principal, tags: [], scope };
    },
  });
  const controller = new Controller(connections, defaults(), undefined);
  const first = options.choose ? undefined : await controller.startupEntry(given);
  if (first) void controller.open(first);
  else controller.choose();
  const calls = () =>
    existsSync(path.join(root, "calls"))
      ? readFileSync(path.join(root, "calls"), "utf8").trim().split("\n")
      : [];
  return { fake, controller, alerts: [], root, calls };
}

test(
  "starts the stopped local services that were set up, visibly, then connects",
  async () => {
    const given = await launch(["setup"]);
    current = given;
    const screen = await render(given);
    await screen.waitFor("Starting SuperTag…", ROUNDS);
    await screen.waitFor("Message lead", ROUNDS);
    expect(screen.frame()).not.toContain("Starting SuperTag…");
    expect(screen.frame()).toContain("Local · connected");
    expect(given.calls()).toContain(`up --state-directory ${path.join(given.root, "state")}`);
    await screen.close();
  },
  TIMEOUT,
);

test(
  "says what supertag up printed when it could not start, and r tries again",
  async () => {
    const given = await launch(["setup", "up-fails"]);
    writeFileSync(
      path.join(given.root, "up-fails"),
      "Error: Worklet laptop did not report readiness: no Node\n",
    );
    current = given;
    const screen = await render(given);
    const failed = await screen.waitFor("did not report readiness: no Node", ROUNDS);
    expect(failed).toContain("Could not start SuperTag:");
    expect(failed).toContain("Logs: ");
    expect(failed).toContain("r try again");
    rmSync(path.join(given.root, "up-fails"));
    await screen.press("r");
    await screen.waitFor("Message lead", ROUNDS);
    expect(given.calls().filter((call) => call.startsWith("up "))).toHaveLength(2);
    await screen.close();
  },
  TIMEOUT,
);

test(
  "says how to set SuperTag up when it is not, and never runs up",
  async () => {
    const given = await launch([]);
    current = given;
    const screen = await render(given);
    const frame = await screen.waitFor("SuperTag is not set up on this machine.", ROUNDS);
    expect(frame).toContain("supertag init");
    expect(frame).toContain("Local · not set up");
    // Once it is set up and running elsewhere, the retry connects.
    writeFileSync(path.join(given.root, "running"), "");
    await screen.waitFor("Message lead", ROUNDS);
    expect(given.calls().some((call) => call.startsWith("up "))).toBe(false);
    await screen.close();
  },
  TIMEOUT,
);

test(
  "offers to restart an older local Gateway, asks first, then restarts and connects",
  async () => {
    const given = await launch(["setup", "running", "older"]);
    current = given;
    const screen = await render(given);
    const offer = await screen.waitFor("Restart SuperTag with 0.3.4", ROUNDS);
    expect(offer).toContain("The local SuperTag runs 0.3.0");
    expect(given.calls().some((call) => call.startsWith("down"))).toBe(false);
    await screen.press("RETURN");
    await screen.waitFor("Its running Tasks are interrupted.", ROUNDS);
    await screen.press("ESCAPE");
    await screen.waitFor("Enter  Restart SuperTag with 0.3.4", ROUNDS);
    expect(given.calls().some((call) => call.startsWith("down"))).toBe(false);
    await screen.press("RETURN");
    await screen.waitFor("Its running Tasks are interrupted.", ROUNDS);
    await screen.press("RETURN");
    await screen.waitFor("Message lead", ROUNDS);
    const state = path.join(given.root, "state");
    expect(given.calls().filter((call) => call.includes("--state-directory"))).toEqual([
      `down --state-directory ${state}`,
      `up --state-directory ${state}`,
    ]);
    await screen.close();
  },
  TIMEOUT,
);

test(
  "an explicit --gateway local never starts the services",
  async () => {
    const given = await launch(["setup"], { gateway: "local" });
    current = given;
    const screen = await render(given);
    await screen.waitFor("No local Gateway is running.", ROUNDS);
    await screen.settle(20);
    expect(given.calls().some((call) => call.startsWith("up "))).toBe(false);
    await screen.close();
  },
  TIMEOUT,
);

test(
  "the chooser settles at once: Local's error and that none is saved",
  async () => {
    const given = await launch(["cli-fails"]);
    writeFileSync(path.join(given.root, "cli-fails"), "state directory is not private");
    current = given;
    const screen = await render(given);
    const frame = await screen.waitFor("Local: Could not read the local Gateway", ROUNDS);
    expect(frame).toContain("state directory is not");
    expect(frame).toContain("No Gateways saved");
    expect(frame).not.toContain("Looking for Gateways…");
    await screen.close();
  },
  TIMEOUT,
);

test(
  "a saved Gateway lists while Local is still being looked for, and opening Local starts it",
  async () => {
    const given = await launch(["setup"], {}, { saved: true, choose: true });
    current = given;
    // Launched onto the saved Gateway, as when it was used last; Local's CLI answers slowly.
    const { connections } = given.controller;
    const slow = connections.localEntry.bind(connections);
    let release = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    connections.localEntry = async () => {
      await answered;
      return slow();
    };
    const screen = await render(given);
    const listed = await screen.waitFor("gw.example.com", ROUNDS);
    expect(listed).toContain("Looking for the local Gateway…");
    release();
    await screen.waitFor("Stopped. Enter starts it.", ROUNDS);
    await screen.press("RETURN");
    await screen.waitFor("Message lead", ROUNDS);
    expect(given.calls()).toContain(`up --state-directory ${path.join(given.root, "state")}`);
    await screen.close();
  },
  TIMEOUT,
);

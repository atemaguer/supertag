/**
 * The window's first screen, decided by the renderer's own startup sequence (`src/startup.ts`)
 * against the main process's real handlers, with a stand-in CLI. A fresh state directory must
 * reach the setup screen; with no CLI, the setup screen says how to install
 * it; a set-up machine with stopped services starts them.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GatewayActivation } from "@supertag/client/model";
import { GatewayState, readLocalGateway } from "@supertag/client/node";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startup } from "../src/startup";
import { gatewayHandlers } from "./gateway/handlers";
import type { Handlers } from "./ipc";
import { type AppIdentity, appCli, installCommand } from "./local/cli";
import { localHandlers } from "./local/handlers";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "supertag-startup-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** What `init --check --json` prints for a fresh state directory, from a 0.3.2 CLI. */
const FRESH_CHECK = {
  version: 1,
  ready: true,
  harnesses: [
    {
      harness: "codex",
      installed: true,
      signed_in: true,
      node: null,
      fix: null,
      fix_command: null,
      install_url: "https://developers.openai.com/codex/cli",
    },
  ],
  repository: null,
  state: { directory: "STATE", configured: false, repository_mapped: false },
};

/**
 * A stand-in `supertag` 0.3.2 for the state directory `state`: set up once `supertag.yaml`
 * exists, running once `up` ran (it never really listens).
 */
async function cli(name: string) {
  const dir = path.join(root, name);
  const state = path.join(dir, "state");
  await mkdir(dir, { recursive: true });
  const calls = path.join(dir, "calls");
  const check = JSON.stringify(FRESH_CHECK).replace("STATE", state);
  const file = path.join(dir, "supertag");
  await writeFile(
    file,
    `#!/bin/sh
echo "$*" >> '${calls}'
state='${state}'
case "$1" in
  --version) echo 'supertag 0.3.2' ;;
  __local-gateway)
    setup=false; test -f "$state/supertag.yaml" && setup=true
    if test -f "$state/running"; then
      echo "{\\"protocol\\":\\"local-gateway.v2\\",\\"running\\":true,\\"state_directory\\":\\"$state\\",\\"set_up\\":$setup,\\"machine_id\\":null,\\"url\\":\\"http://127.0.0.1:9\\",\\"token\\":\\"t\\"}"
    else
      echo "{\\"protocol\\":\\"local-gateway.v2\\",\\"running\\":false,\\"state_directory\\":\\"$state\\",\\"set_up\\":$setup,\\"machine_id\\":null,\\"message\\":\\"No local Gateway is running from $state.\\"}"
    fi ;;
  init) echo '${check}' ;;
  up) mkdir -p "$state" && touch "$state/running" ;;
esac
`,
  );
  await chmod(file, 0o755);
  return { dir, state, calls };
}

function table(
  dir: string,
  env: NodeJS.ProcessEnv,
): Pick<Handlers, "listGateways"> & ReturnType<typeof localHandlers> {
  const app: AppIdentity = { version: "0.3.2", execPath: "/nonexistent/SuperTag", env };
  const state = new GatewayState({
    store: path.join(dir, "config", "gateways.json"),
    cache: path.join(dir, "cache"),
    buildVersion: "0.3.2",
    discoverLocal: async () => readLocalGateway(await appCli(app), env),
  });
  return {
    ...gatewayHandlers(state, { reveal() {} }, path.join(dir, "cache")),
    ...localHandlers({
      app,
      protocolVersions: [6],
      probe: async () => undefined,
      chooseWorkspaceFolder: async () => null,
      localStateOf: (id) => state.localStateOf(id),
    }),
  };
}

const connected: GatewayActivation = {
  gateways: { profiles: [] },
  origin: "local",
  connectionId: "1",
  tags: [],
  principal: "operator:local",
};

async function first(handlers: ReturnType<typeof table>) {
  const starting: boolean[] = [];
  const result = await startup(
    {
      list: () => handlers.listGateways({}),
      localStartNeeded: () => handlers.localStartNeeded({}),
      startLocal: () => handlers.startLocalServices({}),
      select: async () => {
        throw "no saved Gateway";
      },
      // Connecting itself is the Gateway backend's, tested against a real Gateway there.
      connectLocal: async () => connected,
      check: () => handlers.checkSetup({}),
    },
    { gateways() {}, starting: (on) => starting.push(on), live: () => true },
  );
  return { result, starting };
}

it("shows the setup screen for a fresh state directory", async () => {
  const { dir, state } = await cli("fresh");
  const { result, starting } = await first(table(dir, { PATH: `${dir}:/usr/bin:/bin` }));
  expect(result.activation).toBeUndefined();
  expect(result.gateways).toEqual({
    profiles: [],
    active: null,
    local: { problem: `No local Gateway is running from ${state}.` },
  });
  expect(result.setup?.state).toEqual({
    directory: state,
    configured: false,
    repository_mapped: false,
  });
  expect(result.setup?.cli).toBe(path.join(dir, "supertag"));
  expect(starting).toEqual([]);
});

it("shows the setup screen with the install command when there is no CLI", async () => {
  const dir = path.join(root, "none");
  const { result } = await first(table(dir, { PATH: "/nonexistent" }));
  expect(result.setup).toEqual({
    cli: null,
    problem: `Could not find the supertag command. Install it with: ${installCommand("0.3.2")}`,
    install: installCommand("0.3.2"),
  });
  expect(result.gateways.local?.problem).toContain("Could not find the supertag command");
});

it("starts the stopped services of a set-up machine, then connects", async () => {
  const { dir, state, calls } = await cli("stopped");
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "supertag.yaml"), "version: 1\n");
  const { result, starting } = await first(table(dir, { PATH: `${dir}:/usr/bin:/bin` }));
  expect(starting).toEqual([true, false]);
  expect(await readFile(calls, "utf8")).toContain(`up --state-directory ${state}\n`);
  expect(result.activation).toEqual(connected);
  expect(result.setup).toBeUndefined();
});

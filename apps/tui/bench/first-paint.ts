/**
 * First paint in a real PTY against the stack from scripts/stack.sh: the compiled binary opens
 * `--gateway URL`, the URL a proxy that delays every chunk 15 ms each way (≈30 ms round trip) in
 * front of the local Gateway, and the time until the pane shows the lead's latest reply. The lead
 * gets 50 Markdown turns first (the fixture adapter echoes them), then one ending in a marker.
 * "first" clears the terminal UI's cache and preferences before each launch; "next" has them.
 * Budgets: the Go TUI's phase 0 medians + 50 ms (first 302 + 50, next 113 + 50).
 *   TUI_BINARY=/tmp/supertag-tui/dist/supertag-tui-darwin-arm64 \
 *     sh scripts/stack.sh cli … ; bun bench/first-paint.ts [RUNS]
 * Reads SUPERTAG_CLI, TUI_ROOT (default /tmp/supertag-tui) and TUI_BINARY. Exits 1 over budget.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import path from "node:path";
import { GatewayState, readLocalGateway } from "@supertag/client/node";

const runs = Number(process.argv[2] ?? "10");
const root = process.env["TUI_ROOT"] ?? "/tmp/supertag-tui";
const cli = process.env["SUPERTAG_CLI"] as string;
const binary = process.env["TUI_BINARY"] ?? path.join(root, "dist/supertag-tui-darwin-arm64");
const home = path.join(root, "home");
const env = { PATH: "/usr/bin:/bin", HOME: home, SUPERTAG_STATE_DIR: path.join(root, "state") };
const socket = path.join(root, "tmux-paint.sock");
const TAG = "lead";
const TURNS = 50;
const ONE_WAY_MS = 15;
const PROXY_PORT = 47452;

const local = await readLocalGateway(cli, env);
if (!local.running || !local.url || !local.token) throw new Error("start the stack first");

// Seed the lead's conversation, once.
const state = new GatewayState({
  store: path.join(root, "none.json"),
  cache: path.join(root, "bench-cache"),
  buildVersion: "first-paint",
  discoverLocal: async () => local,
});
const connected = await state.connectTo({
  shown: "local",
  gateway: "bench",
  url: local.url,
  token: local.token,
});
const id = connected.connectionId;
const reply = (i: number) =>
  `## Plan ${i}\n\nI read the **failing test** and found the cause:\n\n` +
  "- the cache keys on `width` only\n- the rail rebuilds on every frame\n\n" +
  "```ts\nfunction view(model: Model): string {\n  return render(model);\n}\n```\n\n" +
  `That is all for step ${i}.\n\nmarker-${i}`;
const seeded = (await state.messages(id, { tagId: TAG })).messages.some((message) =>
  message.task.result?.includes(`marker-${TURNS - 1}`),
);
async function turn(text: string) {
  const sent = await state.send(id, TAG, text, crypto.randomUUID().replaceAll("-", ""));
  for (;;) {
    const page = await state.messages(id, { tagId: TAG });
    const done = page.messages.find((message) => message.task.taskId === sent.task.taskId);
    if (done && ["succeeded", "failed"].includes(done.task.state)) return;
    await Bun.sleep(20);
  }
}
if (!seeded) for (let i = 0; i < TURNS; i++) await turn(reply(i));
// One more, so the lead is the Tag with the latest activity, which a fresh launch opens.
const marker = `marker-latest-${Date.now()}`;
await turn(`${reply(TURNS)}\n\n${marker}`);
state.disconnect();

const upstream = new URL(local.url);
const proxy = createServer((client) => {
  const server = tcpConnect({ host: upstream.hostname, port: Number(upstream.port) });
  client.setNoDelay(true);
  server.setNoDelay(true);
  const delayed = (from: typeof client, to: typeof client) =>
    from.on("data", (chunk) => setTimeout(() => to.write(chunk), ONE_WAY_MS));
  delayed(client, server);
  delayed(server, client);
  for (const end of [client, server]) {
    end.on("error", () => {
      client.destroy();
      server.destroy();
    });
    end.on("close", () => {
      client.destroy();
      server.destroy();
    });
  }
});
await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
const tmux = (...args: string[]) =>
  spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });

function clearCaches() {
  rmSync(path.join(home, "Library/Caches/supertag"), { recursive: true, force: true });
  rmSync(path.join(home, ".cache/supertag"), { recursive: true, force: true });
  rmSync(path.join(home, "Library/Application Support/supertag/tui.json"), { force: true });
  rmSync(path.join(home, ".config/supertag/tui.json"), { force: true });
}

async function launch(): Promise<number> {
  tmux("kill-server");
  const command = [
    "env -i",
    `PATH=${env.PATH}`,
    `HOME=${home}`,
    `SUPERTAG_STATE_DIR=${env.SUPERTAG_STATE_DIR}`,
    `SUPERTAG_CLI=${cli}`,
    "TERM=xterm-256color",
    "TMPDIR=/tmp",
    `SUPERTAG_OPERATOR_TOKEN=${local.token}`,
    `${binary} --gateway ${proxyUrl}`,
  ].join(" ");
  const began = performance.now();
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "paint", "-x", "160", "-y", "45", command);
  for (;;) {
    const pane = tmux("capture-pane", "-p", "-t", "paint").stdout;
    if (pane.includes(marker)) {
      const elapsed = performance.now() - began;
      // Let the cache write, then quit as a person would.
      await Bun.sleep(800);
      tmux("send-keys", "-t", "paint", "C-c");
      await Bun.sleep(200);
      tmux("kill-server");
      return elapsed;
    }
    if (performance.now() - began > 20_000) {
      console.error(pane);
      throw new Error(`never showed ${marker}`);
    }
    await Bun.sleep(2);
  }
}

const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    median: +(sorted[Math.floor(sorted.length / 2)] as number).toFixed(1),
    min: +(sorted[0] as number).toFixed(1),
    max: +(sorted[sorted.length - 1] as number).toFixed(1),
  };
};

const first: number[] = [];
const next: number[] = [];
for (let i = 0; i < runs; i++) {
  clearCaches();
  first.push(await launch());
}
clearCaches();
await launch();
for (let i = 0; i < runs; i++) next.push(await launch());
proxy.close();
const results = {
  proxy: `${ONE_WAY_MS * 2} ms round trip`,
  firstLaunch: summary(first),
  nextLaunch: summary(next),
  budgets: {
    "first launch median ≤ 352 ms": summary(first).median <= 352,
    "next launch median ≤ 163 ms": summary(next).median <= 163,
  },
};
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results.budgets).every(Boolean) ? 0 : 1);

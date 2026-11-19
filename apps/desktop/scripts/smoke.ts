/**
 * Launches a built or packaged desktop app and checks its window, as a user would get it: the
 * page renders, has no Node globals, and sees exactly the channel table's `window.supertag`. On
 * Linux it also checks that every renderer runs inside Chromium's sandbox, and that the app
 * logged no sandbox error.
 *
 *   tsx apps/desktop/scripts/smoke.ts EXECUTABLE [APP_DIRECTORY]
 *
 * EXECUTABLE is the app's binary: `SuperTag.app/Contents/MacOS/SuperTag`,
 * `/opt/SuperTag/supertag-desktop`, or Electron itself with the app directory after it. The app
 * runs with a throwaway HOME and state directory and is stopped after.
 *
 * Playwright drives it over Chromium's DevTools protocol rather than `_electron.launch`, which
 * needs the Node inspector that the packaged app's fuses turn off.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, chromium } from "playwright-core";
import { CHANNELS } from "../electron/channels";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: smoke.ts EXECUTABLE [APP_DIRECTORY]");
  process.exit(2);
}
const executable = path.resolve(args[0] as string);
const appArgs = args.slice(1);
const TIMEOUT_MS = 60_000;

function fail(message: string): never {
  throw new Error(message);
}

/** Resolves with the DevTools WebSocket URL the browser process prints on stderr. */
function devToolsUrl(child: ChildProcess, log: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the app printed no DevTools URL in time")),
      TIMEOUT_MS,
    );
    let buffered = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      log.push(chunk);
      buffered += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the app exited early (code ${code}, signal ${signal})`));
    });
  });
}

/**
 * Linux only: every renderer process of the app runs under seccomp-bpf in a PID namespace of its
 * own, as Chromium's sandbox puts it. The renderers are found by their data directory, under
 * this run's HOME, not by parentage: the setuid helper's zygote is reparented. Whether the
 * sandbox came from a user namespace or the setuid helper doesn't show from outside; to check
 * the user-namespace one, make the helper unusable first (CI does: chmod 0755 chrome-sandbox),
 * and Chromium refuses to start without either.
 */
async function checkSandbox(home: string) {
  const renderers: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    // A zygote child rewrites its command line into one space-separated string.
    const words = (await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "")).split(/[\0 ]/);
    if (
      words.includes("--type=renderer") &&
      words.some((word) => word.startsWith(`--user-data-dir=${home}/`))
    ) {
      renderers.push(Number(entry));
    }
  }
  if (renderers.length === 0) fail("found no renderer process of this run");
  for (const pid of renderers) {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    if (!/^Seccomp:\s+2$/m.test(status)) fail(`renderer ${pid} runs without seccomp-bpf`);
    const nspid = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
    if (nspid.length < 2) fail(`renderer ${pid} shares the browser's PID namespace`);
    console.log(`renderer ${pid}: sandboxed (seccomp-bpf, own PID namespace)`);
  }
}

/**
 * Connects Playwright to the app. A connection made while the window is still coming up can
 * stall, so a slow one is dropped and made again.
 */
async function connect(url: string): Promise<Browser> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await chromium.connectOverCDP(url, { timeout: 15_000 });
    } catch (error) {
      if (attempt === 4) throw error;
      console.log(`connecting to the app timed out (attempt ${attempt}); retrying`);
    }
  }
}

const home = await mkdtemp(path.join(tmpdir(), "supertag-smoke-"));
const log: string[] = [];
const child = spawn(executable, [...appArgs, "--remote-debugging-port=0"], {
  env: {
    ...process.env,
    HOME: home,
    SUPERTAG_STATE_DIR: path.join(home, ".supertag"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let failed = false;
try {
  const browser = await connect(await devToolsUrl(child, log));
  const appPage = () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith("app://supertag/"));
  const deadline = Date.now() + TIMEOUT_MS;
  let page = appPage();
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    page = appPage();
  }
  if (!page) fail("the app opened no window on app://supertag/");
  await page.waitForFunction(() => (document.getElementById("app")?.childElementCount ?? 0) > 0, {
    timeout: TIMEOUT_MS,
  });
  const text = (await page.locator("#app").innerText()).trim();
  if (!text) fail("the window rendered no text");
  console.log(`window: ${page.url()} shows "${text.split("\n")[0]}"`);

  const globals = await page.evaluate(() =>
    Object.fromEntries(
      ["require", "process", "module", "Buffer", "global", "__dirname"].map((name) => [
        name,
        typeof (globalThis as Record<string, unknown>)[name],
      ]),
    ),
  );
  const leaked = Object.entries(globals).filter(([, type]) => type !== "undefined");
  if (leaked.length > 0) fail(`the renderer has Node globals: ${JSON.stringify(leaked)}`);
  console.log("renderer: no Node globals");

  const api = await page.evaluate(() =>
    Object.keys((window as unknown as { supertag?: object }).supertag ?? {}).sort(),
  );
  const expected = [...Object.keys(CHANNELS), "onNotificationClick"].sort();
  if (JSON.stringify(api) !== JSON.stringify(expected)) {
    fail(`window.supertag is ${JSON.stringify(api)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`window.supertag: exactly the ${expected.length} expected entries`);

  if (process.platform === "linux") await checkSandbox(home);
  await browser.close().catch(() => {});
} catch (error) {
  failed = true;
  console.error(`smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.kill("SIGTERM");
  });
  const output = log.join("");
  const sandboxErrors = output
    .split("\n")
    .filter((line) => /sandbox/i.test(line) && /fatal|error|no usable/i.test(line));
  if (sandboxErrors.length > 0) {
    console.error(`the app logged sandbox errors:\n${sandboxErrors.join("\n")}`);
    failed = true;
  }
  if (failed) console.error(`--- app output ---\n${output}`);
  await rm(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

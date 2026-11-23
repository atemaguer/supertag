/**
 * Screenshots of the desktop window's main states, from the preview's sample data, so a UI change
 * can be looked at before it is reported.
 *
 *   pnpm --filter @supertag/desktop shots [STATE...]
 *
 * It serves the renderer with Vite on a free port, opens `?preview` in the installed Chrome
 * (headless, through playwright-core), and writes one PNG per state to `apps/desktop/.shots/`,
 * which git ignores. It never starts Electron. It exits 1 when a state does not render: the page
 * throws, or what the state is meant to show is missing.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".shots");

interface State {
  name: string;
  /** Preview parameters after `?preview`, such as `many` or `update=ready`. */
  query?: string;
  size?: { width: number; height: number };
  /** What the window remembers from before, such as the sidebar folded into its rail. */
  storage?: Record<string, string>;
  /** Brings the window into the state. */
  act?(page: Page): Promise<void>;
  /** What must be in the page for the state to count as rendered. */
  expect: string[];
}

const wide = { width: 1280, height: 820 };
const narrow = { width: 900, height: 700 };
const row = (name: string) => `#sidebar button[aria-label^="${name}"]`;

const states: State[] = [
  {
    name: "default",
    expect: [
      '#sidebar img[alt="SuperTag"]',
      row("finch"),
      ".timeline .bubble",
      ".composer textarea",
    ],
  },
  {
    name: "inspector",
    act: (page) => page.click("button.identity-pill"),
    expect: ["#tag-details", "#tag-details .avatar"],
  },
  {
    name: "gateway-selector",
    act: (page) => page.click("#sidebar button.connection"),
    expect: ['[role="menu"]'],
  },
  {
    name: "many-tags",
    query: "many",
    expect: [`${row("finch")}[data-lead]`, ".tag-row >> nth=15"],
  },
  {
    name: "no-lead",
    query: "nolead",
    expect: [".tag-row >> nth=3", ":root:not(:has(.tag-row[data-lead]))"],
  },
  {
    name: "needs-you",
    act: (page) => page.click(row("wren")),
    expect: [`${row("wren")}[aria-current="true"]`, ".timeline .bubble", ".needs-you"],
  },
  {
    // A Tag without a Workspace, whose turn runs on another Worker Host.
    name: "runs-elsewhere",
    act: (page) => page.click(row("moss")),
    expect: [`${row("moss")}[aria-current="true"]`, ".composer-where"],
  },
  {
    name: "approval",
    act: (page) => page.click(row("moss")),
    expect: [".needs-you .needs-you-detail", '.needs-you button:has-text("Approve once")'],
  },
  {
    name: "approval-deny",
    act: async (page) => {
      await page.click(row("moss"));
      await page.click('.needs-you button:has-text("Deny")');
    },
    expect: [".needs-you input:focus"],
  },
  {
    name: "approval-decided",
    act: async (page) => {
      await page.click(row("moss"));
      await page.click('.needs-you button:has-text("Approve once")');
    },
    expect: [".needs-you-decided", ":root:not(:has(.needs-you))"],
  },
  {
    name: "replying",
    act: async (page) => {
      await page.click(row("wren"));
      await page.click('.needs-you button:has-text("Reply")');
    },
    expect: [".composer-reply", ".composer textarea:focus"],
  },
  {
    name: "narrow-approval",
    size: narrow,
    act: (page) => page.click(row("moss")),
    expect: [".needs-you .needs-you-detail"],
  },
  { name: "narrow", size: narrow, expect: [row("finch"), ".timeline .bubble"] },
  {
    name: "narrow-inspector",
    size: narrow,
    act: (page) => page.click("button.identity-pill"),
    expect: ["#tag-details"],
  },
  { name: "narrow-many-tags", query: "many", size: narrow, expect: [".tag-row >> nth=15"] },
  {
    name: "search",
    act: (page) => page.click('#sidebar button[aria-label="Search"]'),
    expect: ['[role="dialog"] input'],
  },
  {
    name: "rail",
    storage: { "supertag.desktop.sidebar": "rail" },
    expect: ['#sidebar[data-mode="rail"]', row("finch")],
  },
  { name: "update-banner", query: "update=ready", expect: [".update-banner", ".sidebar-update"] },
];

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((name) => !states.some((state) => state.name === name));
  if (unknown.length) {
    const names = states.map((state) => state.name).join(", ");
    console.error(`Unknown state: ${unknown.join(", ")}. States: ${names}`);
    process.exit(2);
  }
  const chosen = wanted.length ? states.filter((state) => wanted.includes(state.name)) : states;
  if (!wanted.length) await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // Port 0 lets the system choose a free one, so this never collides with `dev` on 1420.
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not report its port");
  const origin = `http://127.0.0.1:${address.port}`;

  const failures: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const state of chosen) {
      const context = await browser.newContext({
        viewport: state.size ?? wide,
        deviceScaleFactor: 2,
        // A still frame: the typing dots and transitions hold their resting state.
        reducedMotion: "reduce",
        colorScheme: "dark",
      });
      if (state.storage)
        await context.addInitScript((entries) => {
          for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        }, state.storage);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}/?preview${state.query ? `&${state.query}` : ""}`);
        await page.waitForSelector(".tag-row", { timeout: 20_000 });
        await page.evaluate(() => document.fonts.ready);
        await state.act?.(page);
        for (const selector of state.expect)
          await page.waitForSelector(selector, { state: "attached", timeout: 5_000 });
        // Let the transcript settle at its end and menus finish opening.
        await page.waitForTimeout(600);
        if (errors.length) throw new Error(errors.join("; "));
        await page.screenshot({ path: path.join(out, `${state.name}.png`) });
        console.log(`ok    ${state.name}`);
      } catch (error) {
        failures.push(state.name);
        const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
        console.error(`FAIL  ${state.name}: ${reason}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
  const dir = path.relative(process.cwd(), out) || ".";
  console.log(`${chosen.length - failures.length} of ${chosen.length} states in ${dir}`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

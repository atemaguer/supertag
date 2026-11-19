/**
 * `supertag-tui`, the SuperTag terminal UI. The entry contract (apps/tui/README.md):
 * `--version` prints the bare version and `--headless-check` proves OpenTUI's native library
 * loads, both before React or the renderer load; otherwise it needs a terminal, and finds its
 * own Gateway (`--gateway`, the environment, the saved Gateways, `supertag __local-gateway`).
 */
import { parseArguments, USAGE } from "./launch";

const VERSION = process.env["SUPERTAG_TUI_VERSION"] ?? "dev";
const parsed = parseArguments(process.argv.slice(2));

if (parsed.kind === "version") {
  console.log(VERSION);
  process.exit(0);
}
if (parsed.kind === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (parsed.kind === "error") {
  console.error(`${parsed.message}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.kind === "headless-check") {
  const { resolveRenderLib } = await import("@opentui/core");
  resolveRenderLib();
  console.log("ok");
  process.exit(0);
}
if (parsed.kind === "run") {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("supertag-tui needs a terminal. Run supertag in a terminal to open it.");
    process.exit(2);
  }
  const { run } = await import("./run");
  await run(parsed.launch, VERSION);
}

/**
 * Runs the app for development in one command: the Vite server for the renderer, the main
 * process and preload built once by tsup, and Electron loading the Vite server. Closing the
 * window stops the server.
 *
 *   tsx apps/desktop/scripts/dev.ts [--preview]
 *
 * `--preview` loads the sample Tags (`?preview`) instead of connecting to a Gateway.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createServer } from "vite";

const desktop = path.join(import.meta.dirname, "..");
const preview = process.argv.includes("--preview");

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd: desktop, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const server = await createServer({
  root: desktop,
  configFile: path.join(desktop, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
});
let code = 1;
try {
  await server.listen();
  const url = `http://127.0.0.1:1420/${preview ? "?preview" : ""}`;
  code = await run("pnpm", ["exec", "tsup"]);
  if (code === 0) {
    const electron = (await import("electron")).default as unknown as string;
    code = await run(electron, ["."], { ...process.env, SUPERTAG_DESKTOP_DEV_URL: url });
  }
} finally {
  await server.close();
}
process.exit(code);

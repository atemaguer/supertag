/**
 * The interactive terminal UI: resolves where to connect, creates the renderer, and opens the
 * Gateway. `SUPERTAG_TUI_TIMING=FILE` records where startup time goes, for the first-paint bench.
 */
import { writeFileSync } from "node:fs";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { describe } from "@supertag/client/model";
import { App } from "./app";
import { Connections, launchTls } from "./connection";
import { Controller } from "./controller";
import { cliPath, type Launch, notifyLevel } from "./launch";
import { notificationBytes } from "./notify";
import { loadPreferences, preferencesFile } from "./preferences";

export async function run(launch: Launch, version: string) {
  const marks: Record<string, number> = { imported: performance.now() };
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (launch.stateDirectory) env["SUPERTAG_STATE_DIR"] = launch.stateDirectory;
  const url = launch.gateway?.includes("://") ? launch.gateway : env["SUPERTAG_GATEWAY_URL"];
  let launchUrl:
    | { url: string; token: string; tls: Awaited<ReturnType<typeof launchTls>> }
    | undefined;
  if (url && (launch.gateway === undefined || launch.gateway.includes("://"))) {
    const token = env["SUPERTAG_OPERATOR_TOKEN"]?.trim();
    if (!token) {
      console.error(`Set SUPERTAG_OPERATOR_TOKEN to connect to ${url}.`);
      process.exit(2);
    }
    try {
      launchUrl = { url, token, tls: await launchTls(env) };
    } catch (problem) {
      console.error(describe(problem));
      process.exit(2);
    }
  }
  // The credential stays in this process; nothing this starts needs it.
  delete process.env["SUPERTAG_OPERATOR_TOKEN"];
  const level = notifyLevel(env);
  const connections = new Connections({
    env,
    cli: cliPath(env),
    buildVersion: version === "dev" ? "supertag-tui" : version,
    release: version === "dev" ? undefined : version,
    ...(launchUrl ? { launchUrl } : {}),
  });
  const file = preferencesFile(env);
  const controller = new Controller(connections, loadPreferences(file), file);
  let first: string | undefined;
  try {
    first = await controller.startupEntry(launch, launchUrl?.url);
  } catch (problem) {
    console.error(describe(problem));
    process.exit(2);
  }
  marks["target"] = performance.now();
  if (first) void controller.open(first);
  else controller.choose();

  const renderer = await createCliRenderer({ exitOnCtrlC: false, screenMode: "alternate-screen" });
  marks["renderer"] = performance.now();
  let frames = 0;
  const timing = env["SUPERTAG_TUI_TIMING"];
  renderer.on("frame", () => {
    frames++;
    if (frames === 1) {
      marks["firstFrame"] = performance.now();
      if (timing) writeFileSync(timing, JSON.stringify(marks));
    }
  });
  const quit = () => {
    controller.close();
    renderer.destroy();
    process.exit(0);
  };
  createRoot(renderer).render(
    <App
      controller={controller}
      onQuit={quit}
      notifyLevel={level}
      onAlert={(alert) => {
        // Written between frames; terminals and tmux show it without disturbing the screen.
        const bytes = notificationBytes(alert, level, env);
        if (bytes) process.stdout.write(bytes);
      }}
    />,
  );
}

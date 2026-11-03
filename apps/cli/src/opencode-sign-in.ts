import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { minimalProcessEnvironment } from "@supertag/worker-sdk";
import { openCodeProviderEnvironment } from "./opencode-provider.js";

/** Match the Worker's isolated OpenCode home and explicitly selected provider key. */
export async function checkOpenCodeSignIn(
  model: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "supertag-opencode-signin-"));
  try {
    const provider = model.split("/")[0];
    const credentials = openCodeProviderEnvironment(model, environment);
    const key = Object.values(credentials)[0];
    const home = join(directory, "home");
    await mkdir(join(home, "opencode"), { recursive: true });
    if (key && provider)
      await writeFile(
        join(home, "opencode", "auth.json"),
        JSON.stringify({ [provider]: { type: "api", key } }),
        { mode: 0o600 },
      );
    const permission = { "*": "deny" };
    const { stdout } = await promisify(execFile)(
      "opencode",
      [
        "run",
        "--format",
        "json",
        "--model",
        model,
        "--agent",
        "build",
        "--pure",
        "Reply with OK only.",
      ],
      {
        cwd: directory,
        timeout: 30_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: {
          ...minimalProcessEnvironment(environment),
          ...credentials,
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          XDG_CACHE_HOME: home,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model,
            share: "disabled",
            autoupdate: false,
            plugin: [],
            mcp: {},
            permission,
            agent: { build: { mode: "primary", permission } },
          }),
          OPENCODE_PERMISSION: JSON.stringify(permission),
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        },
      },
    );
    const events = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    return (
      !events.some((event) => event.type === "error") &&
      events.some((event) => event.type === "text" && event.part?.text?.trim()) &&
      events.some((event) => event.type === "step_finish" && event.part?.reason === "stop")
    );
  } catch {
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

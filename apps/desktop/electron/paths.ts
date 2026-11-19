import path from "node:path";

/** The app's identifier, and the name of its directories. */
export const APP_ID = "ai.supertag.desktop";

/**
 * Where the app keeps its configuration, `<config>/ai.supertag.desktop`, computed exactly as the
 * CLI does (`core/crates/cli/src/profiles.rs`, `config_directory`): the CLI reads the
 * `gateways.json` saved there. macOS: `~/Library/Application Support`; elsewhere an absolute
 * `$XDG_CONFIG_HOME`, else `~/.config`.
 */
export function configDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = env["HOME"] || undefined;
  if (platform === "darwin") {
    if (!home) throw "HOME is required to find saved Gateways.";
    return path.join(home, "Library/Application Support", APP_ID);
  }
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, APP_ID);
  if (!home) throw "HOME or XDG_CONFIG_HOME is required to find saved Gateways.";
  return path.join(home, ".config", APP_ID);
}

/** The Gateways the app saved, which the CLI also reads. */
export function gatewayStore(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return path.join(configDirectory(env, platform), "gateways.json");
}

/**
 * Where the app caches what it shows on launch: as the Tauri app's data directory, beside the
 * configuration on macOS and in `~/.local/share` (or `$XDG_DATA_HOME`) elsewhere.
 */
export function cacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") return path.join(configDirectory(env, platform), "cache");
  const xdg = env["XDG_DATA_HOME"];
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, APP_ID, "cache");
  const home = env["HOME"] || undefined;
  if (!home) throw "HOME is required to find the app cache.";
  return path.join(home, ".local/share", APP_ID, "cache");
}

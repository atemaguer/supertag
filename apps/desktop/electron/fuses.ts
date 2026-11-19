/**
 * The Electron fuses the packaged app is built with, flipped in the Electron binary at package
 * time (electron-builder's `afterPack`): it never runs as plain Node, ignores `NODE_OPTIONS` and
 * `--inspect`, loads only its own integrity-checked asar, and encrypts its cookies. Every fuse is
 * set explicitly, so an Electron upgrade that adds one fails packaging until it is decided.
 */
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

export const FUSES = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // The renderer loads from app://, so file:// needs none of its old privileges.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
} as const;

/** Flips the fuses in a packaged Electron binary (on macOS, the `.app`'s main executable). */
export async function applyFuses(electronBinary: string, platform = process.platform) {
  await flipFuses(electronBinary, {
    ...FUSES,
    // Flipping invalidates the binary's ad hoc signature; the release signs it again after.
    resetAdHocDarwinSignature: platform === "darwin",
  });
}

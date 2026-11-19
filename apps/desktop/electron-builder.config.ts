/**
 * How electron-builder packages the app: an unsigned `SuperTag.app` for Apple silicon, which
 * `scripts/package-desktop-macos.sh` fills with the CLI, signs and turns into the disk image, and a
 * Debian package for each Linux release platform. The renderer and the main process are already
 * bundled (`pnpm build`), so the app carries only `dist/`, `dist-electron/` and its manifest, and no
 * `node_modules`. The fuses are flipped in `afterPack`, before anything signs the binary.
 */
import path from "node:path";
import type { Configuration } from "electron-builder";
import { applyFuses } from "./electron/fuses";

/** The Linux executable: /usr/bin/supertag-desktop, never /usr/bin/supertag, which is the CLI. */
const LINUX_EXECUTABLE = "supertag-desktop";

const config: Configuration = {
  appId: "ai.supertag.desktop",
  productName: "SuperTag",
  executableName: "SuperTag",
  copyright: "Copyright © SuperTag contributors",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "dist-electron/*.js", "dist-electron/*.cjs", "package.json"],
  asar: true,
  // There are no native modules to rebuild for Electron's Node.
  npmRebuild: false,
  // Our fuses, from electron/fuses.ts; electron-builder's own `electronFuses` stays unset.
  async afterPack(context) {
    const mac = context.electronPlatformName === "darwin";
    const name = context.packager.appInfo.productFilename;
    const binary = mac
      ? path.join(context.appOutDir, `${name}.app`, "Contents/MacOS", name)
      : path.join(context.appOutDir, LINUX_EXECUTABLE);
    await applyFuses(binary, mac ? "darwin" : "linux");
  },
  mac: {
    target: [{ target: "dir", arch: ["arm64"] }],
    // Unsigned here: the release signs the app once the CLI is inside it, with per-file
    // entitlements electron-builder can't express.
    identity: null,
    category: "public.app-category.developer-tools",
    minimumSystemVersion: "13.0",
    icon: "icon.icns",
    darkModeSupport: true,
  },
  linux: {
    target: [{ target: "deb" }],
    executableName: LINUX_EXECUTABLE,
    // The .desktop file is named after package.json's desktopName, the window's WM_CLASS.
    syncDesktopName: true,
    icon: "icons",
    category: "Development",
    maintainer: "SuperTag <noreply@github.com>",
    vendor: "SuperTag",
    synopsis: "Talk to your SuperTag Tags",
    description:
      "The SuperTag desktop app: conversations with your Tags, which run on your coding agents.",
    // The release names the files itself (SuperTag-VERSION-linux-ARCH.deb).
    artifactName: "SuperTag-${version}-linux-${arch}.${ext}",
  },
  deb: {
    packageName: "supertag-desktop",
    packageCategory: "devel",
    depends: [
      "libgtk-3-0t64 | libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "libgbm1",
      "libasound2t64 | libasound2",
      "xdg-utils",
      "libatspi2.0-0t64 | libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
    ],
    // No tray icon, so no libappindicator.
    recommends: [],
    // Ours, not electron-builder's: chrome-sandbox always stays setuid root, and the AppArmor
    // profile that lets Chromium's sandbox create user namespaces on Ubuntu 23.10 and later is
    // only removed when the package is.
    afterInstall: "build/linux/after-install.sh",
    afterRemove: "build/linux/after-remove.sh",
    appArmorProfile: "build/linux/apparmor-profile",
    // Releases up to 0.3.2 shipped the Tauri app as the package super-tag; installing this one
    // removes it rather than leaving two SuperTag apps in the menu.
    fpm: ["--conflicts", "super-tag", "--replaces", "super-tag"],
  },
};

export default config;

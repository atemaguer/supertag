// Signs the Electron parts of SuperTag.app and then the app itself, inside out, with the hardened
// runtime: the frameworks, the helper apps and the main executable. The CLI tree under
// Contents/Resources/supertag/ is skipped; scripts/package-desktop-macos.sh has already signed
// every Mach-O in it, so the app's seal covers it as it is.
//
//   node sign-mac.mjs APP IDENTITY KEYCHAIN
//
// The main executable and each helper app get only allow-jit, for V8. Everything else, such as
// the frameworks' libraries and the crash handler, gets no entitlements.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sign } from "@electron/osx-sign";

const [app, identity, keychain] = process.argv.slice(2);
if (!app || !identity || !keychain) {
  console.error("Usage: sign-mac.mjs APP IDENTITY KEYCHAIN");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const jit = path.join(here, "entitlements.mac.plist");
const none = path.join(here, "entitlements.none.plist");
const cli = `${path.resolve(app)}/Contents/Resources/supertag/`;

await sign({
  app,
  identity,
  keychain,
  platform: "darwin",
  type: "distribution",
  identityValidation: false,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  ignore: (file) => path.resolve(file).startsWith(cli),
  optionsForFile: (file) => ({
    hardenedRuntime: true,
    entitlements: file.endsWith(".app") ? jit : none,
  }),
});
console.log(`Signed ${app} as ${identity}.`);

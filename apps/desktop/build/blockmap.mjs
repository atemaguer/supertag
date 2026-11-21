// Writes ZIP.blockmap beside the signed app's update zip, as electron-builder's own zip target
// would: electron-updater fetches it to download only the blocks that changed since the zip it
// last installed. The release builds the zip itself (scripts/package-desktop-macos.sh), after
// signing, so electron-builder's target can't make it.
//
//   node blockmap.mjs ZIP
//
// Prints the zip's size and SHA-512, the blockmap's own record of it.
import { createRequire } from "node:module";

const [zip] = process.argv.slice(2);
if (!zip) {
  console.error("Usage: blockmap.mjs ZIP");
  process.exit(2);
}
// electron-builder's own blockmap writer, from the app-builder-lib it depends on.
const require = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");
const info = await buildBlockMap(zip, "gzip", `${zip}.blockmap`);
console.log(JSON.stringify({ size: info.size, sha512: info.sha512 }));

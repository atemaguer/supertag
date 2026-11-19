import { defineConfig } from "tsup";

// The Electron main process as ESM, and the preload as CommonJS: a sandboxed preload cannot load
// ES modules. Both bundle everything but Electron itself.
const common = {
  outDir: "dist-electron",
  platform: "node",
  target: "node24",
  external: ["electron"],
  sourcemap: true,
  tsconfig: "electron/tsconfig.json",
} as const;

export default defineConfig([
  { ...common, entry: { main: "electron/main.ts" }, format: ["esm"] },
  {
    ...common,
    entry: { preload: "electron/preload.ts" },
    format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }),
  },
]);

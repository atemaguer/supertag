import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "gateway-client": "src/gateway-client.ts",
    harness: "src/harness.ts",
  },
  clean: true,
  dts: true,
  external: ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-node"],
  format: ["esm"],
  platform: "node",
  sourcemap: true,
  splitting: true,
  target: "node22",
  treeshake: true,
});

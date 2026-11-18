import { join } from "node:path";
import { sandboxProviderConformance } from "@supertag/worker-sdk/internal/rust-workspace-provider/conformance";
import { afterEach, it } from "vitest";
import { fixture } from "./rust-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The fake runs files and processes on this machine and never executes the seal program, so it
// is not isolated: its command and seal cases check the protocol, and the Docker reference
// provider runs the real seal.
for (const check of sandboxProviderConformance(
  async ({ directory }) => ({
    session: (await fixture(cleanups, join(directory, "prepared"))).session,
  }),
  { commands: true, snapshots: true, isolated: false },
))
  it(`E2B conformance: ${check.name}`, check.run, check.timeoutMs);

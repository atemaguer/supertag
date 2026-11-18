import { join } from "node:path";
import { sandboxProviderConformance } from "@supertag/worker-sdk/internal/rust-workspace-provider/conformance";
import { afterEach, it } from "vitest";
import { fakePrivileged, fixture, type LocalRelays } from "./rust-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// The fake runs files and processes on this machine and never executes the seal program, so it
// is not isolated: its command and seal cases check the protocol, and the Docker reference
// provider runs the real seal.
// Its relay is the real relay program on this machine, which the egress case reaches directly.
for (const check of sandboxProviderConformance(
  async ({ directory }) => {
    const relays: LocalRelays = { ports: [], children: [] };
    cleanups.push(async () => {
      for (const child of relays.children) child.kill("SIGKILL");
    });
    const { session } = await fixture(
      cleanups,
      fakePrivileged(0, relays),
      join(directory, "prepared"),
    );
    return { session, relayPort: () => relays.ports.at(-1) };
  },
  { commands: true, snapshots: true, isolated: false, egress: true },
))
  it(`Modal conformance: ${check.name}`, check.run, check.timeoutMs);

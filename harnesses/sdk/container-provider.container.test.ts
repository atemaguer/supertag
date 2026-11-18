import { spawnSync } from "node:child_process";
import { it } from "vitest";
import { sandboxProviderConformance } from "./src/rust-workspace-provider/conformance.js";
import { createContainerWorkspaceSession } from "./src/rust-workspace-provider/container.js";

// The conformance suite against real, separate containers, through the container provider.
// Skipped where no container runtime answers or the image is absent (it is never pulled here;
// set SUPERTAG_TEST_REQUIRE_CONTAINER=1 to fail instead).
const IMAGE = process.env["SUPERTAG_TEST_REFERENCE_IMAGE"] ?? "node:24-bookworm";
const USER = process.env["SUPERTAG_TEST_REFERENCE_USER"] ?? "node";
const runtime = process.env["SUPERTAG_TEST_CONTAINER_RUNTIME"] ?? "docker";
const available =
  spawnSync(runtime, ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0 &&
  spawnSync(runtime, ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
if (!available && process.env["SUPERTAG_TEST_REQUIRE_CONTAINER"] === "1")
  throw new Error(`${runtime} with ${IMAGE} is required for the container provider`);

for (const check of sandboxProviderConformance(
  async () => {
    const session = createContainerWorkspaceSession({
      // The provider refuses an image with setuid programs its user can run, as node's has.
      image: {
        dockerfile: `FROM ${IMAGE}\nUSER root\nRUN find / -xdev -type f -perm /6000 -exec chmod u-s,g-s {} +\nUSER ${USER}\n`,
      },
      user: USER,
      runtime,
      label: "supertag.reference",
    });
    return {
      session,
      async lose() {
        // Out of band, as a crashed or expired sandbox ends. Cases run one at a time in this
        // file, so the only reference container is this case's.
        const listed = spawnSync(
          runtime,
          ["ps", "-aq", "--no-trunc", "--filter", "label=supertag.reference=1"],
          { encoding: "utf8" },
        );
        for (const id of listed.stdout.split("\n").filter(Boolean)) {
          spawnSync(runtime, ["rm", "-f", id], { stdio: "ignore" });
        }
      },
    };
  },
  { commands: true, snapshots: true, isolated: true, timeoutMs: 120_000 },
))
  it.skipIf(!available)(
    `Container provider conformance: ${check.name}`,
    check.run,
    check.timeoutMs,
  );

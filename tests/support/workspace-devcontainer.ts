import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { readTrustedDevcontainer } from "../../packages/runtime/sdk/src/devcontainer-subset.js";
import { bundleTrustedCommit } from "../../packages/runtime/sdk/src/workspace-bundles.js";

const execute = promisify(execFile);

/** Small committed repository and shallow content bundle for fake provider builds. */
export async function workspaceDevcontainerFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "supertag-devcontainer-provider-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await execute("git", ["init", "-q", repository]);
  await execute("git", ["-C", repository, "config", "user.name", "Test"]);
  await execute("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repository, dirname(path)), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await execute("git", ["-C", repository, "add", "."]);
  await execute("git", ["-C", repository, "commit", "-qm", "trusted"]);
  const trustedCommit = (
    await execute("git", ["-C", repository, "rev-parse", "HEAD"])
  ).stdout.trim();
  const content = await bundleTrustedCommit({
    repository,
    trustedCommit,
    directory: join(root, "bundles"),
  });
  const devcontainer = await readTrustedDevcontainer(repository, trustedCommit);
  return {
    root,
    repository,
    trustedCommit,
    content,
    devcontainer,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

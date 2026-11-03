import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { listCodexModels } from "./src/model-check.js";

it("rejects without an unhandled error when the app-server exits before reading its input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-check-"));
  try {
    // Closes stdin, then answers initialization, so the next write (initialized) hits a
    // closed pipe and fails with EPIPE.
    const command = join(directory, "codex");
    await writeFile(
      command,
      '#!/bin/sh\nexec 0<&-\nsleep 0.3\nprintf \'{"id":1,"result":{}}\\n\'\nsleep 0.5\n',
    );
    await chmod(command, 0o755);
    await expect(listCodexModels({ command, timeoutMs: 5_000 })).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

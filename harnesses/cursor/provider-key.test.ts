import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cursorApiKey, PROVIDER_CREDENTIALS_FILE } from "./src/index.js";

it("takes the Cursor API key from the Worker Host's file once, and deletes the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-provider-key-"));
  const original = process.env["CURSOR_API_KEY"];
  try {
    const file = join(directory, "credentials.json");
    await writeFile(file, JSON.stringify({ CURSOR_API_KEY: "key-from-file" }), { mode: 0o600 });
    process.env[PROVIDER_CREDENTIALS_FILE] = file;
    process.env["CURSOR_API_KEY"] = "key-from-environment";
    expect(cursorApiKey()).toBe("key-from-file");
    expect(await readdir(directory)).toEqual([]);
    expect(process.env[PROVIDER_CREDENTIALS_FILE]).toBeUndefined();
    // Later calls keep the key read from the file.
    expect(cursorApiKey()).toBe("key-from-file");
  } finally {
    if (original === undefined) delete process.env["CURSOR_API_KEY"];
    else process.env["CURSOR_API_KEY"] = original;
    await rm(directory, { recursive: true, force: true });
  }
});

import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSqliteUrl, invocationDirectory, stateDirectory } from "./src/paths.js";

const originalInitCwd = process.env["INIT_CWD"];
const originalStateDirectory = process.env["SUPERTAG_STATE_DIR"];
const originalHome = process.env["HOME"];

afterEach(() => {
  restoreEnvironment("INIT_CWD", originalInitCwd);
  restoreEnvironment("SUPERTAG_STATE_DIR", originalStateDirectory);
  restoreEnvironment("HOME", originalHome);
});

describe("self-hosted state paths", () => {
  it("keeps zero-configuration state under the user's home directory", () => {
    process.env["HOME"] = "/tmp/supertag-home";
    process.env["INIT_CWD"] = "/tmp/supertag-invocation";
    delete process.env["SUPERTAG_STATE_DIR"];

    expect(invocationDirectory()).toBe("/tmp/supertag-invocation");
    expect(stateDirectory()).toBe("/tmp/supertag-home/.supertag");
    expect(defaultSqliteUrl()).toBe("file:/tmp/supertag-home/.supertag/supertag.db");
  });

  it("resolves an operator-configured state directory from the invocation directory", () => {
    process.env["INIT_CWD"] = "/srv/supertag";
    process.env["SUPERTAG_STATE_DIR"] = "state";

    expect(stateDirectory()).toBe(resolve("/srv/supertag", "state"));
    expect(defaultSqliteUrl()).toBe("file:/srv/supertag/state/supertag.db");
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

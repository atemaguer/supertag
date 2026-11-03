/** Reads devcontainer settings as data from a trusted git commit. This module never checks out
 * repository content or executes a repository command on the Worker Host. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DevcontainerCommand, DevcontainerSubset } from "./workspace-environment.js";

const execute = promisify(execFile);
const FILE_LIMIT = 1024 * 1024;
const CANDIDATES = [".devcontainer/devcontainer.json", ".devcontainer.json"] as const;
const FIELDS = new Set([
  "image",
  "build",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "containerEnv",
  "remoteEnv",
  "remoteUser",
  "containerUser",
  "workspaceFolder",
  "postStartCommand",
  "postAttachCommand",
  "forwardPorts",
  "customizations",
]);
const IGNORED = new Set([
  "postStartCommand",
  "postAttachCommand",
  "forwardPorts",
  "customizations",
]);
const BUILD_FIELDS = new Set(["dockerfile", "context", "args"]);

/** Parsed JSON before the named Dockerfile is read and hashed from the trusted commit. */
export interface ParsedDevcontainerSubset extends Omit<DevcontainerSubset, "build"> {
  readonly build?: {
    readonly dockerfile: string;
    readonly context?: string;
    readonly args?: Readonly<Record<string, string>>;
  };
}

function object(value: unknown, property: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`devcontainer property ${property} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, property: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0"))
    throw new Error(
      `devcontainer property ${property} must be a string${allowEmpty ? "" : " with content"}`,
    );
  if (/\$\{localEnv:/iu.test(value))
    throw new Error(
      `devcontainer property ${property} cannot reference localEnv on the Worker Host`,
    );
  return value;
}

function assertEnvName(key: string, property: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
    throw new Error(`devcontainer property ${property}.${key} has an invalid variable name`);
  if (
    (property === "containerEnv" || property === "remoteEnv") &&
    /^(?:ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|GIT_|SUPERTAG_|LD_|DYLD_|E2B_|MODAL_|AWS_|NODE_OPTIONS$|PATH$)|_PROXY$/iu.test(
      key,
    )
  )
    throw new Error(`devcontainer property ${property}.${key} is a reserved variable name`);
}

function strings(value: unknown, property: string): Record<string, string> {
  const entries = Object.entries(object(value, property));
  return Object.fromEntries(
    entries.map(([key, entry]) => {
      assertEnvName(key, property);
      return [key, string(entry, `${property}.${key}`, true)];
    }),
  );
}

function command(value: unknown, property: string): DevcontainerCommand {
  if (typeof value === "string") return string(value, property);
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`devcontainer property ${property} needs a command`);
    return value.map((entry, index) => string(entry, `${property}[${index}]`));
  }
  const entries = Object.entries(object(value, property));
  if (entries.length === 0) throw new Error(`devcontainer property ${property} needs a command`);
  return Object.fromEntries(
    entries.map(([name, entry]) => [name, commandEntry(entry, `${property}.${name}`)]),
  );
}

function commandEntry(value: unknown, property: string): string | readonly string[] {
  if (typeof value === "string") return string(value, property);
  if (Array.isArray(value) && value.length > 0)
    return value.map((part, index) => string(part, `${property}[${index}]`));
  throw new Error(`devcontainer property ${property} must be a string or argv list`);
}

function relativePath(value: unknown, property: string): string {
  const path = string(value, property);
  if (path.startsWith("/") || path.includes("\\") || /[\r\n]/u.test(path))
    throw new Error(`devcontainer property ${property} must be a relative repository path`);
  return posix.normalize(path);
}

/** Parses JSON with comments and trailing commas, as the devcontainer format allows. */
function jsonc(source: string): unknown {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      output += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index++;
      }
      if (index >= source.length) throw new Error("devcontainer has an unclosed comment");
      index++;
    } else output += char;
  }
  // Remove commas only when the next nonspace character closes an array or object.
  let cleaned = "";
  quoted = false;
  escaped = false;
  for (let index = 0; index < output.length; index++) {
    const char = output[index];
    if (quoted) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      cleaned += char;
    } else if (char === "," && /^[\s]*[}\]]/u.test(output.slice(index + 1))) {
    } else cleaned += char;
  }
  return JSON.parse(cleaned);
}

/** Refuses every out-of-subset property by name. Ignored properties are discarded. */
export function parseDevcontainerSubset(source: string): ParsedDevcontainerSubset {
  if (Buffer.byteLength(source) > FILE_LIMIT) throw new Error("devcontainer.json is too large");
  let parsed: Record<string, unknown>;
  try {
    parsed = object(jsonc(source), "root");
  } catch (error) {
    throw new Error(
      `Invalid devcontainer.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const property of Object.keys(parsed))
    if (!FIELDS.has(property)) throw new Error(`Unsupported devcontainer property ${property}`);
  if (parsed["image"] !== undefined && parsed["build"] !== undefined)
    throw new Error("devcontainer properties image and build are mutually exclusive");
  const result: {
    image?: string;
    build?: NonNullable<ParsedDevcontainerSubset["build"]>;
    onCreateCommand?: DevcontainerCommand;
    updateContentCommand?: DevcontainerCommand;
    postCreateCommand?: DevcontainerCommand;
    containerEnv?: Record<string, string>;
    remoteEnv?: Record<string, string>;
    remoteUser?: string;
    containerUser?: string;
    workspaceFolder?: string;
  } = {};
  if (parsed["image"] !== undefined) {
    const image = string(parsed["image"], "image");
    if (/\s/u.test(image))
      throw new Error("devcontainer property image must be an image reference");
    result.image = image;
  }
  if (parsed["build"] !== undefined) {
    const build = object(parsed["build"], "build");
    for (const property of Object.keys(build))
      if (!BUILD_FIELDS.has(property))
        throw new Error(`Unsupported devcontainer property build.${property}`);
    const dockerfile = relativePath(build["dockerfile"], "build.dockerfile");
    result.build = {
      dockerfile,
      ...(build["context"] === undefined
        ? {}
        : { context: relativePath(build["context"], "build.context") }),
      ...(build["args"] === undefined ? {} : { args: strings(build["args"], "build.args") }),
    };
  }
  for (const property of ["onCreateCommand", "updateContentCommand", "postCreateCommand"] as const)
    if (parsed[property] !== undefined) result[property] = command(parsed[property], property);
  for (const property of ["containerEnv", "remoteEnv"] as const)
    if (parsed[property] !== undefined) result[property] = strings(parsed[property], property);
  for (const property of ["remoteUser", "containerUser"] as const)
    if (parsed[property] !== undefined) {
      const user = string(parsed[property], property);
      if (!/^[A-Za-z0-9._:-]+$/u.test(user))
        throw new Error(`devcontainer property ${property} must be a user name or ID`);
      result[property] = user;
    }
  if (parsed["workspaceFolder"] !== undefined) {
    const folder = string(parsed["workspaceFolder"], "workspaceFolder");
    if (
      !posix.isAbsolute(folder) ||
      folder === "/" ||
      posix.normalize(folder) !== folder ||
      /[\r\n]/u.test(folder)
    )
      throw new Error("devcontainer property workspaceFolder must be a normalized absolute path");
    result.workspaceFolder = folder;
  }
  for (const property of IGNORED) void parsed[property];
  return result;
}

const gitEnv = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execute(
    "git",
    ["-C", repository, "-c", "core.hooksPath=/dev/null", ...args],
    {
      env: gitEnv,
      encoding: "utf8",
      maxBuffer: FILE_LIMIT,
    },
  );
  return stdout;
}

async function blob(repository: string, commit: string, path: string): Promise<string | undefined> {
  const listed = await git(repository, ["ls-tree", "-r", commit, "--", path]);
  const entry = listed.split("\n").find((line) => line.endsWith(`\t${path}`));
  if (entry === undefined) return undefined;
  if (!/^100(644|755) blob [0-9a-f]{40,64}\t/u.test(entry))
    throw new Error(`devcontainer file ${path} must be a regular file`);
  return git(repository, ["cat-file", "blob", `${commit}:${path}`]);
}

/** Reads only the trusted commit. Missing file means the provider default toolchain. */
export async function readTrustedDevcontainer(
  repository: string,
  trustedCommit: string,
): Promise<DevcontainerSubset | undefined> {
  for (const path of CANDIDATES) {
    const source = await blob(repository, trustedCommit, path);
    if (source === undefined) continue;
    const parsed = parseDevcontainerSubset(source);
    if (parsed.build === undefined) {
      const { build: _build, ...definition } = parsed;
      return definition;
    }
    const directory = dirname(path).replaceAll("\\", "/");
    const dockerfilePath = posix.normalize(posix.join(directory, parsed.build.dockerfile));
    if (
      dockerfilePath.startsWith("../") ||
      dockerfilePath === ".." ||
      dockerfilePath.startsWith("/")
    )
      throw new Error("devcontainer property build.dockerfile escapes the trusted repository");
    const context = posix.normalize(posix.join(directory, parsed.build.context ?? "."));
    if (context.startsWith("../") || context === ".." || context.startsWith("/"))
      throw new Error("devcontainer property build.context escapes the trusted repository");
    const dockerfile = await blob(repository, trustedCommit, dockerfilePath);
    if (dockerfile === undefined)
      throw new Error(
        `devcontainer build.dockerfile ${dockerfilePath} is missing at the trusted commit`,
      );
    return {
      ...parsed,
      build: {
        ...parsed.build,
        dockerfilePath,
        dockerfileContent: dockerfile,
        dockerfileDigest: createHash("sha256").update(dockerfile).digest("hex"),
        context,
      },
    };
  }
  return undefined;
}

/** Materializes only tracked regular blobs from the trusted commit for E2B's Docker build.
 * No checkout, smudge filter, hook, archive extraction, or repository script runs on the host. */
export async function materializeTrustedBuildContext(input: {
  readonly repository: string;
  readonly trustedCommit: string;
  readonly context: string;
  readonly destination: string;
}): Promise<void> {
  const context = input.context === "." ? "" : `${input.context}/`;
  const { stdout } = await execute(
    "git",
    [
      "-C",
      input.repository,
      "-c",
      "core.hooksPath=/dev/null",
      "ls-tree",
      "-r",
      "-z",
      input.trustedCommit,
      "--",
      input.context,
    ],
    {
      env: gitEnv,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  let total = 0;
  for (const entry of stdout.toString("utf8").split("\0")) {
    if (!entry) continue;
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
    if (!match) throw new Error("devcontainer build.context contains an unsupported git entry");
    const path = match[3] as string;
    if (!path.startsWith(context)) continue;
    const relative = path.slice(context.length);
    if (!relative || relative.startsWith("/") || relative.split("/").includes(".."))
      throw new Error("devcontainer build.context contains an unsafe path");
    if (match[1] === "120000")
      throw new Error(`devcontainer build.context contains symlink ${path}`);
    const target = resolve(input.destination, relative);
    if (!target.startsWith(`${resolve(input.destination)}${sep}`))
      throw new Error("devcontainer build.context escapes its private directory");
    const { stdout: bytes } = await execute(
      "git",
      [
        "-C",
        input.repository,
        "-c",
        "core.hooksPath=/dev/null",
        "cat-file",
        "blob",
        match[2] as string,
      ],
      {
        env: gitEnv,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    total += bytes.byteLength;
    if (total > 512 * 1024 * 1024) throw new Error("devcontainer build.context exceeds 512 MiB");
    await mkdir(join(input.destination, dirname(relative)), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    if (match[1] === "100755") await chmod(target, 0o700);
  }
}

/** Applies the declared build arguments to ARG instructions without consulting host variables. */
export function applyDevcontainerBuildArgs(
  dockerfile: string,
  args: Readonly<Record<string, string>> | undefined,
): string {
  if (args === undefined || Object.keys(args).length === 0) return dockerfile;
  let result = dockerfile;
  for (const [name, value] of Object.entries(args)) {
    if (/[\r\n\0]/u.test(value))
      throw new Error(`devcontainer property build.args.${name} cannot contain a newline`);
    const expression = new RegExp(`^(\\s*ARG\\s+${name})(?:=[^\\r\\n]*)?\\s*$`, "gimu");
    if (!expression.test(result))
      throw new Error(`devcontainer property build.args.${name} has no ARG in build.dockerfile`);
    result = result.replace(expression, `$1=${value.replaceAll("$", "$$$$")}`);
  }
  return result;
}

/** Restricts Dockerfiles to instructions both remote providers translate without host file reads. */
export function validatedDevcontainerDockerfile(
  content: string,
  args: Readonly<Record<string, string>> | undefined,
): string {
  const source = applyDevcontainerBuildArgs(content, args);
  if (
    [...source].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        code === 127 ||
        code === 133 ||
        code === 0x2028 ||
        code === 0x2029
      );
    })
  )
    throw new Error("devcontainer build.dockerfile contains a control character");
  const allowed = new Set([
    "FROM",
    "RUN",
    "ENV",
    "ARG",
    "WORKDIR",
    "USER",
    "EXPOSE",
    "VOLUME",
    "CMD",
    "ENTRYPOINT",
  ]);
  let seenFrom = false;
  for (const raw of source.replaceAll(/\\(?:\r\n|\r|\n)/gu, " ").split(/\r\n|\r|\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (/^#\s*(?:syntax|escape|check)\s*=/iu.test(line))
        throw new Error("devcontainer build.dockerfile cannot use parser directives");
      continue;
    }
    const instruction = /^([A-Za-z]+)(?:\s|$)/u.exec(line)?.[1]?.toUpperCase();
    if (!instruction) throw new Error("devcontainer build.dockerfile has an invalid instruction");
    if (!allowed.has(instruction))
      throw new Error(`devcontainer build.dockerfile cannot use ${instruction}`);
    if (instruction === "FROM") {
      if (seenFrom)
        throw new Error("devcontainer build.dockerfile cannot use multiple FROM stages");
      seenFrom = true;
    } else if (!seenFrom && instruction !== "ARG") {
      throw new Error(`devcontainer build.dockerfile needs FROM before ${instruction}`);
    }
  }
  if (!seenFrom) throw new Error("devcontainer build.dockerfile needs FROM");
  return source;
}

/**
 * The user prepare gives the checkout and MCP directories: `remoteUser`, then `containerUser`,
 * then the last `USER` in `build.dockerfile`. Undefined when none is set, so the image's default
 * user (root on the fallback images) owns them. A `USER` must be a literal name or ID, since
 * prepare runs `chown` with it.
 */
export function devcontainerImageUser(
  devcontainer: Pick<DevcontainerSubset, "remoteUser" | "containerUser" | "build"> | undefined,
): string | undefined {
  const declared = devcontainer?.remoteUser ?? devcontainer?.containerUser;
  const build = devcontainer?.build;
  if (build?.dockerfileContent === undefined) return declared;
  const users = validatedDevcontainerDockerfile(build.dockerfileContent, build.args)
    .replaceAll(/\\(?:\r\n|\r|\n)/gu, " ")
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => /^USER(?:\s|$)/iu.test(line))
    .map((line) => line.slice(4).trim());
  for (const user of users)
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/u.test(user))
      throw new Error("devcontainer build.dockerfile USER must name a literal user or user:group");
  return declared ?? users.at(-1);
}

/** Modal begins with a registry image, then applies supported Dockerfile instructions as layers.
 * COPY and ADD from the repository need a local Docker context, which Modal's JS SDK lacks. */
export function modalDevcontainerBase(
  devcontainer: DevcontainerSubset | undefined,
  fallback: string,
): { readonly image: string; readonly commands: readonly string[] } {
  if (devcontainer?.image) return { image: devcontainer.image, commands: [] };
  if (!devcontainer?.build) return { image: fallback, commands: [] };
  const content = devcontainer.build.dockerfileContent;
  if (content === undefined) throw new Error("devcontainer build.dockerfile content is missing");
  const source = validatedDevcontainerDockerfile(content, devcontainer.build.args);
  const lines = source
    .replaceAll(/\\\r?\n/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const args: Record<string, string> = {};
  while (lines[0] && /^ARG\s+/iu.test(lines[0])) {
    const declaration = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/iu.exec(
      lines.shift() as string,
    );
    if (!declaration) throw new Error("Modal devcontainer build.dockerfile has an invalid ARG");
    args[declaration[1] as string] = declaration[2] ?? "";
  }
  const first = lines.shift();
  const from = first && /^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/iu.exec(first);
  if (!from)
    throw new Error(
      "Modal devcontainer build.dockerfile needs a registry FROM as its first instruction",
    );
  const image = (from[1] as string).replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu,
    (_match, name: string) => {
      if (!args[name])
        throw new Error(
          `Modal devcontainer build.dockerfile has an undefined FROM argument ${name}`,
        );
      return args[name];
    },
  );
  const commands: string[] = [];
  for (const line of lines) {
    const instruction = /^([A-Za-z]+)\b/u.exec(line)?.[1]?.toUpperCase();
    if (instruction === "FROM")
      throw new Error("Modal devcontainer build.dockerfile does not support multiple FROM stages");
    if (!instruction)
      throw new Error("Modal devcontainer build.dockerfile has an invalid instruction");
    commands.push(line);
  }
  return { image, commands };
}

/** Resolves the subset's container references from repository values alone. Host env is never read. */
export function resolvedDevcontainerEnv(
  devcontainer: Pick<DevcontainerSubset, "containerEnv" | "remoteEnv"> | undefined,
  workspaceFolder: string,
): Record<string, string> {
  if (!devcontainer) return {};
  const container = devcontainer.containerEnv ?? {};
  const resolved = new Map<string, string>();
  const visiting = new Set<string>();
  const expand = (value: string, property: string): string =>
    value.replace(/\$\{([^}]+)\}/gu, (_match, reference: string) => {
      if (reference === "workspaceFolder") return workspaceFolder;
      const variable = /^containerEnv:([A-Za-z_][A-Za-z0-9_]*)$/u.exec(reference)?.[1];
      if (!variable || !Object.hasOwn(container, variable))
        throw new Error(
          `devcontainer property ${property} has unsupported reference \${${reference}}`,
        );
      return resolveContainer(variable);
    });
  const resolveContainer = (name: string): string => {
    const existing = resolved.get(name);
    if (existing !== undefined) return existing;
    if (visiting.has(name))
      throw new Error(`devcontainer property containerEnv.${name} has a cycle`);
    visiting.add(name);
    const value = expand(container[name] as string, `containerEnv.${name}`);
    visiting.delete(name);
    resolved.set(name, value);
    return value;
  };
  const result: Record<string, string> = Object.create(null);
  for (const name of Object.keys(container)) {
    assertEnvName(name, "containerEnv");
    result[name] = resolveContainer(name);
  }
  for (const [name, value] of Object.entries(devcontainer.remoteEnv ?? {})) {
    assertEnvName(name, "remoteEnv");
    result[name] = expand(value, `remoteEnv.${name}`);
  }
  return result;
}

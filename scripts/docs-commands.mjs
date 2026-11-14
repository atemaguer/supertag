// Validates `supertag` commands and flags written in documentation against the generated CLI
// reference (docs/reference/cli.md). rust/crates/cli/tests/cli_help.rs keeps that reference equal
// to the CLI's help, so a command that passes here is one the CLI accepts.

// Flags of other programs that documentation names in prose, such as `codex login` options.
const foreignFlags = new Set([
  "--ignore-user-config",
  "--listen",
  "--json",
  "--rm",
  "--hard",
  "--force-with-lease",
  "--show-toplevel",
  "--verify",
  "--quiet",
  "--prebuilt",
  "--remote-only",
  "--detach",
  "--build",
  "--no-cache",
  "--project",
  "--profile",
  "--sandbox",
]);

/** Parses the CLI reference into commands, their flags, subcommand aliases, and argument values. */
export function parseReference(text) {
  const commands = new Map(); // "host enroll" -> Set of flags its help lists; "" is bare supertag
  const aliases = new Map(); // "get tags" -> "get tag"
  const firstArgument = new Map(); // "watch" -> Set of values its first argument accepts
  const urlArgument = new Set(); // commands whose first argument is a URL
  const allFlags = new Set();
  for (const section of text.split(/^## /mu).slice(1)) {
    const heading = section.match(/^`supertag(?: ([^`]+))?`/u);
    if (!heading) continue;
    const path = heading[1] ?? "";
    const flags = new Set([...section.matchAll(/--[a-z][a-z0-9-]*/gu)].map(([flag]) => flag));
    commands.set(path, flags);
    for (const flag of flags) allFlags.add(flag);
    for (const [, name, alias] of section.matchAll(
      /^ {2}([a-z][a-z0-9-]*) .*\[alias: ([a-z0-9-]+)\]$/gmu,
    ))
      aliases.set(`${path} ${alias}`.trim(), `${path} ${name}`.trim());
    const argument = section.match(/^Arguments:\n {2}\S+[^\n]*\[possible values: ([^\]]+)\]$/mu);
    if (argument) firstArgument.set(path, new Set(argument[1].split(/,\s*/u)));
    if (/^Arguments:\n {2}[<[]URL[>\]]/mu.test(section)) urlArgument.add(path);
  }
  return { commands, aliases, firstArgument, urlArgument, allFlags };
}

const globalFlags = new Set(["--control-plane", "--help", "--version"]);
// A placeholder such as KIND, ID, or a|b stands for a value the reader chooses.
const variable = (token) =>
  /^[A-Z][A-Z0-9_]*$/u.test(token) || token.includes("|") || /^[<[]/u.test(token);
const flagOf = (word) =>
  word
    .replace(/^[[(]+/u, "")
    .replace(/[\])]+$/u, "")
    .split("=")[0];

/** Returns why `command` (starting with "supertag") is not a command of the reference, or null. */
export function checkCommand(reference, command) {
  const { commands, aliases, firstArgument, urlArgument } = reference;
  const words = command
    .replace(/\s+#.*$/u, "")
    .replace(/"[^"]*"|'[^']*'/gu, "VALUE")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(1);
  // The global Control Plane selector may come before the command.
  while (words[0]?.startsWith("--")) {
    if (words[0] === "--control-plane") words.splice(0, 2);
    else if (globalFlags.has(words[0])) return null;
    else return `unknown global flag ${words[0]}`;
  }
  const path = [];
  for (const word of words) {
    if (/^[[(]?-/u.test(word)) break;
    path.push(word);
  }
  // Prose may name a command by placeholder ("`supertag KIND`") or elide it.
  if (path[0] === "..." || (path[0] && variable(path[0]))) return null;
  let key;
  let length = path.length;
  for (; length >= 0 && key === undefined; length--) {
    const candidate = path.slice(0, length).join(" ");
    const resolved = aliases.get(candidate) ?? candidate;
    if (commands.has(resolved) && (length > 0 || path.length === 0)) key = resolved;
  }
  length++;
  if (key === undefined) return `\`supertag ${path.slice(0, 2).join(" ")}\` is not a command`;
  const next = path[length];
  if (next !== undefined && next !== "..." && !variable(next)) {
    const prefix = key ? `${key} ` : "";
    const hasSubcommands = [...commands.keys()].some((name) => name.startsWith(prefix) && name);
    if (key === "" || hasSubcommands)
      return `\`supertag ${[key, next].filter(Boolean).join(" ")}\` is not a command`;
    const values = firstArgument.get(key);
    if (values && !values.has(next))
      return `\`${next}\` is not a value of the first argument of \`supertag ${key}\``;
    if (urlArgument.has(key) && !/^(https?|wss?):\/\/|^\$/u.test(next))
      return `\`supertag ${key}\` takes a URL, not \`${next}\``;
  }
  const unknown = words
    .filter((word) => /^[[(]?--[a-z]/u.test(word))
    .map(flagOf)
    .filter((flag) => !globalFlags.has(flag) && !commands.get(key).has(flag));
  return unknown.length
    ? `flag ${[...new Set(unknown)].join(", ")} not listed for \`supertag ${key}\``
    : null;
}

/** Returns why an inline flag written in prose is no flag of the CLI, or null. */
export function checkProseFlag(reference, span) {
  const flag = flagOf(span.trim().split(/\s+/u)[0]);
  if (!/^--[a-z]/u.test(flag) || reference.allFlags.has(flag) || foreignFlags.has(flag))
    return null;
  return `flag ${flag} is not a flag of any supertag command`;
}

/** Finds commands in fenced shell blocks and inline code, and flags in inline code. */
export function commandsIn(text) {
  const found = [];
  const flags = [];
  let fence = null;
  const lines = text.split("\n");
  let paragraph = [];
  const flush = () => {
    // Inline code may wrap across the lines of one paragraph, but not across a blank line.
    const joined = paragraph.map(({ content }) => content).join("\n");
    for (const span of joined.matchAll(/`([^`]+)`/gu)) {
      const line = paragraph[0].line + joined.slice(0, span.index).split("\n").length - 1;
      const code = span[1].replace(/\s+/gu, " ").trim();
      if (/^supertag(\s|$)/u.test(code)) found.push({ line, command: code });
      else if (/^[[(]?--[a-z]/u.test(code)) flags.push({ line, flag: code });
    }
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^\s*(```+|~~~+)\s*([\w-]*)/u);
    if (marker) {
      flush();
      fence = fence ? null : marker[2] || "text";
      continue;
    }
    if (fence && /^(sh|bash|shell|zsh|console|text)$/u.test(fence)) {
      let command = line.replace(/^\s*\$\s+/u, "");
      let end = index;
      while (command.trimEnd().endsWith("\\") && end + 1 < lines.length)
        command = `${command.trimEnd().slice(0, -1)} ${lines[++end].trim()}`;
      // Allow leading environment assignments: FOO=bar supertag ...
      const match = command.match(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*supertag(\s.*)?$/u);
      if (match) found.push({ line: index + 1, command: `supertag${match[1] ?? ""}` });
      index = end;
    } else if (!fence) {
      if (line.trim() === "") flush();
      else paragraph.push({ line: index + 1, content: line });
    }
  }
  flush();
  return { commands: found, flags };
}

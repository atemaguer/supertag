import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const internal = /(architecture|product-brief)[^/]*\.md$/u;
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/gu, "-");
}
const anchorCache = new Map();
function anchors(path) {
  if (!anchorCache.has(path)) {
    const seen = new Map();
    const set = new Set();
    let fenced = false;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
      const heading = !fenced && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/u);
      if (!heading) continue;
      const base = slug(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      set.add(count ? `${base}-${count}` : base);
    }
    for (const [, id] of readFileSync(path, "utf8").matchAll(/<a\s+(?:id|name)="([^"]+)"/gu))
      set.add(id);
    anchorCache.set(path, set);
  }
  return anchorCache.get(path);
}
function linkTargets(text) {
  const targets = [];
  const stripped = text.replace(/(```|~~~)[\s\S]*?\1/gu, (block) => block.replace(/[^\n]/gu, " "));
  const lines = stripped.split("\n");
  lines.forEach((line, index) => {
    const prose = line.replace(/`[^`]*`/gu, "");
    const inline = [...prose.matchAll(/\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/gu)];
    const definition = prose.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/u);
    if (definition) inline.push(definition);
    for (const [, raw] of inline) {
      targets.push({ target: raw.replace(/^<|>$/gu, ""), line: index + 1 });
    }
  });
  return targets;
}

export function checkLinks(root, file, text) {
  const problems = [];
  for (const { target, line } of linkTargets(text)) {
    // Published READMEs link this repository's files by absolute URL; check those files too.
    const own = target.match(
      /^https:\/\/github\.com\/atemaguer\/supertag\/(?:blob|tree)\/main\/(.*)$/u,
    );
    if (!own && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue;
    const [path, anchor] = (own ? own[1] : target).split("#");
    const destination = !path
      ? file
      : own
        ? resolve(root, decodeURIComponent(path))
        : resolve(dirname(file), decodeURIComponent(path));
    const at = `${relative(root, file)}:${line}`;
    if (internal.test(destination)) {
      problems.push(`${at}: links internal design record ${path}`);
      continue;
    }
    // The published SDK README points into documentation copied by the bundle build.
    // On a fresh checkout those files are absent; once present, check them normally.
    const generatedSdkDoc =
      relative(root, file) === "packages/supertag-ai/README.md" && path.startsWith("dist/docs/");
    if (generatedSdkDoc && !existsSync(destination)) continue;
    if (!existsSync(destination)) {
      problems.push(`${at}: broken link ${target}`);
      continue;
    }
    if (anchor && destination.endsWith(".md") && statSync(destination).isFile())
      if (!anchors(destination).has(anchor.toLowerCase()))
        problems.push(`${at}: missing anchor #${anchor} in ${relative(root, destination)}`);
  }
  return problems;
}

export function checkOrphans(root, files) {
  const index = resolve(root, "docs/README.md");
  const text = readFileSync(index, "utf8");
  const linked = new Set(
    linkTargets(text).map(({ target }) =>
      resolve(dirname(index), decodeURIComponent(target.split("#")[0])),
    ),
  );
  return files
    .filter((file) => file !== index && !linked.has(file))
    .map((file) => `${relative(root, file)}: not linked from docs/README.md`);
}

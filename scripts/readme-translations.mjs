// Translated READMEs live in docs/readme/README.<language>.md. Prose is translated; commands,
// link destinations, images, headings' structure, and tables' shape must match README.md, so a
// change to the English README fails this check until every translation follows it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const translationDirectory = "docs/readme";

/** The languages the README is offered in, in the order the language row lists them. */
export const languages = [
  { code: "zh-CN", name: "中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "pt", name: "Português" },
  { code: "tr", name: "Türkçe" },
  { code: "ru", name: "Русский" },
];

export const translationPath = (code) => `${translationDirectory}/README.${code}.md`;

const isReadme = (path) => path === "README.md" || path.startsWith(`${translationDirectory}/`);

/** What a translation must share with the English README, with paths made root-relative. */
export function structure(root, name, text) {
  const directory = dirname(join(root, name));
  const blocks = [...text.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1\s*$/gmu)].map(
    (match) => match[2],
  );
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gmu, "");
  const targets = [];
  const destinations = [
    ...prose.matchAll(/\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/gu),
    ...prose.matchAll(/\b(?:src|href)="([^"]+)"/gu),
  ];
  for (const [, raw] of destinations) {
    const target = raw.replace(/^<|>$/gu, "");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target) || target.startsWith("#")) {
      targets.push(target);
      continue;
    }
    const [path, anchor] = target.split("#");
    const resolved = relative(root, resolve(directory, decodeURIComponent(path)));
    // The language row differs between the files by design.
    if (isReadme(resolved)) continue;
    targets.push(anchor ? `${resolved}#${anchor}` : resolved);
  }
  const lines = prose.split("\n");
  return {
    blocks,
    targets: targets.sort(),
    headings: lines.flatMap((line) => line.match(/^(#{1,6})\s/u)?.[1].length ?? []),
    tableRows: lines.filter((line) => line.startsWith("|")).length,
    names: [...prose.matchAll(/<a\s+name="([^"]+)"/gu)].map((match) => match[1]).sort(),
    code: [...prose.matchAll(/`[^`\n]+`/gu)].map((match) => match[0]).sort(),
  };
}

function difference(label, expected, actual) {
  const remaining = [...actual];
  const missing = [];
  for (const item of expected) {
    const at = remaining.indexOf(item);
    if (at < 0) missing.push(item);
    else remaining.splice(at, 1);
  }
  const show = (items) => items.map((item) => JSON.stringify(item)).join(", ");
  return [
    ...(missing.length ? [`${label} missing: ${show(missing)}`] : []),
    ...(remaining.length ? [`${label} not in README.md: ${show(remaining)}`] : []),
  ];
}

/** The English headings a navigation link may point at, by the anchor a translation must name. */
export function englishAnchors(text) {
  return [...text.matchAll(/\]\(#([^)]+)\)/gu)].map((match) => match[1]);
}

export function translationProblems(root) {
  const problems = [];
  const english = readFileSync(join(root, "README.md"), "utf8");
  const expected = structure(root, "README.md", english);
  const directory = join(root, translationDirectory);
  const present = existsSync(directory) ? readdirSync(directory) : [];
  for (const file of present)
    if (!languages.some(({ code }) => `README.${code}.md` === file))
      problems.push(`${translationDirectory}/${file}: not a listed language`);
  for (const { code, name: label } of languages) {
    const name = translationPath(code);
    if (!english.includes(`[${label}](${name})`))
      problems.push(`README.md: link ${label} as [${label}](${name})`);
    if (!existsSync(join(root, name))) {
      problems.push(`${name}: missing`);
      continue;
    }
    const text = readFileSync(join(root, name), "utf8");
    if (!text.includes("[English](../../README.md)"))
      problems.push(`${name}: link [English](../../README.md)`);
    for (const other of languages)
      if (other.code !== code && !text.includes(`[${other.name}](README.${other.code}.md)`))
        problems.push(`${name}: link [${other.name}](README.${other.code}.md)`);
    const actual = structure(root, name, text);
    const report = (found) => problems.push(...found.map((problem) => `${name}: ${problem}`));
    if (JSON.stringify(actual.blocks) !== JSON.stringify(expected.blocks))
      report(["command blocks differ from README.md; keep them byte for byte"]);
    report(difference("link or image", expected.targets, actual.targets));
    report(difference("inline code", expected.code, actual.code));
    // A translated heading has another anchor, so each linked heading carries its English one.
    report(
      difference(
        "<a name> anchor",
        [...new Set([...expected.names, ...englishAnchors(english)])].sort(),
        actual.names,
      ),
    );
    if (JSON.stringify(actual.headings) !== JSON.stringify(expected.headings))
      report([`headings differ: expected levels ${expected.headings.join(" ")}`]);
    if (actual.tableRows !== expected.tableRows)
      report([`has ${actual.tableRows} table rows; README.md has ${expected.tableRows}`]);
  }
  return problems;
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  languages,
  structure,
  translationPath,
  translationProblems,
} from "./readme-translations.mjs";

const row = (own) =>
  [{ code: "en", name: "English" }, ...languages]
    .map(({ code, name }) =>
      code === own
        ? name
        : code === "en"
          ? "[English](../../README.md)"
          : `[${name}](README.${code}.md)`,
    )
    .join(" · ");
const englishRow = `English · ${languages.map(({ code, name }) => `[${name}](${translationPath(code)})`).join(" · ")}`;
const english = `${englishRow}

[Start](#start) · [Guide](docs/guide.md)

## Start

Run \`supertag init\` first.

\`\`\`sh
supertag init
\`\`\`

| A | B |
| --- | --- |
| one | two |

![A picture](assets/picture.png)
`;
const translated = (code, body = {}) => `${row(code)}

[Inicio](#start) · [Guía](${body.guide ?? "../../docs/guide.md"})

<a name="start"></a>

## Inicio

Primero ejecuta ${body.inline ?? "`supertag init`"}.

\`\`\`sh
${body.command ?? "supertag init"}
\`\`\`

| A | B |
| --- | --- |
| uno | dos |
${body.extraRow ?? ""}
![Una imagen](../../assets/picture.png)
`;

function repository(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "readme-translations-"));
  const write = (name, text) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  };
  write("README.md", english);
  for (const { code } of languages) write(translationPath(code), translated(code, overrides[code]));
  return root;
}

test("matching translations pass", () => {
  assert.deepEqual(translationProblems(repository()), []);
});

test("paths are compared from the repository root", () => {
  const root = repository();
  assert.deepEqual(
    structure(root, translationPath("es"), translated("es")).targets,
    structure(root, "README.md", english).targets,
  );
});

test("a changed command, link, inline code, or table is reported", () => {
  const problems = translationProblems(
    repository({
      es: { command: "supertag up" },
      fr: { guide: "../../docs/other.md" },
      ja: { inline: "`supertag start`" },
      ko: { extraRow: "| tres | cuatro |" },
    }),
  );
  const of = (code) => problems.filter((problem) => problem.startsWith(translationPath(code)));
  assert.match(of("es").join("\n"), /command blocks differ/u);
  assert.match(of("fr").join("\n"), /link or image missing: "docs\/guide\.md"/u);
  assert.match(of("ja").join("\n"), /inline code missing: "`supertag init`"/u);
  assert.match(of("ko").join("\n"), /has 4 table rows; README\.md has 3/u);
  assert.equal(
    problems.length,
    of("es").length + of("fr").length + of("ja").length + of("ko").length,
  );
});

test("a missing translation and a missing English anchor are reported", () => {
  const root = repository();
  writeFileSync(
    join(root, translationPath("ru")),
    translated("ru").replace('<a name="start"></a>\n', ""),
  );
  writeFileSync(join(root, translationPath("tr")), "");
  const problems = translationProblems(root).join("\n");
  assert.match(problems, /README\.ru\.md: <a name> anchor missing: "start"/u);
  assert.match(problems, /README\.tr\.md: link \[English\]/u);
});

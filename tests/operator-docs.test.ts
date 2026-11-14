import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
function destinations(source: string): string[] {
  return [...readFileSync(resolve(root, source), "utf8").matchAll(/\]\(([^)\s]+)\)/gu)].map(
    ([, target]) => resolve(root, dirname(source), (target ?? "").split("#")[0] ?? ""),
  );
}

describe("operator documentation discovery", () => {
  const guide = "docs/guides/coding-agent-operator.md";
  const skill = "skills/operate-supertag/SKILL.md";
  const operatorPages = [guide, skill];
  it("makes the guide reachable from the docs index and the skill from the guide", () => {
    expect(destinations("docs/README.md")).toContain(resolve(root, guide));
    expect(destinations(guide)).toContain(resolve(root, skill));
  });
  it.each(["skills/SKILLS.md", "CLAUDE.md"])("lists the skill in %s", (catalog) => {
    expect(destinations(catalog)).toContain(resolve(root, skill));
    const text = readFileSync(resolve(root, skill), "utf8");
    expect(text).toMatch(/^---\nname: operate-supertag\ndescription: .+\n---/u);
  });
  it.each(operatorPages)("guards pending-question replies in %s", (page) => {
    const content = readFileSync(resolve(root, page), "utf8");
    // The operator reads and quotes the pending question and answers the exact Task that asked,
    // keeping the answer text in a private file.
    expect(content).toMatch(/quote\s+the\s+question/iu);
    expect(content).toMatch(/pending questions\s+\*{0,2}before\s+(?:sending|messaging)/iu);
    expect(content).toContain("supertag question answer TASK_ID");
    expect(content).toMatch(/text read from the\s+private file/u);
    expect(content).not.toMatch(/supertag message (?:tag|objective)/u);
  });
  it.each(operatorPages)("guards administrator credentials in %s", (page) => {
    const content = readFileSync(resolve(root, page), "utf8");
    expect(content).toMatch(/administrator CLI credential/iu);
    expect(content).toMatch(/never read or print `~\/.supertag`/iu);
    expect(content).toMatch(/secrets in Objective or message text/iu);
  });
  it.each(operatorPages)("keeps message and outcome text out of shell heredocs in %s", (page) => {
    const content = readFileSync(resolve(root, page), "utf8");
    expect(content).not.toMatch(/<<-?\s*['"]?(?:MESSAGE|OUTCOME)['"]?/u);
    expect(content).toContain("mktemp");
  });
});

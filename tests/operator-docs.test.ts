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
    expect(content).toMatch(/quote\s+the\s+question/iu);
    expect(content).toMatch(/message objective[^\n]*--reply-to MESSAGE_ID[^\n]*--output json/iu);
    expect(content).toMatch(/unmarked\s+message\s+leaves\s+questions\s+pending/iu);
    expect(content).toContain("repliedToMessageId");
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

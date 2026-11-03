import { describe, expect, it } from "vitest";
import { renderGitHubPresentation } from "../packages/surfaces/github/src/index.ts";
import { renderLarkPresentation } from "../packages/surfaces/lark/src/index.ts";
import { renderLinearPresentation } from "../packages/surfaces/linear/src/index.ts";
import { parseSurfaceMarkdown } from "../packages/surfaces/sdk/src/index.ts";
import {
  renderSlackMarkdown,
  renderSlackPresentation,
} from "../packages/surfaces/slack/src/index.ts";
import { renderTeamsPresentation } from "../packages/surfaces/teams/src/index.ts";

describe("surface presentation rendering", () => {
  it("parses canonical Markdown and GFM into a shared surface-neutral AST", () => {
    const document = parseSurfaceMarkdown("~~done~~\n\n| Check |\n| --- |\n| tests |");

    expect(document.children.map((node) => node.type)).toEqual(["paragraph", "table"]);
    expect(document.children[0]).toMatchObject({
      children: [{ type: "delete", children: [{ type: "text", value: "done" }] }],
    });
  });

  it("converts canonical Markdown to Slack mrkdwn and suppresses raw mention syntax", () => {
    const markdown = [
      "# Result",
      "",
      "**bold** and *italic* and ~~old~~.",
      "[docs](https://example.com?a=1&b=2)",
      "`[code](https://example.com) <T>` & <@U123>",
    ].join("\n");

    const rendered = renderSlackPresentation({ kind: "final-result", markdown });

    expect(rendered).toEqual({
      text: [
        "*Result*",
        "",
        "*bold* and _italic_ and ~old~.",
        "<https://example.com?a=1&b=2|docs>",
        "`[code](https://example.com) &lt;T&gt;` &amp; &lt;@U123&gt;",
      ].join("\n"),
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("does not reinterpret Markdown links inside Slack code blocks", () => {
    expect(renderSlackMarkdown("```md\n[docs](https://example.com)\n```")).toBe(
      "```\n[docs](https://example.com)\n```",
    );
  });

  it("renders GFM tables as aligned Slack code blocks", () => {
    expect(
      renderSlackMarkdown(
        "| Component | Expected rendering |\n| --- | --- |\n| Markdown AST | Parsed once |\n| Slack | Native mrkdwn |",
      ),
    ).toBe(
      [
        "```",
        "Component     Expected rendering",
        "------------  ------------------",
        "Markdown AST  Parsed once",
        "Slack         Native mrkdwn",
        "```",
      ].join("\n"),
    );
  });

  it("bounds long Slack output without splitting Unicode", () => {
    const rendered = renderSlackMarkdown(`**Result**\n${"🟣".repeat(40_000)}`);

    expect(Array.from(rendered)).toHaveLength(39_000);
    expect(rendered).toMatch(/^\*Result\*/u);
    expect(rendered).toMatch(/…$/u);
  });

  it("preserves normalized Markdown for GitHub and Linear", () => {
    const presentation = {
      kind: "final-result" as const,
      markdown: "\r\n## Result\r\n\r\n| Check | State |\r\n| --- | --- |\r\n| tests | pass |\r\n",
    };
    const expected = "## Result\n\n| Check | State |\n| ----- | ----- |\n| tests | pass  |";

    expect(renderGitHubPresentation(presentation)).toBe(expected);
    expect(renderLinearPresentation(presentation)).toBe(expected);
  });

  it("marks Teams activities as Markdown and adapts unsupported headings", () => {
    expect(
      renderTeamsPresentation({
        kind: "final-result",
        markdown: "# Result\n\n**Tests:** passed\n\n```md\n# code heading\n```",
      }),
    ).toEqual({
      type: "message",
      text: "**Result**\n\n**Tests:** passed\n\n```md\n# code heading\n```",
      textFormat: "markdown",
    });
  });

  it("renders Lark Markdown in a presentation-aware interactive card", () => {
    const card = renderLarkPresentation({
      kind: "error",
      markdown: "# Failed\n\nSee [logs](https://example.com). <at id=all>everyone</at>",
    });

    expect(card.header).toEqual({
      template: "red",
      title: { tag: "plain_text", content: "SuperTag could not complete the task" },
    });
    expect(card.elements).toEqual([
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**Failed**\n\nSee [logs](https://example.com). ‹at id=all›everyone‹/at›",
        },
      },
    ]);
  });
});

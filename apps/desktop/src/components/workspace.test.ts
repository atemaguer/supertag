import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { Tag } from "../control-plane";
import { WorkspaceShell } from "./workspace";

const tags: Tag[] = [
  { tagId: "finch", instructions: "", allowedActions: [], revision: 1, harnessKind: "codex" },
  {
    tagId: "moss",
    name: "Moss",
    instructions: "",
    allowedActions: [],
    revision: 1,
    harnessKind: "claude_code",
  },
];

it("puts each Tag in the rail and the Tag and conversation in the floating pill", () => {
  const html = renderToStaticMarkup(
    createElement(
      WorkspaceShell,
      {
        tags,
        tag: tags[1],
        conversation: "release-checks",
        names: ["release-checks", "default"],
        connected: true,
        selector: null,
      },
      null,
    ),
  );
  expect(html).toMatch(/<nav class="rail" aria-label="Tags">/);
  expect(html).toMatch(/aria-label="finch" title="finch" aria-current="false"/);
  expect(html).toMatch(/aria-label="Moss" title="Moss" aria-current="true"/);
  expect(html).toContain('aria-label="Moss, Release checks. Switch conversation"');
  expect(html).toContain('aria-label="New conversation"');
  expect(html).toContain("Claude Code");
  // The rail's top and the conversation's top strip drag the window.
  expect(html).toMatch(/class="rail-top" data-tauri-drag-region/);
  expect(html).toMatch(/class="topstrip" data-tauri-drag-region/);
  expect(html).not.toContain('<header class="topbar"');
});

it("shows an empty rail and no conversation controls before a Control Plane connects", () => {
  const html = renderToStaticMarkup(
    createElement(
      WorkspaceShell,
      {
        tags: [],
        connected: false,
        selector: null,
      },
      null,
    ),
  );
  expect(html).toContain("Connect to see your Tags");
  expect(html).not.toContain("identity-pill");
  expect(html).not.toContain('aria-label="New conversation"');
});

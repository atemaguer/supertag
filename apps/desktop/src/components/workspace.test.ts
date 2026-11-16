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

it("puts each Tag in the rail and the selected Tag, with no conversation controls, in the pill", () => {
  const html = renderToStaticMarkup(
    createElement(
      WorkspaceShell,
      {
        tags,
        tag: tags[1],
        connected: true,
        selector: () => null,
      },
      null,
    ),
  );
  expect(html).toMatch(/<nav id="sidebar" class="rail" aria-label="Tags">/);
  expect(html).toMatch(/aria-label="finch" title="finch" aria-current="false"/);
  expect(html).toMatch(/aria-label="Moss" title="Moss" aria-current="true"/);
  expect(html).toMatch(/<div class="identity-pill">.*<span class="tag-name">Moss<\/span><\/div>/);
  expect(html).not.toContain("conversation-menu");
  expect(html).not.toContain("New conversation");
  expect(html).not.toContain("Release checks");
  expect(html).toContain("Claude Code");
  // The rail's top and the conversation's top strip drag the window.
  expect(html).toMatch(/class="rail-top" data-tauri-drag-region/);
  expect(html).toMatch(/class="topstrip" data-tauri-drag-region/);
  expect(html).not.toContain('<header class="topbar"');
});

it("shows an empty rail and no Tag pill before a Control Plane connects", () => {
  const html = renderToStaticMarkup(
    createElement(
      WorkspaceShell,
      {
        tags: [],
        connected: false,
        selector: () => null,
      },
      null,
    ),
  );
  expect(html).toContain("Connect to see your Tags");
  expect(html).not.toContain("identity-pill");
});

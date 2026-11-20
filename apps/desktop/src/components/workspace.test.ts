import type { Tag } from "@supertag/client/model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
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

it("lists each Tag in the sidebar and puts just the selected Tag in the pill", () => {
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
  expect(html).toMatch(/<nav id="sidebar" class="sidebar" data-mode="expanded" aria-label="Tags">/);
  expect(html).toMatch(/aria-label="finch" aria-current="false"/);
  expect(html).toMatch(/aria-label="Moss" aria-current="true"/);
  expect(html).toMatch(/<div class="identity-pill">.*<span class="tag-name">Moss<\/span><\/div>/);
  expect(html).not.toContain("conversation-menu");
  expect(html).not.toContain("New conversation");
  expect(html).not.toContain("Release checks");
  expect(html).toContain("Claude Code");
  // The sidebar's top and the conversation's top strip drag the window.
  expect(html).toMatch(/class="sidebar-top drag-region"/);
  expect(html).toMatch(/class="topstrip drag-region"/);
  expect(html).not.toContain('<header class="topbar"');
});

it("shows an empty sidebar and no Tag pill before a Gateway connects", () => {
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

it("offers New Tag in the sidebar only to a connection that may create Tags", () => {
  const render = (props: Partial<Parameters<typeof WorkspaceShell>[0]>) =>
    renderToStaticMarkup(
      createElement(
        WorkspaceShell,
        { tags, tag: tags[0], connected: true, selector: () => null, ...props },
        null,
      ),
    );
  expect(render({ onNewTag: () => {} })).toMatch(
    /aria-label="New Tag" aria-disabled="false" title="New Tag"/,
  );
  const refused = render({ newTagRefusal: "Only an operator can create Tags." });
  expect(refused).toMatch(
    /aria-label="New Tag" aria-description="Only an operator can create Tags." aria-disabled="true"/,
  );
  expect(render({})).not.toContain("New Tag");
});

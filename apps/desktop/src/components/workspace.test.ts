// @vitest-environment happy-dom

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

/** The shell's markup as a document to query, as a first paint without effects. */
function page(props: Partial<Parameters<typeof WorkspaceShell>[0]>) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(WorkspaceShell, { tags, connected: true, selector: () => null, ...props }, null),
  );
  return host;
}

it("lists each Tag in the sidebar and puts just the selected Tag in the pill", () => {
  const shell = page({ tag: tags[1] });
  expect(shell.querySelector("nav")?.getAttribute("aria-label")).toBe("Tags");
  const rows = [...shell.querySelectorAll("nav button[aria-current]")];
  expect(
    rows.map((row) => [row.getAttribute("aria-label"), row.getAttribute("aria-current")]),
  ).toEqual([
    ["finch", "false"],
    ["Moss", "true"],
  ]);
  // The pill names the open Tag and its harness, and nothing of the other Tags.
  const pill = shell.querySelector("header .identity-pill");
  expect(pill?.querySelector(".tag-name")?.textContent).toBe("Moss");
  expect(pill?.textContent).toContain("Claude Code");
  expect(pill?.textContent).not.toContain("Codex");
  expect(pill?.querySelector(".avatar")?.textContent).toBe("MO");
  expect(shell.textContent).not.toContain("New conversation");
  // The sidebar's top and the conversation's header band drag the window.
  expect(shell.querySelectorAll(".drag-region")).toHaveLength(2);
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
  const newTag = (props: Partial<Parameters<typeof WorkspaceShell>[0]>) =>
    page({ tag: tags[0], ...props }).querySelector('nav button[aria-label="New Tag"]');
  expect(newTag({ onNewTag: () => {} })?.getAttribute("aria-disabled")).toBe("false");
  const refused = newTag({ newTagRefusal: "Only an operator can create Tags." });
  expect(refused?.getAttribute("aria-disabled")).toBe("true");
  expect(refused?.getAttribute("aria-description")).toBe("Only an operator can create Tags.");
  expect(newTag({})).toBeNull();
});

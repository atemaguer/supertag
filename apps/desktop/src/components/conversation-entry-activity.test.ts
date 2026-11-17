// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Message } from "../gateway";
import { ConversationEntry } from "./conversation-entry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("opens the Task activity from the typing bubble while the turn runs", () => {
  const message: Message = {
    order: 1,
    task: { taskId: "t1", tagId: "engineer", sessionId: "s", prompt: "Go", state: "running" },
  };
  const onActivity = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(ConversationEntry, {
        message,
        onActivity,
        onSaveArtifact: async () => false,
      }),
    ),
  );
  const dots = host.querySelector(".typing-button") as HTMLButtonElement;
  act(() => dots.click());
  expect(onActivity).toHaveBeenCalledWith("t1", dots);
  act(() => root.unmount());
  host.remove();
});

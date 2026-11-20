/**
 * The local services panel, as the desktop app's startup shows them: `supertag up` starting the
 * services this machine set up ("Starting SuperTag…"), what it printed when it could not, how to
 * set SuperTag up when it is not, and the offer to restart a local Gateway of an older release
 * with this one, which asks first because running Tasks are interrupted. It shows over the cached
 * conversations, or in place of them.
 */
import { useState } from "react";
import type { Controller } from "./controller";
import { safe } from "./text";
import { color, type KeyEvent, useKeyboard } from "./ui";

export function LocalPanel({
  controller,
  width,
  onChoose,
}: {
  controller: Controller;
  width: number;
  /** Ctrl-P: the Gateway chooser. */
  onChoose(): void;
}) {
  const status = controller.status;
  const [confirming, setConfirming] = useState(false);
  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "p") {
      setConfirming(false);
      onChoose();
      return;
    }
    const enter = key.name === "return" || key.name === "enter";
    if (status.kind === "upgrade") {
      if (!confirming && enter) setConfirming(true);
      else if (confirming && enter) {
        setConfirming(false);
        void controller.restartLocal();
      } else if (confirming && key.name === "escape") setConfirming(false);
    } else if (status.kind === "startFailed" && key.name === "r" && !key.ctrl) {
      void controller.retryLocal();
    }
  });
  let title = "SuperTag";
  let lines: { text: string; fg: string }[] = [];
  let keys = "Ctrl-P Gateways";
  switch (status.kind) {
    case "starting":
      title = "Starting SuperTag";
      lines = [
        { text: "Starting SuperTag…", fg: color.text },
        {
          text: "This machine's services were stopped; supertag up is starting them.",
          fg: color.muted,
        },
      ];
      break;
    case "restarting":
      title = "Restarting SuperTag";
      lines = [
        {
          text: status.step === "stopping" ? "Stopping SuperTag…" : "Starting SuperTag…",
          fg: color.text,
        },
      ];
      break;
    case "startFailed":
      title = "SuperTag did not start";
      lines = status.problem
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line, index) => ({ text: safe(line), fg: index === 0 ? color.error : color.muted }));
      keys = "r try again · Ctrl-P Gateways";
      break;
    case "notSetUp":
      title = "Set SuperTag up";
      lines = [
        { text: "SuperTag is not set up on this machine.", fg: color.text },
        { text: "In a repository, run:  supertag init", fg: color.accent },
        {
          text: `It sets SuperTag up in ${safe(status.stateDirectory)} and starts it; this connects once it runs.`,
          fg: color.muted,
        },
      ];
      keys = "Ctrl-P Gateways · Ctrl-C quit";
      break;
    case "upgrade":
      title = "Restart SuperTag";
      lines = confirming
        ? [
            {
              text: `Restart SuperTag with ${safe(status.version)}? Its running Tasks are interrupted.`,
              fg: color.warning,
            },
            {
              text: "supertag down stops it, then supertag up starts it with this release.",
              fg: color.muted,
            },
          ]
        : [
            {
              text: `The local SuperTag runs ${safe(status.running)}, an older release than this terminal UI.`,
              fg: color.text,
            },
            { text: `Enter  Restart SuperTag with ${safe(status.version)}`, fg: color.accent },
          ];
      keys = confirming ? "Enter restart · Esc cancel" : "Enter restart · Ctrl-P Gateways";
      break;
    default:
      return null;
  }
  return (
    <box
      width={width}
      flexDirection="column"
      border
      borderColor={status.kind === "startFailed" ? color.error : color.focus}
      backgroundColor="#151515"
      title={title}
      marginTop={2}
    >
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for one state.
        <text key={index} fg={line.fg}>
          {line.text}
        </text>
      ))}
      <text fg={color.faint}>{keys}</text>
    </box>
  );
}

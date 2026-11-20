/**
 * An inbox item, opened in place: type the answer to a question and press Enter, and the owner
 * reads it in the same Session; on an approval request, `a` then Enter approves it once, `d`
 * denies it with a reason. Esc cancels either. Other items say what holds them and the command
 * that shows them in full.
 */
import { type ApprovalDetails, describe, type InboxItem, inboxMark } from "@supertag/client/model";
import { useEffect, useState } from "react";
import type { TuiGateway } from "./connection";
import { safe } from "./text";
import { color, type KeyEvent, useKeyboard } from "./ui";

export function InboxView({
  gateway,
  item,
  focused,
  tagName,
  onDone,
}: {
  gateway: TuiGateway;
  item: InboxItem;
  focused: boolean;
  tagName(tagId: string): string;
  /** The item was answered or decided: read the inbox again. */
  onDone(): void;
}) {
  const [answer, setAnswer] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<"view" | "approve" | "deny">("view");
  const [details, setDetails] = useState<ApprovalDetails | undefined>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState("");
  const approvalId = item.approval?.approvalId;
  useEffect(() => {
    if (!approvalId) return;
    let stopped = false;
    void gateway.approval(approvalId).then(
      (read) => !stopped && setDetails(read),
      (error) => !stopped && setProblem(describe(error)),
    );
    return () => {
      stopped = true;
    };
  }, [gateway, approvalId]);

  async function act(work: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      setDone(await work());
      setMode("view");
      onDone();
    } catch (error) {
      setProblem(describe(error));
    } finally {
      setBusy(false);
    }
  }

  const answerQuestion = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    void act(async () => {
      await gateway.answerQuestion(item.taskId, trimmed);
      setAnswer("");
      return "Answered. The owner reads it in the same Session.";
    });
  };
  const decide = (approve: boolean, why: string) => {
    if (!approvalId) return;
    if (!approve && !why.trim()) {
      setProblem("Say why it is denied.");
      return;
    }
    void act(async () => {
      setDetails(await gateway.decideApproval(approvalId, approve, why.trim()));
      return approve ? "Approved once." : "Denied.";
    });
  };

  useKeyboard((key: KeyEvent) => {
    if (!focused || key.ctrl || key.meta || busy) return;
    if (key.name === "escape" && mode !== "view") {
      setMode("view");
      return;
    }
    if (item.kind !== "approval" || done) return;
    if (mode === "approve" && (key.name === "return" || key.name === "enter")) decide(true, "");
    else if (mode === "view" && key.name === "a") setMode("approve");
    else if (mode === "view" && key.name === "d") setMode("deny");
  });

  const asked = item.question;
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      minWidth={0}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={color.strong}>
        {inboxMark(item)}{" "}
        {item.kind === "question"
          ? "A question"
          : item.kind === "approval"
            ? "An approval request"
            : "Waiting on you"}
        {item.objectiveId ? ` · Objective ${safe(item.objectiveId)}` : ""}
      </text>
      {asked ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={color.text}>{safe(asked.text)}</text>
          {asked.truncated ? <text fg={color.faint}>(shortened)</text> : null}
        </box>
      ) : null}
      {item.approval ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={color.text}>
            {safe(tagName(item.approval.tagId))} asks to {safe(item.approval.summary)}
          </text>
          {details ? (
            <>
              <text fg={color.muted}>
                {safe(details.action)}
                {details.resource ? ` on ${safe(details.resource)}` : ""} · {details.state}
              </text>
              {details.pending && details.arguments ? (
                <text fg={color.muted}>{safe(details.arguments)}</text>
              ) : null}
            </>
          ) : null}
        </box>
      ) : null}
      {!asked && !item.approval ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={color.text}>{safe(item.reason || item.kind)}</text>
          <text fg={color.muted}>
            See it in full with supertag get inbox-item {safe(item.key)}.
          </text>
        </box>
      ) : null}
      <box flexGrow={1} />
      {done ? <text fg={color.you}>{done}</text> : null}
      {problem ? <text fg={color.error}>{safe(problem)}</text> : null}
      {item.kind === "question" && !done ? (
        <box
          border
          borderColor={focused ? color.focus : color.border}
          height={3}
          flexShrink={0}
          title="Answer"
        >
          <input
            focused={focused}
            placeholder="Type the answer"
            value={answer}
            onInput={setAnswer}
            onSubmit={(value: string) => answerQuestion(String(value))}
          />
        </box>
      ) : null}
      {mode === "deny" ? (
        <box
          border
          borderColor={focused ? color.focus : color.border}
          height={3}
          flexShrink={0}
          title="Why is it denied?"
        >
          <input
            focused={focused}
            placeholder="The reason the Tag reads"
            value={reason}
            onInput={setReason}
            onSubmit={(value: string) => decide(false, String(value))}
          />
        </box>
      ) : null}
      <text fg={color.faint} flexShrink={0}>
        {busy
          ? "Waiting for the Gateway…"
          : item.kind === "question"
            ? done
              ? ""
              : "Enter sends the answer"
            : item.kind === "approval" && !done
              ? mode === "approve"
                ? "Enter approves it once · Esc cancels"
                : mode === "deny"
                  ? "Enter denies it · Esc cancels"
                  : "a approve once · d deny"
              : ""}
      </text>
    </box>
  );
}

import type { ApprovalDetails, Gateway, InboxItem } from "@supertag/client/model";
import { describe } from "@supertag/client/model";
import { Check, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";

/** An approval request of the open Tag that still waits, as the operator inbox lists it. */
export type PendingApproval = NonNullable<InboxItem["approval"]>;

/** What the composer's next message answers: shown as a chip the person can dismiss. */
export interface ReplyTarget {
  /** Which card asked, so its Reply button shows as pressed. */
  key: string;
  /** The question, or the approval's summary. */
  text: string;
}

/** How an approval request ended: decided in this window, or found decided when read again. */
export interface ApprovalOutcome {
  /** The request's state as the Gateway names it: `approved`, `denied`, `expired`, and so on. */
  state: string;
  /** Set when this window decided it; the Gateway does not say who decided otherwise. */
  byYou?: boolean;
  reason?: string;
}

export interface ApprovalCardState {
  approvalId: string;
  summary: string;
  outcome?: ApprovalOutcome;
}

/** The pending approval requests of the open Tag, out of everything waiting on an operator. */
export function tagApprovals(inbox: readonly InboxItem[], tagId: string): PendingApproval[] {
  return inbox.flatMap((item) =>
    item.kind === "approval" && item.approval?.tagId === tagId ? [item.approval] : [],
  );
}

/** A decided request in one line: `Approved once by you`, `Denied by you: not on main`. */
export function outcomeLine(outcome: ApprovalOutcome): string {
  const state = outcome.state.replaceAll("_", " ");
  const word = state === "approved" && outcome.byYou ? "Approved once" : capitalised(state);
  const who = outcome.byYou ? " by you" : "";
  return `${word}${who}${outcome.reason ? `: ${outcome.reason}` : ""}`;
}

const capitalised = (text: string) => text.slice(0, 1).toLocaleUpperCase() + text.slice(1);

/**
 * The approval cards a conversation shows: each request seen pending while it is open, in the
 * order it arrived, and how it ended. A request this window decides records its outcome at once;
 * one that leaves the inbox another way is read again to learn its state.
 */
export function useApprovalCards(
  gateway: Gateway,
  pending: readonly PendingApproval[],
  onDecided?: () => void,
) {
  const [cards, setCards] = useState<ApprovalCardState[]>([]);
  const asked = useRef(new Set<string>());
  const record = useCallback((approvalId: string, outcome: ApprovalOutcome) => {
    setCards((prior) =>
      prior.map((card) =>
        card.approvalId === approvalId && !card.outcome ? { ...card, outcome } : card,
      ),
    );
  }, []);
  useEffect(() => {
    setCards((prior) => {
      const known = new Set(prior.map((card) => card.approvalId));
      const added = pending
        .filter((approval) => !known.has(approval.approvalId))
        .map(({ approvalId, summary }) => ({ approvalId, summary }));
      return added.length ? [...prior, ...added] : prior;
    });
  }, [pending]);
  useEffect(() => {
    const waiting = new Set(pending.map((approval) => approval.approvalId));
    for (const card of cards) {
      if (card.outcome || waiting.has(card.approvalId) || asked.current.has(card.approvalId))
        continue;
      asked.current.add(card.approvalId);
      void gateway.approval?.(card.approvalId).then(
        (details) => {
          if (details.pending) asked.current.delete(card.approvalId);
          else record(card.approvalId, { state: details.state });
        },
        () => record(card.approvalId, { state: "no longer waiting" }),
      );
    }
  }, [gateway, pending, cards, record]);
  const decide = useCallback(
    async (approvalId: string, approve: boolean, reason: string) => {
      if (!gateway.decideApproval) throw "This connection cannot decide approval requests.";
      const details = await gateway.decideApproval(approvalId, approve, reason);
      record(approvalId, {
        state: details.pending ? (approve ? "approved" : "denied") : details.state,
        byYou: true,
        ...(reason ? { reason } : {}),
      });
      onDecided?.();
    },
    [gateway, record, onDecided],
  );
  return { cards, decide };
}

/**
 * A Tag's approval request in the conversation: what it asks to do, the exact arguments, and
 * Approve once, Deny, or Reply. Nothing is chosen by default, and Deny asks for a reason first.
 * Once decided it is one quiet line saying how.
 */
export function ApprovalCard({
  gateway,
  card,
  replying,
  decide,
  onReply,
}: {
  gateway: Gateway;
  card: ApprovalCardState;
  /** The composer is answering this card. */
  replying?: boolean;
  decide(approvalId: string, approve: boolean, reason: string): Promise<void>;
  onReply(target: ReplyTarget): void;
}) {
  const { approvalId, summary, outcome } = card;
  const id = useId();
  const [details, setDetails] = useState<ApprovalDetails>();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny">();
  const [problem, setProblem] = useState("");
  const decided = outcome !== undefined;
  useEffect(() => {
    if (decided || !gateway.approval) return;
    let current = true;
    gateway.approval(approvalId).then(
      (read) => current && setDetails(read),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [gateway, approvalId, decided]);

  if (outcome) {
    return (
      <p className="needs-you-decided" role="status">
        {outcome.state === "approved" ? (
          <Check size={13} aria-hidden />
        ) : (
          <X size={13} aria-hidden />
        )}
        <span>
          {outcomeLine(outcome)} <span aria-hidden>·</span> {summary}
        </span>
      </p>
    );
  }

  const run = (approve: boolean, why: string) => {
    if (busy) return;
    setBusy(approve ? "approve" : "deny");
    setProblem("");
    decide(approvalId, approve, why).catch((error: unknown) => {
      setBusy(undefined);
      setProblem(describe(error));
    });
  };
  const deny = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setProblem("Say why it is denied.");
      return;
    }
    run(false, reason.trim());
  };
  return (
    <section className="needs-you" aria-labelledby={`${id}-label`} aria-describedby={`${id}-ask`}>
      <p className="needs-you-label" id={`${id}-label`}>
        Needs you <span aria-hidden>·</span> Approval
      </p>
      <p className="needs-you-ask" id={`${id}-ask`}>
        {summary}
      </p>
      {details?.arguments && details.arguments !== "{}" && (
        <pre className="needs-you-detail">{details.arguments}</pre>
      )}
      {denying ? (
        <form className="needs-you-actions" onSubmit={deny}>
          <input
            className="needs-you-reason"
            aria-label="Why it is denied"
            placeholder="Why? The Tag reads this."
            value={reason}
            // biome-ignore lint/a11y/noAutofocus: The person just chose Deny; the reason is the next thing to type.
            autoFocus
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setDenying(false);
              setProblem("");
            }}
          />
          <Button type="submit" variant="outline" className="pill" disabled={busy !== undefined}>
            {busy === "deny" ? "Denying…" : "Deny"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="pill quiet"
            disabled={busy !== undefined}
            onClick={() => {
              setDenying(false);
              setProblem("");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="needs-you-actions">
          <Button
            className="pill primary"
            disabled={busy !== undefined}
            onClick={() => run(true, "")}
          >
            {busy === "approve" ? "Approving…" : "Approve once"}
          </Button>
          <Button
            variant="outline"
            className="pill"
            disabled={busy !== undefined}
            onClick={() => setDenying(true)}
          >
            Deny
          </Button>
          <Button
            variant="ghost"
            className="pill quiet"
            aria-pressed={Boolean(replying)}
            disabled={busy !== undefined}
            onClick={() => onReply({ key: approvalId, text: summary })}
          >
            Reply
          </Button>
        </div>
      )}
      {problem && (
        <p className="needs-you-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** The key of the question card's reply target; a conversation has one open question at most. */
export const QUESTION_KEY = "question";

/**
 * The Tag's unanswered question, under the message that asks it: Reply puts the cursor in the
 * composer and marks what the next message answers.
 */
export function QuestionCard({
  name,
  question,
  replying,
  onReply,
}: {
  name: string;
  /** The Tag's message that asks. */
  question: string;
  replying?: boolean;
  onReply(target: ReplyTarget): void;
}) {
  const id = useId();
  return (
    <section className="needs-you" aria-labelledby={`${id}-label`} aria-describedby={`${id}-ask`}>
      <p className="needs-you-label" id={`${id}-label`}>
        Needs you <span aria-hidden>·</span> Question
      </p>
      <p className="needs-you-ask" id={`${id}-ask`}>
        {name} is waiting for your answer.
      </p>
      <div className="needs-you-actions">
        <Button
          className="pill primary"
          aria-pressed={Boolean(replying)}
          onClick={() => onReply({ key: QUESTION_KEY, text: question })}
        >
          Reply
        </Button>
      </div>
    </section>
  );
}

/** The chip over the composer's field that says what the next message answers. */
export function ReplyChip({ target, onDismiss }: { target: ReplyTarget; onDismiss(): void }) {
  return (
    <div className="composer-reply">
      <span className="composer-reply-text">
        <span className="composer-reply-label">Replying to:</span> {oneLine(target.text)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="icon-button"
        aria-label="Stop replying to this"
        title="Stop replying to this (Esc)"
        onClick={onDismiss}
      >
        <X size={13} aria-hidden />
      </Button>
    </div>
  );
}

/** A message as one line of plain words, for a chip: markdown marks and line breaks removed. */
export function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(#+|>)\s+/gm, "")
    .replace(/[`*_|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

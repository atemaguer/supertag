import { TagMailboxClient } from "supertag-ai/messaging";

const path = process.env.SUPERTAG_MAILBOX_CREDENTIAL_FILE;
if (!path) throw new Error("Set SUPERTAG_MAILBOX_CREDENTIAL_FILE to the host-side credential file");
const mailbox = await TagMailboxClient.fromCredentialFile(path);
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

// This example asks a clarification; it does not execute or accept an objective.
await mailbox.consume(async (message, { mailbox, signal }) => {
  if (message.type !== "delegation.requested") return;
  await mailbox.send(
    {
      recipientTagId: message.senderTagId,
      objectiveId: message.objectiveId,
      inReplyTo: message.id,
      type: "clarification.requested",
      body: { question: "What is the target launch date?" },
      idempotencyKey: `clarify-${message.id}`,
    },
    signal,
  );
}, stop.signal);

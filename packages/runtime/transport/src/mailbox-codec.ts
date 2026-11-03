import {
  create,
  type DescMessage,
  fromJson,
  type JsonValue,
  type MessageShape,
  toJson,
} from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type * as Core from "@supertag/core";
import * as p from "./gen/supertag/mailbox/v1/mailbox_pb.js";

export const MAILBOX_GRPC_MAX_REQUEST_BYTES = 70_000;
// A permitted history page can contain 200 messages with 64 KiB bodies plus routing metadata.
export const MAILBOX_GRPC_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** JSON conversion is for named typed protobuf fields. Only user-defined message bodies are opaque. */
export function mailboxInput<D extends DescMessage>(schema: D, value: unknown): MessageShape<D> {
  return fromJson(schema, JSON.parse(JSON.stringify(value)) as JsonValue);
}
export function mailboxRecord<D extends DescMessage>(
  schema: D,
  value: MessageShape<D>,
): Record<string, unknown> {
  return toJson(schema, value, { alwaysEmitImplicit: true }) as Record<string, unknown>;
}
export function encodeSend(value: Core.SendTagMessageInput): p.SendRequest {
  const { body, ...fields } = value;
  const json = JSON.stringify(body);
  if (typeof json !== "string" || Buffer.byteLength(json) > 65_536)
    throw new ConnectError("Mailbox message body exceeds limit", Code.InvalidArgument);
  return mailboxInput(p.SendRequestSchema, {
    ...fields,
    bodyJson: Buffer.from(json).toString("base64"),
  });
}
export function decodeSend(value: p.SendRequest): Core.SendTagMessageInput {
  if (value.bodyJson.byteLength > 65_536)
    throw new ConnectError("Mailbox message body exceeds limit", Code.InvalidArgument);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value.bodyJson));
  } catch {
    throw new ConnectError("Invalid mailbox body", Code.InvalidArgument);
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ConnectError("Mailbox body must be an object", Code.InvalidArgument);
  const { bodyJson: _, ...fields } = mailboxRecord(p.SendRequestSchema, value);
  return { ...fields, body } as Core.SendTagMessageInput;
}
export function encodeMessage(value: Core.TagMessage): p.Message {
  const {
    recipientTagId,
    recipientTeamId,
    objectiveId,
    type,
    body,
    idempotencyKey,
    inReplyTo,
    ...fields
  } = value;
  return create(p.MessageSchema, {
    ...fields,
    content: encodeSend({
      recipientTagId,
      ...(recipientTeamId === undefined ? {} : { recipientTeamId }),
      objectiveId,
      type,
      body,
      idempotencyKey,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
    }),
  });
}
export function decodeMessage(value: p.Message | undefined): Core.TagMessage {
  if (!value?.content) throw new ConnectError("Missing mailbox message", Code.DataLoss);
  const { content: _, ...fields } = mailboxRecord(p.MessageSchema, value);
  return { ...decodeSend(value.content), ...fields } as unknown as Core.TagMessage;
}
export function encodeObjectiveInput(value: Core.CreateObjectiveInput): p.CreateObjectiveRequest {
  const { runtimeActions, ...fields } = value;
  return mailboxInput(p.CreateObjectiveRequestSchema, {
    ...fields,
    ...(runtimeActions === undefined ? {} : { runtimeActions: { values: runtimeActions } }),
  });
}
export function decodeObjectiveInput(value: p.CreateObjectiveRequest): Core.CreateObjectiveInput {
  const { runtimeActions: _, ...fields } = mailboxRecord(p.CreateObjectiveRequestSchema, value);
  return {
    ...fields,
    ...(value.runtimeActions ? { runtimeActions: value.runtimeActions.values } : {}),
  } as unknown as Core.CreateObjectiveInput;
}
export function encodeObjective(value: Core.Objective): p.Objective {
  const {
    id,
    outcome,
    deadline,
    budgetLimitMinor,
    budgetCurrency,
    runtimeActions,
    observations,
    ongoing,
    ...fields
  } = value;
  const result = mailboxInput(p.ObjectiveSchema, {
    observationState: fields.observationState,
    ownerTagId: fields.ownerTagId,
    status: fields.status,
    revision: fields.revision,
    completionSummary: fields.completionSummary,
    cancelledAt: fields.cancelledAt,
    cancellationReason: fields.cancellationReason,
    executionStartedAt: fields.executionStartedAt,
    surfaceTaskId: fields.surfaceTaskId,
    surfaceSessionId: fields.surfaceSessionId,
    spentMinor: fields.spentMinor,
    reservedMinor: fields.reservedMinor,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    limitState: fields.limitState,
  });
  result.definition = encodeObjectiveInput({
    id,
    outcome,
    ...(deadline === undefined ? {} : { deadline }),
    ...(budgetLimitMinor === undefined ? {} : { budgetLimitMinor }),
    ...(budgetCurrency === undefined ? {} : { budgetCurrency }),
    ...(runtimeActions === undefined ? {} : { runtimeActions }),
    ...(observations === undefined ? {} : { observations }),
    ...(ongoing === undefined ? {} : { ongoing }),
  });
  return result;
}
export function decodeObjective(value: p.Objective): Core.Objective {
  if (!value.definition) throw new ConnectError("Missing Objective definition", Code.DataLoss);
  const { definition: _, ...fields } = mailboxRecord(p.ObjectiveSchema, value);
  const definition = decodeObjectiveInput(value.definition);
  return {
    ...definition,
    ...fields,
    deadline: definition.deadline ?? null,
    budgetLimitMinor: definition.budgetLimitMinor ?? null,
    budgetCurrency: definition.budgetCurrency ?? null,
    limitState: (fields["limitState"] as Core.ObjectiveLimitState | undefined) ?? {},
    completionSummary: value.completionSummary ?? null,
    cancelledAt: value.cancelledAt ?? null,
    cancellationReason: value.cancellationReason ?? null,
    executionStartedAt: value.executionStartedAt ?? null,
    surfaceTaskId: value.surfaceTaskId ?? null,
    surfaceSessionId: value.surfaceSessionId ?? null,
  } as Core.Objective;
}
export function encodeWorkstream(value: Core.Workstream): p.Workstream {
  return create(p.WorkstreamSchema, {
    id: value.id,
    objectiveId: value.objectiveId,
    title: value.title,
    ownerTagId: value.ownerTagId,
    participantTagIds: [...value.participantTagIds],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
export function decodeWorkstream(value: p.Workstream): Core.Workstream {
  return mailboxRecord(p.WorkstreamSchema, value) as unknown as Core.Workstream;
}
export function encodePost(value: Core.WorkstreamPost): p.Post {
  return mailboxInput(p.PostSchema, { ...value, authorTagId: value.authorTagId ?? undefined });
}
export function decodePost(value: p.Post): Core.WorkstreamPost {
  return {
    ...mailboxRecord(p.PostSchema, value),
    authorTagId: value.authorTagId ?? null,
    replyTo: value.replyTo ?? null,
  } as unknown as Core.WorkstreamPost;
}

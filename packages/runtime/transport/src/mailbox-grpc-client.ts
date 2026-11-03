import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { CreateObjectiveInput, SendTagMessageInput } from "@supertag/core";
import * as p from "./gen/supertag/mailbox/v1/mailbox_pb.js";
import {
  decodeMessage,
  decodeObjective,
  decodePost,
  decodeWorkstream,
  encodeObjectiveInput,
  encodeSend,
  MAILBOX_GRPC_MAX_REQUEST_BYTES,
  MAILBOX_GRPC_MAX_RESPONSE_BYTES,
  mailboxInput,
} from "./mailbox-codec.js";

/** Encoding adapter only. The public client owns consume/ack retry semantics. */
export class GrpcMailboxTransport {
  readonly #client;
  constructor(
    baseUrl: string,
    private readonly token: string,
    tlsCa?: string,
  ) {
    this.#client = createClient(
      p.MailboxService,
      createGrpcTransport({
        baseUrl,
        readMaxBytes: MAILBOX_GRPC_MAX_RESPONSE_BYTES,
        writeMaxBytes: MAILBOX_GRPC_MAX_REQUEST_BYTES,
        idleConnectionTimeoutMs: 1000,
        ...(tlsCa ? { nodeOptions: { ca: tlsCa } } : {}),
      }),
    );
  }
  async request(path: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const options = {
      headers: { authorization: `Bearer ${this.token}` },
      timeoutMs: 30_000,
      ...(signal === undefined ? {} : { signal }),
    };
    const value = input as Record<string, unknown>;
    const objective = /^\/objectives\/([^/]+)\/(get|status)$/u.exec(path);
    const workstream = /^\/workstreams\/([^/]+)\/(get|posts\/create|posts\/list)$/u.exec(path);
    const settlement = /^\/messages\/([^/]+)\/(ack|release|renew)$/u.exec(path);
    if (path === "/send") {
      const result = await this.#client.send(encodeSend(input as SendTagMessageInput), options);
      return { message: decodeMessage(result.message), duplicate: result.duplicate };
    }
    if (path === "/history") {
      const result = await this.#client.history(
        mailboxInput(p.HistoryRequestSchema, input),
        options,
      );
      return {
        items: result.items.map(decodeMessage),
        ...(result.nextCursor
          ? { nextCursor: { createdAt: result.nextCursor.createdAt, id: result.nextCursor.id } }
          : {}),
      };
    }
    if (path === "/receive") {
      const result = await this.#client.receive(
        mailboxInput(p.ReceiveRequestSchema, input),
        options,
      );
      return {
        delivery: result.delivery
          ? {
              message: decodeMessage(result.delivery.message),
              leaseToken: result.delivery.leaseToken,
              leaseExpiresAt: result.delivery.leaseExpiresAt,
            }
          : null,
      };
    }
    if (settlement) {
      const body = { ...value, messageId: decodeURIComponent(settlement[1] ?? "") };
      if (settlement[2] === "ack")
        await this.#client.acknowledge(mailboxInput(p.AcknowledgeRequestSchema, body), options);
      else if (settlement[2] === "release")
        await this.#client.release(mailboxInput(p.ReleaseRequestSchema, body), options);
      else await this.#client.renew(mailboxInput(p.RenewRequestSchema, body), options);
      return { ok: true };
    }
    if (path === "/objectives/create")
      return decodeObjective(
        await this.#client.createObjective(
          encodeObjectiveInput(input as CreateObjectiveInput),
          options,
        ),
      );
    if (path === "/objectives/list")
      return {
        items: (
          await this.#client.listObjectives(
            mailboxInput(p.ListObjectivesRequestSchema, input),
            options,
          )
        ).items.map(decodeObjective),
      };
    if (objective) {
      const id = decodeURIComponent(objective[1] ?? "");
      return decodeObjective(
        objective[2] === "get"
          ? await this.#client.getObjective({ id }, options)
          : await this.#client.updateObjectiveStatus(
              mailboxInput(p.UpdateObjectiveStatusRequestSchema, { ...value, id }),
              options,
            ),
      );
    }
    if (path === "/workstreams/list")
      return {
        items: (
          await this.#client.listWorkstreams(
            mailboxInput(p.ListWorkstreamsRequestSchema, input),
            options,
          )
        ).items.map(decodeWorkstream),
      };
    if (workstream) {
      const id = decodeURIComponent(workstream[1] ?? "");
      const body = { ...value, id };
      switch (workstream[2]) {
        case "get":
          return decodeWorkstream(await this.#client.getWorkstream({ id }, options));
        case "posts/create":
          return decodePost(
            await this.#client.postWorkstream(
              mailboxInput(p.PostWorkstreamRequestSchema, body),
              options,
            ),
          );
        case "posts/list":
          return {
            items: (
              await this.#client.workstreamPosts(
                mailboxInput(p.WorkstreamPostsRequestSchema, body),
                options,
              )
            ).items.map(decodePost),
          };
      }
    }
    throw new Error("Unsupported mailbox operation");
  }
}

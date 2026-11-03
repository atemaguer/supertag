/** Internal server adapter contract; not part of the public SuperTag SDK. */
export * as mailboxProtocol from "./gen/supertag/mailbox/v1/mailbox_pb.js";
export {
  decodeObjectiveInput,
  decodeSend,
  encodeMessage,
  encodeObjective,
  encodePost,
  encodeWorkstream,
  MAILBOX_GRPC_MAX_REQUEST_BYTES,
  MAILBOX_GRPC_MAX_RESPONSE_BYTES,
  mailboxRecord,
} from "./mailbox-codec.js";

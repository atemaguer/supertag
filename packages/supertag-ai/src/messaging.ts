/** Experimental surface-independent Tag messaging. Mailboxes are automatic per Tag. */

export type {
  SendTagMessageInput,
  TagMailboxCredential,
  TagMessage,
  TagMessageDelivery,
  TagMessageHistoryCursor,
  TagMessageHistoryOptions,
  TagMessageHistoryPage,
  TagMessageStatus,
  TagMessageType,
  TagMessagingGrant,
} from "../../core/src/mailbox.js";
export { TAG_MAILBOX_MAX_OUTSTANDING, TAG_MESSAGE_TYPES } from "../../core/src/mailbox.js";
export type {
  CreateObjectiveInput,
  Objective,
  ObjectiveStatus,
  UpdateObjectiveStatusInput,
} from "../../core/src/objective.js";
export { OBJECTIVE_STATUSES } from "../../core/src/objective.js";
export type { TaskAssignment, TaskAssignmentStatus } from "../../core/src/task-assignment.js";
export type { CreateTeamInput, Team, TeamScaling, UpdateTeamInput } from "../../core/src/team.js";
export type {
  ListWorkstreamPostsOptions,
  PostWorkstreamInput,
  Workstream,
  WorkstreamPost,
  WorkstreamPostType,
} from "../../core/src/workstream.js";
export {
  WORKSTREAM_POST_MAX_BODY,
  WORKSTREAM_POST_MAX_REFERENCE,
  WORKSTREAM_POST_MAX_REFERENCES,
  WORKSTREAM_POST_MAX_TO,
  WORKSTREAM_POST_TYPES,
} from "../../core/src/workstream.js";
export type {
  TagMailboxClientOptions,
  TagMessageHandlerContext,
} from "../../runtime/transport/src/mailbox-client.js";
export {
  TagMailboxClient,
  TagMailboxClientError,
} from "../../runtime/transport/src/mailbox-client.js";

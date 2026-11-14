// Presentation types of the terminal UI. They began as the generated types of the removed
// supertag.operator.v1 protos; the Control Plane's runtime.v2 replies are projected into them.

package views

import (
	"strconv"

	"google.golang.org/protobuf/types/known/timestamppb"
)

// Who wrote an entry in a conversation.
type ConversationAuthor int32

const (
	ConversationAuthor_CONVERSATION_AUTHOR_UNSPECIFIED ConversationAuthor = 0
	// The caller.
	ConversationAuthor_CONVERSATION_AUTHOR_OPERATOR ConversationAuthor = 1
	// The Tag: a reply or a work Session's report.
	ConversationAuthor_CONVERSATION_AUTHOR_TAG ConversationAuthor = 2
)

// Enum value maps for ConversationAuthor.
var (
	ConversationAuthor_name = map[int32]string{
		0: "CONVERSATION_AUTHOR_UNSPECIFIED",
		1: "CONVERSATION_AUTHOR_OPERATOR",
		2: "CONVERSATION_AUTHOR_TAG",
	}
	ConversationAuthor_value = map[string]int32{
		"CONVERSATION_AUTHOR_UNSPECIFIED": 0,
		"CONVERSATION_AUTHOR_OPERATOR":    1,
		"CONVERSATION_AUTHOR_TAG":         2,
	}
)

func (x ConversationAuthor) Enum() *ConversationAuthor {
	p := new(ConversationAuthor)
	*p = x
	return p
}

func (x ConversationAuthor) String() string {
	if s, ok := ConversationAuthor_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// Whether a reply or a report has been written.
type ReplyStatus int32

const (
	ReplyStatus_REPLY_STATUS_UNSPECIFIED ReplyStatus = 0
	// Not yet.
	ReplyStatus_REPLY_STATUS_WAITING ReplyStatus = 1
	// It has; the reply or report is set.
	ReplyStatus_REPLY_STATUS_REPLIED ReplyStatus = 2
)

// Enum value maps for ReplyStatus.
var (
	ReplyStatus_name = map[int32]string{
		0: "REPLY_STATUS_UNSPECIFIED",
		1: "REPLY_STATUS_WAITING",
		2: "REPLY_STATUS_REPLIED",
	}
	ReplyStatus_value = map[string]int32{
		"REPLY_STATUS_UNSPECIFIED": 0,
		"REPLY_STATUS_WAITING":     1,
		"REPLY_STATUS_REPLIED":     2,
	}
)

func (x ReplyStatus) Enum() *ReplyStatus {
	p := new(ReplyStatus)
	*p = x
	return p
}

func (x ReplyStatus) String() string {
	if s, ok := ReplyStatus_name[int32(x)]; ok {
		return s
	}
	return strconv.Itoa(int(x))
}

// What kind of reply the Tag wrote.
type ReplyPresentation int32

const (
	ReplyPresentation_REPLY_PRESENTATION_UNSPECIFIED ReplyPresentation = 0
	// The turn's result.
	ReplyPresentation_REPLY_PRESENTATION_FINAL_RESULT ReplyPresentation = 1
	// The error that ended the turn, such as a failed Task.
	ReplyPresentation_REPLY_PRESENTATION_ERROR ReplyPresentation = 2
	// A progress update.
	ReplyPresentation_REPLY_PRESENTATION_STATUS ReplyPresentation = 3
	// An acknowledgement that the turn started.
	ReplyPresentation_REPLY_PRESENTATION_ACKNOWLEDGEMENT ReplyPresentation = 4
)

// Enum value maps for ReplyPresentation.
var (
	ReplyPresentation_name = map[int32]string{
		0: "REPLY_PRESENTATION_UNSPECIFIED",
		1: "REPLY_PRESENTATION_FINAL_RESULT",
		2: "REPLY_PRESENTATION_ERROR",
		3: "REPLY_PRESENTATION_STATUS",
		4: "REPLY_PRESENTATION_ACKNOWLEDGEMENT",
	}
	ReplyPresentation_value = map[string]int32{
		"REPLY_PRESENTATION_UNSPECIFIED":     0,
		"REPLY_PRESENTATION_FINAL_RESULT":    1,
		"REPLY_PRESENTATION_ERROR":           2,
		"REPLY_PRESENTATION_STATUS":          3,
		"REPLY_PRESENTATION_ACKNOWLEDGEMENT": 4,
	}
)

func (x ReplyPresentation) Enum() *ReplyPresentation {
	p := new(ReplyPresentation)
	*p = x
	return p
}

func (x ReplyPresentation) String() string {
	if s, ok := ReplyPresentation_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// How a work Session's latest Task is doing.
type WorkSessionStatus int32

const (
	WorkSessionStatus_WORK_SESSION_STATUS_UNSPECIFIED WorkSessionStatus = 0
	// It has no Task yet, or its Task waits to run.
	WorkSessionStatus_WORK_SESSION_STATUS_PENDING WorkSessionStatus = 1
	// Its Task runs.
	WorkSessionStatus_WORK_SESSION_STATUS_RUNNING WorkSessionStatus = 2
	// Its Task completed.
	WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED WorkSessionStatus = 3
	// Its Task failed.
	WorkSessionStatus_WORK_SESSION_STATUS_FAILED WorkSessionStatus = 4
	// Its Task was cancelled.
	WorkSessionStatus_WORK_SESSION_STATUS_CANCELLED WorkSessionStatus = 5
	// Its Task completed waiting on the person: on the answer to `question`
	// when set, otherwise on a decision on its `approvals`.
	WorkSessionStatus_WORK_SESSION_STATUS_WAITING WorkSessionStatus = 6
)

// Enum value maps for WorkSessionStatus.
var (
	WorkSessionStatus_name = map[int32]string{
		0: "WORK_SESSION_STATUS_UNSPECIFIED",
		1: "WORK_SESSION_STATUS_PENDING",
		2: "WORK_SESSION_STATUS_RUNNING",
		3: "WORK_SESSION_STATUS_COMPLETED",
		4: "WORK_SESSION_STATUS_FAILED",
		5: "WORK_SESSION_STATUS_CANCELLED",
		6: "WORK_SESSION_STATUS_WAITING",
	}
	WorkSessionStatus_value = map[string]int32{
		"WORK_SESSION_STATUS_UNSPECIFIED": 0,
		"WORK_SESSION_STATUS_PENDING":     1,
		"WORK_SESSION_STATUS_RUNNING":     2,
		"WORK_SESSION_STATUS_COMPLETED":   3,
		"WORK_SESSION_STATUS_FAILED":      4,
		"WORK_SESSION_STATUS_CANCELLED":   5,
		"WORK_SESSION_STATUS_WAITING":     6,
	}
)

func (x WorkSessionStatus) Enum() *WorkSessionStatus {
	p := new(WorkSessionStatus)
	*p = x
	return p
}

func (x WorkSessionStatus) String() string {
	if s, ok := WorkSessionStatus_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

// Whether a command or tool call runs or has ended.
type ActivityStatus int32

const (
	ActivityStatus_ACTIVITY_STATUS_UNSPECIFIED ActivityStatus = 0
	// It started.
	ActivityStatus_ACTIVITY_STATUS_RUNNING ActivityStatus = 1
	// It ended successfully.
	ActivityStatus_ACTIVITY_STATUS_COMPLETED ActivityStatus = 2
	// It ended with a failure.
	ActivityStatus_ACTIVITY_STATUS_FAILED ActivityStatus = 3
)

// Enum value maps for ActivityStatus.
var (
	ActivityStatus_name = map[int32]string{
		0: "ACTIVITY_STATUS_UNSPECIFIED",
		1: "ACTIVITY_STATUS_RUNNING",
		2: "ACTIVITY_STATUS_COMPLETED",
		3: "ACTIVITY_STATUS_FAILED",
	}
	ActivityStatus_value = map[string]int32{
		"ACTIVITY_STATUS_UNSPECIFIED": 0,
		"ACTIVITY_STATUS_RUNNING":     1,
		"ACTIVITY_STATUS_COMPLETED":   2,
		"ACTIVITY_STATUS_FAILED":      3,
	}
)

func (x ActivityStatus) Enum() *ActivityStatus {
	p := new(ActivityStatus)
	*p = x
	return p
}

func (x ActivityStatus) String() string {
	if s, ok := ActivityStatus_name[int32(x)]; ok {
		return s
	}
	return strconv.
		Itoa(int(x))
}

type ListMessagesRequest struct {

	// The Tag's name.
	Tag string
	// The conversation's name. Empty means `default`.
	Conversation string
	// At most this many messages; 0 means 50, and more than 100 means 100.
	PageSize int32
	// The `next_page_token` of the previous page.

}

func (x *ListMessagesRequest) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *ListMessagesRequest) GetConversation() string {
	if x != nil {
		return x.Conversation
	}
	return ""
}

func (x *ListMessagesRequest) GetPageSize() int32 {
	if x != nil {
		return x.PageSize
	}
	return 0
}

// One of the caller's conversations with a Tag.
type Conversation struct {

	// The Tag's name.
	Tag string
	// The conversation's name, such as `default`.
	Name string
	// The conversation's Session.
	SessionId string
	// The start of the conversation's most recent entry, at most 200
	// characters: the caller's latest message, the Tag's reply to it, or a work
	// Session's report, whichever came last.
	LastMessageText string
	// Who wrote `last_message_text`.
	LastMessageAuthor ConversationAuthor
	// When the most recent entry was written.

	// How many work Sessions the conversation's turns started are not finished:
	// their status is `WORK_SESSION_STATUS_PENDING`,
	// `WORK_SESSION_STATUS_RUNNING` or `WORK_SESSION_STATUS_WAITING`.
	OpenWorkSessionCount int32
}

func (x *Conversation) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *Conversation) GetName() string {
	if x != nil {
		return x.Name
	}
	return ""
}

func (x *Conversation) GetSessionId() string {
	if x != nil {
		return x.SessionId
	}
	return ""
}

func (x *Conversation) GetLastMessageText() string {
	if x != nil {
		return x.LastMessageText
	}
	return ""
}

func (x *Conversation) GetLastMessageAuthor() ConversationAuthor {
	if x != nil {
		return x.LastMessageAuthor
	}
	return ConversationAuthor_CONVERSATION_AUTHOR_UNSPECIFIED
}

func (x *Conversation) GetOpenWorkSessionCount() int32 {
	if x != nil {
		return x.OpenWorkSessionCount
	}
	return 0
}

// One message in a conversation and what answered it.
//
// A message is one the caller sent, or a turn of an Objective whose home
// thread is one of the caller's conversations. A turn of an Objective without
// a home thread is readable by every operator. A work Session's own Task is not
// a message: the message that started it carries it in `work_sessions`.
type Message struct {

	// The ID of the Task the message started. It names the message.
	TaskId string
	// The Tag's name.
	Tag string
	// The conversation's name. For an Objective turn without a home thread, it
	// is `objective:` and the Objective's ID.
	Conversation string
	// The conversation's Session.
	SessionId string
	// What the message said: the caller's text, or the text an Objective turn
	// delivered.
	Text string
	// When the message was sent.
	CreatedAt *timestamppb.Timestamp
	// Whether the Tag has replied.
	Status ReplyStatus
	// Why the turn has not started, in one line, while no bound Worker Host can
	// run it, such as `no bound Worker Host provides MCP server notes`. Empty
	// once the turn can be placed or after the reply.
	WaitingReason string
	// The Tag's final reply: the turn's result, or the error that ended it.
	// Set when `status` is `REPLY_STATUS_REPLIED`.
	Reply *Reply
	// The running turn this message was delivered into, when it joined one
	// instead of starting its own. That turn's reply is `reply`. It goes back
	// to empty when that turn ends without reading the message, which then
	// runs as its own turn.
	JoinedTaskId string
	// The work Sessions this message's turn started or continued, oldest first.
	WorkSessions []*WorkSession
}

func (x *Message) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *Message) GetTag() string {
	if x != nil {
		return x.Tag
	}
	return ""
}

func (x *Message) GetConversation() string {
	if x != nil {
		return x.Conversation
	}
	return ""
}

func (x *Message) GetSessionId() string {
	if x != nil {
		return x.SessionId
	}
	return ""
}

func (x *Message) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

func (x *Message) GetCreatedAt() *timestamppb.Timestamp {
	if x != nil {
		return x.CreatedAt
	}
	return nil
}

func (x *Message) GetStatus() ReplyStatus {
	if x != nil {
		return x.Status
	}
	return ReplyStatus_REPLY_STATUS_UNSPECIFIED
}

func (x *Message) GetWaitingReason() string {
	if x != nil {
		return x.WaitingReason
	}
	return ""
}

func (x *Message) GetReply() *Reply {
	if x != nil {
		return x.Reply
	}
	return nil
}

func (x *Message) GetJoinedTaskId() string {
	if x != nil {
		return x.JoinedTaskId
	}
	return ""
}

func (x *Message) GetWorkSessions() []*WorkSession {
	if x != nil {
		return x.WorkSessions
	}
	return nil
}

// A reply the Tag wrote: its answer to a message, or a work Session's report.
type Reply struct {

	// What kind of reply it is.
	Presentation ReplyPresentation
	// The text, as the Tag wrote it.
	Text string
}

func (x *Reply) GetPresentation() ReplyPresentation {
	if x != nil {
		return x.Presentation
	}
	return ReplyPresentation_REPLY_PRESENTATION_UNSPECIFIED
}

func (x *Reply) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

// A work Session a message's turn started: its latest Task and its report.
type WorkSession struct {

	// The work Session's ID.
	Id string
	// The title the Tag gave the work.
	Title string
	// The work Session's latest Task. Empty until it has one. A decision on an
	// approval request continues the work Session as a new Task, which this
	// then names.
	TaskId string
	// How the latest Task is doing.
	Status WorkSessionStatus
	// What the Task asked the person, when it completed by asking. The answer
	// is the caller's next message in the conversation.
	Question string
	// A notice for each of the Task's pending approval requests, as the Tag
	// posted it to the conversation. Decide one with `supertag approve request`
	// or `supertag deny request`; the decision continues the work Session.
	Approvals []*ApprovalNotice
	// Why a decision on a request the Task waited on did not continue the work
	// Session, such as the Tag's permissions changing or the turn's limits
	// being spent. `status` is then the Task's own.
	NotContinued string
	// Whether the report on the latest Task has been written.
	ReportStatus ReplyStatus
	// The conversation turn that reports the work Session's result.
	ReportTaskId string
	// The report. Set when `report_status` is `REPLY_STATUS_REPLIED`.
	Report *Reply
}

func (x *WorkSession) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *WorkSession) GetTitle() string {
	if x != nil {
		return x.Title
	}
	return ""
}

func (x *WorkSession) GetTaskId() string {
	if x != nil {
		return x.TaskId
	}
	return ""
}

func (x *WorkSession) GetStatus() WorkSessionStatus {
	if x != nil {
		return x.Status
	}
	return WorkSessionStatus_WORK_SESSION_STATUS_UNSPECIFIED
}

func (x *WorkSession) GetQuestion() string {
	if x != nil {
		return x.Question
	}
	return ""
}

func (x *WorkSession) GetApprovals() []*ApprovalNotice {
	if x != nil {
		return x.Approvals
	}
	return nil
}

func (x *WorkSession) GetNotContinued() string {
	if x != nil {
		return x.NotContinued
	}
	return ""
}

func (x *WorkSession) GetReportStatus() ReplyStatus {
	if x != nil {
		return x.ReportStatus
	}
	return ReplyStatus_REPLY_STATUS_UNSPECIFIED
}

func (x *WorkSession) GetReportTaskId() string {
	if x != nil {
		return x.ReportTaskId
	}
	return ""
}

func (x *WorkSession) GetReport() *Reply {
	if x != nil {
		return x.Report
	}
	return nil
}

// The notice the Tag posted for one pending approval request.
type ApprovalNotice struct {

	// The approval request's ID.
	RequestId string
	// The notice.
	Text string
}

func (x *ApprovalNotice) GetRequestId() string {
	if x != nil {
		return x.RequestId
	}
	return ""
}

func (x *ApprovalNotice) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

// One event while following a message. See `FollowMessage` for the order.
type FollowEvent struct {

	// Orders the stream's events and resumes it as `after_sequence`. 0 only on
	// `heartbeat`, which is never resumed from.
	Sequence int64
	// What happened. Exactly one is set.
	//
	// Types that are valid to be assigned to Part:
	//
	//	*FollowEvent_Joined
	//	*FollowEvent_Waiting
	//	*FollowEvent_TextDelta
	//	*FollowEvent_Activity
	//	*FollowEvent_Finish
	//	*FollowEvent_Error
	//	*FollowEvent_WorkSessionChanged
	//	*FollowEvent_End
	//	*FollowEvent_Heartbeat
	Part isFollowEvent_Part
}

func (x *FollowEvent) GetSequence() int64 {
	if x != nil {
		return x.Sequence
	}
	return 0
}

func (x *FollowEvent) GetPart() isFollowEvent_Part {
	if x != nil {
		return x.Part
	}
	return nil
}

type isFollowEvent_Part interface {
	isFollowEvent_Part()
}

type FollowEvent_Joined struct {
	// The message was delivered into a running turn, which answers it, or,
	// with an empty `task_id`, that delivery was withdrawn.

}

type FollowEvent_Waiting struct {
	// Why the turn has not started. Sent when the reason changes.

}

type FollowEvent_TextDelta struct {
	// Reply text as the Tag writes it.
	TextDelta *TextDelta
}

type FollowEvent_Activity struct {
	// A command, tool call or retry of the turn or of a work Session.
	Activity *Activity
}

type FollowEvent_Finish struct {
	// The turn ended with its reply.
	Finish *Finish
}

type FollowEvent_Error struct {
	// The turn ended with an error instead of a reply.
	Error *TurnError
}

type FollowEvent_WorkSessionChanged struct {
	// A work Session the turn started changed.
	WorkSessionChanged *WorkSessionChanged
}

type FollowEvent_End struct {
	// Nothing more will follow. The last event of the stream.
	End *FollowEnd
}

type FollowEvent_Heartbeat struct {
	// Keeps an idle stream open.
	Heartbeat *Heartbeat
}

func (*FollowEvent_Joined) isFollowEvent_Part() {}

func (*FollowEvent_Waiting) isFollowEvent_Part() {}

func (*FollowEvent_TextDelta) isFollowEvent_Part() {}

func (*FollowEvent_Activity) isFollowEvent_Part() {}

func (*FollowEvent_Finish) isFollowEvent_Part() {}

func (*FollowEvent_Error) isFollowEvent_Part() {}

func (*FollowEvent_WorkSessionChanged) isFollowEvent_Part() {}

func (*FollowEvent_End) isFollowEvent_Part() {}

func (*FollowEvent_Heartbeat) isFollowEvent_Part() {}

// Reply text as the Tag's harness writes it. It includes what the Tag says
// between tool calls, and text from a Task Attempt a retry replaced; `finish`
// carries the reply itself. An `activity` between two deltas ends a block of
// text. The server may skip text of a very long turn.
type TextDelta struct {

	// The text to append.
	Text string
}

func (x *TextDelta) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

// A command or tool call starting or ending, or a retry of the Task in a new
// Task Attempt.
type Activity struct {

	// The work Session the activity belongs to. Empty for the message's own
	// turn.
	WorkSessionId string
	// One line for a start or a retry, such as `running: COMMAND`, `using: TOOL`, or
	// `retrying (Task Attempt N)`. Empty when a command or tool call ends. A
	// client shows it when it does not recognize `detail`.
	Text string
	// What the activity is. A client that does not recognize the member set
	// shows `text`.
	//
	// Types that are valid to be assigned to Detail:
	//
	//	*Activity_Command
	//	*Activity_Tool
	//	*Activity_Retry
	Detail isActivity_Detail
}

func (x *Activity) GetWorkSessionId() string {
	if x != nil {
		return x.WorkSessionId
	}
	return ""
}

func (x *Activity) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

func (x *Activity) GetDetail() isActivity_Detail {
	if x != nil {
		return x.Detail
	}
	return nil
}

func (x *Activity) GetCommand() *CommandActivity {
	if x != nil {
		if x, ok := x.Detail.(*Activity_Command); ok {
			return x.Command
		}
	}
	return nil
}

func (x *Activity) GetTool() *ToolActivity {
	if x != nil {
		if x, ok := x.Detail.(*Activity_Tool); ok {
			return x.Tool
		}
	}
	return nil
}

type isActivity_Detail interface {
	isActivity_Detail()
}

type Activity_Command struct {
	// A command starting or ending.
	Command *CommandActivity
}

type Activity_Tool struct {
	// A tool call starting or ending.
	Tool *ToolActivity
}

type Activity_Retry struct {
	// A new Task Attempt of the Task.
	Retry *RetryActivity
}

func (*Activity_Command) isActivity_Detail() {}

func (*Activity_Tool) isActivity_Detail() {}

func (*Activity_Retry) isActivity_Detail() {}

// A command the Tag runs.
type CommandActivity struct {

	// Pairs the command's start with its end.
	Id string
	// The command line. The Tag wrote it, so it is untrusted: the Worker removes
	// control characters and cuts it to 200 characters.
	Command string
	// `ACTIVITY_STATUS_RUNNING` when it starts, then once more when it ends.
	Status ActivityStatus
}

func (x *CommandActivity) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *CommandActivity) GetCommand() string {
	if x != nil {
		return x.Command
	}
	return ""
}

func (x *CommandActivity) GetStatus() ActivityStatus {
	if x != nil {
		return x.Status
	}
	return ActivityStatus_ACTIVITY_STATUS_UNSPECIFIED
}

// A tool the Tag calls.
type ToolActivity struct {

	// Pairs the call's start with its end.
	Id string
	// The tool as `PROVIDER.OPERATION`, such as `github.create_pull_request`.
	Tool string
	// `ACTIVITY_STATUS_RUNNING` when it starts, then once more when it ends.
	Status ActivityStatus
}

func (x *ToolActivity) GetId() string {
	if x != nil {
		return x.Id
	}
	return ""
}

func (x *ToolActivity) GetTool() string {
	if x != nil {
		return x.Tool
	}
	return ""
}

func (x *ToolActivity) GetStatus() ActivityStatus {
	if x != nil {
		return x.Status
	}
	return ActivityStatus_ACTIVITY_STATUS_UNSPECIFIED
}

// A new Task Attempt continues the Task after the previous one ended without
// a result. Text before it is not part of the reply.
type RetryActivity struct {

	// The new Task Attempt's number, from 1.
	Attempt int32
}

func (x *RetryActivity) GetAttempt() int32 {
	if x != nil {
		return x.Attempt
	}
	return 0
}

// The turn's reply.
type Finish struct {

	// The reply. Its presentation is never `REPLY_PRESENTATION_ERROR`; such a
	// reply is a `TurnError` instead.
	Reply *Reply
	// The message as `GetMessage` returns it now, with the work Sessions the
	// turn started.
	Message *Message
}

func (x *Finish) GetReply() *Reply {
	if x != nil {
		return x.Reply
	}
	return nil
}

func (x *Finish) GetMessage() *Message {
	if x != nil {
		return x.Message
	}
	return nil
}

// The error that ended the turn: its Task failed, or the Control Plane could
// not tell whether a delivery into a running turn reached it.
type TurnError struct {

	// The error, as the message's `reply.text`.
	Text string
}

func (x *TurnError) GetText() string {
	if x != nil {
		return x.Text
	}
	return ""
}

// A work Session's current state, after any change to it.
type WorkSessionChanged struct {

	// The whole work Session. It replaces the one the client holds with the
	// same `id`.
	WorkSession *WorkSession
}

func (x *WorkSessionChanged) GetWorkSession() *WorkSession {
	if x != nil {
		return x.WorkSession
	}
	return nil
}

// The end of the stream.
type FollowEnd struct {

	// The message as `GetMessage` returns it now.
	Message *Message
}

func (x *FollowEnd) GetMessage() *Message {
	if x != nil {
		return x.Message
	}
	return nil
}

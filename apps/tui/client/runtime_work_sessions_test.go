package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func runtimeWorkSession() *v2.WorkSession {
	return &v2.WorkSession{WorkSessionId: "work/one", Title: "Check tests", ParentTagId: "lead", ParentSessionId: "parent", StarterTaskId: "root", TagId: "lead", LatestTaskId: "child", LatestTaskState: v2.TaskState_TASK_STATE_RUNNING}
}

func runtimeParentMessage(id string) *v2.ConversationMessage {
	return &v2.ConversationMessage{Conversation: "default", Task: &v2.Task{TaskId: id, TagId: "lead", SessionId: "parent", Prompt: "Please check", State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Started checking")}}
}

func TestRuntimeWorkSessionHistoryKeepsReportTaskAndCursorWithoutInternalPrompt(t *testing.T) {
	mux := http.NewServeMux()
	work := runtimeWorkSession()
	work.LatestTaskState, work.ReportTaskId, work.ReportTaskState = v2.TaskState_TASK_STATE_SUCCEEDED, proto.String("report"), v2.TaskState_TASK_STATE_SUCCEEDED
	report := runtimeParentMessage("report")
	report.WorkSessionReportId = proto.String(work.WorkSessionId)
	report.Task.Prompt, report.Task.Result = "INTERNAL REPORT INSTRUCTION", proto.String("Tests passed")
	testRPC(mux, rpc.ConversationsListMessagesProcedure, func(_ context.Context, req *v2.ListMessagesRequest) (*v2.ListMessagesResponse, error) {
		if req.GetCursor() != "original-cursor" || req.GetConversation() != "default" || req.GetTagId() != "lead" {
			t.Errorf("message scope: %v", req)
		}
		return &v2.ListMessagesResponse{Messages: []*v2.ConversationMessage{report, runtimeParentMessage("root")}, NextCursor: "unchanged-next"}, nil
	})
	testRPC(mux, rpc.WorkSessionsListProcedure, func(_ context.Context, req *v2.ListWorkSessionsRequest) (*v2.ListWorkSessionsResponse, error) {
		if req.GetParentTagId() != "lead" || req.GetParentSessionId() != "parent" || req.GetStarterTaskId() != "root" || req.GetLimit() != 4 {
			t.Errorf("Work Session scope: %v", req)
		}
		return &v2.ListWorkSessionsResponse{WorkSessions: []*v2.WorkSession{work}}, nil
	})
	testRPC(mux, rpc.WorkSessionsGetProcedure, func(_ context.Context, req *v2.GetWorkSessionRequest) (*v2.WorkSession, error) {
		if req.GetWorkSessionId() != work.WorkSessionId || req.GetReportTaskId() != "report" {
			t.Errorf("Get scope: %v", req)
		}
		return work, nil
	})
	testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
		if req.GetTaskId() != "report" {
			t.Errorf("report scope: %v", req)
		}
		return report.Task, nil
	})
	c := testRuntime(t, mux, false)
	page, cursor, err := c.ListMessages(t.Context(), "lead", "default", 10, "original-cursor")
	if err != nil || cursor != "unchanged-next" || len(page) != 2 {
		t.Fatalf("page = %v %q %v", page, cursor, err)
	}
	if page[0].GetTaskId() != "report" || page[0].GetText() != "" {
		t.Fatalf("report row = %v", page[0])
	}
	history := History("lead", page)
	var events []FollowEvent
	for _, item := range history {
		if item.Follow {
			t.Fatal("completed report should not need follow")
		}
		events = append(events, item.Events...)
	}
	if got := describe(events); strings.Count(got, "report [Check tests] (done) Tests passed") != 1 || strings.Contains(got, "INTERNAL") {
		t.Fatalf("history:\n%s", got)
	}
	// A report on a page without its root still renders once and retains its own Task ID.
	isolated := History("lead", page[:1])
	if isolated[0].Message.GetTaskId() != "report" || !strings.Contains(describe(isolated[0].Events), "Tests passed") {
		t.Fatalf("isolated report: %v", isolated)
	}
}

func TestRuntimeWorkSessionHistoryUsesExactChildTurnAfterContinuation(t *testing.T) {
	mux := http.NewServeMux()
	first := runtimeWorkSession()
	first.LatestTaskState, first.ReportTaskId, first.ReportTaskState = v2.TaskState_TASK_STATE_SUCCEEDED, proto.String("report-first"), v2.TaskState_TASK_STATE_SUCCEEDED
	first.Question = &v2.WorkSessionQuestion{WorkSessionId: first.WorkSessionId, TaskId: first.LatestTaskId, AttemptId: "attempt-first", Text: "Which region?", AskedAtMs: 10, PublishedAtMs: proto.Int64(11), AnswerTaskId: proto.String("child-second")}
	second := proto.Clone(first).(*v2.WorkSession)
	second.StarterTaskId, second.LatestTaskId, second.ReportTaskId, second.Question = "continue-parent", "child-second", proto.String("report-second"), nil
	message := func(id string) *v2.ConversationMessage {
		out := runtimeParentMessage(id)
		if strings.HasPrefix(id, "report-") {
			out.WorkSessionReportId = proto.String(first.WorkSessionId)
		}
		if id == "report-first" {
			out.Task.Result = proto.String("Which region should I use?")
		}
		if id == "report-second" {
			out.Task.Result = proto.String("Region verified")
		}
		return out
	}
	testRPC(mux, rpc.ConversationsListMessagesProcedure, func(_ context.Context, _ *v2.ListMessagesRequest) (*v2.ListMessagesResponse, error) {
		return &v2.ListMessagesResponse{Messages: []*v2.ConversationMessage{message("report-second"), message("continue-parent"), message("report-first"), message("root")}, NextCursor: "historical-page"}, nil
	})
	testRPC(mux, rpc.WorkSessionsListProcedure, func(_ context.Context, req *v2.ListWorkSessionsRequest) (*v2.ListWorkSessionsResponse, error) {
		if req.GetParentTagId() != "lead" || req.GetParentSessionId() != "parent" {
			t.Errorf("parent scope: %v", req)
		}
		switch req.GetStarterTaskId() {
		case "root":
			return &v2.ListWorkSessionsResponse{WorkSessions: []*v2.WorkSession{first}}, nil
		case "continue-parent":
			return &v2.ListWorkSessionsResponse{WorkSessions: []*v2.WorkSession{second}}, nil
		default:
			return nil, fmt.Errorf("unexpected parent %q", req.GetStarterTaskId())
		}
	})
	testRPC(mux, rpc.WorkSessionsGetProcedure, func(_ context.Context, req *v2.GetWorkSessionRequest) (*v2.WorkSession, error) {
		if req.GetWorkSessionId() != first.WorkSessionId {
			t.Errorf("Work Session scope: %v", req)
		}
		switch req.GetReportTaskId() {
		case "report-first":
			return first, nil
		case "report-second":
			return second, nil
		default:
			return nil, fmt.Errorf("report history must select its exact Task: %v", req)
		}
	})
	testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
		return message(req.GetTaskId()).Task, nil
	})
	c := testRuntime(t, mux, false)
	page, cursor, err := c.ListMessages(t.Context(), "lead", "default", 10, "")
	if err != nil || len(page) != 4 || cursor != "historical-page" {
		t.Fatalf("history = %v, %q, %v", page, cursor, err)
	}
	if page[3].WorkSessions[0].TaskId != "child" || page[1].WorkSessions[0].TaskId != "child-second" {
		t.Fatal("a continuation replaced the original child projection")
	}
	if page[2].WorkSessions[0].Question != "Which region?" || page[2].WorkSessions[0].Status != operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED {
		t.Fatalf("question state = %v", page[2].WorkSessions[0])
	}
	var events []FollowEvent
	for _, item := range History("lead", page) {
		if item.Follow {
			t.Fatal("a published, reported question waits for the operator, not another running follow")
		}
		events = append(events, item.Events...)
	}
	got := describe(events)
	if strings.Count(got, "report [Check tests] (done) Which region should I use?") != 1 || strings.Count(got, "report [Check tests] (done) Region verified") != 1 {
		t.Fatalf("reports:\n%s", got)
	}
}

func TestRuntimeWorkSessionQuestionAppearsOnlyAfterPublicationAndClearsWaitingAfterAnswer(t *testing.T) {
	work := runtimeWorkSession()
	work.LatestTaskState = v2.TaskState_TASK_STATE_SUCCEEDED
	work.Question = &v2.WorkSessionQuestion{WorkSessionId: work.WorkSessionId, TaskId: work.LatestTaskId, Text: "Which region?", AskedAtMs: 10}
	if view := runtimeWork(work); view.Question != "" || view.Status == operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_WAITING {
		t.Fatalf("unpublished question became operator wait: %v", view)
	}
	work.Question.PublishedAtMs = proto.Int64(11)
	if view := runtimeWork(work); view.Question != "Which region?" || view.Status != operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_WAITING {
		t.Fatalf("published question = %v", view)
	}
	waiting := runtimeWork(work)
	waiting.ReportStatus, waiting.Report = operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, &operatorv1.Reply{Text: "Which region?"}
	history := History("lead", []*operatorv1.Message{{TaskId: "root", Tag: "lead", Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED, Reply: &operatorv1.Reply{Text: "Started"}, WorkSessions: []*operatorv1.WorkSession{waiting}}})
	if history[0].Follow || !strings.Contains(describe(history[0].Events), "(waiting on you) Which region?") {
		t.Fatalf("reported question should wait for the operator: %s", describe(history[0].Events))
	}
	work.Question.AnswerTaskId = proto.String("child-answer")
	if view := runtimeWork(work); view.Question != "Which region?" || view.Status != operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_COMPLETED {
		t.Fatalf("answered question still blocks work: %v", view)
	}
}

func TestRuntimeWorkSessionFollowDrainsChildPagesAndWaitsForParentReport(t *testing.T) {
	mux := http.NewServeMux()
	var childDone atomic.Bool
	var reportReads atomic.Int32
	testRPC(mux, rpc.ConversationsGetMessageProcedure, func(_ context.Context, req *v2.GetMessageRequest) (*v2.ConversationMessage, error) {
		if req.GetTaskId() != "root" || req.GetTagId() != "lead" {
			t.Errorf("root scope: %v", req)
		}
		return runtimeParentMessage("root"), nil
	})
	testRPC(mux, rpc.ConversationsListMessageEventsProcedure, func(_ context.Context, _ *v2.ListMessageEventsRequest) (*v2.ListEventsResponse, error) {
		return &v2.ListEventsResponse{}, nil
	})
	testRPC(mux, rpc.WorkSessionsListProcedure, func(_ context.Context, req *v2.ListWorkSessionsRequest) (*v2.ListWorkSessionsResponse, error) {
		if req.GetStarterTaskId() != "root" || req.GetParentSessionId() != "parent" {
			t.Errorf("work scope: %v", req)
		}
		work := runtimeWorkSession()
		if childDone.Load() {
			work.LatestTaskState, work.ReportTaskId, work.ReportTaskState = v2.TaskState_TASK_STATE_SUCCEEDED, proto.String("report"), v2.TaskState_TASK_STATE_RUNNING
		}
		return &v2.ListWorkSessionsResponse{WorkSessions: []*v2.WorkSession{work}}, nil
	})
	testRPC(mux, rpc.OperatorListEventsProcedure, func(_ context.Context, req *v2.ListEventsRequest) (*v2.ListEventsResponse, error) {
		if req.GetTaskId() != "child" {
			t.Errorf("child scope: %v", req)
		}
		switch req.GetAfterSequence() {
		case 0:
			events := make([]*v2.TaskEvent, runtimeEventPage)
			for i := range events {
				events[i] = &v2.TaskEvent{Sequence: uint64(i + 1), Text: fmt.Sprintf("child event %d", i+1)}
			}
			return &v2.ListEventsResponse{Events: events}, nil
		case runtimeEventPage:
			childDone.Store(true)
			return &v2.ListEventsResponse{Events: []*v2.TaskEvent{{Sequence: runtimeEventPage + 1, Text: "last child event"}}}, nil
		default:
			return &v2.ListEventsResponse{}, nil
		}
	})
	testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
		if req.GetTaskId() != "report" {
			t.Errorf("report scope: %v", req)
		}
		task := runtimeParentMessage("report").Task
		task.State = v2.TaskState_TASK_STATE_RUNNING
		if reportReads.Add(1) >= 2 {
			task.State, task.Result = v2.TaskState_TASK_STATE_SUCCEEDED, proto.String("Tests passed")
		}
		return task, nil
	})
	c := testRuntime(t, mux, false)
	events := collect(t, testFollower(c).Follow(t.Context(), "lead", message("root"), nil))
	var reports, activities, replies int
	for _, event := range events {
		switch event.Kind {
		case EventReport:
			reports++
			if activities != runtimeEventPage+1 || event.Text != "Tests passed" || event.TaskID != "report" {
				t.Fatalf("premature/wrong report: %v", event)
			}
		case EventActivity:
			activities++
			if !event.Indent || event.WorkSession != "work/one" {
				t.Fatalf("child activity: %v", event)
			}
		case EventReply:
			replies++
		case EventError:
			t.Fatalf("follow error: %s", event.Text)
		}
	}
	if reports != 1 || replies != 1 || activities != runtimeEventPage+1 || reportReads.Load() < 2 {
		t.Fatalf("events:\n%s", describe(events))
	}
}

func TestRuntimeWorkSessionListChecksScopeAndPagination(t *testing.T) {
	for _, wrong := range []string{"", "parent", "starter", "tag", "question", "repeat-cursor"} {
		t.Run(wrong, func(t *testing.T) {
			mux := http.NewServeMux()
			var cursors []string
			testRPC(mux, rpc.WorkSessionsListProcedure, func(_ context.Context, req *v2.ListWorkSessionsRequest) (*v2.ListWorkSessionsResponse, error) {
				cursors = append(cursors, req.GetCursor())
				work := runtimeWorkSession()
				if wrong == "parent" {
					work.ParentSessionId = "private-other"
				}
				if wrong == "starter" {
					work.StarterTaskId = "other"
				}
				if wrong == "tag" {
					work.ParentTagId = "other"
				}
				if wrong == "question" {
					work.Question = &v2.WorkSessionQuestion{WorkSessionId: work.WorkSessionId, TaskId: "private-child", Text: "Must not appear"}
				}
				if req.GetCursor() == "" {
					return &v2.ListWorkSessionsResponse{WorkSessions: []*v2.WorkSession{work}, NextCursor: "next"}, nil
				}
				if wrong == "repeat-cursor" {
					return &v2.ListWorkSessionsResponse{NextCursor: "next"}, nil
				}
				return &v2.ListWorkSessionsResponse{}, nil
			})
			c := testRuntime(t, mux, false)
			work, err := c.runtime.messageWorkSessions(t.Context(), runtimeParentMessage("root"))
			if wrong == "" {
				if err != nil || len(work) != 1 || !slices.Equal(cursors, []string{"", "next"}) {
					t.Fatalf("list = %v, %v, %v", work, cursors, err)
				}
			} else {
				var api *APIError
				if !errors.As(err, &api) || api.Code != connect.CodeDataLoss {
					t.Fatalf("wrong scope accepted: %v", err)
				}
			}
		})
	}
}

func TestRuntimeWorkSessionReportGetChecksEveryLink(t *testing.T) {
	for _, wrong := range []string{"id", "parent-tag", "parent-session", "report-task", "result-session"} {
		t.Run(wrong, func(t *testing.T) {
			mux := http.NewServeMux()
			work := runtimeWorkSession()
			work.ReportTaskId = proto.String("report")
			report := runtimeParentMessage("report")
			report.WorkSessionReportId = proto.String(work.WorkSessionId)
			switch wrong {
			case "id":
				work.WorkSessionId = "work/other"
			case "parent-tag":
				work.ParentTagId = "other"
			case "parent-session":
				work.ParentSessionId = "other"
			case "report-task":
				work.ReportTaskId = proto.String("other")
			}
			testRPC(mux, rpc.WorkSessionsGetProcedure, func(_ context.Context, req *v2.GetWorkSessionRequest) (*v2.WorkSession, error) {
				if req.GetWorkSessionId() != "work/one" {
					t.Errorf("Get request: %v", req)
				}
				return work, nil
			})
			testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
				if req.GetTaskId() != "report" {
					t.Errorf("report request: %v", req)
				}
				task := runtimeParentMessage("report").Task
				task.SessionId = "private-other"
				return task, nil
			})
			c := testRuntime(t, mux, false)
			var err error
			if wrong == "result-session" {
				_, err = c.runtime.projectWork(t.Context(), work, nil)
			} else {
				_, err = c.runtime.projectMessage(t.Context(), report)
			}
			var api *APIError
			if !errors.As(err, &api) || api.Code != connect.CodeDataLoss {
				t.Fatalf("wrong Work Session link accepted: %v", err)
			}
		})
	}
}

func TestRuntimeWorkSessionOnlyMissingServiceMeansNoChildren(t *testing.T) {
	for _, code := range []connect.Code{connect.CodeUnimplemented, connect.CodePermissionDenied, connect.CodeUnavailable} {
		t.Run(code.String(), func(t *testing.T) {
			mux := http.NewServeMux()
			testRPC(mux, rpc.WorkSessionsListProcedure, func(_ context.Context, _ *v2.ListWorkSessionsRequest) (*v2.ListWorkSessionsResponse, error) {
				return nil, connect.NewError(code, errors.New("unavailable test service"))
			})
			c := testRuntime(t, mux, false)
			work, err := c.runtime.messageWorkSessions(t.Context(), runtimeParentMessage("root"))
			if code == connect.CodeUnimplemented {
				if err != nil || len(work) != 0 {
					t.Fatalf("missing service: %v, %v", work, err)
				}
			} else {
				var api *APIError
				if !errors.As(err, &api) || api.Code != code {
					t.Fatalf("failure was hidden: %v", err)
				}
			}
		})
	}
}

func TestRuntimeWorkSessionDetailAndRecordedActivity(t *testing.T) {
	mux := http.NewServeMux()
	work := runtimeWorkSession()
	work.LatestTaskState = v2.TaskState_TASK_STATE_QUEUED
	testRPC(mux, rpc.WorkSessionsGetProcedure, func(_ context.Context, req *v2.GetWorkSessionRequest) (*v2.WorkSession, error) {
		if req.GetWorkSessionId() != "work/one" {
			t.Errorf("detail scope: %v", req)
		}
		return work, nil
	})
	testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
		if req.GetTaskId() != "child" {
			t.Errorf("detail task scope: %v", req)
		}
		return &v2.Task{TaskId: "child", TagId: "lead", SessionId: "work/one", State: v2.TaskState_TASK_STATE_QUEUED}, nil
	})
	testRPC(mux, rpc.OperatorListEventsProcedure, func(_ context.Context, req *v2.ListEventsRequest) (*v2.ListEventsResponse, error) {
		if req.GetTaskId() != "child" || req.GetAfterSequence() != 7 {
			t.Errorf("detail activity scope: %v", req)
		}
		return &v2.ListEventsResponse{Events: []*v2.TaskEvent{{Sequence: 8, Text: "running tests"}, {Sequence: 9, Text: "tests passed"}}}, nil
	})
	c := testRuntime(t, mux, false)
	detail, err := c.GetSession(t.Context(), "work/one")
	if err != nil || detail.GetParentSessionId() != "parent" || detail.GetLatestTaskId() != "child" || detail.GetLatestTaskStatus() != operatorv1.TaskStatus_TASK_STATUS_PENDING {
		t.Fatalf("detail = %v, %v", detail, err)
	}
	activity, after, err := c.TaskActivity(t.Context(), "child", 7)
	if err != nil || after != 9 || len(activity) != 2 || activity[0].Key != "child:8" || activity[1].Line != "tests passed" {
		t.Fatalf("activity = %v, %d, %v", activity, after, err)
	}
	if _, err := c.GetSession(t.Context(), "ordinary-root"); err == nil {
		t.Fatal("ordinary Session detail should remain unsupported")
	}
	if runtimeWork(work).GetStatus() != operatorv1.WorkSessionStatus_WORK_SESSION_STATUS_PENDING {
		t.Fatal("queued child must project as pending")
	}
}

func TestRuntimeWorkSessionQueuedReportPreviewIsNotOperatorText(t *testing.T) {
	mux := http.NewServeMux()
	report := runtimeParentMessage("report")
	report.WorkSessionReportId = proto.String("work/one")
	report.Task.Prompt, report.Task.State = "INTERNAL REPORT INSTRUCTION", v2.TaskState_TASK_STATE_QUEUED
	testRPC(mux, rpc.ConversationsListConversationsProcedure, func(_ context.Context, _ *v2.ListConversationsRequest) (*v2.ListConversationsResponse, error) {
		return &v2.ListConversationsResponse{Conversations: []*v2.Conversation{{TagId: "lead", Name: "default", SessionId: "parent", LatestTask: report.Task}}}, nil
	})
	testRPC(mux, rpc.ConversationsGetMessageProcedure, func(_ context.Context, req *v2.GetMessageRequest) (*v2.ConversationMessage, error) {
		if req.GetTaskId() != "report" || req.GetTagId() != "lead" {
			t.Errorf("preview scope: %v", req)
		}
		return report, nil
	})
	c := testRuntime(t, mux, false)
	conversations, err := c.ListConversations(t.Context(), "lead")
	if err != nil || len(conversations) != 1 || conversations[0].GetLastMessageText() != "Work Session report pending." || conversations[0].GetLastMessageAuthor() != operatorv1.ConversationAuthor_CONVERSATION_AUTHOR_TAG {
		t.Fatalf("preview: %v, %v", conversations, err)
	}
}

func TestRuntimeFailedRootKeepsFollowingUncertainChild(t *testing.T) {
	mux := http.NewServeMux()
	root := runtimeParentMessage("root")
	root.Task.State, root.Task.Result = v2.TaskState_TASK_STATE_FAILED, proto.String("Root failed")
	work := runtimeWorkSession()
	work.LatestTaskState = v2.TaskState_TASK_STATE_UNCERTAIN
	testRPC(mux, rpc.ConversationsGetMessageProcedure, func(_ context.Context, _ *v2.GetMessageRequest) (*v2.ConversationMessage, error) { return root, nil })
	testRPC(mux, rpc.WorkSessionsListProcedure, func(_ context.Context, _ *v2.ListWorkSessionsRequest) (*v2.ListWorkSessionsResponse, error) {
		return &v2.ListWorkSessionsResponse{WorkSessions: []*v2.WorkSession{work}}, nil
	})
	testRPC(mux, rpc.OperatorListEventsProcedure, func(_ context.Context, _ *v2.ListEventsRequest) (*v2.ListEventsResponse, error) {
		return &v2.ListEventsResponse{}, nil
	})
	c := testRuntime(t, mux, false)
	view, err := c.GetMessage(t.Context(), "lead", "root")
	if err != nil {
		t.Fatal(err)
	}
	history := History("lead", []*operatorv1.Message{view})
	if !history[0].Follow {
		t.Fatal("root failure cannot settle an uncertain child")
	}
	follower := testFollower(c)
	follower.WorkTimeout = 5 * time.Millisecond
	events := collect(t, follower.Follow(t.Context(), "lead", view, history[0].Shown))
	if len(events) != 1 || events[0].Kind != EventStillWorking {
		t.Fatalf("uncertain child should stay pending, not fabricate a report: %s", describe(events))
	}
}

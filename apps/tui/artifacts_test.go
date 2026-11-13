package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"connectrpc.com/connect"
	"github.com/atemaguer/supertag/apps/tui/client"
	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func taskFilesApp(t *testing.T) *app {
	t.Helper()
	data := []byte("verified report\n")
	file := &v2.ArtifactFile{Path: "reports/summary.txt", Blob: &v2.BlobReference{Sha256: fmt.Sprintf("%x", sha256.Sum256(data)), ByteLength: uint64(len(data))}}
	mux := http.NewServeMux()
	mux.Handle(rpc.OperatorGetTaskProcedure, connect.NewUnaryHandler(rpc.OperatorGetTaskProcedure,
		func(_ context.Context, req *connect.Request[v2.GetTaskRequest]) (*connect.Response[v2.Task], error) {
			if req.Msg.GetTaskId() != "task-files" {
				return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("private Task"))
			}
			return connect.NewResponse(&v2.Task{TaskId: "task-files", State: v2.TaskState_TASK_STATE_SUCCEEDED, Artifacts: []*v2.ArtifactSelection{{ArtifactId: "capture", Paths: []string{file.Path}}}}), nil
		}))
	mux.Handle(rpc.ArtifactCatalogGetProcedure, connect.NewUnaryHandler(rpc.ArtifactCatalogGetProcedure,
		func(_ context.Context, req *connect.Request[v2.GetCapturedArtifactRequest]) (*connect.Response[v2.CapturedArtifact], error) {
			if req.Msg.GetArtifactId() != "capture" {
				t.Errorf("unexpected capture: %v", req.Msg)
			}
			return connect.NewResponse(&v2.CapturedArtifact{Summary: &v2.ArtifactSummary{ArtifactId: "capture", Description: &v2.ArtifactDescription{Title: "Report"}}, Files: []*v2.ArtifactFile{file}}), nil
		}))
	mux.Handle(rpc.ArtifactTransfersDownloadFileProcedure, connect.NewServerStreamHandler(rpc.ArtifactTransfersDownloadFileProcedure,
		func(_ context.Context, req *connect.Request[v2.DownloadArtifactFileRequest], stream *connect.ServerStream[v2.ArtifactDownload]) error {
			if req.Msg.GetArtifactId() != "capture" || req.Msg.GetPath() != file.Path {
				t.Errorf("unexpected download: %v", req.Msg)
			}
			if err := stream.Send(&v2.ArtifactDownload{Part: &v2.ArtifactDownload_File{File: file}}); err != nil {
				return err
			}
			return stream.Send(&v2.ArtifactDownload{Part: &v2.ArtifactDownload_Chunk{Chunk: data}})
		}))
	handleNegotiation(mux)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == rpc.ProtocolNegotiationNegotiateProcedure {
			mux.ServeHTTP(w, r)
			return
		}
		if r.ProtoMajor != 2 || r.Header.Get("Authorization") != "Bearer fixture-token" {
			t.Errorf("missing scoped gRPC authority")
		}
		mux.ServeHTTP(w, r)
	}))
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	t.Cleanup(server.Close)
	a, err := newApp(t.Context(), dialRuntimeV2("test"), []client.Target{{URL: server.URL, Token: "fixture-token"}, {URL: server.URL, Token: "fixture-token"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.stop)
	a.inner.tags, a.inner.selected = runtimeTestTags(), 0
	a.inner.shown().runtime.head = "task-files"
	a.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	return a
}

// File actions return a bounded Gateway command. Deliver its result directly so
// the fixture never drops a completed RPC while simulating unrelated timers.
func completeTaskFilesAction(t *testing.T, a *app) {
	t.Helper()
	_, command := a.Update(key(tea.KeyEnter))
	if command == nil {
		t.Fatal("Task file action did not start")
	}
	a.Update(command())
}

func TestTaskFilesPaletteSavesSelectedResultWithoutChangingDraft(t *testing.T) {
	a := taskFilesApp(t)
	a.inner.input.SetValue("unfinished operator message")
	pressApp(t, a, ctrlK)
	typeApp(t, a, "Task files")
	completeTaskFilesAction(t, a)
	if s := appScreen(a); !strings.Contains(s, "reports/summary.txt") || !strings.Contains(s, "Report") {
		t.Fatalf("files not shown:\n%s", s)
	}
	pressApp(t, a, key(tea.KeyEnter))
	output := filepath.Join(t.TempDir(), "download.txt")
	a.files.input.SetValue("")
	a.Update(tea.PasteMsg{Content: output})
	completeTaskFilesAction(t, a)
	if s := appScreen(a); !strings.Contains(s, "Saved ") {
		t.Fatalf("download result not shown:\n%s", s)
	}
	data, err := os.ReadFile(output)
	if err != nil || string(data) != "verified report\n" {
		t.Fatalf("download: %q, %v", data, err)
	}
	pressApp(t, a, key(tea.KeyEscape))
	if a.files != nil || a.inner.input.Value() != "unfinished operator message" {
		t.Fatal("dialog changed conversation draft")
	}
}

func TestTaskFilesDialogScopesLateResultsAndCancelsOnSwitch(t *testing.T) {
	a := taskFilesApp(t)
	cmd := a.openTaskFiles()
	old := a.files
	a.closeTaskFiles()
	a.Update(cmd())
	if a.files != nil {
		t.Fatal("late file list reopened the dialog")
	}
	a.inner.shown().runtime.head = ""
	a.openTaskFiles()
	current := a.files
	a.Update(taskFilesMsg{dialog: old, files: []client.TaskFile{{Path: "stale"}}})
	if len(current.files) != 0 {
		t.Fatal("prior dialog populated current dialog")
	}
	ctx, cancel := context.WithCancel(a.inner.ctx)
	current.cancel = cancel
	if err := a.start(1); err != nil {
		t.Fatal(err)
	}
	if a.files != nil || ctx.Err() == nil {
		t.Fatal("switch retained download authority")
	}
	a.Update(taskFileSavedMsg{dialog: current, path: "wrong Gateway"})
	if strings.Contains(appScreen(a), "wrong Gateway") {
		t.Fatal("late save leaked between Gateways")
	}
}

func TestTaskFilesManualTaskAndObjectivePrefill(t *testing.T) {
	a := taskFilesApp(t)
	a.inner.shown().runtime.head = ""
	a.openTaskFiles()
	typeApp(t, a, "private-task")
	completeTaskFilesAction(t, a)
	if s := appScreen(a); !strings.Contains(s, "private Task") {
		t.Fatalf("access failure hidden: %s", s)
	}
	pressApp(t, a, letter('t'))
	a.files.input.SetValue("task-files")
	completeTaskFilesAction(t, a)
	if len(a.files.files) != 1 {
		t.Fatal("manual Task lookup failed")
	}
	a.inner.pane, a.inner.objectiveID = paneObjective, "objective"
	a.inner.objectiveMessages["objective"] = &objectiveMessage{task: "task-files"}
	cmd := a.openTaskFiles()
	a.Update(cmd())
	if a.files.task != "task-files" || len(a.files.files) != 1 {
		t.Fatal("Objective Task files not reachable")
	}
}

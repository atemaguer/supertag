package client

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	rpc "github.com/atemaguer/supertag/rust/bindings/go/runtimev2/runtimev2connect"
)

func TestRuntimeReplyMakesAcceptedTaskFilesDiscoverable(t *testing.T) {
	task := &v2.Task{TaskId: "task-files", State: v2.TaskState_TASK_STATE_SUCCEEDED, Result: proto.String("Report ready."), Artifacts: []*v2.ArtifactSelection{
		{ArtifactId: "capture-report", Paths: []string{"reports/summary.md", "data/results.csv"}},
	}}
	text := runtimeReply(task).GetText()
	for _, want := range []string{"Report ready.", "2 files", "reports/summary.md", "task-files", "Task files"} {
		if !strings.Contains(text, want) {
			t.Errorf("reply omits %q: %q", want, text)
		}
	}
	task.Artifacts = nil
	if text := runtimeReply(task).GetText(); text != "Report ready." {
		t.Fatalf("ordinary reply changed: %q", text)
	}
}

func artifactFixture(t *testing.T, body []byte, stream func(*connect.ServerStream[v2.ArtifactDownload], *v2.ArtifactFile) error) (*Client, TaskFile) {
	t.Helper()
	blob := &v2.BlobReference{Sha256: fmt.Sprintf("%x", sha256.Sum256(body)), ByteLength: uint64(len(body))}
	file := &v2.ArtifactFile{Path: "reports/summary.md", Blob: blob}
	mux := http.NewServeMux()
	testRPC(mux, rpc.OperatorGetTaskProcedure, func(_ context.Context, req *v2.GetTaskRequest) (*v2.Task, error) {
		if req.GetTaskId() != "task-files" {
			return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("private Task"))
		}
		return &v2.Task{TaskId: req.TaskId, State: v2.TaskState_TASK_STATE_SUCCEEDED, Artifacts: []*v2.ArtifactSelection{{ArtifactId: "capture", Paths: []string{file.Path}}}}, nil
	})
	testRPC(mux, rpc.ArtifactCatalogGetProcedure, func(_ context.Context, req *v2.GetCapturedArtifactRequest) (*v2.CapturedArtifact, error) {
		if req.GetArtifactId() != "capture" {
			t.Errorf("artifact ID = %q", req.GetArtifactId())
		}
		return &v2.CapturedArtifact{Summary: &v2.ArtifactSummary{ArtifactId: "capture", Description: &v2.ArtifactDescription{Title: "Engineering report"}}, Files: []*v2.ArtifactFile{file, {Path: "not-selected.txt", Blob: blob}}}, nil
	})
	mux.Handle(rpc.ArtifactTransfersDownloadFileProcedure, connect.NewServerStreamHandler(rpc.ArtifactTransfersDownloadFileProcedure,
		func(_ context.Context, req *connect.Request[v2.DownloadArtifactFileRequest], reply *connect.ServerStream[v2.ArtifactDownload]) error {
			if req.Msg.GetArtifactId() != "capture" || req.Msg.GetPath() != file.Path {
				t.Errorf("download request = %v", req.Msg)
			}
			return stream(reply, file)
		}))
	c := testRuntime(t, mux, false)
	return c, TaskFile{TaskID: "task-files", ArtifactID: "capture", Path: file.Path, SHA256: blob.Sha256, Bytes: blob.ByteLength}
}

func receipt(file *v2.ArtifactFile) *v2.ArtifactDownload {
	return &v2.ArtifactDownload{Part: &v2.ArtifactDownload_File{File: file}}
}

func chunk(body []byte) *v2.ArtifactDownload {
	return &v2.ArtifactDownload{Part: &v2.ArtifactDownload_Chunk{Chunk: body}}
}

func TestRuntimeTaskFilesOnlyOffersAcceptedSelections(t *testing.T) {
	c, _ := artifactFixture(t, []byte("verified report"), nil)
	files, err := c.TaskFiles(context.Background(), "task-files")
	if err != nil || len(files) != 1 || files[0].Path != "reports/summary.md" || files[0].Title != "Engineering report" || files[0].TaskID != "task-files" {
		t.Fatalf("Task files = %v, %v", files, err)
	}
	if _, err := c.TaskFiles(context.Background(), "private-task"); err == nil {
		t.Fatal("private Task became visible")
	}
}

func TestRuntimeArtifactDownloadVerifiesAndDoesNotOverwrite(t *testing.T) {
	for _, body := range [][]byte{[]byte("verified report"), {}} {
		t.Run(fmt.Sprintf("bytes-%d", len(body)), func(t *testing.T) {
			c, selected := artifactFixture(t, body, func(stream *connect.ServerStream[v2.ArtifactDownload], file *v2.ArtifactFile) error {
				if err := stream.Send(receipt(file)); err != nil {
					return err
				}
				if len(body) != 0 {
					return stream.Send(chunk(body))
				}
				return nil
			})
			dir := t.TempDir()
			output := filepath.Join(dir, "saved.md")
			saved, err := c.DownloadTaskFile(context.Background(), selected, output)
			if err != nil || saved != output {
				t.Fatalf("save = %q, %v", saved, err)
			}
			actual, err := os.ReadFile(output)
			if err != nil || string(actual) != string(body) {
				t.Fatalf("downloaded bytes = %q, %v", actual, err)
			}
			if info, err := os.Stat(output); err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("download is not private: %v, %v", info, err)
			}
			if err := os.WriteFile(output, []byte("keep existing file"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := c.DownloadTaskFile(context.Background(), selected, output); err == nil {
				t.Fatal("overwrote destination")
			}
			actual, _ = os.ReadFile(output)
			if string(actual) != "keep existing file" {
				t.Fatalf("existing bytes changed: %q", actual)
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 1 {
				t.Fatalf("staging files leaked: %v", entries)
			}
		})
	}
}

func TestRuntimeArtifactDownloadRejectsCorruptionAndCleansStaging(t *testing.T) {
	for _, mode := range []string{"wrong-path", "wrong-digest", "truncated", "extra-receipt", "oversized-chunk", "lost-authority"} {
		t.Run(mode, func(t *testing.T) {
			body := []byte("verified report")
			c, selected := artifactFixture(t, body, func(stream *connect.ServerStream[v2.ArtifactDownload], file *v2.ArtifactFile) error {
				file = proto.Clone(file).(*v2.ArtifactFile)
				if mode == "wrong-path" {
					file.Path = "other.md"
				}
				if err := stream.Send(receipt(file)); err != nil {
					return err
				}
				switch mode {
				case "wrong-digest":
					return stream.Send(chunk([]byte(strings.Repeat("x", len(body)))))
				case "truncated":
					return stream.Send(chunk(body[:2]))
				case "extra-receipt":
					return stream.Send(receipt(file))
				case "oversized-chunk":
					return stream.Send(chunk(make([]byte, maxArtifactChunkBytes+1)))
				case "lost-authority":
					return connect.NewError(connect.CodePermissionDenied, fmt.Errorf("revoked"))
				default:
					return nil
				}
			})
			dir := t.TempDir()
			if _, err := c.DownloadTaskFile(context.Background(), selected, filepath.Join(dir, "saved.md")); err == nil {
				t.Fatal("accepted invalid download")
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Fatalf("failed download left files: %v", entries)
			}
		})
	}
}

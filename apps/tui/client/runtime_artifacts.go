package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
)

const maxArtifactFileBytes = 32 * 1024 * 1024
const maxArtifactChunkBytes = 256 * 1024

// TaskFile is one exact file accepted as part of a successful Task result.
// The catalog supplies its immutable receipt; download verifies that receipt again.
type TaskFile struct {
	TaskID, ArtifactID, Path, Title, SHA256 string
	Bytes                                   uint64
}

func taskFilesNotice(task *v2.Task) string {
	count := 0
	var names []string
	for _, selection := range task.GetArtifacts() {
		count += len(selection.GetPaths())
		for _, path := range selection.GetPaths() {
			if len(names) < 3 {
				names = append(names, strconv.Quote(path))
			}
		}
	}
	if count == 0 {
		return ""
	}
	label := "files"
	if count == 1 {
		label = "file"
	}
	return fmt.Sprintf("\n\n%d %s: %s\nSave from Ctrl+k → Task files · Task %s", count, label, strings.Join(names, ", "), strconv.Quote(task.GetTaskId()))
}

func artifactDataLoss(text string) error {
	return &APIError{Code: connect.CodeDataLoss, Message: text}
}

func validArtifactPath(path string) bool {
	if len(path) > 1024 || strings.ContainsAny(path, "\\:") || strings.ContainsFunc(path, unicode.IsControl) {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") || strings.EqualFold(part, ".supertag") {
			return false
		}
	}
	return true
}

func validArtifactBlob(blob *v2.BlobReference) bool {
	if blob == nil || blob.GetByteLength() > maxArtifactFileBytes || len(blob.GetSha256()) != 64 || strings.ToLower(blob.GetSha256()) != blob.GetSha256() {
		return false
	}
	_, err := hex.DecodeString(blob.GetSha256())
	return err == nil
}

// TaskFiles reads result selections through the operator API. Other files in a
// capture are not offered simply because the Task selected one of its files.
func (c *Client) TaskFiles(ctx context.Context, taskID string) ([]TaskFile, error) {
	if !c.RuntimeV2() {
		return nil, unavailable("Task file downloads")
	}
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.operator.GetTask(ctx, connect.NewRequest(&v2.GetTaskRequest{TaskId: taskID}))
	if err != nil {
		return nil, apiError(err)
	}
	task := res.Msg
	if taskID == "" || task.GetTaskId() != taskID || len(task.GetArtifacts()) > 100 {
		return nil, artifactDataLoss("Gateway returned a different Task or invalid file selections.")
	}
	if task.GetState() != v2.TaskState_TASK_STATE_SUCCEEDED {
		return nil, nil
	}
	seen := map[string]bool{}
	var result []TaskFile
	for _, selection := range task.GetArtifacts() {
		id := selection.GetArtifactId()
		if id == "" || seen[id] || len(selection.GetPaths()) == 0 || len(selection.GetPaths()) > 100 {
			return nil, artifactDataLoss("Gateway returned invalid Task file selections.")
		}
		seen[id] = true
		res, err := c.runtime.artifacts.Get(ctx, connect.NewRequest(&v2.GetCapturedArtifactRequest{ArtifactId: id}))
		if err != nil {
			return nil, apiError(err)
		}
		capture := res.Msg
		if capture.GetSummary().GetArtifactId() != id || len(capture.GetFiles()) > 100 {
			return nil, artifactDataLoss("Gateway returned a different artifact.")
		}
		files := map[string]*v2.ArtifactFile{}
		for _, file := range capture.GetFiles() {
			if !validArtifactPath(file.GetPath()) || !validArtifactBlob(file.GetBlob()) || files[file.GetPath()] != nil {
				return nil, artifactDataLoss("Gateway returned an invalid artifact manifest.")
			}
			files[file.GetPath()] = file
		}
		selected := map[string]bool{}
		for _, path := range selection.GetPaths() {
			file := files[path]
			if file == nil || selected[path] {
				return nil, artifactDataLoss("A selected Task file is absent or duplicated in its artifact.")
			}
			selected[path] = true
			result = append(result, TaskFile{TaskID: taskID, ArtifactID: id, Path: path,
				Title: capture.GetSummary().GetDescription().GetTitle(), SHA256: file.GetBlob().GetSha256(), Bytes: file.GetBlob().GetByteLength()})
		}
	}
	return result, nil
}

// DownloadTaskFile reauthorizes through the selected Gateway, verifies the exact
// chosen receipt, and publishes with an exclusive link so no existing file is replaced.
func (c *Client) DownloadTaskFile(ctx context.Context, selected TaskFile, output string) (string, error) {
	if !c.RuntimeV2() {
		return "", unavailable("Task file downloads")
	}
	if selected.ArtifactID == "" || !validArtifactPath(selected.Path) || !validArtifactBlob(&v2.BlobReference{Sha256: selected.SHA256, ByteLength: selected.Bytes}) || strings.TrimSpace(output) == "" {
		return "", errors.New("Choose a Task file and a local destination.")
	}
	output, err := filepath.Abs(output)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 65*time.Second)
	defer cancel()
	stream, err := c.runtime.artifactFiles.DownloadFile(ctx, connect.NewRequest(&v2.DownloadArtifactFileRequest{ArtifactId: selected.ArtifactID, Path: selected.Path}))
	if err != nil {
		return "", apiError(err)
	}
	defer stream.Close()
	if !stream.Receive() {
		if err := stream.Err(); err != nil {
			return "", apiError(err)
		}
		return "", artifactDataLoss("Artifact download did not include a file receipt.")
	}
	file := stream.Msg().GetFile()
	if file.GetPath() != selected.Path || !validArtifactBlob(file.GetBlob()) || file.GetBlob().GetSha256() != selected.SHA256 || file.GetBlob().GetByteLength() != selected.Bytes {
		return "", artifactDataLoss("Artifact download differs from the selected file receipt.")
	}
	staged, err := os.CreateTemp(filepath.Dir(output), ".supertag-download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(staged.Name())
	defer staged.Close()
	hash, size := sha256.New(), uint64(0)
	for stream.Receive() {
		chunk, ok := stream.Msg().GetPart().(*v2.ArtifactDownload_Chunk)
		if !ok || len(chunk.Chunk) == 0 || len(chunk.Chunk) > maxArtifactChunkBytes || uint64(len(chunk.Chunk)) > selected.Bytes-size {
			return "", artifactDataLoss("Artifact download exceeds its receipt or contains an invalid record.")
		}
		size += uint64(len(chunk.Chunk))
		hash.Write(chunk.Chunk)
		if _, err := staged.Write(chunk.Chunk); err != nil {
			return "", err
		}
	}
	if err := stream.Err(); err != nil {
		return "", apiError(err)
	}
	if size != selected.Bytes || hex.EncodeToString(hash.Sum(nil)) != selected.SHA256 {
		return "", artifactDataLoss("Artifact download failed its length or SHA-256 check.")
	}
	if err := staged.Sync(); err != nil {
		return "", err
	}
	if err := staged.Close(); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := os.Link(staged.Name(), output); err != nil {
		return "", fmt.Errorf("save Task file without replacing an existing file: %w", err)
	}
	if err := os.Remove(staged.Name()); err != nil {
		return "", err
	}
	directory, err := os.Open(filepath.Dir(output))
	if err != nil {
		return "", err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return "", err
	}
	return output, nil
}

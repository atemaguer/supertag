package client

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// ErrDone is returned by SSEReader.Next after the stream's "[DONE]" event.
var ErrDone = errors.New("stream done")

// Event is one Server-Sent Event.
type Event struct {
	ID   string
	Data string
}

// Part is one AI SDK UI message stream part.
type Part struct {
	Type            string          `json:"type"`
	Delta           string          `json:"delta,omitempty"`
	Data            json.RawMessage `json:"data,omitempty"`
	ErrorText       string          `json:"errorText,omitempty"`
	MessageMetadata *struct {
		Reply *Reply `json:"reply,omitempty"`
	} `json:"messageMetadata,omitempty"`
}

// SSEReader reads Server-Sent Events: data lines join with newlines, comment lines are skipped,
// and each dispatched event sets the last event id, for resuming.
type SSEReader struct {
	body  io.ReadCloser
	lines *bufio.Scanner
	// idBuffer is the id field seen so far; it becomes lastID only when its event is dispatched,
	// so a connection lost mid-event resumes at that event, not after it.
	idBuffer, lastID string
}

// NewSSEReader reads events from body.
func NewSSEReader(body io.ReadCloser) *SSEReader {
	lines := bufio.NewScanner(body)
	lines.Buffer(make([]byte, 64*1024), 16*1024*1024)
	return &SSEReader{body: body, lines: lines}
}

// LastID is the id of the last event dispatched, to resume from.
func (r *SSEReader) LastID() string { return r.lastID }

// Close stops reading.
func (r *SSEReader) Close() error { return r.body.Close() }

// Next returns the next event with data. It returns ErrDone after "[DONE]" and io.EOF when the
// stream ends without it.
func (r *SSEReader) Next() (Event, error) {
	var data []string
	hasData := false
	for r.lines.Scan() {
		line := strings.TrimSuffix(r.lines.Text(), "\r")
		if line == "" {
			r.lastID = r.idBuffer
			if !hasData {
				continue
			}
			event := Event{ID: r.lastID, Data: strings.Join(data, "\n")}
			if event.Data == "[DONE]" {
				return event, ErrDone
			}
			return event, nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "data":
			data = append(data, value)
			hasData = true
		case "id":
			if !strings.ContainsRune(value, 0) {
				r.idBuffer = value
			}
		}
	}
	if err := r.lines.Err(); err != nil {
		return Event{}, err
	}
	// A final event without its blank line still counts when the stream ended cleanly.
	if hasData {
		r.lastID = r.idBuffer
		event := Event{ID: r.lastID, Data: strings.Join(data, "\n")}
		if event.Data == "[DONE]" {
			return event, ErrDone
		}
		return event, nil
	}
	return Event{}, io.EOF
}

// NextPart returns the next event that is a stream part; events that are not one are skipped.
func (r *SSEReader) NextPart() (Part, error) {
	for {
		event, err := r.Next()
		if err != nil {
			return Part{}, err
		}
		var part Part
		if json.Unmarshal([]byte(event.Data), &part) == nil && part.Type != "" {
			return part, nil
		}
	}
}

// ActivityLine is the short line for a data-activity part, or "" for one not shown: a command or
// tool the Tag starts, or a retry.
func ActivityLine(data json.RawMessage) string {
	var activity struct {
		Kind    string          `json:"kind"`
		Status  string          `json:"status"`
		Command *string         `json:"command"`
		Tool    *string         `json:"tool"`
		Attempt json.RawMessage `json:"attempt"`
	}
	if json.Unmarshal(data, &activity) != nil {
		return ""
	}
	if activity.Kind == "retry" {
		return "· retrying (Task Attempt " + strings.Trim(string(activity.Attempt), `"`) + ")"
	}
	if activity.Status != "running" {
		return ""
	}
	if activity.Kind == "command" && activity.Command != nil {
		return "· running: " + *activity.Command
	}
	if activity.Kind == "tool" && activity.Tool != nil {
		return "· using: " + *activity.Tool
	}
	return ""
}

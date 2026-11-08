package client

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func reader(s string) *SSEReader { return NewSSEReader(io.NopCloser(strings.NewReader(s))) }

func TestSSEReaderEvents(t *testing.T) {
	r := reader(": keepalive\n\n" +
		"id: 1\ndata: {\"type\":\"text-start\"}\n\n" +
		"id: 2\r\ndata:first\r\ndata: second\r\n\r\n" +
		"event: ignored\ndata: third\n\n" +
		"data: [DONE]\n\n")
	want := []Event{{ID: "1", Data: `{"type":"text-start"}`}, {ID: "2", Data: "first\nsecond"}, {ID: "2", Data: "third"}}
	for _, w := range want {
		got, err := r.Next()
		if err != nil || got != w {
			t.Fatalf("Next() = %+v, %v; want %+v", got, err, w)
		}
	}
	if _, err := r.Next(); !errors.Is(err, ErrDone) {
		t.Fatalf("want ErrDone, got %v", err)
	}
	if r.LastID() != "2" {
		t.Fatalf("LastID = %q", r.LastID())
	}
}

func TestSSEReaderEndsWithoutDone(t *testing.T) {
	r := reader("data: tail")
	if got, err := r.Next(); err != nil || got.Data != "tail" {
		t.Fatalf("Next() = %+v, %v", got, err)
	}
	if _, err := r.Next(); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestNextPartSkipsNonParts(t *testing.T) {
	r := reader("data: not json\n\ndata: {\"x\":1}\n\n" +
		"data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"Hi\"}\n\n" +
		"data: {\"type\":\"finish\",\"messageMetadata\":{\"reply\":{\"presentation\":\"markdown\",\"text\":\"**Hi**\"}}}\n\n")
	part, err := r.NextPart()
	if err != nil || part.Type != "text-delta" || part.Delta != "Hi" {
		t.Fatalf("NextPart() = %+v, %v", part, err)
	}
	part, err = r.NextPart()
	if err != nil || part.Type != "finish" || part.MessageMetadata.Reply.Text != "**Hi**" {
		t.Fatalf("NextPart() = %+v, %v", part, err)
	}
}

func TestActivityLine(t *testing.T) {
	cases := map[string]string{
		`{"kind":"command","status":"running","command":"go test ./..."}`: "· running: go test ./...",
		`{"kind":"tool","status":"running","tool":"notes.search"}`:        "· using: notes.search",
		`{"kind":"retry","attempt":2}`:                                    "· retrying (Task Attempt 2)",
		`{"kind":"command","status":"completed","command":"ls"}`:          "",
		`"nope"`: "",
	}
	for data, want := range cases {
		if got := ActivityLine(json.RawMessage(data)); got != want {
			t.Errorf("ActivityLine(%s) = %q; want %q", data, got, want)
		}
	}
}

// failingBody returns its data, then a read error, like a connection reset mid-event.
type failingBody struct{ data *strings.Reader }

func (b failingBody) Read(p []byte) (int, error) {
	if b.data.Len() == 0 {
		return 0, errors.New("connection reset")
	}
	return b.data.Read(p)
}
func (failingBody) Close() error { return nil }

func TestSSEReaderSetsTheLastIDOnDispatch(t *testing.T) {
	r := NewSSEReader(failingBody{strings.NewReader("id: 40\ndata: {\"type\":\"text-start\"}\n\nid: 41\n")})
	if got, err := r.Next(); err != nil || got.ID != "40" {
		t.Fatalf("Next() = %+v, %v", got, err)
	}
	if _, err := r.Next(); err == nil {
		t.Fatal("want the read error")
	}
	if r.LastID() != "40" {
		t.Fatalf("LastID = %q; part 41 was never dispatched, so resume must replay it", r.LastID())
	}
}

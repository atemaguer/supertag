package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	c, err := New(Target{URL: server.URL + "/", Token: "secret", Name: "local"}, "0.0.0-test")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func requireAuth(t *testing.T, r *http.Request) {
	t.Helper()
	if got := r.Header.Get("authorization"); got != "Bearer secret" {
		t.Errorf("%s %s authorization = %q", r.Method, r.URL.Path, got)
	}
}

func TestListTags(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requireAuth(t, r)
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/tags" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"kind":"ResourceList","items":[{"kind":"Tag","metadata":{"name":"lead"},"status":{"phase":"active"}}]}`))
	})
	tags, err := c.ListTags(context.Background())
	if err != nil || len(tags) != 1 || tags[0].Name() != "lead" || tags[0].Status.Phase != "active" {
		t.Fatalf("ListTags() = %+v, %v", tags, err)
	}
}

func TestSendMessage(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requireAuth(t, r)
		if r.Method != http.MethodPost || r.URL.EscapedPath() != "/api/v1/tags/a%2Fb/messages" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.EscapedPath())
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if len(body) != 2 || body["text"] != "hello" || body["session"] != "default" {
			t.Errorf("body = %v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"kind":"TagMessage","tag":"a/b","session":"default","sessionId":"s","taskId":"t1","status":"waiting","waiting":"no bound Worker Host"}`))
	})
	record, err := c.SendMessage(context.Background(), "a/b", "hello", "default")
	if err != nil || record.TaskID != "t1" || record.Status != "waiting" || record.Waiting != "no bound Worker Host" {
		t.Fatalf("SendMessage() = %+v, %v", record, err)
	}
}

func TestGetMessageAndErrors(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requireAuth(t, r)
		switch r.URL.Path {
		case "/api/v1/tags/lead/messages/t1":
			_, _ = w.Write([]byte(`{"taskId":"t1","status":"replied","reply":{"presentation":"markdown","text":"done"},"startedSessions":[{"id":"s1","title":"Fix","taskId":"w1","status":"running","reportStatus":"waiting"}]}`))
		case "/api/v1/tags/lead/messages/missing":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not_found","message":"Message missing was not found"}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
		}
	})
	record, err := c.GetMessage(context.Background(), "lead", "t1")
	if err != nil || record.Reply.Text != "done" || record.StartedSessions[0].TaskID != "w1" {
		t.Fatalf("GetMessage() = %+v, %v", record, err)
	}
	var apiErr *APIError
	if _, err := c.GetMessage(context.Background(), "lead", "missing"); !errors.As(err, &apiErr) || apiErr.Message != "Message missing was not found" {
		t.Fatalf("want the message sentence, got %v", err)
	}
	if _, err := c.ListTags(context.Background()); err == nil || err.Error() != "Control Plane returned HTTP 401" {
		t.Fatalf("want the HTTP status, got %v", err)
	}
}

func TestStreamResumes(t *testing.T) {
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		requireAuth(t, r)
		if r.URL.Path != "/api/v1/tags/lead/messages/t1/stream" || r.Header.Get("accept") != "text/event-stream" {
			t.Errorf("unexpected %s accept=%q", r.URL.Path, r.Header.Get("accept"))
		}
		if got := r.Header.Get("last-event-id"); got != "7" {
			t.Errorf("last-event-id = %q", got)
		}
		_, _ = w.Write([]byte("id: 8\ndata: {\"type\":\"finish\"}\n\n"))
	})
	stream, err := c.Stream(context.Background(), "lead", "t1", "7")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if part, err := stream.NextPart(); err != nil || part.Type != "finish" || stream.LastID() != "8" {
		t.Fatalf("NextPart() = %+v, %v", part, err)
	}
}

func TestNewRejectsBadURL(t *testing.T) {
	if _, err := New(Target{URL: "ftp://x", Token: "t"}, ""); err == nil {
		t.Fatal("want an error")
	}
}

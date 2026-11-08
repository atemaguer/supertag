// Package client talks to a SuperTag Control Plane over its HTTP API: typed calls for the Tag
// conversation routes, a reader for their Server-Sent Events reply streams, and a follower that
// turns one message's turn into the events a terminal UI shows.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Target names the Control Plane to talk to and the token to talk to it with.
type Target struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	Name  string `json:"name,omitempty"`
}

// Tag is the part of a Tag resource the UI shows.
type Tag struct {
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Status struct {
		Phase string `json:"phase"`
	} `json:"status"`
}

// Name is the Tag's name.
func (t Tag) Name() string { return t.Metadata.Name }

// Reply is a Tag's reply or a work Session's report.
type Reply struct {
	Presentation string `json:"presentation"`
	Text         string `json:"text"`
}

// Approval is a notice for one of a work Session's pending approval requests.
type Approval struct {
	RequestID string `json:"requestId"`
	Text      string `json:"text"`
}

// StartedSession is a work Session a message's turn started or continued.
type StartedSession struct {
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	TaskID       string     `json:"taskId,omitempty"`
	Status       string     `json:"status"`
	Question     string     `json:"question,omitempty"`
	Approvals    []Approval `json:"approvals,omitempty"`
	NotContinued string     `json:"notContinued,omitempty"`
	ReportStatus string     `json:"reportStatus"`
	Report       *Reply     `json:"report,omitempty"`
}

// MessageRecord is one message in a conversation, as the messages routes return it.
type MessageRecord struct {
	Tag       string `json:"tag"`
	Session   string `json:"session"`
	SessionID string `json:"sessionId"`
	TaskID    string `json:"taskId"`
	// JoinedTaskID is the running Task this message was delivered into, once it was.
	JoinedTaskID    string           `json:"joinedTaskId,omitempty"`
	Status          string           `json:"status"`
	Waiting         string           `json:"waiting,omitempty"`
	Reply           *Reply           `json:"reply,omitempty"`
	StartedSessions []StartedSession `json:"startedSessions,omitempty"`
}

// APIError is a request the Control Plane refused.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return e.Message }

// Client calls one Control Plane.
type Client struct {
	target  Target
	base    *url.URL
	version string
	http    *http.Client
}

// New returns a client for target; version is sent as the client version.
func New(target Target, version string) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(target.URL, "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, fmt.Errorf("invalid Control Plane URL %q", target.URL)
	}
	return &Client{
		target:  target,
		base:    base,
		version: version,
		http: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("the Control Plane redirected; requests must stay on the configured origin")
		}},
	}, nil
}

// Target is the Control Plane this client calls.
func (c *Client) Target() Target { return c.target }

// ListTags returns the organization's Tags.
func (c *Client) ListTags(ctx context.Context) ([]Tag, error) {
	var list struct {
		Items []Tag `json:"items"`
	}
	err := c.do(ctx, http.MethodGet, "/api/v1/tags", nil, &list)
	return list.Items, err
}

// SendMessage sends text to the Tag in the named conversation.
func (c *Client) SendMessage(ctx context.Context, tag, text, session string) (MessageRecord, error) {
	var record MessageRecord
	body := map[string]string{"text": text, "session": session}
	err := c.do(ctx, http.MethodPost, messagesPath(tag), body, &record)
	return record, err
}

// GetMessage rereads one message: its reply and the work Sessions its turn started.
func (c *Client) GetMessage(ctx context.Context, tag, taskID string) (MessageRecord, error) {
	var record MessageRecord
	err := c.do(ctx, http.MethodGet, messagesPath(tag)+"/"+url.PathEscape(taskID), nil, &record)
	return record, err
}

// Stream opens one message's reply stream, resuming after lastEventID when it is set. Close the
// returned reader to stop following.
func (c *Client) Stream(ctx context.Context, tag, taskID, lastEventID string) (*SSEReader, error) {
	req, err := c.newRequest(ctx, http.MethodGet, messagesPath(tag)+"/"+url.PathEscape(taskID)+"/stream", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "text/event-stream")
	if lastEventID != "" {
		req.Header.Set("last-event-id", lastEventID)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		return nil, responseError(res)
	}
	return NewSSEReader(res.Body), nil
}

func messagesPath(tag string) string {
	return "/api/v1/tags/" + url.PathEscape(tag) + "/messages"
}

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base.String()+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+c.target.Token)
	req.Header.Set("content-type", "application/json")
	if c.version != "" {
		req.Header.Set("SuperTag-Client-Version", c.version)
	}
	return req, nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return responseError(res)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("reading %s %s: %w", method, path, err)
	}
	return nil
}

// responseError reads the refusal's sentence the way the CLI does: `message`, else an `error`
// that is a sentence, else the HTTP status.
func responseError(res *http.Response) error {
	var body struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body)
	message := body.Message
	if message == "" && strings.ContainsAny(body.Error, " \t\n") {
		message = body.Error
	}
	if message == "" {
		message = fmt.Sprintf("Control Plane returned HTTP %d", res.StatusCode)
	}
	return &APIError{Status: res.StatusCode, Message: message}
}

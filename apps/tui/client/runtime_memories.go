package client

import (
	"context"
	"time"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// Note is one of a Tag's notes: something it keeps of what it cannot look up again.
type Note struct {
	ID, Tag, Text string
	// Private says only the person whose conversation wrote it sees it.
	Private bool
	// Kept is when it was written or last rewritten; LastSeen when a turn last had it in its
	// context, zero until one has.
	Kept, LastSeen time.Time
}

func noteView(memory *v2.Memory) Note {
	note := Note{ID: memory.GetMemoryId(), Tag: memory.GetTagId(), Text: memory.GetText(),
		Private: memory.Audience != nil, Kept: time.UnixMilli(max(memory.GetUpdatedAtMs(), memory.GetCreatedAtMs()))}
	if memory.LastSeenAtMs != nil {
		note.LastSeen = time.UnixMilli(memory.GetLastSeenAtMs())
	}
	return note
}

// Notes lists the Tag's notes the caller sees, newest first.
func (c *Client) Notes(ctx context.Context, tag string) ([]Note, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.memories.List(ctx, connect.NewRequest(&v2.ListMemoriesRequest{TagId: &tag}))
	if err != nil {
		return nil, apiError(err)
	}
	var out []Note
	for _, memory := range res.Msg.GetMemories() {
		if memory.GetTagId() != tag {
			return nil, &APIError{Code: connect.CodeDataLoss, Message: "Control Plane returned another Tag's note."}
		}
		out = append(out, noteView(memory))
	}
	return out, nil
}

// DeleteNote deletes a note at once; the Tag no longer sees it from its next turn.
func (c *Client) DeleteNote(ctx context.Context, id string) (Note, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.memories.Delete(ctx, connect.NewRequest(&v2.GetMemoryRequest{MemoryId: id}))
	if err != nil {
		return Note{}, apiError(err)
	}
	return noteView(res.Msg), nil
}

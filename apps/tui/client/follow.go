package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// EventKind says what a FollowEvent shows.
type EventKind int

const (
	// EventWaiting says why the turn has not started (Text), once per reason.
	EventWaiting EventKind = iota
	// EventDelta is reply text as the Tag writes it (Text). The final reply replaces it.
	EventDelta
	// EventActivity is a command or tool the Tag or a work Session (Title) starts (Text).
	EventActivity
	// EventReply is the Tag's final reply (Reply).
	EventReply
	// EventWorking says a work Session (Title) is working.
	EventWorking
	// EventReport is a work Session's (Title) report (Text); Status is "done", "waiting on you",
	// "waiting for approval", "failed" or "stopped".
	EventReport
	// EventApproval is a work Session's (Title) approval request notice (Text).
	EventApproval
	// EventNotContinued says why a decision did not continue a work Session (Title, Text).
	EventNotContinued
	// EventStillWorking says following stopped while work Sessions still run (Text).
	EventStillWorking
	// EventJoined says the message was delivered into a turn already being followed, which shows
	// its reply and work; this follow shows nothing more.
	EventJoined
	// EventError ends the follow with a failure (Text).
	EventError
)

// FollowEvent is one thing to show while following a message.
type FollowEvent struct {
	Kind   EventKind
	Title  string
	Status string
	Text   string
	Reply  *Reply
	// Indent marks activity of a work Session, shown under its "working" line.
	Indent bool
	// Discard, on EventJoined, drops the reply text this follow streamed: it repeated the turn
	// it joined.
	Discard bool
}

// Follower follows a message's turn the way `supertag message tag` does on a terminal.
type Follower struct {
	Client *Client
	// Interval is how often records are reread; ReplyTimeout is how long a reply stream may go
	// without a part; WorkTimeout is how long work Sessions are followed.
	Interval, ReplyTimeout, WorkTimeout time.Duration

	turnsMu sync.Mutex
	turns   map[string]*tagTurns
}

// tagTurns is what one Tag's follows share, so a message joined into a running turn is not
// shown twice: the turns whose reply is still being followed, and every Task a follow showed,
// with the message whose follow showed it.
type tagTurns struct {
	replying map[string]chan struct{}
	shown    map[string]string
}

// NewFollower returns a follower with the CLI's fixed timings.
func NewFollower(c *Client) *Follower {
	return &Follower{Client: c, Interval: time.Second, ReplyTimeout: 10 * time.Minute, WorkTimeout: time.Hour}
}

// Follow streams the turn's reply, then follows each work Session it started until it reports.
// The channel closes when there is nothing more to follow or ctx ends.
func (f *Follower) Follow(ctx context.Context, tag string, record MessageRecord) <-chan FollowEvent {
	events := make(chan FollowEvent, 16)
	emit := func(event FollowEvent) {
		select {
		case events <- event:
		case <-ctx.Done():
		}
	}
	go func() {
		defer close(events)
		if err := f.follow(ctx, tag, record, emit); err != nil && ctx.Err() == nil {
			emit(FollowEvent{Kind: EventError, Text: err.Error()})
		}
	}()
	return events
}

func (f *Follower) follow(ctx context.Context, tag string, record MessageRecord, emit func(FollowEvent)) error {
	others, replied := f.beginTurn(tag, record.TaskID)
	defer replied()
	if record.Status != "replied" && len(others) > 0 {
		// A message sent while another of this Tag's turns still replies may be delivered into
		// that turn, whose follow already shows the reply and its work.
		var joined bool
		record, joined = f.awaitJoin(ctx, tag, record, others)
		if joined {
			emit(FollowEvent{Kind: EventJoined})
			return nil
		}
	}
	var mu sync.Mutex
	shownWaiting := map[string]bool{}
	showWaiting := func(current MessageRecord) {
		mu.Lock()
		defer mu.Unlock()
		if current.Waiting == "" || shownWaiting[current.Waiting] {
			return
		}
		shownWaiting[current.Waiting] = true
		emit(FollowEvent{Kind: EventWaiting, Text: current.Waiting})
	}
	showWaiting(record)

	var streamed *Reply
	if record.Status != "replied" {
		// Until the reply stream sends its first part, reread the message to say why the turn
		// has not started.
		startedCtx, started := context.WithCancel(ctx)
		var watching sync.WaitGroup
		watching.Go(func() {
			for pause(startedCtx, f.Interval) {
				current, err := f.Client.GetMessage(startedCtx, tag, record.TaskID)
				if startedCtx.Err() != nil {
					return
				}
				if err == nil {
					f.noteShown(tag, record.TaskID, current)
					showWaiting(current)
					if current.Status == "replied" {
						return
					}
				}
			}
		})
		reply, ended, err := f.streamReply(ctx, tag, record.TaskID, streamOptions{deltas: true, onPart: started}, emit)
		started()
		watching.Wait()
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		if ended == endedIdle {
			return fmt.Errorf("Tag %s has not replied yet; it keeps working on task/%s", tag, record.TaskID)
		}
		streamed = reply
	}
	reply := record.Reply
	if reply == nil {
		reply = streamed
	}
	if reply == nil {
		replied, err := f.poll(ctx, tag, record)
		if err != nil || replied.Reply == nil {
			return err
		}
		reply = replied.Reply
	}
	current, err := f.reread(ctx, tag, record.TaskID, time.Now().Add(f.WorkTimeout))
	if err != nil || ctx.Err() != nil {
		return err
	}
	if f.joinedShown(tag, current) {
		emit(FollowEvent{Kind: EventJoined, Discard: streamed != nil || record.Status != "replied"})
		return nil
	}
	f.noteShown(tag, record.TaskID, current)
	if reply.Presentation == "error" {
		return fmt.Errorf("Tag %s could not answer: %s", tag, reply.Text)
	}
	emit(FollowEvent{Kind: EventReply, Reply: reply})
	replied()
	return f.followWork(ctx, tag, current, emit)
}

// beginTurn records a follow of message taskID; others are the Tag's other turns still replying,
// each closed when its reply is shown. Call replied once this follow's reply is shown or it ends.
func (f *Follower) beginTurn(tag, taskID string) (others []chan struct{}, replied func()) {
	f.turnsMu.Lock()
	defer f.turnsMu.Unlock()
	if f.turns == nil {
		f.turns = map[string]*tagTurns{}
	}
	turns := f.turns[tag]
	if turns == nil {
		turns = &tagTurns{replying: map[string]chan struct{}{}, shown: map[string]string{}}
		f.turns[tag] = turns
	}
	for id, done := range turns.replying {
		if id != taskID {
			others = append(others, done)
		}
	}
	done := make(chan struct{})
	turns.replying[taskID] = done
	turns.shown[taskID] = taskID
	var once sync.Once
	return others, func() {
		once.Do(func() {
			f.turnsMu.Lock()
			defer f.turnsMu.Unlock()
			if turns.replying[taskID] == done {
				delete(turns.replying, taskID)
			}
			close(done)
		})
	}
}

// noteShown records that the follow of message taskID shows the Task its message joined.
func (f *Follower) noteShown(tag, taskID string, current MessageRecord) {
	if current.JoinedTaskID == "" {
		return
	}
	f.turnsMu.Lock()
	defer f.turnsMu.Unlock()
	if turns := f.turns[tag]; turns != nil {
		if _, ok := turns.shown[current.JoinedTaskID]; !ok {
			turns.shown[current.JoinedTaskID] = taskID
		}
	}
}

// joinedShown reports whether current joined a Task another message's follow shows.
func (f *Follower) joinedShown(tag string, current MessageRecord) bool {
	if current.JoinedTaskID == "" {
		return false
	}
	f.turnsMu.Lock()
	defer f.turnsMu.Unlock()
	turns := f.turns[tag]
	if turns == nil {
		return false
	}
	owner, ok := turns.shown[current.JoinedTaskID]
	return ok && owner != current.TaskID
}

// awaitJoin rereads the message until it joined a turn another follow shows, or the other
// turns' replies are shown and one more reread says it did not.
func (f *Follower) awaitJoin(ctx context.Context, tag string, record MessageRecord, others []chan struct{}) (MessageRecord, bool) {
	settled := false
	for {
		if f.joinedShown(tag, record) {
			return record, true
		}
		if settled || !pause(ctx, f.Interval) {
			return record, false
		}
		settled = allClosed(others)
		if current, err := f.Client.GetMessage(ctx, tag, record.TaskID); err == nil {
			record = current
		}
	}
}

func allClosed(chans []chan struct{}) bool {
	for _, c := range chans {
		select {
		case <-c:
		default:
			return false
		}
	}
	return true
}

// transient reports whether a failed request is worth retrying: the Control Plane could not be
// reached, or it failed rather than refused.
func transient(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status >= 500 || apiErr.Status == 429
	}
	return true
}

// reread rereads the message, retrying while the Control Plane is unreachable until deadline.
func (f *Follower) reread(ctx context.Context, tag, taskID string, deadline time.Time) (MessageRecord, error) {
	for {
		current, err := f.Client.GetMessage(ctx, tag, taskID)
		if err == nil || ctx.Err() != nil || !transient(err) || time.Now().After(deadline) {
			return current, err
		}
		if !pause(ctx, f.Interval) {
			return current, nil
		}
	}
}

// poll rereads the message until it has a reply.
func (f *Follower) poll(ctx context.Context, tag string, record MessageRecord) (MessageRecord, error) {
	deadline := time.Now().Add(f.ReplyTimeout)
	current := record
	for current.Status != "replied" {
		if time.Now().After(deadline) {
			return current, fmt.Errorf("Tag %s has not replied yet; it keeps working on task/%s", tag, record.TaskID)
		}
		if !pause(ctx, f.Interval) {
			return current, nil
		}
		// A Control Plane that is briefly unreachable, say while it restarts, is reread later.
		next, err := f.Client.GetMessage(ctx, tag, record.TaskID)
		if err != nil && !transient(err) {
			return next, err
		}
		if err == nil {
			current = next
		}
	}
	return current, nil
}

// followWork follows the work Sessions a turn started: a line per Session, their activity, and
// each report as it arrives.
func (f *Follower) followWork(ctx context.Context, tag string, record MessageRecord, emit func(FollowEvent)) error {
	if len(record.StartedSessions) == 0 {
		return nil
	}
	followCtx, stop := context.WithCancel(ctx)
	var activity sync.WaitGroup
	defer func() {
		stop()
		activity.Wait()
	}()
	// Each work Session's Task being followed. A decision on its approval request continues the
	// Session as its next Task, which shows "working" again and then its own report.
	followed := map[string]string{}
	shown := map[string]bool{}
	follow := func(session StartedSession, count int) {
		previous, known := followed[session.ID]
		if known && previous == session.TaskID {
			return
		}
		followed[session.ID] = session.TaskID
		// A Session that had no Task yet is still the same piece of work.
		if !known || previous != "" {
			emit(FollowEvent{Kind: EventWorking, Title: session.Title})
		}
		if session.TaskID == "" || session.ReportStatus == "replied" {
			return
		}
		opts := streamOptions{indent: true}
		if count > 1 {
			opts.title = session.Title
		}
		activity.Go(func() {
			_, _, _ = f.streamReply(followCtx, tag, session.TaskID, opts, emit)
		})
	}
	onRecord := func(current MessageRecord) {
		for _, session := range current.StartedSessions {
			follow(session, len(current.StartedSessions))
		}
		for _, session := range current.StartedSessions {
			for _, approval := range session.Approvals {
				if key := "approval:" + approval.RequestID; !shown[key] {
					shown[key] = true
					emit(FollowEvent{Kind: EventApproval, Title: session.Title, Text: approval.Text})
				}
			}
			key := "report:" + session.TaskID
			if session.TaskID == "" {
				key = "report:" + session.ID
			}
			if session.Report == nil || shown[key] {
				continue
			}
			shown[key] = true
			emit(FollowEvent{Kind: EventReport, Title: session.Title, Status: reportEnding(session), Text: session.Report.Text})
		}
		for _, session := range current.StartedSessions {
			if key := "stopped:" + session.TaskID; session.NotContinued != "" && !shown[key] {
				shown[key] = true
				emit(FollowEvent{Kind: EventNotContinued, Title: session.Title, Text: session.NotContinued})
			}
		}
	}
	deadline := time.Now().Add(f.WorkTimeout)
	current := record
	for {
		onRecord(current)
		if allSettled(current.StartedSessions) {
			return nil
		}
		if time.Now().After(deadline) {
			emit(FollowEvent{Kind: EventStillWorking, Text: fmt.Sprintf("Tag %s is still working; each report will arrive in the %s conversation.", tag, record.Session)})
			return nil
		}
		if !pause(ctx, f.Interval) {
			return nil
		}
		// Work runs for a long time; a Control Plane that is briefly unreachable, say while it
		// restarts, is reread on the next interval rather than ending the follow.
		next, err := f.Client.GetMessage(ctx, tag, record.TaskID)
		if err != nil && !transient(err) {
			return err
		}
		if err == nil {
			current = next
		}
	}
}

func reportEnding(session StartedSession) string {
	switch session.Status {
	case "completed":
		return "done"
	case "waiting":
		if session.Question == "" {
			return "waiting for approval"
		}
		return "waiting on you"
	case "failed":
		return "failed"
	}
	return "stopped"
}

// allSettled reports whether no work Session needs more following: each one's report arrived,
// and none waits on an approval decision only, since deciding it continues the Session.
func allSettled(sessions []StartedSession) bool {
	for _, session := range sessions {
		if session.ReportStatus != "replied" || (session.Status == "waiting" && session.Question == "") {
			return false
		}
	}
	return true
}

type streamEnd int

const (
	endedFinished streamEnd = iota
	endedClosed
	endedIdle
)

type streamOptions struct {
	// deltas emits text deltas; indent and title mark a work Session's activity.
	deltas bool
	indent bool
	title  string
	onPart func()
}

// streamReply follows one reply stream to its finish or error part, emitting activity lines. A
// dropped connection resumes after the last part seen, a few times.
func (f *Follower) streamReply(ctx context.Context, tag, taskID string, opts streamOptions, emit func(FollowEvent)) (*Reply, streamEnd, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := false
	var idleMu sync.Mutex
	timer := time.AfterFunc(f.ReplyTimeout, func() {
		idleMu.Lock()
		idle = true
		idleMu.Unlock()
		cancel()
	})
	defer timer.Stop()
	wasIdle := func() bool {
		idleMu.Lock()
		defer idleMu.Unlock()
		return idle
	}

	lastID := ""
	for attempt := 0; ; attempt++ {
		reader, err := f.Client.Stream(ctx, tag, taskID, lastID)
		if err == nil {
			reply, done, readErr := f.readParts(reader, opts, timer, emit)
			lastID = reader.LastID()
			reader.Close()
			if done {
				return reply, endedFinished, nil
			}
			if readErr == nil {
				return nil, endedClosed, nil
			}
			err = readErr
		}
		if wasIdle() {
			return nil, endedIdle, nil
		}
		if ctx.Err() != nil {
			return nil, endedClosed, nil
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) || attempt >= 3 || !pause(ctx, f.Interval) {
			return nil, endedClosed, err
		}
	}
}

// readParts reads parts until a finish or error part (done), the stream's end (nil error) or a
// read failure.
func (f *Follower) readParts(reader *SSEReader, opts streamOptions, timer *time.Timer, emit func(FollowEvent)) (*Reply, bool, error) {
	for {
		part, err := reader.NextPart()
		if errors.Is(err, ErrDone) || errors.Is(err, io.EOF) {
			return nil, false, nil
		}
		if err != nil {
			return nil, false, err
		}
		timer.Reset(f.ReplyTimeout)
		if opts.onPart != nil {
			opts.onPart()
		}
		switch part.Type {
		case "text-delta":
			if opts.deltas && part.Delta != "" {
				emit(FollowEvent{Kind: EventDelta, Text: part.Delta})
			}
		case "data-activity":
			if line := ActivityLine(part.Data); line != "" {
				emit(FollowEvent{Kind: EventActivity, Title: opts.title, Text: line, Indent: opts.indent})
			}
		case "error":
			return &Reply{Presentation: "error", Text: part.ErrorText}, true, nil
		case "finish":
			if part.MessageMetadata != nil {
				return part.MessageMetadata.Reply, true, nil
			}
			return nil, true, nil
		}
	}
}

// pause waits d; false when ctx ended first.
func pause(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

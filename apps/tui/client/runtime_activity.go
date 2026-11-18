package client

import (
	"context"
	"time"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// TagActivity is how a Tag's unprompted messages (Schedule fires, Objective notices) landed over
// the last WindowDays, and its start rate when it has one: what `supertag describe tag` shows.
type TagActivity struct {
	WindowDays uint32
	// Posted reached someone; Read was read in a person's conversation (surfaces have no read
	// receipts); Answered got an answer in the same Session within a day; Quiet found nothing and
	// posted nothing.
	Posted, Read, Answered, Quiet uint32
	// StartRate is nil when the Tag has none.
	StartRate *StartRate
	// IdleObjectives are its working Objectives that sit idle, oldest idle first.
	IdleObjectives []IdleObjective
}

// IdleObjective is a working Objective whose owner's last turn left nothing running and asked
// nothing.
type IdleObjective struct {
	ID, Outcome string
	Since       time.Time
}

// StartRate lets at most Starts Task Attempts start in any Per; InWindow started in the current one.
type StartRate struct {
	Starts, InWindow uint32
	Per              time.Duration
}

// TagActivity reads the Tag's activity.
func (c *Client) TagActivity(ctx context.Context, tag string) (TagActivity, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.operator.GetTag(ctx, connect.NewRequest(&v2.GetTagRequest{TagId: tag}))
	if err != nil {
		return TagActivity{}, apiError(err)
	}
	attention := res.Msg.GetAttention()
	out := TagActivity{WindowDays: attention.GetWindowDays(), Posted: attention.GetPosted(),
		Read: attention.GetRead(), Answered: attention.GetAnswered(), Quiet: attention.GetQuiet()}
	if rate := res.Msg.GetStartRate(); rate.GetStarts() > 0 {
		out.StartRate = &StartRate{Starts: rate.GetStarts(), InWindow: res.Msg.GetStartsInWindow(),
			Per: time.Duration(rate.GetPerMs()) * time.Millisecond}
	}
	for _, idle := range res.Msg.GetIdleObjectives() {
		out.IdleObjectives = append(out.IdleObjectives, IdleObjective{ID: idle.GetObjectiveId(),
			Outcome: idle.GetOutcome(), Since: time.UnixMilli(idle.GetIdleSinceMs())})
	}
	return out, nil
}

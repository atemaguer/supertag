package client

import (
	"context"
	"errors"
	"strings"
	"time"

	"connectrpc.com/connect"

	v2 "github.com/atemaguer/supertag/sdks/go/runtimev2"
)

// Schedule is a wake-up of a Tag: once at a time, or on a recurrence.
type Schedule struct {
	ID, Tag, Note string
	// State is active, paused, staged, done, or cancelled.
	State string
	// Cron and TimeZone describe a recurring Schedule; At is a one-off's time.
	Cron, TimeZone string
	At             time.Time
	// NextDue is when it fires next; zero when it will not.
	NextDue   time.Time
	CreatedBy string
}

// Pending says the Schedule can still fire: it is active or paused.
func (s Schedule) Pending() bool {
	return s.State == "active" || s.State == "paused"
}

// ScheduleAction is what an operator can do to a Schedule.
type ScheduleAction string

const (
	PauseSchedule  ScheduleAction = "pause"
	ResumeSchedule ScheduleAction = "resume"
	DeleteSchedule ScheduleAction = "delete"
)

func scheduleDataLoss(message string) error {
	return &APIError{Code: connect.CodeDataLoss, Message: message}
}

// Schedules lists the Tag's pending Schedules the caller can see, next due first.
func (c *Client) Schedules(ctx context.Context, tag string) ([]Schedule, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	res, err := c.runtime.schedules.List(ctx, connect.NewRequest(&v2.ListSchedulesRequest{TagId: &tag}))
	if err != nil {
		return nil, apiError(err)
	}
	var out []Schedule
	for _, schedule := range res.Msg.GetSchedules() {
		if schedule.GetTagId() != tag {
			return nil, scheduleDataLoss("Control Plane returned another Tag's Schedule.")
		}
		if shown := scheduleView(schedule); shown.Pending() {
			out = append(out, shown)
		}
	}
	return out, nil
}

// ChangeSchedule pauses, resumes, or deletes a Schedule, and returns it as it is now.
func (c *Client) ChangeSchedule(ctx context.Context, id string, action ScheduleAction) (Schedule, error) {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	request := connect.NewRequest(&v2.GetScheduleRequest{ScheduleId: id})
	var res *connect.Response[v2.Schedule]
	var err error
	switch action {
	case PauseSchedule:
		res, err = c.runtime.schedules.Pause(ctx, request)
	case ResumeSchedule:
		res, err = c.runtime.schedules.Resume(ctx, request)
	case DeleteSchedule:
		res, err = c.runtime.schedules.Delete(ctx, request)
	default:
		return Schedule{}, errors.New("unknown Schedule action")
	}
	if err != nil {
		return Schedule{}, apiError(err)
	}
	if res.Msg.GetScheduleId() != id {
		return Schedule{}, scheduleDataLoss("Control Plane returned a different Schedule.")
	}
	return scheduleView(res.Msg), nil
}

func scheduleView(schedule *v2.Schedule) Schedule {
	out := Schedule{
		ID:        schedule.GetScheduleId(),
		Tag:       schedule.GetTagId(),
		Note:      schedule.GetNote(),
		State:     strings.ToLower(strings.TrimPrefix(schedule.GetState().String(), "SCHEDULE_STATE_")),
		CreatedBy: schedule.GetCreatedBy(),
	}
	if every := schedule.GetEvery(); every != nil {
		out.Cron, out.TimeZone = every.GetCron(), every.GetTimeZone()
	}
	if schedule.AtMs != nil {
		out.At = time.UnixMilli(schedule.GetAtMs())
	}
	if schedule.NextDueAtMs != nil {
		out.NextDue = time.UnixMilli(schedule.GetNextDueAtMs())
	}
	return out
}

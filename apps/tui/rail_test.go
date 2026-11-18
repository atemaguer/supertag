package main

import (
	"testing"
	"time"
)

// The Tag list says a time today on the same 12-hour clock as the conversation's dividers.
func TestRailTimeUsesTheDividersClock(t *testing.T) {
	now := time.Date(2026, 11, 17, 16, 30, 0, 0, time.Local)
	for _, tc := range []struct {
		at   time.Time
		want string
	}{
		{time.Date(2026, 11, 17, 16, 1, 0, 0, time.Local), "4:01 PM"},
		{time.Date(2026, 11, 17, 9, 5, 0, 0, time.Local), "9:05 AM"},
		{time.Date(2026, 11, 16, 23, 0, 0, 0, time.Local), "Yday"},
		{time.Date(2026, 11, 13, 8, 0, 0, 0, time.Local), "Fri"},
		{time.Date(2026, 10, 2, 8, 0, 0, 0, time.Local), "Oct 2"},
	} {
		if got := railTime(tc.at.UnixMilli(), now); got != tc.want {
			t.Errorf("railTime(%v) = %q, want %q", tc.at, got, tc.want)
		}
	}
	if got := timeLabel(time.Date(2026, 11, 17, 16, 1, 0, 0, time.Local), now); got != "Today 4:01 PM" {
		t.Errorf("divider = %q", got)
	}
}

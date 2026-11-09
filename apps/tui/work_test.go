package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/packages/operator-api/go/operatorv1"
)

const testPR = "https://github.com/acme/app/pull/7"

// reportedHistory is one earlier message whose work Session s1 reported.
func reportedHistory() func(*operatorv1.ListMessagesRequest) []*operatorv1.Message {
	return func(req *operatorv1.ListMessagesRequest) []*operatorv1.Message {
		if req.GetTag() != "lead" || req.GetConversation() != "default" {
			return nil
		}
		return []*operatorv1.Message{{TaskId: "t1", Tag: "lead", Conversation: "default", Text: "Fix the discount", Status: operatorv1.ReplyStatus_REPLY_STATUS_REPLIED,
			Reply: finalReply("Started."), WorkSessions: []*operatorv1.WorkSession{workSession("s1", "Fix", "w1", "Fixed it.")}}}
	}
}

func TestAWorkSessionExpandsToItsActivityReportAndBranch(t *testing.T) {
	fake := &fakeControlPlane{
		tags:    tags("lead"),
		history: reportedHistory(),
		sessions: func(id string) *operatorv1.Session {
			if id != "s1" {
				return nil
			}
			return delivered("s1", "w1", "supertag/session/s1", "", "abc1234", "main", testPR)
		},
		taskEvents: func(req *operatorv1.ListTaskEventsRequest) []*operatorv1.TaskEvent {
			if req.GetTaskId() != "w1" {
				t.Errorf("read the events of %s, want w1", req.GetTaskId())
			}
			return []*operatorv1.TaskEvent{
				commandEvent("w1", 1, "c1", "pytest -q", "running"),
				commandEvent("w1", 2, "c1", "pytest -q", "completed"),
				toolEvent("w1", 3, "u1", "github", "create_pull_request"),
				commandEvent("w1", 4, "c2", "rm \x1b[2J -rf", "running"),
			}
		},
	}
	m := start(t, testModel(t, fake))
	got := screen(m)
	if !strings.Contains(got, "Branch supertag/session/s1   [d] diff  [o] open") {
		t.Fatalf("no branch line after the report:\n%s", got)
	}
	if fake.count(fake.sessionReads, "s1") != 1 {
		t.Fatalf("GetSession(s1) ran %d times, want once", fake.count(fake.sessionReads, "s1"))
	}

	m = press(t, m, key(tea.KeyUp))
	if !m.shown().selected.branch || !strings.Contains(screen(m), "d diff · o open the pull request") {
		t.Fatalf("up did not select the branch line:\n%s", screen(m))
	}
	m = press(t, m, key(tea.KeyUp), key(tea.KeyEnter))
	got = screen(m)
	for _, want := range []string{"▾ working: Fix", "Session s1 · Task w1 completed", "Activity:", "· running: pytest -q",
		"· using: github.create_pull_request", "· running: rm  [2J -rf", "Report:", "Fixed it.",
		"Branch supertag/session/s1 in Workspace app", "Pull request " + testPR + " (ready for review)", "enter hides details"} {
		if !strings.Contains(got, want) {
			t.Errorf("the expanded work Session lacks %q:\n%s", want, got)
		}
	}
	if strings.Count(got, "· running: pytest -q") != 1 {
		t.Errorf("a command shows once:\n%s", got)
	}
	if strings.Contains(m.View().Content, "\x1b[2J") {
		t.Error("recorded activity reached the terminal unfiltered")
	}

	m = press(t, m, key(tea.KeyEnter))
	if strings.Contains(screen(m), "Activity:") || !strings.Contains(screen(m), "· working: Fix") {
		t.Fatalf("enter did not collapse the work Session:\n%s", screen(m))
	}

	var opened []string
	m.openURL = func(address string) error {
		opened = append(opened, address)
		return nil
	}
	m = press(t, m, letter('o'))
	if len(opened) != 1 || opened[0] != testPR || !strings.Contains(screen(m), "Opened "+testPR) {
		t.Fatalf("o opened %v:\n%s", opened, screen(m))
	}

	m = press(t, m, letter('x'))
	if m.shown().selected != nil || m.input.Value() != "x" {
		t.Fatalf("typing must leave the selection for the input: input %q", m.input.Value())
	}
}

func TestAnExpandedWorkSessionFollowsItsActivity(t *testing.T) {
	events := []*operatorv1.TaskEvent{commandEvent("w1", 1, "c1", "make test", "running")}
	fake := &fakeControlPlane{
		tags:       tags("lead"),
		history:    reportedHistory(),
		sessions:   func(id string) *operatorv1.Session { return delivered(id, "w1", "fix", "", "abc1234", "main", "") },
		taskEvents: func(*operatorv1.ListTaskEventsRequest) []*operatorv1.TaskEvent { return events },
	}
	m := start(t, testModel(t, fake))
	m = press(t, m, key(tea.KeyUp), key(tea.KeyUp), key(tea.KeyEnter))
	if !strings.Contains(screen(m), "· running: make test") {
		t.Fatalf("screen:\n%s", screen(m))
	}
	events = append(events, commandEvent("w1", 2, "c2", "make lint", "running"))
	next, cmd := m.Update(watchMsg{update: client.WatchUpdate{Kind: client.WatchChanged, Change: &operatorv1.WatchChange{
		Kind: operatorv1.WatchKind_WATCH_KIND_SESSION, Id: "s1"}}, updates: closedUpdates()})
	m = run(t, next.(model), cmd)
	if got := screen(m); !strings.Contains(got, "· running: make lint") || strings.Count(got, "· running: make test") != 1 {
		t.Fatalf("a Session change did not add the new activity once:\n%s", got)
	}
	if strings.Contains(screen(m), "[o] open") {
		t.Fatal("a branch without a pull request offers no open")
	}
}

func closedUpdates() chan client.WatchUpdate {
	updates := make(chan client.WatchUpdate)
	close(updates)
	return updates
}

// gitRepo makes a repository with a main branch and branch, which changes one file, and returns
// it with the base and branch commits.
func gitRepo(t *testing.T, branch string) (dir, base, head string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir = t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	git("init", "-q", "-b", "main")
	write("discount.py", "def apply_discount(price, percent):\n\treturn price * (1 - percent / 100)\n")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	base = git("rev-parse", "HEAD")
	git("checkout", "-q", "-b", branch)
	write("discount.py", "def apply_discount(price, percent):\n\tif percent > 100:\n\t\traise ValueError(\"\x1b[2Jtoo much\")\n\treturn price * (1 - percent / 100)\n")
	git("commit", "-q", "-am", "reject percentages over 100")
	head = git("rev-parse", "HEAD")
	git("checkout", "-q", "main")
	return dir, base, head
}

func TestDiffShowsTheBranchFromTheLocalCheckout(t *testing.T) {
	dir, base, head := gitRepo(t, "supertag/session/s1")
	fake := &fakeControlPlane{
		tags:    tags("lead"),
		history: reportedHistory(),
		sessions: func(id string) *operatorv1.Session {
			return delivered(id, "w1", "supertag/session/s1", base, head, "main", testPR)
		},
	}
	m := testModel(t, fake)
	m.cwd = dir
	m = start(t, m)
	m = press(t, m, key(tea.KeyUp), letter('d'))
	got := screen(m)
	for _, want := range []string{"Diff · supertag/session/s1", "Branch supertag/session/s1 in Workspace app, from main at " + base[:12],
		"+++ b/discount.py", "+    if percent > 100:", `raise ValueError(" [2Jtoo much")`, "o open the pull request"} {
		if !strings.Contains(got, want) {
			t.Errorf("the diff pane lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(m.View().Content, "\x1b[2J") {
		t.Error("the diff reached the terminal unfiltered")
	}
	m = press(t, m, key(tea.KeyEscape))
	if m.pane != paneConversation || !m.shown().selected.branch {
		t.Fatalf("esc should return to the conversation with the branch line selected")
	}
}

func TestDiffFetchesABranchTheCheckoutLacks(t *testing.T) {
	upstream, base, head := gitRepo(t, "supertag/session/s1")
	clone := filepath.Join(t.TempDir(), "clone")
	if out, err := exec.Command("git", "clone", "-q", "--single-branch", "--branch", "main", upstream, clone).CombinedOutput(); err != nil {
		t.Fatalf("git clone: %v\n%s", err, out)
	}
	result := gitDiff(context.Background(), runGit, clone, diffRequest{branch: "supertag/session/s1", head: head, base: base, ref: "main"})
	if result.reason != "" || !strings.Contains(result.text, "+\tif percent > 100:") {
		t.Fatalf("gitDiff() = %+v", result)
	}
	result = gitDiff(context.Background(), runGit, clone, diffRequest{branch: "supertag/session/s1", ref: "main"})
	if result.reason != "" || !strings.Contains(result.text, "raise ValueError") {
		t.Fatalf("gitDiff() without recorded commits = %+v", result)
	}
}

func TestDiffSaysWhyItCannotRun(t *testing.T) {
	dir, base, head := gitRepo(t, "supertag/session/s1")
	for _, tc := range []struct {
		name string
		dir  string
		req  diffRequest
		want string
	}{
		{"not a repository", t.TempDir(), diffRequest{branch: "b", head: head}, "not in a git repository"},
		{"an option as a branch", dir, diffRequest{branch: "--output=/tmp/x", head: head}, "cannot be passed to git"},
		{"revision syntax as a branch", dir, diffRequest{branch: "main@{1}", head: head}, "cannot be passed to git"},
		{"no remote", dir, diffRequest{branch: "gone", base: base}, "has no remote to fetch it from"},
		{"no base", dir, diffRequest{branch: "supertag/session/s1", head: head}, "recorded no base"},
		{"a base it lacks", dir, diffRequest{branch: "supertag/session/s1", head: head, base: "0123456789abcdef0123456789abcdef01234567"}, "does not have the branch's base 0123456789abcdef"},
	} {
		if got := gitDiff(context.Background(), runGit, tc.dir, tc.req); !strings.Contains(got.reason, tc.want) {
			t.Errorf("%s: reason = %q, want %q", tc.name, got.reason, tc.want)
		}
	}

	fake := &fakeControlPlane{
		tags:    tags("lead"),
		history: reportedHistory(),
		sessions: func(id string) *operatorv1.Session {
			return delivered(id, "w1", "supertag/session/s1", base, head, "main", testPR)
		},
	}
	m := testModel(t, fake)
	m.cwd = t.TempDir()
	m = press(t, start(t, m), key(tea.KeyUp), letter('d'))
	if got := screen(m); !strings.Contains(got, "No diff here: The current directory is not in a git repository") ||
		!strings.Contains(got, "Pull request: "+testPR) {
		t.Fatalf("the diff pane does not say why:\n%s", got)
	}
}

func TestOpenRefusesWhatIsNotAWebAddress(t *testing.T) {
	for _, address := range []string{"file:///etc/passwd", "-a Calculator", "javascript:alert(1)", "https://", "https://x/ y"} {
		if err := openURL(address); err == nil {
			t.Errorf("openURL(%q) should fail", address)
		}
	}
}

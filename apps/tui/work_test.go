package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/atemaguer/supertag/apps/tui/client"
	"github.com/atemaguer/supertag/apps/tui/views"
)

const testPR = "https://github.com/acme/app/pull/7"

// reportedHistory is one earlier message whose work Session s1 reported.
func reportedHistory() func(*views.ListMessagesRequest) []*views.Message {
	return func(req *views.ListMessagesRequest) []*views.Message {
		if req.GetTag() != "lead" || req.GetConversation() != "default" {
			return nil
		}
		return []*views.Message{{TaskId: "t1", Tag: "lead", Conversation: "default", Text: "Fix the discount", Status: views.ReplyStatus_REPLY_STATUS_REPLIED,
			Reply: finalReply("Started."), WorkSessions: []*views.WorkSession{workSession("s1", "Fix", "w1", "Fixed it.")}}}
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

func TestOpenRefusesWhatIsNotAWebAddress(t *testing.T) {
	for _, address := range []string{"file:///etc/passwd", "-a Calculator", "javascript:alert(1)", "https://", "https://x/ y"} {
		if err := openURL(address); err == nil {
			t.Errorf("openURL(%q) should fail", address)
		}
	}
}

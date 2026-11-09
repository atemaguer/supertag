package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// gitTimeout bounds each git command a diff runs; fetching a branch may take longer.
var (
	gitTimeout   = 30 * time.Second
	fetchTimeout = 2 * time.Minute
)

// maxGitOutput bounds what one git command may print, and maxDiffLines how much of a diff the
// pane shows.
const (
	maxGitOutput = 16 << 20
	maxDiffLines = 20000
)

// gitRunner runs git with args in dir and returns what it printed. A failure carries git's
// first line of complaint.
type gitRunner func(ctx context.Context, dir string, args ...string) (string, error)

// runGit runs the git on PATH, detached from the terminal the TUI holds and with prompts off, so
// a fetch that needs credentials fails rather than asking for them.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never")
	detach(cmd)
	var stderr bytes.Buffer
	stdout := &limitedBuffer{limit: maxGitOutput}
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", errors.New("git took too long")
		}
		if line := firstLine(stderr.String()); line != "" {
			return "", errors.New(line)
		}
		return "", err
	}
	return stdout.String(), nil
}

// limitedBuffer keeps the first limit bytes written to it and drops the rest.
type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// diffRequest is the branch to diff and the base it started from, as the Worker recorded them.
type diffRequest struct {
	branch, head string
	base, ref    string
}

// diffResult is a branch's diff against its base, or why there is none.
type diffResult struct {
	text   string
	reason string
	// note says something about text, such as that the branch moved since its delivery.
	note string
}

var (
	commitPattern = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	refPattern    = regexp.MustCompile(`^[A-Za-z0-9._/+-]+$`)
)

// validRef reports whether name may name a branch passed to git: no option, no revision syntax.
func validRef(name string) bool {
	return refPattern.MatchString(name) && !strings.HasPrefix(name, "-") && !strings.HasPrefix(name, "/") &&
		!strings.HasSuffix(name, "/") && !strings.HasSuffix(name, ".lock") && !strings.Contains(name, "..") &&
		!strings.Contains(name, "//")
}

// gitDiff runs `git diff base...branch` in dir, the user's checkout. The branch is its recorded
// head when the checkout has that commit, else the branch in the checkout or one of its remotes,
// else the branch fetched from the checkout's remote. Branch and base names come from the
// Control Plane, so only names git cannot read as options or revision syntax are passed, and
// the diff runs between the commits they resolve to.
func gitDiff(ctx context.Context, git gitRunner, dir string, req diffRequest) diffResult {
	run := func(timeout time.Duration, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		return git(ctx, dir, args...)
	}
	if dir == "" {
		return diffResult{reason: "The terminal UI could not tell which directory it runs in."}
	}
	if _, err := run(gitTimeout, "rev-parse", "--git-dir"); err != nil {
		return diffResult{reason: "The current directory is not in a git repository. Start supertag in a checkout of the Workspace to see the diff here."}
	}
	if !validRef(req.branch) {
		return diffResult{reason: fmt.Sprintf("The branch name %q cannot be passed to git.", req.branch)}
	}
	resolve := func(rev string) string {
		out, err := run(gitTimeout, "rev-parse", "--verify", "--quiet", rev+"^{commit}")
		if err != nil {
			return ""
		}
		return strings.TrimSpace(out)
	}
	var remotes []string
	if out, err := run(gitTimeout, "remote"); err == nil {
		for _, remote := range strings.Fields(out) {
			if remote == "origin" {
				remotes = append([]string{remote}, remotes...)
			} else if validRef(remote) {
				remotes = append(remotes, remote)
			}
		}
	}
	head := ""
	recorded := commitPattern.MatchString(req.head)
	if recorded {
		head = resolve(req.head)
	} else {
		head = resolve("refs/heads/" + req.branch)
		for _, remote := range remotes {
			if head == "" {
				head = resolve("refs/remotes/" + remote + "/" + req.branch)
			}
		}
	}
	result := diffResult{}
	if head == "" {
		if len(remotes) == 0 {
			return diffResult{reason: fmt.Sprintf("This checkout does not have branch %s and has no remote to fetch it from.", req.branch)}
		}
		if _, err := run(fetchTimeout, "fetch", "--no-tags", "--quiet", remotes[0], "refs/heads/"+req.branch); err != nil {
			return diffResult{reason: fmt.Sprintf("This checkout does not have branch %s, and fetching it from %s failed: %s", req.branch, remotes[0], err)}
		}
		if recorded {
			head = resolve(req.head)
		}
		if head == "" {
			head = resolve("FETCH_HEAD")
			if recorded {
				result.note = fmt.Sprintf("The branch no longer has the commit %s the Worker recorded; this is the diff of its current head.", req.head)
			}
		}
		if head == "" {
			return diffResult{reason: fmt.Sprintf("Fetching branch %s from %s gave no commit to diff.", req.branch, remotes[0])}
		}
	}
	base := ""
	if commitPattern.MatchString(req.base) {
		base = resolve(req.base)
	}
	if base == "" && req.ref != "" && validRef(req.ref) {
		for _, remote := range remotes {
			if base == "" {
				base = resolve("refs/remotes/" + remote + "/" + req.ref)
			}
		}
		if base == "" {
			base = resolve("refs/heads/" + req.ref)
		}
	}
	if base == "" {
		what := req.base
		if what == "" {
			what = req.ref
		}
		if what == "" {
			return diffResult{reason: "The Worker recorded no base for the branch, so there is nothing to diff it against."}
		}
		return diffResult{reason: fmt.Sprintf("This checkout does not have the branch's base %s.", what)}
	}
	out, err := run(gitTimeout, "diff", "--no-color", "--no-ext-diff", base+"..."+head)
	if err != nil {
		return diffResult{reason: "git diff failed: " + err.Error()}
	}
	result.text = out
	return result
}

// diffView is what the diff pane shows of one work Session's branch.
type diffView struct {
	session string
	title   string
	// branch describes the delivery: the branch, its Workspace and base.
	branch  string
	pr      string
	loading bool
	// rendered is the diff, styled and filtered for the terminal; reason says why there is none.
	rendered string
	reason   string
	note     string
}

type (
	diffMsg struct {
		session string
		result  diffResult
	}
	openedMsg struct {
		url string
		err error
	}
)

// showDiff opens the diff pane on a work Session's delivered branch and runs the diff.
func (m *model) showDiff(id string) tea.Cmd {
	d := m.work[id]
	workspace := d.branch()
	if workspace == nil {
		m.notice = note{text: "This work Session has delivered no branch yet.", err: true}
		return nil
	}
	m.saveDraft()
	view := &diffView{session: id, loading: true, pr: d.pullRequest(), title: terminalText(workspace.GetBranch())}
	base := workspace.GetRef()
	if workspace.GetBase() != "" {
		base = shortCommit(workspace.GetBase())
		if workspace.GetRef() != "" {
			base = workspace.GetRef() + " at " + base
		}
	}
	view.branch = "Branch " + workspace.GetBranch() + " in Workspace " + workspace.GetName()
	if base != "" {
		view.branch += ", from " + base
	}
	view.branch = terminalText(view.branch)
	m.diff, m.pane = view, paneDiff
	m.viewport.SoftWrap = true
	m.viewport.GotoTop()
	m.syncInput()
	m.refresh()
	req := diffRequest{branch: workspace.GetBranch(), head: workspace.GetHead(), base: workspace.GetBase(), ref: workspace.GetRef()}
	ctx, git, dir := m.ctx, m.git, m.cwd
	return func() tea.Msg {
		return diffMsg{session: id, result: gitDiff(ctx, git, dir, req)}
	}
}

func (m *model) diffRead(msg diffMsg) {
	if m.diff == nil || m.diff.session != msg.session || !m.diff.loading {
		return
	}
	m.diff.loading = false
	m.diff.reason = terminalText(msg.result.reason)
	m.diff.note = terminalText(msg.result.note)
	if msg.result.reason == "" {
		m.diff.rendered = renderDiff(msg.result.text)
	}
	if m.pane == paneDiff {
		m.refresh()
	}
}

var (
	addedStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	removedStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("9"))
	hunkStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("14"))
)

// renderDiff styles a unified diff line by line. Each line is filtered for the terminal, so a
// changed file's escape sequences show as text.
func renderDiff(text string) string {
	if strings.TrimSpace(text) == "" {
		return faint.Render("The branch has no changes against its base.")
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	extra := 0
	if len(lines) > maxDiffLines {
		extra = len(lines) - maxDiffLines
		lines = lines[:maxDiffLines]
	}
	for i, line := range lines {
		plain := terminalText(strings.ReplaceAll(strings.TrimSuffix(line, "\r"), "\t", "    "))
		switch {
		case strings.HasPrefix(line, "diff --git"), strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
			lines[i] = bold.Render(plain)
		case strings.HasPrefix(line, "@@"):
			lines[i] = hunkStyle.Render(plain)
		case strings.HasPrefix(line, "+"):
			lines[i] = addedStyle.Render(plain)
		case strings.HasPrefix(line, "-"):
			lines[i] = removedStyle.Render(plain)
		default:
			lines[i] = plain
		}
	}
	if extra > 0 {
		lines = append(lines, faint.Render(fmt.Sprintf("… %d more lines. Run the diff in your checkout to see them all.", extra)))
	}
	return strings.Join(lines, "\n")
}

// renderDiffPane is the diff pane: the delivery, then the diff or why it cannot be shown here,
// with the pull request to look at instead.
func (m model) renderDiffPane() string {
	view := m.diff
	wrap := lipgloss.NewStyle().Width(m.paneWidth())
	head := faint.Render(wrap.Render(view.branch))
	switch {
	case view.loading:
		return head + "\n\n" + faint.Render("Reading the diff…")
	case view.reason != "":
		lines := []string{errorStyle.Render(wrap.Render("No diff here: " + view.reason))}
		if view.pr != "" {
			lines = append(lines, "", wrap.Render("Pull request: "+terminalText(view.pr)), faint.Render("Press o to open it."))
		} else {
			lines = append(lines, "", faint.Render(wrap.Render("The branch has no pull request.")))
		}
		return head + "\n\n" + strings.Join(lines, "\n")
	}
	out := head + "\n"
	if view.note != "" {
		out += faint.Render(wrap.Render(view.note)) + "\n"
	}
	return out + "\n" + view.rendered
}

// diffHint ends the diff pane: the keys that act on it.
func (m model) diffHint() string {
	parts := []string{"↑↓ pgup pgdn scroll"}
	if m.diff.pr != "" {
		parts = append(parts, "o open the pull request")
	}
	return strings.Join(append(parts, "esc back"), " · ")
}

// openPullRequest opens a pull request's web address with the platform's opener.
func (m *model) openPullRequest(address string) tea.Cmd {
	if address == "" {
		m.notice = note{text: "This work Session has opened no pull request.", err: true}
		return nil
	}
	open := m.openURL
	return func() tea.Msg {
		return openedMsg{url: address, err: open(address)}
	}
}

func (m *model) opened(msg openedMsg) {
	if msg.err != nil {
		m.notice = note{text: "Could not open the pull request: " + terminalText(msg.err.Error()), err: true}
	} else {
		m.notice = note{text: "Opened " + terminalText(msg.url)}
	}
}

// openURL opens an http or https address with `open` on macOS and `xdg-open` elsewhere, without
// waiting for the browser.
func openURL(address string) error {
	u, err := url.Parse(address)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || strings.ContainsAny(address, " \t\r\n") {
		return fmt.Errorf("%s is not a web address", address)
	}
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	cmd := exec.Command(name, u.String())
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("running %s: %w", name, err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// shortCommit is a commit's first twelve characters.
func shortCommit(commit string) string {
	if len(commit) > 12 {
		return commit[:12]
	}
	return commit
}

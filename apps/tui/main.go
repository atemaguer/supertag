// Command supertag-tui is SuperTag's terminal UI. Plain `supertag` in a terminal starts it and hands it the
// Control Plane target over file descriptor 3.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/atemaguer/supertag/apps/tui/client"
)

// version is set at build time.
var version = "dev"

const launchHint = "Run supertag in a terminal to start the terminal UI."

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	target, err := readTarget(os.NewFile(3, "supertag-target"))
	if err != nil {
		fmt.Fprintln(os.Stderr, launchHint)
		os.Exit(2)
	}
	c, err := client.New(target, version)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := tea.NewProgram(newModel(ctx, c, client.NewFollower(c), client.NewWatcher(c, watchKinds...))).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// readTarget reads the one JSON line `supertag` writes to the inherited pipe, to EOF. Only a
// pipe or a socket counts (Node's `stdio: "pipe"` is a Unix socketpair), so a stray descriptor 3
// a shell left open on a file or terminal is not read.
func readTarget(f *os.File) (client.Target, error) {
	var target client.Target
	if f == nil {
		return target, errors.New("no target descriptor")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return target, err
	}
	if info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return target, errors.New("the target descriptor is not a pipe")
	}
	data, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return target, err
	}
	if err := json.Unmarshal(data, &target); err != nil {
		return target, err
	}
	if target.URL == "" || target.Token == "" {
		return target, errors.New("the target needs a url and a token")
	}
	return target, nil
}

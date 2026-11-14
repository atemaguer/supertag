// conformance decodes a Task written by the Python protobuf bindings.
package main

import (
	"fmt"
	"io"
	"os"

	"github.com/atemaguer/supertag/rust/bindings/go/runtimev2"
	"google.golang.org/protobuf/proto"
)

func main() {
	if err := roundTrip(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func roundTrip() error {
	wire, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	task := new(runtimev2.Task)
	if err := proto.Unmarshal(wire, task); err != nil {
		return err
	}
	if task.GetTagRevision() != 9007199254740993 || task.Result == nil || task.GetResult() != "" || task.AttemptId != nil {
		return fmt.Errorf("unexpected revision or optional field presence in Python Task")
	}
	task.TagRevision++
	task.AttemptId = proto.String("go-attempt")
	wire, err = proto.Marshal(task)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(wire)
	return err
}

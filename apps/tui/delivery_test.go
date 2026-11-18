package main

import (
	"strings"
	"testing"

	"github.com/atemaguer/supertag/apps/tui/views"
)

// A delivery names its patches and outputs by artifact, and never suggests a download: clients
// fetch no files.
func TestDeliveryLinesNameArtifactsWithoutADownload(t *testing.T) {
	lines := deliveryLines(&views.TaskDelivery{
		Patches: []*views.PatchDelivery{{ArtifactId: "patch-1", Path: "changes.patch"}},
		Outputs: []*views.OutputDelivery{{ArtifactId: "out-1", Paths: []string{"outputs/report.md"}}},
	}, "  ")
	got := strings.Join(lines, "\n")
	for _, want := range []string{"  Patch changes.patch (artifact patch-1)", "  Output outputs/report.md (artifact out-1)"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "download") {
		t.Errorf("a delivery suggested a download:\n%s", got)
	}
}

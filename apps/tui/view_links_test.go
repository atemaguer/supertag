package main

import "testing"

func TestLocalLinksShowOnlyTheirText(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Added it to [calc.py](/private/tmp/host/checkouts/1/calc.py).", "Added it to calc.py."},
		{"See [calc.py](file:///tmp/x/calc.py) and [b](/b)", "See calc.py and b"},
		{"Docs: [guide](https://example.com/guide)", "Docs: [guide](https://example.com/guide)"},
		{"Added [calc.py](calc.py) and [t](src/t.py)", "Added calc.py and t"},
		{"Mail [me](mailto:a@b.c)", "Mail [me](mailto:a@b.c)"},
		{"Index a[0] and [x", "Index a[0] and [x"},
	} {
		if got := withoutLocalLinks(c.in); got != c.want {
			t.Errorf("withoutLocalLinks(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

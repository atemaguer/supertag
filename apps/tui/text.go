package main

import (
	"strings"
	"unicode"
)

// terminalText filters one human-readable field from the server or an agent for the terminal,
// as the CLI's terminalText does: control and format characters, line and paragraph separators
// and blank-looking fillers become spaces, so an escape sequence shows as text and cannot style,
// hide or rewrite the screen. More than two combining marks in a row become a space.
func terminalText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	marks := 0
	for _, r := range s {
		if unicode.Is(unicode.M, r) {
			marks++
			if marks == 3 {
				b.WriteByte(' ')
			}
			if marks >= 3 {
				continue
			}
			b.WriteRune(r)
			continue
		}
		marks = 0
		if blank(r) {
			b.WriteByte(' ')
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func blank(r rune) bool {
	switch r {
	case '\u115f', '\u1160', '\u2800', '\u3164', '\uffa0':
		return true
	}
	return unicode.In(r, unicode.Cc, unicode.Cf, unicode.Zl, unicode.Zp)
}

// terminalLines filters each line of a multi-line text with terminalText, keeping the breaks.
func terminalLines(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = terminalText(strings.TrimSuffix(line, "\r"))
	}
	return strings.Join(lines, "\n")
}

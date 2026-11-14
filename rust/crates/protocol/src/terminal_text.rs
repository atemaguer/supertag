//! Terminal-safe text for anything a SuperTag process writes to a terminal.
//!
//! The CLI and the services it runs in the foreground print values that come from the Control
//! Plane, Worker Hosts, surfaces, and files, so any of them may hold terminal controls. [`text`]
//! replaces every control, format character, line or paragraph separator, and invisible filler
//! with a space and keeps escape payloads visible; [`lines`] does the same but keeps line breaks.

use std::io::Write;

/// Unicode `General_Category=Cf` (format characters), as of Unicode 16.
const FORMAT: &[(u32, u32)] = &[
    (0x00ad, 0x00ad),
    (0x0600, 0x0605),
    (0x061c, 0x061c),
    (0x06dd, 0x06dd),
    (0x070f, 0x070f),
    (0x0890, 0x0891),
    (0x08e2, 0x08e2),
    (0x180e, 0x180e),
    (0x200b, 0x200f),
    (0x202a, 0x202e),
    (0x2060, 0x2064),
    (0x2066, 0x206f),
    (0xfeff, 0xfeff),
    (0xfff9, 0xfffb),
    (0x110bd, 0x110bd),
    (0x110cd, 0x110cd),
    (0x13430, 0x1343f),
    (0x1bca0, 0x1bca3),
    (0x1d173, 0x1d17a),
    (0xe0001, 0xe0001),
    (0xe0020, 0xe007f),
];

/// Characters that render as blank space without being classed as space.
const FILLERS: &[char] = &['\u{115f}', '\u{1160}', '\u{2800}', '\u{3164}', '\u{ffa0}'];

/// At most this many combining marks may stack on one character. Two cover ordinary accents.
pub const MAX_MARKS: usize = 2;

/// Whether `c` could move the cursor, change the terminal, reorder text, or hide as blank space.
pub fn unsafe_char(c: char) -> bool {
    let code = u32::from(c);
    c.is_control()
        || matches!(c, '\u{2028}' | '\u{2029}')
        || FILLERS.contains(&c)
        || FORMAT
            .iter()
            .any(|&(start, end)| (start..=end).contains(&code))
}

/// Whether `c` is a combining mark, which [`text`] bounds per character.
pub fn mark(c: char) -> bool {
    unicode_normalization::char::is_combining_mark(c)
}

/// One field or assembled display line. Every control, including a line break, becomes a space.
pub fn text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut marks = 0;
    for c in value.chars() {
        if unsafe_char(c) {
            marks = 0;
            output.push(' ');
        } else if mark(c) {
            marks += 1;
            if marks <= MAX_MARKS {
                output.push(c);
            } else if marks == MAX_MARKS + 1 {
                output.push(' ');
            }
        } else {
            marks = 0;
            output.push(c);
        }
    }
    output
}

/// Filter each line but keep the line breaks, so multi-line output stays readable.
pub fn lines(value: &str) -> String {
    value
        .split('\n')
        .map(|line| text(line.strip_suffix('\r').unwrap_or(line)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Print one diagnostic line to standard error, filtered with [`text`] so a value it carries
/// cannot drive the terminal or add a line of its own.
pub fn warn(message: &str) {
    let mut line = text(message);
    line.push('\n');
    // As with `eprintln!`, a closed stream ends the output; nothing else can be reported.
    // terminal-safe: `line` is filtered above.
    let _ = std::io::stderr().lock().write_all(line.as_bytes());
}

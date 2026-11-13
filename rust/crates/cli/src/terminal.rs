//! Terminal safety for everything the CLI prints.
//!
//! Values the CLI prints come from the Control Plane, Worker Hosts, surfaces, logs, and files,
//! so any of them may hold terminal controls. Every write to standard output or standard error
//! goes through [`out!`], [`outln!`], or [`errln!`], which keep line breaks and replace every other
//! control, format character, line or paragraph separator, and invisible filler with a space.
//! Escape payload text stays visible, so evidence is never hidden. Single fields that a renderer
//! places on one line go through [`text`] first, so a value cannot add a fake output line.
//!
//! JSON keeps every value: [`json`] and [`json_pretty`] write those characters as `\u` escapes,
//! which parsers read back as the original value and terminals print as plain text.

use std::io::Write;

use supertag_protocol::terminal_text::{MAX_MARKS, mark, unsafe_char};
pub use supertag_protocol::terminal_text::{lines, text};

/// Escape unsafe characters, and combining marks past the bound, inside serialized JSON.
/// Serialized JSON holds raw line breaks only as structure, never inside a string.
fn escape_json(serialized: String) -> String {
    if !serialized
        .chars()
        .any(|c| c != '\n' && (unsafe_char(c) || mark(c)))
    {
        return serialized;
    }
    let mut output = String::with_capacity(serialized.len() + 16);
    let mut marks = 0;
    for c in serialized.chars() {
        let escape = if c == '\n' {
            marks = 0;
            false
        } else if unsafe_char(c) {
            marks = 0;
            true
        } else if mark(c) {
            marks += 1;
            marks > MAX_MARKS
        } else {
            marks = 0;
            false
        };
        if escape {
            for unit in c.encode_utf16(&mut [0; 2]) {
                output.push_str(&format!("\\u{unit:04x}"));
            }
        } else {
            output.push(c);
        }
    }
    output
}

/// Compact JSON that keeps every value and cannot drive a terminal.
pub fn json(value: &impl serde::Serialize) -> serde_json::Result<String> {
    serde_json::to_string(value).map(escape_json)
}

/// Indented JSON that keeps every value and cannot drive a terminal.
pub fn json_pretty(value: &impl serde::Serialize) -> serde_json::Result<String> {
    serde_json::to_string_pretty(value).map(escape_json)
}

/// Print one compact JSON document and a line break to standard output.
pub fn print_json(value: &serde_json::Value) -> serde_json::Result<()> {
    write_stdout(&format!("{}\n", json(value)?));
    Ok(())
}

/// Print one indented JSON document and a line break to standard output.
pub fn print_json_pretty(value: &impl serde::Serialize) -> serde_json::Result<()> {
    write_stdout(&format!("{}\n", json_pretty(value)?));
    Ok(())
}

fn write(mut stream: impl Write, value: &str) {
    // As with `print!`, a closed pipe ends the output; nothing else can be reported.
    let _ = stream
        .write_all(lines(value).as_bytes())
        .and_then(|()| stream.flush());
}

#[doc(hidden)]
pub fn write_stdout(value: &str) {
    // terminal-safe: `write` filters every line.
    write(std::io::stdout().lock(), value);
}

#[doc(hidden)]
pub fn write_stderr(value: &str) {
    // terminal-safe: `write` filters every line.
    write(std::io::stderr().lock(), value);
}

/// Print filtered text to standard output without a line break.
macro_rules! out {
    ($($arg:tt)*) => {
        $crate::terminal::write_stdout(&format!($($arg)*))
    };
}

/// Print filtered text and a line break to standard output.
macro_rules! outln {
    () => {
        $crate::terminal::write_stdout("\n")
    };
    ($($arg:tt)*) => {
        $crate::terminal::write_stdout(&format!("{}\n", format_args!($($arg)*)))
    };
}

/// Print filtered text and a line break to standard error.
macro_rules! errln {
    ($($arg:tt)*) => {
        $crate::terminal::write_stderr(&format!("{}\n", format_args!($($arg)*)))
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) const HOSTILE: &str =
        "visible\x1b[2J\x1b]0;hidden-title\x07\r\n\t\x08\0\x7f\u{9b}\u{202e}\u{2028}\u{2029}end";

    /// The checks the TypeScript CLI applied to every hostile rendering.
    pub(crate) fn assert_safe(output: &str) {
        for kept in ["visible", "end", "hidden-title", "[2J"] {
            assert!(output.contains(kept), "{output:?}");
        }
        assert!(
            !output.chars().any(|c| c != '\n' && unsafe_char(c)),
            "{output:?}"
        );
        assert!(!output.contains("\nend"), "{output:?}");
    }

    /// Every write to standard output or standard error goes through this module, or through
    /// `supertag_protocol::terminal_text` in the services the `supertag` binary runs in the
    /// foreground. A raw write needs a `// terminal-safe:` comment on the line before it that says
    /// why it is safe. Test sources are not part of the binary and are skipped.
    #[test]
    fn the_cli_prints_only_through_this_module() {
        fn sources(directory: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if name == "tests" || name == "tests.rs" {
                    continue;
                }
                if path.is_dir() {
                    sources(&path, files);
                } else if path.extension().is_some_and(|extension| extension == "rs") {
                    files.push(path);
                }
            }
        }
        let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut files = Vec::new();
        for linked in [
            "cli",
            "protocol",
            "control-plane",
            "api",
            "gateway",
            "worker-host",
            "codex-adapter",
            "workspaces",
        ] {
            sources(&crates.join(linked).join("src"), &mut files);
        }
        assert!(
            files
                .iter()
                .any(|file| file.ends_with("worker-host/src/lib.rs")),
            "{files:?}"
        );
        let raw = [
            "print!(",
            "println!(",
            "eprint!(",
            "eprintln!(",
            "io::stdout()",
            "io::stderr()",
        ];
        let mut unfiltered = Vec::new();
        for file in files {
            let text = std::fs::read_to_string(&file).unwrap();
            let lines: Vec<&str> = text.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                let code = line.split("//").next().unwrap_or("");
                let marked = index > 0 && lines[index - 1].trim().starts_with("// terminal-safe:");
                if raw.iter().any(|call| {
                    code.match_indices(call).any(|(at, _)| {
                        !code[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '"')
                    })
                }) && !marked
                {
                    unfiltered.push(format!("{}:{}: {}", file.display(), index + 1, line.trim()));
                }
            }
        }
        assert!(unfiltered.is_empty(), "unfiltered output: {unfiltered:#?}");
    }

    #[test]
    fn replaces_terminal_controls_and_keeps_payloads_visible() {
        for (input, expected) in [
            ("before\x1b[31mred\x1b[0mafter", "before [31mred [0mafter"),
            (
                "before\x1b]8;;https://evil.test\x1b\\link\x1b]8;;\x1b\\after",
                "before ]8;;https://evil.test \\link ]8;; \\after",
            ),
            ("before\u{9b}2Jafter", "before 2Jafter"),
            ("before\x1bafter", "before after"),
            (
                "before\r\n\t\x08\0\x7f\u{202e}\u{2028}\u{2029}after",
                "before         after",
            ),
        ] {
            assert_eq!(text(input), expected, "{input:?}");
        }
        assert_safe(&text(HOSTILE));
        assert_safe(&lines(HOSTILE));
    }

    #[test]
    fn replaces_invisible_fillers_and_format_characters() {
        for filler in [
            '\u{3164}',
            '\u{2800}',
            '\u{115f}',
            '\u{1160}',
            '\u{ffa0}',
            '\u{200b}',
            '\u{2066}',
            '\u{feff}',
            '\u{ad}',
            '\u{e0041}',
        ] {
            assert_eq!(text(&format!("before{filler}after")), "before after");
        }
    }

    #[test]
    fn bounds_stacked_combining_marks_and_keeps_accents() {
        let stacked = text(&format!("x{}end", "\u{301}".repeat(30)));
        assert_eq!(stacked, "x\u{301}\u{301} end");
        assert_eq!(text("café"), "café");
        assert_eq!(text("cafe\u{301}"), "cafe\u{301}");
    }

    #[test]
    fn lines_keep_line_breaks_but_not_carriage_returns() {
        assert_eq!(lines("one\r\ntwo\rthree\n"), "one\ntwo three\n");
    }

    #[test]
    fn json_escapes_unsafe_characters_without_changing_values() {
        let value = json!({ "name": HOSTILE, "marks": format!("x{}", "\u{301}".repeat(5)) });
        for rendered in [json(&value).unwrap(), json_pretty(&value).unwrap()] {
            assert!(
                !rendered.chars().any(|c| c != '\n' && unsafe_char(c)),
                "{rendered:?}"
            );
            assert!(rendered.contains("\\u009b") && rendered.contains("\\u202e"));
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&rendered).unwrap(),
                value
            );
            // The final output filter leaves escaped JSON untouched.
            assert_eq!(lines(&rendered), rendered);
        }
        let astral = json!("tag\u{e0041}");
        assert_eq!(json(&astral).unwrap(), "\"tag\\udb40\\udc41\"");
    }
}

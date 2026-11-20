//! Every turn's memory paragraph, and its TypeScript copy for the Node harnesses.
use supertag_protocol::{HarnessMemory, memory_context, memory_text};

#[test]
fn every_turn_hears_notes_the_review_and_its_harness_memory() {
    let codex = memory_context(true, Some(HarnessMemory::Codex));
    assert_eq!(
        codex,
        format!(
            "{} {} {}",
            memory_text::NOTES,
            memory_text::NOTES_WRITABLE,
            memory_text::CODEX
        )
    );
    for text in [
        "remember and forget",
        "review turn",
        "never in the Control Plane",
        "a Work Session on another harness doesn't share it yet",
        // Where people see it, which never goes through the Control Plane.
        "supertag get memories on that Worker Host's machine",
        // Codex's own template says to add memory only when asked; notes say otherwise.
        "covers that folder, not notes",
    ] {
        assert!(codex.contains(text), "{text}");
    }
    assert_eq!(
        memory_context(false, Some(HarnessMemory::ClaudeCode)),
        format!(
            "{} {} {}",
            memory_text::NOTES,
            memory_text::NOTES_READ_ONLY,
            memory_text::CLAUDE_CODE
        )
    );
    assert_eq!(
        memory_context(false, None),
        format!(
            "{} {} {}",
            memory_text::NOTES,
            memory_text::NOTES_READ_ONLY,
            memory_text::NO_HARNESS_MEMORY
        )
    );
}

/// The Node harnesses join the same sentences, so a change here must reach them too.
#[test]
fn the_typescript_copy_matches() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../harnesses/sdk/src/rust-harness/coordination.ts"
    ))
    .expect("the harness SDK source is in this checkout");
    for sentence in [
        memory_text::NOTES,
        memory_text::NOTES_WRITABLE,
        memory_text::NOTES_READ_ONLY,
        memory_text::CLAUDE_CODE,
        memory_text::NO_HARNESS_MEMORY,
    ] {
        assert!(
            source.contains(&format!("{sentence:?}")),
            "coordination.ts lacks {sentence:?}"
        );
    }
}

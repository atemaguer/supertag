//! Every turn's memory paragraph, and its TypeScript copy for the Node harnesses.
use supertag_protocol::{HarnessMemory, memory_context, memory_text};

#[test]
fn every_turn_hears_where_its_memory_is_who_sees_it_and_the_review() {
    let codex = memory_context(true, Some(HarnessMemory::Codex));
    assert_eq!(
        codex,
        format!(
            "{} {} {}",
            memory_text::CODEX,
            memory_text::KEPT,
            memory_text::TRUSTED
        )
    );
    for text in [
        "review turn",
        "never in the Control Plane",
        "a Work Session on another harness doesn't share it yet",
        // Where people see it, which never goes through the Control Plane.
        "supertag get memories on that Worker Host's machine",
        // Codex's own template says to add memory only when asked; a Tag keeps it current.
        "doesn't apply here",
    ] {
        assert!(codex.contains(text), "{text}");
    }
    for gone in ["remember", "notes are", "forget"] {
        assert!(!codex.contains(gone), "{gone}");
    }
    assert_eq!(
        memory_context(false, Some(HarnessMemory::ClaudeCode)),
        format!(
            "{} {} {}",
            memory_text::CLAUDE_CODE,
            memory_text::KEPT,
            memory_text::PROPOSED
        )
    );
    assert!(memory_text::PROPOSED.contains("proposal"));
    // OpenCode and Cursor keep none of their own: the folder SuperTag keeps for them, how to keep
    // it, and the rest as for every harness.
    for (harness, opening) in [
        (HarnessMemory::OpenCode, memory_text::OPENCODE),
        (HarnessMemory::Cursor, memory_text::CURSOR),
    ] {
        let text = memory_context(true, Some(harness));
        assert_eq!(
            text,
            format!(
                "{opening} {} {} {}",
                memory_text::FOLDER,
                memory_text::KEPT,
                memory_text::TRUSTED
            )
        );
        for needed in [
            "MEMORY.md",
            "Claude Code's format",
            "frontmatter",
            "review turn",
        ] {
            assert!(text.contains(needed), "{needed}");
        }
        assert!(memory_context(false, Some(harness)).ends_with(memory_text::PROPOSED));
    }
    assert_eq!(memory_context(false, None), memory_text::NO_MEMORY);
    assert_eq!(memory_context(true, None), memory_text::NO_MEMORY);
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
        memory_text::CLAUDE_CODE,
        memory_text::OPENCODE,
        memory_text::CURSOR,
        memory_text::FOLDER,
        memory_text::KEPT,
        memory_text::TRUSTED,
        memory_text::PROPOSED,
        memory_text::NO_MEMORY,
    ] {
        assert!(
            source.contains(&format!("{sentence:?}")),
            "coordination.ts lacks {sentence:?}"
        );
    }
}

use anyhow::Result;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde_json::{Value, json};

const MAX_CHARACTERS: usize = 24_000;
const ELEMENT_CHARACTERS: usize = 4_000;

/// Preserve Markdown while adapting constructs unsupported by Lark cards. Native
/// mention tags in model output are always displayed as text, never executed.
pub(crate) fn card(markdown: &str) -> Result<Value> {
    let mut events = Vec::new();
    let mut parser = Parser::new_ext(markdown, Options::ENABLE_TABLES).peekable();
    while let Some(event) = parser.next() {
        match event {
            Event::Start(Tag::Heading { .. }) => {
                events.extend([Event::Start(Tag::Paragraph), Event::Start(Tag::Strong)]);
            }
            Event::End(TagEnd::Heading(_)) => {
                events.extend([Event::End(TagEnd::Strong), Event::End(TagEnd::Paragraph)]);
            }
            Event::Start(Tag::Table(alignments)) => {
                let mut table = vec![Event::Start(Tag::Table(alignments))];
                for event in parser.by_ref() {
                    let end = matches!(event, Event::End(TagEnd::Table));
                    table.push(event);
                    if end {
                        break;
                    }
                }
                let mut text = String::new();
                pulldown_cmark_to_cmark::cmark(table.iter(), &mut text)?;
                events.extend([
                    Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced("".into()))),
                    Event::Text(text.into()),
                    Event::End(TagEnd::CodeBlock),
                ]);
            }
            Event::Html(text) | Event::InlineHtml(text) => {
                events.push(Event::Text(text.replace('<', "‹").replace('>', "›").into()));
            }
            Event::Start(Tag::HtmlBlock) => events.push(Event::Start(Tag::Paragraph)),
            Event::End(TagEnd::HtmlBlock) => events.push(Event::End(TagEnd::Paragraph)),
            event => events.push(event),
        }
    }
    let mut normalized = String::new();
    pulldown_cmark_to_cmark::cmark(events.iter(), &mut normalized)?;
    // Escaped source tags and code spans must also remain inert in the provider.
    normalized = normalized.replace('<', "‹").replace('>', "›");
    let mut chars: Vec<_> = normalized.trim().chars().take(MAX_CHARACTERS + 1).collect();
    if chars.len() > MAX_CHARACTERS {
        chars.truncate(MAX_CHARACTERS - 1);
        chars.push('…');
    }
    let elements: Vec<_> = chars
        .chunks(ELEMENT_CHARACTERS)
        .map(|chunk| {
            json!({"tag":"div","text":{"tag":"lark_md","content":chunk.iter().collect::<String>()}})
        })
        .collect();
    Ok(json!({
        "config":{"wide_screen_mode":true},
        "header":{"template":"green","title":{"tag":"plain_text","content":"SuperTag"}},
        "elements":elements
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn card_adapts_headings_tables_and_disables_native_mentions() {
        let output = card("# Done\n\nSee [logs](https://example.com). <at id=all>everyone</at>\n\n| A | B |\n|---|---|\n| 1 | 2 |\n").unwrap();
        let text = output["elements"][0]["text"]["content"].as_str().unwrap();
        assert!(text.starts_with("**Done**"), "{text}");
        assert!(text.contains("[logs](https://example.com)"), "{text}");
        assert!(text.contains("‹at id=all›everyone‹/at›"), "{text}");
        assert!(text.contains("```"), "{text}");
        assert!(!text.contains("<at"));
    }
    #[test]
    fn card_bounds_unicode_without_splitting_codepoints() {
        let output = card(&"🦀".repeat(30_000)).unwrap();
        let elements = output["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 6);
        let text: String = elements
            .iter()
            .map(|element| {
                let text = element["text"]["content"].as_str().unwrap();
                assert!(text.chars().count() <= ELEMENT_CHARACTERS);
                text
            })
            .collect();
        assert_eq!(text.chars().count(), MAX_CHARACTERS);
        assert!(text.ends_with('…'));
    }
}

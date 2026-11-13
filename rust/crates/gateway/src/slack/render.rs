//! Canonical Markdown to Slack mrkdwn and the work Session result card.
//!
//! Matches `packages/surfaces/slack/src/render.ts` and `result-card.ts`: Markdown is parsed
//! once, rendered into Slack's dialect, every provider control character in model output is
//! escaped, and the result is bounded without splitting a Unicode scalar.
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use serde_json::{Value, json};

const MAX_TEXT_CHARACTERS: usize = 39_000;
const MAX_TABLE_CELL_CHARACTERS: usize = 36;
const MAX_PULL_REQUEST_URL_BYTES: usize = 3_000;

/// Escapes the three characters Slack interprets as control sequences.
pub(crate) fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Renders canonical Markdown as bounded Slack mrkdwn. Returns `None` for empty input.
pub(crate) fn markdown(markdown: &str) -> Option<String> {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim();
    if normalized.is_empty() {
        return None;
    }
    let rendered = document(normalized);
    if rendered.chars().count() <= MAX_TEXT_CHARACTERS {
        return Some(rendered);
    }
    // Truncate the source, not the output, so markup and escapes are never split.
    let characters: Vec<char> = normalized.chars().collect();
    let (mut low, mut high) = (0_usize, characters.len());
    let mut best = "…".to_owned();
    while low <= high {
        let midpoint = (low + high) / 2;
        let source: String = characters[..midpoint].iter().collect();
        let candidate = document(&format!("{}…", source.trim_end()));
        if candidate.chars().count() <= MAX_TEXT_CHARACTERS {
            best = candidate;
            low = midpoint + 1;
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    Some(best)
}

/// Block Kit for a verified work Session delivery, or `None` when there is nothing to show.
pub(crate) fn result_card(branch: Option<&str>, pull_request_url: Option<&str>) -> Option<Value> {
    let mut blocks = vec![];
    if let Some(branch) = branch.filter(|branch| !branch.is_empty()) {
        blocks.push(json!({
            "type": "section",
            "fields": [{"type": "mrkdwn", "text": format!("*Branch*\n{}", escape(branch))}],
        }));
    }
    if let Some(url) = pull_request_url.filter(|url| github_pull_request_url(url)) {
        blocks.push(json!({
            "type": "actions",
            "elements": [{
                "type": "button",
                "text": {"type": "plain_text", "text": "Pull request", "emoji": true},
                "url": url,
                "action_id": format!("link-{url}"),
            }],
        }));
    }
    if blocks.is_empty() {
        return None;
    }
    blocks.insert(
        0,
        json!({
            "type": "header",
            "text": {"type": "plain_text", "text": "Work Session result", "emoji": true},
        }),
    );
    Some(Value::Array(blocks))
}

/// `https://github.com/OWNER/REPOSITORY/pull/NUMBER`, exactly.
pub(crate) fn github_pull_request_url(value: &str) -> bool {
    let Some(path) = value.strip_prefix("https://github.com/") else {
        return false;
    };
    let parts: Vec<&str> = path.split('/').collect();
    value.len() <= MAX_PULL_REQUEST_URL_BYTES
        && matches!(parts.as_slice(), [owner, repository, "pull", number]
            if !owner.is_empty()
                && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && !repository.is_empty()
                && repository.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                && number.bytes().next().is_some_and(|b| (b'1'..=b'9').contains(&b))
                && number.bytes().all(|b| b.is_ascii_digit()))
}

#[derive(Debug)]
enum Node {
    Text(String),
    Code(String),
    Html(String),
    Break,
    Rule,
    CodeBlock(String),
    Footnote(String),
    Element(Kind, Vec<Node>),
}

#[derive(Debug)]
enum Kind {
    Paragraph,
    Heading,
    Strong,
    Emphasis,
    Delete,
    Quote,
    List(Option<u64>),
    Item(Option<bool>),
    Link(String),
    Image(String),
    Table,
    Row,
    Cell,
    Skip,
}

fn document(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let mut stack: Vec<(Kind, Vec<Node>)> = vec![(Kind::Paragraph, vec![])];
    let mut code: Option<String> = None;
    for event in Parser::new_ext(markdown, options) {
        if let Some(text) = code.as_mut() {
            match event {
                Event::End(TagEnd::CodeBlock) => {
                    let mut value = code.take().unwrap_or_default();
                    if value.ends_with('\n') {
                        value.pop();
                    }
                    push(&mut stack, Node::CodeBlock(value));
                }
                Event::Text(value) => text.push_str(&value),
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::CodeBlock(_)) => code = Some(String::new()),
            Event::Start(tag) => {
                let kind = match tag {
                    Tag::Paragraph => Kind::Paragraph,
                    Tag::Heading { .. } => Kind::Heading,
                    Tag::Strong => Kind::Strong,
                    Tag::Emphasis => Kind::Emphasis,
                    Tag::Strikethrough => Kind::Delete,
                    Tag::BlockQuote(_) => Kind::Quote,
                    Tag::List(start) => Kind::List(start),
                    Tag::Item => Kind::Item(None),
                    Tag::Link {
                        link_type,
                        dest_url,
                        ..
                    } => Kind::Link(if link_type == LinkType::Email {
                        format!("mailto:{dest_url}")
                    } else {
                        dest_url.into_string()
                    }),
                    Tag::Image { dest_url, .. } => Kind::Image(dest_url.into_string()),
                    Tag::Table(_) => Kind::Table,
                    Tag::TableHead | Tag::TableRow => Kind::Row,
                    Tag::TableCell => Kind::Cell,
                    Tag::FootnoteDefinition(_) => Kind::Skip,
                    _ => Kind::Paragraph,
                };
                stack.push((kind, vec![]));
            }
            Event::End(_) => {
                if stack.len() > 1
                    && let Some((kind, children)) = stack.pop()
                    && !matches!(kind, Kind::Skip)
                {
                    push(&mut stack, Node::Element(kind, children));
                }
            }
            Event::Text(value) => push(&mut stack, Node::Text(value.into_string())),
            Event::Code(value) => push(&mut stack, Node::Code(value.into_string())),
            Event::Html(value) | Event::InlineHtml(value) => {
                push(&mut stack, Node::Html(value.into_string()))
            }
            Event::SoftBreak | Event::HardBreak => push(&mut stack, Node::Break),
            Event::Rule => push(&mut stack, Node::Rule),
            Event::FootnoteReference(id) => push(&mut stack, Node::Footnote(id.into_string())),
            Event::TaskListMarker(checked) => {
                if let Some((Kind::Item(state), _)) = stack.last_mut() {
                    *state = Some(checked);
                }
            }
            Event::InlineMath(value) | Event::DisplayMath(value) => {
                push(&mut stack, Node::Text(value.into_string()))
            }
        }
    }
    let root = stack.into_iter().next().map(|(_, nodes)| nodes);
    blocks(&root.unwrap_or_default()).trim().to_owned()
}

fn push(stack: &mut [(Kind, Vec<Node>)], node: Node) {
    if let Some((_, children)) = stack.last_mut() {
        children.push(node);
    }
}

fn inline(node: &Node) -> bool {
    match node {
        Node::Text(_) | Node::Code(_) | Node::Break | Node::Footnote(_) => true,
        Node::Html(value) => !value.ends_with('\n'),
        Node::Element(kind, _) => matches!(
            kind,
            Kind::Strong | Kind::Emphasis | Kind::Delete | Kind::Link(_) | Kind::Image(_)
        ),
        Node::Rule | Node::CodeBlock(_) => false,
    }
}

/// Blocks joined by blank lines. Inline runs, as in a tight list item, form one paragraph.
fn blocks(nodes: &[Node]) -> String {
    let mut parts = vec![];
    let mut run = String::new();
    let mut in_run = false;
    for node in nodes {
        if inline(node) {
            run.push_str(&render(node));
            in_run = true;
            continue;
        }
        if in_run {
            parts.push(std::mem::take(&mut run));
            in_run = false;
        }
        parts.push(render(node));
    }
    if in_run {
        parts.push(run);
    }
    parts.retain(|part| !part.is_empty());
    parts.join("\n\n")
}

fn inlines(nodes: &[Node]) -> String {
    nodes.iter().map(render).collect()
}

fn render(node: &Node) -> String {
    match node {
        Node::Text(value) => escape(value),
        Node::Code(value) => format!("`{}`", escape(value).replace('`', "ˋ")),
        Node::Html(value) => escape(value.trim_end_matches('\n')),
        Node::Break => "\n".into(),
        Node::Rule => "────────".into(),
        Node::CodeBlock(value) => format!("```\n{}\n```", escape(value)),
        Node::Footnote(id) => format!("[^{}]", escape(id)),
        Node::Element(kind, children) => match kind {
            Kind::Paragraph | Kind::Cell | Kind::Row | Kind::Skip => inlines(children),
            Kind::Heading | Kind::Strong => format!("*{}*", inlines(children)),
            Kind::Emphasis => format!("_{}_", inlines(children)),
            Kind::Delete => format!("~{}~", inlines(children)),
            Kind::Quote => blocks(children)
                .split('\n')
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n"),
            Kind::List(start) => list(*start, children),
            Kind::Item(_) => blocks(children),
            Kind::Link(url) => link(url, &plain(children)),
            Kind::Image(url) => {
                let alt = plain(children);
                link(
                    url,
                    &format!("Image: {}", if alt.is_empty() { "image" } else { &alt }),
                )
            }
            Kind::Table => table(children),
        },
    }
}

fn list(start: Option<u64>, items: &[Node]) -> String {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let marker = start.map_or_else(
                || "•".to_owned(),
                |start| format!("{}.", start.saturating_add(index as u64)),
            );
            let (checked, content) = match item {
                Node::Element(Kind::Item(checked), children) => (*checked, blocks(children)),
                other => (None, render(other)),
            };
            let checked = match checked {
                Some(true) => "[x] ",
                Some(false) => "[ ] ",
                None => "",
            };
            let mut lines = content.split('\n');
            let first = lines.next().unwrap_or_default();
            let rest: String = lines.map(|line| format!("\n  {line}")).collect();
            format!("{marker} {checked}{first}{rest}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn link(url: &str, label: &str) -> String {
    let safe = !url.contains(['|', '<', '>', '\r', '\n'])
        && reqwest::Url::parse(url)
            .is_ok_and(|url| matches!(url.scheme(), "https" | "http" | "mailto"));
    if safe {
        format!("<{url}|{}>", escape(label))
    } else {
        format!("{} ({})", escape(label), escape(url))
    }
}

fn plain(nodes: &[Node]) -> String {
    nodes
        .iter()
        .map(|node| match node {
            Node::Text(value) | Node::Code(value) | Node::Html(value) => value.clone(),
            Node::CodeBlock(value) => value.clone(),
            Node::Break => "\n".into(),
            Node::Element(_, children) => plain(children),
            Node::Rule | Node::Footnote(_) => String::new(),
        })
        .collect()
}

fn table(rows: &[Node]) -> String {
    let rows: Vec<Vec<String>> = rows
        .iter()
        .map(|row| match row {
            Node::Element(_, cells) => cells
                .iter()
                .map(|cell| {
                    let text = match cell {
                        Node::Element(_, children) => plain(children),
                        other => plain(std::slice::from_ref(other)),
                    };
                    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    if normalized.chars().count() <= MAX_TABLE_CELL_CHARACTERS {
                        normalized
                    } else {
                        let mut cut: String = normalized
                            .chars()
                            .take(MAX_TABLE_CELL_CHARACTERS - 1)
                            .collect();
                        cut.push('…');
                        cut
                    }
                })
                .collect(),
            _ => vec![],
        })
        .collect();
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|column| {
            rows.iter()
                .map(|row| row.get(column).map_or(0, |cell| cell.chars().count()))
                .max()
                .unwrap_or(0)
                .max(3)
        })
        .collect();
    let line = |row: &[String]| {
        widths
            .iter()
            .enumerate()
            .map(|(column, width)| {
                let cell = row.get(column).map_or("", String::as_str);
                format!(
                    "{cell}{}",
                    " ".repeat(width.saturating_sub(cell.chars().count()))
                )
            })
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_owned()
    };
    let mut lines = vec![];
    if let Some((header, body)) = rows.split_first() {
        lines.push(line(header));
        lines.push(
            widths
                .iter()
                .map(|width| "-".repeat(*width))
                .collect::<Vec<_>>()
                .join("  "),
        );
        lines.extend(body.iter().map(|row| line(row)));
    }
    format!("```\n{}\n```", escape(&lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected strings are the TypeScript renderer's output for the same input
    // (`tests/surface-rendering.test.ts` and `packages/surfaces/slack/src/render.ts`).
    #[test]
    fn converts_canonical_markdown_and_suppresses_raw_mention_syntax() {
        let source = [
            "# Result",
            "",
            "**bold** and *italic* and ~~old~~.",
            "[docs](https://example.com?a=1&b=2)",
            "`[code](https://example.com) <T>` & <@U123>",
        ]
        .join("\n");
        assert_eq!(
            markdown(&source).unwrap(),
            [
                "*Result*",
                "",
                "*bold* and _italic_ and ~old~.",
                "<https://example.com?a=1&b=2|docs>",
                "`[code](https://example.com) &lt;T&gt;` &amp; &lt;@U123&gt;",
            ]
            .join("\n")
        );
    }

    #[test]
    fn code_blocks_tables_lists_and_links_match_the_typescript_renderer() {
        for (source, expected) in [
            (
                "```md\n[docs](https://example.com)\n```",
                "```\n[docs](https://example.com)\n```",
            ),
            (
                "| Component | Expected rendering |\n| --- | --- |\n| Markdown AST | Parsed once |\n| Slack | Native mrkdwn |",
                "```\nComponent     Expected rendering\n------------  ------------------\nMarkdown AST  Parsed once\nSlack         Native mrkdwn\n```",
            ),
            (
                "| a | b |\n| - | - |\n| 1 |",
                "```\na    b\n---  ---\n1\n```",
            ),
            ("- a\n- b\n\n1. x\n2. y", "• a\n• b\n\n1. x\n2. y"),
            ("3. c\n4. d", "3. c\n4. d"),
            ("* a\n\n* b", "• a\n• b"),
            ("- [x] done\n- [ ] todo", "• [x] done\n• [ ] todo"),
            (
                "1. one\n   continued\n\n   para",
                "1. one\n  continued\n  \n  para",
            ),
            ("> quote\n> more", "> quote\n> more"),
            ("a  \nb", "a\nb"),
            ("a\nb", "a\nb"),
            ("---", "────────"),
            (
                "![alt](https://x.y/z.png)",
                "<https://x.y/z.png|Image: alt>",
            ),
            ("[r][1]\n\n[1]: https://e.com", "<https://e.com|r>"),
            ("[bad](javascript:alert)", "bad (javascript:alert)"),
            ("a <b>html</b>", "a &lt;b&gt;html&lt;/b&gt;"),
            ("x[^1]\n\n[^1]: note", "x[^1]"),
            ("***both***", "_*both*_"),
            ("Heading\n===", "*Heading*"),
            (
                "<https://auto.link>",
                "<https://auto.link|https://auto.link>",
            ),
            ("   lead", "lead"),
        ] {
            assert_eq!(markdown(source).unwrap(), expected, "{source:?}");
        }
        assert_eq!(markdown(" \r\n "), None);
    }

    #[test]
    fn bounds_long_output_without_splitting_unicode() {
        let rendered = markdown(&format!("**Result**\n{}", "🟣".repeat(40_000))).unwrap();
        assert_eq!(rendered.chars().count(), 39_000);
        assert!(rendered.starts_with("*Result*"));
        assert!(rendered.ends_with('…'));
    }

    // `tests/slack-result-card.test.ts`; payloads are the exact TypeScript Block Kit output.
    #[test]
    fn result_card_is_exact_block_kit_and_omits_sections_without_data() {
        let url = "https://github.com/example/supertag/pull/42";
        let header = json!({"text":{"emoji":true,"text":"Work Session result","type":"plain_text"},"type":"header"});
        let actions = json!({"elements":[{"action_id":format!("link-{url}"),"text":{"emoji":true,"text":"Pull request","type":"plain_text"},"type":"button","url":url}],"type":"actions"});
        assert_eq!(result_card(None, Some(url)), Some(json!([header, actions])));
        assert_eq!(
            result_card(Some("supertag/session/<!channel> & x"), Some(url)),
            Some(json!([
                header,
                {"fields":[{"text":"*Branch*\nsupertag/session/&lt;!channel&gt; &amp; x","type":"mrkdwn"}],"type":"section"},
                actions,
            ]))
        );
        assert_eq!(result_card(None, None), None);
        // A URL that is not exactly a GitHub pull request never reaches the card.
        for url in [
            "https://github.com.example.net/example/supertag/pull/42",
            "http://github.com/acme/app/pull/7",
            "https://gitlab.com/acme/app/pull/7",
            "https://github.com/acme/app/issues/7",
            "https://github.com/acme/app/pull/7/files",
            "https://github.com/acme/app/pull/07",
        ] {
            assert_eq!(result_card(None, Some(url)), None, "{url}");
            assert!(
                !result_card(Some("b"), Some(url))
                    .unwrap()
                    .to_string()
                    .contains("pull")
            );
        }
    }
}

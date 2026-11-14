//! The shared secret-redaction rules for text a harness produces: Task events, results, questions,
//! Workstream posts, and Mailbox messages.
//!
//! Ported from `packages/runtime/sdk/src/redaction.ts`. Two kinds of secret are hidden:
//!
//! - Explicit credentials found in the text itself: URL userinfo (`scheme://user:password@host`),
//!   credential query parameters (`?access_token=...`), and `Basic` authorization values.
//! - Values the host knows: the values of credential-named environment variables and of URL
//!   variables' userinfo and credential parameters, matched with their percent, JSON, and base64
//!   encodings. A short or word-like value is a low-confidence hint that is masked only as a whole
//!   word outside URLs.
//!
//! Escaped diagnostics (JSON escapes and percent encoding) are decoded up to three times, and the
//! decoded text is kept only when decoding reveals a credential.

use std::sync::LazyLock;

use regex::Regex;

pub const REDACTED: &str = "[REDACTED]";

static STORAGE_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[_-])(?:store|directory|dir|path|file)$").unwrap());
static CREDENTIAL_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)token|secret|password|passphrase|pwd|credential|authorization|cookie|jwt|signature|api[_-]?key|access_?key|private_?key|sshkey").unwrap()
});
static URL_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[_-])url$").unwrap());
static BASIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bBasic\s+[a-z\d+/_-]+=*").unwrap());
static PROTECTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"supertag-artifact:sha256:[a-f0-9]{64}|\[REDACTED\]").unwrap());
static URI_RUN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)[a-z][a-z\d+.-]*://[^\s<>"']*|(?:urn|mailto|tel|data|file):[^\s<>"']*|supertag-artifact:sha256:[a-f0-9]{64}|//[^\s<>"']*|\[REDACTED\]"#).unwrap()
});

const ENVIRONMENT_CREDENTIAL_SEGMENTS: &[&str] = &[
    "KEY",
    "SK",
    "TOKEN",
    "SECRET",
    "PASS",
    "PASSWD",
    "PASSWORD",
    "PWD",
    "PAT",
    "CREDENTIAL",
    "CREDENTIALS",
    "AUTH",
    "COOKIE",
];

/// Whether a variable or field name holds a credential. Storage locations such as
/// `PASSWORD_STORE_DIR` name where a credential is kept, not the credential.
pub fn is_sensitive_name(name: &str) -> bool {
    if STORAGE_SUFFIX.is_match(name) {
        return false;
    }
    CREDENTIAL_NAME.is_match(name) || environment_credential(name)
}

fn environment_credential(name: &str) -> bool {
    let environment = name
        .bytes()
        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && name.bytes().any(|byte| byte.is_ascii_uppercase());
    environment
        && name
            .split('_')
            .any(|segment| ENVIRONMENT_CREDENTIAL_SEGMENTS.contains(&segment))
}

fn credential_storage_name(name: &str) -> bool {
    STORAGE_SUFFIX.is_match(name) && CREDENTIAL_NAME.is_match(&STORAGE_SUFFIX.replace(name, ""))
}

fn path_like(value: &str) -> bool {
    let value = value.trim();
    let bytes = value.as_bytes();
    let rest = value
        .strip_prefix('~')
        .or_else(|| value.strip_prefix(".."))
        .or_else(|| value.strip_prefix('.'))
        .unwrap_or(value);
    rest.starts_with(['/', '\\'])
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

fn sensitive_query_name(name: &str) -> bool {
    name.split(['[', ']']).any(|part| {
        let key = part.trim();
        CREDENTIAL_NAME.is_match(key) || key.eq_ignore_ascii_case("key")
    })
}

/// A value to hide. High-confidence values match anywhere; a low-confidence hint matches only as
/// a whole word outside URLs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SensitiveValue {
    High(String),
    Low(String),
}

impl SensitiveValue {
    fn text(&self) -> &str {
        match self {
            Self::High(value) | Self::Low(value) => value,
        }
    }
}

fn ordinary_word(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let rest = chars.as_str();
    value.chars().all(|c| c.is_ascii_lowercase())
        || value.chars().all(|c| c.is_ascii_uppercase())
        || (first.is_ascii_uppercase()
            && !rest.is_empty()
            && rest.chars().all(|c| c.is_ascii_lowercase()))
}

fn plausible_secret(value: &str) -> bool {
    value.chars().count() >= 8 && !ordinary_word(value)
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Decodes JSON string escapes and percent-encoded runs, not arbitrary application data.
fn decode_diagnostic(text: &str) -> String {
    // JSON escapes.
    let mut unescaped = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('\\') {
        unescaped.push_str(&rest[..index]);
        let tail = &rest[index + 1..];
        let mut chars = tail.chars();
        let replacement = match chars.next() {
            Some('"') => Some(('"', 1)),
            Some('\\') => Some(('\\', 1)),
            Some('/') => Some(('/', 1)),
            Some('b') => Some(('\u{8}', 1)),
            Some('f') => Some(('\u{c}', 1)),
            Some('n') => Some(('\n', 1)),
            Some('r') => Some(('\r', 1)),
            Some('t') => Some(('\t', 1)),
            Some('u') => tail
                .get(1..5)
                .filter(|digits| digits.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .and_then(|digits| u32::from_str_radix(digits, 16).ok())
                .map(|code| (char::from_u32(code).unwrap_or('\u{fffd}'), 5)),
            _ => None,
        };
        match replacement {
            Some((character, length)) => {
                unescaped.push(character);
                rest = &tail[length..];
            }
            None => {
                unescaped.push('\\');
                rest = tail;
            }
        }
    }
    unescaped.push_str(rest);
    // Percent-encoded runs.
    let bytes = unescaped.as_bytes();
    let mut output = String::with_capacity(unescaped.len());
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        let mut decoded = Vec::new();
        while index + 2 < bytes.len()
            && bytes[index] == b'%'
            && let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
        {
            decoded.push(high * 16 + low);
            index += 3;
        }
        if decoded.is_empty() {
            let character = unescaped[index..].chars().next().unwrap_or_default();
            output.push(character);
            index += character.len_utf8().max(1);
            continue;
        }
        match String::from_utf8(decoded.clone()) {
            Ok(text) => output.push_str(&text),
            Err(_) => {
                // Keep invalid UTF-8 bytes, but do not let them hide adjacent ASCII delimiters.
                for (offset, byte) in decoded.into_iter().enumerate() {
                    if byte < 128 {
                        output.push(char::from(byte));
                    } else {
                        let at = start + offset * 3;
                        output.push_str(&unescaped[at..at + 3]);
                    }
                }
            }
        }
    }
    output
}

/// The end of a candidate userinfo run: whitespace, a quote, or an angle bracket.
fn run_end(text: &str) -> usize {
    text.find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
        .unwrap_or(text.len())
}

/// Whether `rest` (after `//`) starts with `host:port` followed by a path, query, or the end.
fn endpoint_port(rest: &str) -> bool {
    let Some(colon) = rest.find(':') else {
        return false;
    };
    let host = &rest[..colon];
    if host.is_empty() || host.contains(['/', '\\', '?', '#', '@']) {
        return false;
    }
    let after = &rest[colon + 1..];
    let digits = after.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0
        && after[..digits]
            .parse::<u32>()
            .is_ok_and(|port| port <= 65535)
        && after[digits..]
            .chars()
            .next()
            .is_none_or(|c| matches!(c, '/' | '\\' | '?' | '#') || c.is_whitespace())
}

/// Replaces URL userinfo with `[REDACTED]`, collecting passwords and token-shaped usernames.
fn redact_url_userinfo(text: &str, collect: &mut dyn FnMut(&str)) -> String {
    let mut output = String::with_capacity(text.len());
    // Text before `position` is in `output`; the next `//` is searched from `search`.
    let mut position = 0;
    let mut search = 0;
    while let Some(found) = text[search..].find("//") {
        let start = search + found + 2;
        let rest = &text[start..];
        let mut end = run_end(rest);
        // Consume a whole run without `@` at once: no URL in it has userinfo. Retrying at every
        // `//` would be quadratic.
        if !rest[..end].contains('@') {
            search = start + end;
            continue;
        }
        output.push_str(&text[position..start]);
        position = start;
        search = start;
        // Another URL in the same run bounds this one.
        if let Some(next) = rest[..end].find("://") {
            end = rest[..next]
                .rfind(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
                .map_or(0, |index| index + 1);
        }
        let candidate = &rest[..end];
        let prefix = candidate
            .find([':', '/', '\\', '?', '#', '@'])
            .is_some_and(|index| candidate.as_bytes()[index] == b':');
        let password_prefix = prefix && !endpoint_port(candidate);
        let authority = if password_prefix {
            candidate
        } else {
            let stop = candidate
                .find(['/', '\\', '?', '#', ',', ';', '|'])
                .unwrap_or(candidate.len());
            &candidate[..stop]
        };
        let Some(at) = authority.rfind('@') else {
            continue;
        };
        let userinfo = &authority[..at];
        let (username, password) = match userinfo.split_once(':') {
            Some((username, password)) => (username, Some(password)),
            None => (userinfo, None),
        };
        if (username.is_empty() && password.is_none()) || username.contains(['/', '\\', '?', '#']) {
            continue;
        }
        if let Some(password) = password
            && !password.is_empty()
        {
            collect(password);
        }
        if [
            "ghp_",
            "gho_",
            "ghu_",
            "ghs_",
            "ghr_",
            "github_pat_",
            "glpat-",
            "npm_",
            "sk-",
        ]
        .iter()
        .any(|prefix| username.starts_with(prefix))
            || (username.starts_with("xox")
                && username
                    .as_bytes()
                    .get(3..5)
                    .is_some_and(|tail| b"baprs".contains(&tail[0]) && tail[1] == b'-'))
        {
            collect(username);
        }
        output.push_str(REDACTED);
        position = start + at;
        search = position;
    }
    output.push_str(&text[position..]);
    output
}

/// Redacts URL userinfo and credential query parameters, collecting each value removed.
fn redact_url_credentials(text: &str, collect: &mut dyn FnMut(&str)) -> String {
    let safe = redact_url_userinfo(text, collect);
    let mut output = String::with_capacity(safe.len());
    let mut position = 0;
    let bytes = safe.as_bytes();
    while let Some(found) = safe[position..].find(['?', '&', '#']) {
        let separator = position + found;
        output.push_str(&safe[position..=separator]);
        let name_start = separator + 1;
        let name_end = safe[name_start..]
            .find(|c: char| {
                matches!(c, '=' | '&' | '#' | '"' | '<' | '>') || (c.is_whitespace() && c != ' ')
            })
            .map_or(safe.len(), |index| name_start + index);
        let name = &safe[name_start..name_end];
        if name_end < safe.len() && bytes[name_end] == b'=' && !name.is_empty() {
            let value_start = name_end + 1;
            let value_end = safe[value_start..]
                .find(|c: char| matches!(c, '&' | '#' | '"' | '<' | '>') || c.is_whitespace())
                .map_or(safe.len(), |index| value_start + index);
            if sensitive_query_name(name) {
                collect(&safe[value_start..value_end]);
                output.push_str(name);
                output.push('=');
                output.push_str(REDACTED);
                position = value_end;
                continue;
            }
        }
        position = name_start;
    }
    output.push_str(&safe[position..]);
    output
}

fn named_sensitive_values(name: &str, value: &str) -> Vec<String> {
    let mut values = Vec::new();
    let trimmed = value.trim();
    let plain_word = !trimmed.is_empty()
        && trimmed.len() <= 16
        && trimmed.bytes().all(|byte| byte.is_ascii_lowercase());
    if is_sensitive_name(name)
        || (credential_storage_name(name) && !path_like(value) && !plain_word)
    {
        values.push(value.to_owned());
    }
    if URL_NAME.is_match(name) {
        let mut decoded = value.to_owned();
        for _ in 0..3 {
            let mut found = Vec::new();
            let safe = redact_url_credentials(&decoded, &mut |credential| {
                found.push(credential.to_owned());
            });
            for mut credential in found {
                if credential == REDACTED {
                    continue;
                }
                for _ in 0..3 {
                    values.push(credential.clone());
                    let next = decode_diagnostic(&credential);
                    if next == credential {
                        break;
                    }
                    credential = next;
                }
            }
            let next = decode_diagnostic(&safe);
            if next == safe {
                break;
            }
            decoded = next;
        }
    }
    values
}

/// Unique values, longest first. A high-confidence value replaces a low-confidence one.
pub fn unique_sensitive_values(values: Vec<SensitiveValue>) -> Vec<SensitiveValue> {
    let mut unique: Vec<SensitiveValue> = Vec::new();
    for value in values {
        if value.text().is_empty() {
            continue;
        }
        match unique.iter_mut().find(|item| item.text() == value.text()) {
            Some(existing) => {
                if matches!(value, SensitiveValue::High(_)) {
                    *existing = value;
                }
            }
            None => unique.push(value),
        }
    }
    unique.sort_by_key(|value| std::cmp::Reverse(value.text().len()));
    unique
}

/// The secrets an environment holds: credential-named variables and URL variables' credentials.
pub fn sensitive_environment_values<'a>(
    environment: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<SensitiveValue> {
    let mut values = Vec::new();
    for (name, value) in environment {
        // The shell's working-directory variables hold locations, not passwords.
        if name == "PWD" || name == "OLDPWD" {
            continue;
        }
        let url = URL_NAME.is_match(name);
        for secret in named_sensitive_values(name, value) {
            if url || plausible_secret(&secret) {
                values.push(SensitiveValue::High(secret));
            } else if secret.chars().count() >= 4
                && !["true", "false", "yes", "no"]
                    .iter()
                    .any(|word| secret.eq_ignore_ascii_case(word))
                && !secret.bytes().all(|byte| byte.is_ascii_digit())
            {
                values.push(SensitiveValue::Low(secret));
            }
        }
    }
    unique_sensitive_values(values)
}

fn base64(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..=chunk.len() {
            output.push(char::from(
                alphabet[(value >> (18 - 6 * index)) as usize & 63],
            ));
        }
        if pad {
            for _ in chunk.len()..3 {
                output.push('=');
            }
        }
    }
    output
}

fn percent_encode_component(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

/// The encoded forms in which a known credential is recognized.
fn encoded_forms(value: &str) -> Vec<String> {
    const STANDARD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let json = serde_json::to_string(value).unwrap_or_default();
    vec![
        value.to_owned(),
        percent_encode_component(value),
        json[1..json.len().saturating_sub(1).max(1)].to_owned(),
        base64(value.as_bytes(), STANDARD, true),
        base64(value.as_bytes(), STANDARD, false),
        base64(value.as_bytes(), URL_SAFE, false),
    ]
}

/// The longest text `redact_text` matches for a known value.
pub fn redaction_span(values: &[SensitiveValue]) -> usize {
    values
        .iter()
        .map(|value| match value {
            SensitiveValue::High(value) => encoded_forms(value)
                .iter()
                .map(String::len)
                .max()
                .unwrap_or(0),
            SensitiveValue::Low(value) => value.len(),
        })
        .max()
        .unwrap_or(0)
}

/// Applies `transform` to the text outside `[REDACTED]` markers and artifact references.
fn outside_protected(input: &str, transform: impl Fn(&str) -> String) -> String {
    let mut output = String::with_capacity(input.len());
    let mut position = 0;
    for found in PROTECTED.find_iter(input) {
        output.push_str(&transform(&input[position..found.start()]));
        output.push_str(found.as_str());
        position = found.end();
    }
    output.push_str(&transform(&input[position..]));
    output
}

fn word_character(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Masks a low-confidence hint as a whole word, case-insensitively.
fn redact_word(text: &str, value: &str) -> String {
    let lower_text = text.to_lowercase();
    let lower_value = value.to_lowercase();
    if lower_text.len() != text.len() || lower_value.is_empty() {
        // Lowercasing changed byte offsets; match case-sensitively instead.
        return redact_word_exact(text, value);
    }
    let mut output = String::with_capacity(text.len());
    let mut position = 0;
    let mut search = 0;
    while let Some(found) = lower_text[search..].find(&lower_value) {
        let start = search + found;
        let end = start + lower_value.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        if before.is_none_or(|c| !word_character(c)) && after.is_none_or(|c| !word_character(c)) {
            output.push_str(&text[position..start]);
            output.push_str(REDACTED);
            position = end;
            search = end;
        } else {
            search = start + text[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    output.push_str(&text[position..]);
    output
}

fn redact_word_exact(text: &str, value: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut position = 0;
    for (start, _) in text.match_indices(value) {
        if start < position {
            continue;
        }
        let end = start + value.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        if before.is_none_or(|c| !word_character(c)) && after.is_none_or(|c| !word_character(c)) {
            output.push_str(&text[position..start]);
            output.push_str(REDACTED);
            position = end;
        }
    }
    output.push_str(&text[position..]);
    output
}

/// Hides every credential in `text`. With `structural`, low-confidence hints are not applied, as
/// for identifiers and enum values whose short words must stay readable.
pub fn redact_text(text: &str, values: &[SensitiveValue], structural: bool) -> String {
    let mut forms = Vec::new();
    let mut low = Vec::new();
    for value in values {
        match value {
            SensitiveValue::High(value) => {
                forms.extend(encoded_forms(value).into_iter().map(SensitiveValue::High));
            }
            SensitiveValue::Low(value) if !structural => {
                low.push(SensitiveValue::Low(value.clone()))
            }
            SensitiveValue::Low(_) => {}
        }
    }
    let high = unique_sensitive_values(forms)
        .into_iter()
        .map(|value| value.text().to_owned())
        .collect::<Vec<_>>();
    let low = unique_sensitive_values(low)
        .into_iter()
        .map(|value| value.text().to_owned())
        .collect::<Vec<_>>();
    let redact_words = |input: &str| -> String {
        if low.is_empty() {
            return input.to_owned();
        }
        // URI runs never receive low-confidence replacement.
        let mut output = String::with_capacity(input.len());
        let mut position = 0;
        let words = |part: &str| {
            low.iter()
                .fold(part.to_owned(), |safe, value| redact_word(&safe, value))
        };
        for found in URI_RUN.find_iter(input) {
            output.push_str(&words(&input[position..found.start()]));
            output.push_str(found.as_str());
            position = found.end();
        }
        output.push_str(&words(&input[position..]));
        output
    };
    let replace_high = |part: &str| -> String {
        // One left-to-right pass, longest value first at each position.
        if high.is_empty() {
            return part.to_owned();
        }
        let mut output = String::with_capacity(part.len());
        let mut position = 0;
        let mut index = 0;
        while index < part.len() {
            if let Some(value) = high
                .iter()
                .find(|value| part[index..].starts_with(value.as_str()))
            {
                output.push_str(&part[position..index]);
                output.push_str(REDACTED);
                index += value.len();
                position = index;
            } else {
                index += part[index..].chars().next().map_or(1, char::len_utf8);
            }
        }
        output.push_str(&part[position..]);
        output
    };
    let protected_redact = |input: &str| -> String {
        let safe = outside_protected(input, |part| {
            let urls = redact_url_credentials(part, &mut |_| {});
            BASIC.replace_all(&urls, "Basic [REDACTED]").into_owned()
        });
        let high_safe = outside_protected(&safe, replace_high);
        redact_words(&high_safe)
    };
    let mut safe = protected_redact(text);
    let mut decoded = safe.clone();
    for _ in 0..3 {
        let next = decode_diagnostic(&decoded);
        if next == decoded {
            break;
        }
        decoded = next;
        let redacted = protected_redact(&decoded);
        if redacted != decoded {
            safe = redacted.clone();
            decoded = redacted;
        }
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::{SensitiveValue::*, *};

    fn environment(pairs: &[(&str, &str)]) -> Vec<SensitiveValue> {
        sensitive_environment_values(pairs.iter().copied())
    }

    fn redact(text: &str) -> String {
        redact_text(text, &[], false)
    }

    // packages/runtime/sdk/redaction.test.ts
    #[test]
    fn ignores_tiny_boolean_and_short_numeric_host_hints() {
        assert_eq!(
            environment(&[
                ("TOKEN_ENABLED", "false"),
                ("TOKEN_DEBUG", "true"),
                ("TOKEN_COUNT", "123456"),
                ("TOKEN_RATIO", "1.234"),
                ("TOKEN_FLAG", "1"),
                ("BRANCH_KEY", "abc"),
                ("REAL_TOKEN", "long-secret"),
            ]),
            [High("long-secret".into()), Low("1.234".into())]
        );
    }

    #[test]
    fn redacts_unescaped_separators_in_url_passwords() {
        for separator in ["/", "//", "?", "#", ","] {
            assert_eq!(
                redact(&format!("https://user:pa{separator}ss@example.test/path")),
                "https://[REDACTED]@example.test/path",
                "{separator}"
            );
        }
    }

    #[test]
    fn keeps_ordinary_escaped_text_and_handles_malformed_encoding() {
        for text in [
            r"C:\Temp\Users\File",
            r"literal \u0041",
            "https://example.test/%ff",
        ] {
            assert_eq!(redact(text), text);
        }
        assert!(!redact("https%3A%2F%2F%ffuser:password%40example.test").contains("password"));
    }

    #[test]
    fn redacts_encoded_url_credentials() {
        for url in [
            r"https:\/\/user:password@example.test/path",
            r"https:\u002f\u002fuser:password\u0040example.test/path",
            "https%3A%2F%2Fuser%3Apassword%40example.test%2Fpath",
            "https://user:password%40example.test/path",
        ] {
            let safe = redact(url);
            assert!(!safe.contains("user"), "{url}: {safe}");
            assert!(!safe.contains("password"), "{url}: {safe}");
            assert!(safe.contains(REDACTED), "{url}: {safe}");
        }
    }

    #[test]
    fn redacts_query_credentials() {
        for key in [
            "access_token",
            "X-Amz-Signature",
            "secretAccessKey",
            "provider_token",
            "provider_secret",
            "key",
            "user[password]",
        ] {
            let url = format!("https://example.test/path?{key}=query-secret&safe=yes");
            for text in [url.clone(), percent_encode_component(&url)] {
                let safe = redact(&text);
                assert!(!safe.contains("query-secret"), "{text}: {safe}");
                assert!(safe.contains(REDACTED), "{text}");
            }
        }
        assert_eq!(
            redact("https://example.test/?q=search&page=2"),
            "https://example.test/?q=search&page=2"
        );
    }

    #[test]
    fn redacts_percent_json_base64_and_basic_copies_of_host_secrets() {
        let secret = "host/pass?word#\"value\\end";
        let values = environment(&[("HOST_PASSWORD", secret)]);
        const STANDARD: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let json = serde_json::to_string(secret).unwrap();
        for encoded in [
            percent_encode_component(secret),
            json[1..json.len() - 1].to_owned(),
            base64(secret.as_bytes(), STANDARD, true),
            format!(
                "Basic {}",
                base64(format!("username:{secret}").as_bytes(), STANDARD, true)
            ),
        ] {
            let safe = redact_text(&format!("failed: {encoded}"), &values, false);
            assert!(!safe.contains(&encoded), "{safe}");
            assert!(!safe.contains(secret), "{safe}");
            assert!(safe.contains(REDACTED), "{safe}");
        }
    }

    #[test]
    fn recognizes_credential_environment_names() {
        for name in [
            "PROVIDER_API_KEY",
            "SERVICE_AUTHORIZATION",
            "DB_PASSWORD",
            "PASSPHRASE",
            "GITHUB_TOKEN",
            "PROVIDER_SECRET",
        ] {
            assert_eq!(
                environment(&[(name, "private-value")]),
                [High("private-value".into())],
                "{name}"
            );
        }
        for name in [
            "PASSWORD_STORE_DIR",
            "SECRET_STORE",
            "TOKEN_FILE",
            "PASSWORD_PATH",
            "PATH",
            "HOME",
            "PWD",
        ] {
            assert!(!is_sensitive_name(name) || name == "PWD", "{name}");
        }
        assert!(environment(&[("PASSWORD_STORE_DIR", "/home/me/.password-store")]).is_empty());
        assert!(environment(&[("PWD", "/home/me/long-directory")]).is_empty());
        assert_eq!(
            environment(&[("TOKEN_FILE", "ghp_abcdefghijklmnop")]),
            [High("ghp_abcdefghijklmnop".into())]
        );
    }

    #[test]
    fn collects_credentials_from_url_variables_without_hiding_ordinary_endpoints() {
        let values = environment(&[
            (
                "DATABASE_URL",
                "postgresql://db-user:db-password@example.test/db",
            ),
            (
                "SERVICE_URL",
                "https://example.test/?access_token=url-token-value",
            ),
            ("PUBLIC_URL", "https://example.test/public"),
        ]);
        assert_eq!(
            redact_text(
                "db-password url-token-value https://example.test/public",
                &values,
                false
            ),
            "[REDACTED] [REDACTED] https://example.test/public"
        );
    }

    #[test]
    fn redacts_url_userinfo() {
        for (input, expected) in [
            ("//user:pass@example.test/a", "//[REDACTED]@example.test/a"),
            (
                "https://user:pass@example.test/a",
                "https://[REDACTED]@example.test/a",
            ),
            (
                "postgresql://user:p%40ss@[::1]:5432/db",
                "postgresql://[REDACTED]@[::1]:5432/db",
            ),
            (
                "HTTPS://token@example.test",
                "HTTPS://[REDACTED]@example.test",
            ),
            (
                "ssh://user:p@ss@example.test/repo",
                "ssh://[REDACTED]@example.test/repo",
            ),
            (
                "https://example.test/path?email=user@example.test",
                "https://example.test/path?email=user@example.test",
            ),
            (
                "user@example.test and /local/path",
                "user@example.test and /local/path",
            ),
            (
                "http://localhost:8080/api failed for admin@example.com",
                "http://localhost:8080/api failed for admin@example.com",
            ),
            (
                "https://user:password@host/path admin@example.com",
                "https://[REDACTED]@host/path admin@example.com",
            ),
        ] {
            assert_eq!(
                redact(&format!("Failed: {input}")),
                format!("Failed: {expected}")
            );
        }
    }

    #[test]
    fn redacts_separate_credentials_in_adjacent_urls() {
        let safe = redact("https://a:first@one.test/x,https://b:second@two.test/y");
        assert!(
            !safe.contains("first") && !safe.contains("second"),
            "{safe}"
        );
        assert!(
            safe.contains("one.test/x") && safe.contains("two.test/y"),
            "{safe}"
        );
    }

    #[test]
    fn redacts_overlapping_host_secrets_longest_first() {
        let values = environment(&[
            ("PROVIDER_API_KEY", "shared-prefix"),
            ("HOST_CREDENTIAL", "shared-prefix-private-suffix"),
            ("EMPTY_TOKEN", ""),
            ("PATH", "/usr/bin"),
            ("HOME", "/home/user"),
        ]);
        assert_eq!(
            redact_text(
                "shared-prefix-private-suffix shared-prefix /usr/bin /home/user",
                &values,
                false
            ),
            "[REDACTED] [REDACTED] /usr/bin /home/user"
        );
    }

    #[test]
    fn distinguishes_url_passwords_from_ordinary_host_words() {
        let values = environment(&[
            (
                "DATABASE_URL",
                "postgres://admin:long-password@example.test/db",
            ),
            ("SERVICE_URL", "https://operator@example.test"),
            ("BRANCH_KEY", "main"),
        ]);
        assert_eq!(values, [High("long-password".into()), Low("main".into())]);
        assert_eq!(
            redact_text("admin operator main long-password", &values, false),
            "admin operator [REDACTED] [REDACTED]"
        );
        // Low-confidence hints never apply inside URLs or structural fields.
        assert_eq!(
            redact_text("https://example.test/main", &values, false),
            "https://example.test/main"
        );
        assert_eq!(redact_text("main", &values, true), "main");
    }

    #[test]
    fn keeps_artifact_references_and_markers() {
        let reference = format!("supertag-artifact:sha256:{}", "a".repeat(64));
        let values = [High("aaaaaaaa".into())];
        assert_eq!(redact_text(&reference, &values, false), reference);
        assert_eq!(
            redact_text("[REDACTED]", &[Low("REDACTED".into())], false),
            "[REDACTED]"
        );
    }

    #[test]
    fn scans_long_adversarial_input_in_bounded_time() {
        let input = "//a:b".repeat(256 * 1024 / 5);
        let started = std::time::Instant::now();
        assert_eq!(redact(&input), input);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let name = format!("{}a", "A".repeat(100_000));
        assert!(!is_sensitive_name(&name));
        let labels = "password=x ".repeat(6_000);
        let started = std::time::Instant::now();
        let _ = redact_text(&labels, &[Low("abcd".into())], false);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn redaction_span_covers_the_longest_encoding() {
        let values = [High("ab/cd".into()), Low("short".into())];
        assert_eq!(redaction_span(&values), "ab%2Fcd".len().max(8));
    }
}

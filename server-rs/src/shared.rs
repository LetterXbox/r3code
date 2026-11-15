//! Shared protocol helpers.
use std::collections::HashSet;

pub const FRAME_PART_BYTES: usize = 48 * 1024;
pub const FRAME_PART_PREFIX: char = '\u{1e}';

/// Split text frames by UTF-8 bytes, preserving scalar boundaries. All but the
/// last part are prefixed with the record separator.
pub fn split_frame(frame: &str) -> Vec<String> {
    if frame.encode_utf16().count() * 3 <= FRAME_PART_BYTES {
        return vec![frame.to_owned()];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    let mut bytes = 1;
    for (index, ch) in frame.char_indices() {
        if bytes + ch.len_utf8() > FRAME_PART_BYTES {
            parts.push(format!("{FRAME_PART_PREFIX}{}", &frame[start..index]));
            start = index;
            bytes = 1;
        }
        bytes += ch.len_utf8();
    }
    parts.push(frame[start..].to_owned());
    parts
}

fn valid_scope_token(token: &str) -> bool {
    !token.is_empty()
        && token
            .bytes()
            .all(|b| matches!(b, 0x21 | 0x23..=0x5b | 0x5d..=0x7e))
}
pub fn parse_oauth_scope(value: &str) -> Option<Vec<&str>> {
    let mut seen = HashSet::new();
    let mut scopes = Vec::new();
    for token in value.split(' ') {
        if !valid_scope_token(token) {
            return None;
        }
        if seen.insert(token) {
            scopes.push(token);
        }
    }
    Some(scopes)
}
pub fn encode_oauth_scope(scopes: &[&str]) -> Option<String> {
    let mut seen = HashSet::new();
    if scopes.is_empty()
        || scopes
            .iter()
            .any(|s| !valid_scope_token(s) || !seen.insert(*s))
    {
        return None;
    }
    Some(scopes.join(" "))
}
pub fn oauth_scope_set_equals(value: &str, expected: &[&str]) -> bool {
    let Some(scopes) = parse_oauth_scope(value) else {
        return false;
    };
    scopes.iter().collect::<HashSet<_>>() == expected.iter().collect::<HashSet<_>>()
}

pub fn parse_allowed_oauth_scope<'a>(value: &'a str, allowed: &[&str]) -> Option<Vec<&'a str>> {
    let scopes = parse_oauth_scope(value)?;
    scopes
        .iter()
        .all(|scope| allowed.contains(scope))
        .then_some(scopes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_parts_preserve_unicode_and_account_for_prefix() {
        let original = format!(
            "{}🦀{}",
            "a".repeat(FRAME_PART_BYTES - 2),
            "é".repeat(30_000)
        );
        let parts = split_frame(&original);
        assert!(parts.len() > 1);
        assert!(parts[..parts.len() - 1]
            .iter()
            .all(|part| part.starts_with(FRAME_PART_PREFIX) && part.len() <= FRAME_PART_BYTES));
        assert!(!parts.last().unwrap().starts_with(FRAME_PART_PREFIX));
        assert_eq!(
            parts
                .iter()
                .enumerate()
                .map(|(i, p)| if i + 1 < parts.len() {
                    &p[1..]
                } else {
                    p.as_str()
                })
                .collect::<String>(),
            original
        );
        assert_eq!(split_frame("small"), vec!["small"]);
        // The reference counts the prefix while scanning, including the final
        // unprefixed part; exactly 48 KiB of ASCII therefore produces two parts.
        let boundary = "x".repeat(FRAME_PART_BYTES);
        let parts = split_frame(&boundary);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].len(), FRAME_PART_BYTES);
        assert_eq!(parts[1], "x");
    }
    #[test]
    fn oauth_scope_vectors() {
        assert_eq!(parse_oauth_scope("a b a"), Some(vec!["a", "b"]));
        for invalid in ["", "a  b", "a\"b", "a\\b", "é"] {
            assert_eq!(parse_oauth_scope(invalid), None);
        }
        assert_eq!(encode_oauth_scope(&["a", "b"]), Some("a b".into()));
        assert_eq!(encode_oauth_scope(&["a", "a"]), None);
        assert!(oauth_scope_set_equals("b a a", &["a", "b"]));
        assert!(!oauth_scope_set_equals("a  b", &["a", "b"]));
        assert_eq!(parse_allowed_oauth_scope("a b", &["a"]), None);
    }
}

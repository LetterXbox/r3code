//! Parsers for the NUL-delimited formats emitted by Git.
use std::collections::HashMap;

pub fn refresh_failure_cooldown_ms(failures: u32) -> u64 {
    30_000u64
        .saturating_mul(1u64 << failures.saturating_sub(1).min(30))
        .min(900_000)
}
pub fn branch_ahead_behind(value: &str) -> (u64, u64) {
    if value.trim() != value {
        return (0, 0);
    }
    let mut fields = value.split_whitespace();
    let (Some(a), Some(b), None) = (fields.next(), fields.next(), fields.next()) else {
        return (0, 0);
    };
    let (Some(a), Some(b)) = (a.strip_prefix('+'), b.strip_prefix('-')) else {
        return (0, 0);
    };
    if a.is_empty()
        || b.is_empty()
        || !a.bytes().all(|v| v.is_ascii_digit())
        || !b.bytes().all(|v| v.is_ascii_digit())
    {
        return (0, 0);
    }
    match (a.parse(), b.parse()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => (0, 0),
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct Numstat {
    pub path: String,
    pub previous_path: Option<String>,
    pub additions: u64,
    pub deletions: u64,
}
pub fn review_numstat(input: &str) -> Vec<Numstat> {
    let mut parts = input.split('\0');
    let mut rows = Vec::new();
    while let Some(record) = parts.next() {
        let mut columns = record.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (columns.next(), columns.next(), columns.next())
        else {
            continue;
        };
        let parse = |s: &str| {
            if s == "-" {
                Some(0)
            } else if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
                s.parse().ok()
            } else {
                None
            }
        };
        let (Some(additions), Some(deletions)) = (parse(a), parse(d)) else {
            continue;
        };
        let (path, previous_path) = if path.is_empty() {
            match (parts.next(), parts.next()) {
                (Some(old), Some(new)) => (new, Some(old.to_owned())),
                _ => break,
            }
        } else {
            (path, None)
        };
        rows.push(Numstat {
            path: path.to_owned(),
            previous_path,
            additions,
            deletions,
        });
    }
    rows
}
pub fn porcelain_path(record: &str) -> Option<&str> {
    let fields = match record.as_bytes().first()? {
        b'1' => 8,
        b'2' => 9,
        b'u' => 10,
        b'?' | b'!' => 1,
        _ => return None,
    };
    let mut position = 0;
    for _ in 0..fields {
        position += record[position..].find(' ')? + 1;
    }
    let path = &record[position..];
    (!path.is_empty()).then_some(path)
}
pub fn worktree_branches(input: &str) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let (mut path, mut branch, mut prunable) = (None, None, false);
    let flush = |result: &mut HashMap<String, String>,
                 path: &mut Option<String>,
                 branch: &mut Option<String>,
                 prunable: &mut bool| {
        if let (Some(p), Some(b), false) = (path.take(), branch.take(), *prunable) {
            result.insert(b, p);
        }
        *prunable = false;
    };
    for field in input.split('\0') {
        if field.is_empty() {
            flush(&mut result, &mut path, &mut branch, &mut prunable);
        } else if let Some(v) = field.strip_prefix("worktree ") {
            path = Some(v.to_owned())
        } else if let Some(v) = field.strip_prefix("branch refs/heads/") {
            branch = Some(v.to_owned())
        } else if field == "prunable" || field.starts_with("prunable ") {
            prunable = true
        }
    }
    flush(&mut result, &mut path, &mut branch, &mut prunable);
    result
}
pub fn nul_paths(input: &str, truncated: bool) -> Vec<&str> {
    let mut fields: Vec<&str> = input.split('\0').collect();
    if truncated && fields.last().is_some_and(|s| !s.is_empty()) {
        fields.pop();
    }
    fields.into_iter().filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_git_records_without_losing_spaces_or_renames() {
        assert_eq!(branch_ahead_behind("+3 -12"), (3, 12));
        assert_eq!(branch_ahead_behind("+3 -x"), (0, 0));
        assert_eq!(refresh_failure_cooldown_ms(6), 900_000);
        let rows = review_numstat("3\t2\ta b\0-\t-\t\0old name\0new name\0");
        assert_eq!(
            rows,
            vec![
                Numstat {
                    path: "a b".into(),
                    previous_path: None,
                    additions: 3,
                    deletions: 2
                },
                Numstat {
                    path: "new name".into(),
                    previous_path: Some("old name".into()),
                    additions: 0,
                    deletions: 0
                }
            ]
        );
        assert_eq!(
            porcelain_path("1 .M N... 100644 100644 100644 a b file name"),
            Some("file name")
        );
        assert_eq!(nul_paths("one\0partial", true), vec!["one"]);
        let branches=worktree_branches("worktree /a b\0branch refs/heads/main\0\0worktree /gone\0branch refs/heads/dead\0prunable gitdir missing\0\0");
        assert_eq!(branches.get("main").map(String::as_str), Some("/a b"));
        assert!(!branches.contains_key("dead"));
    }
}

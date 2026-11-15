//! Migration 050: materialize legacy single pull-request links.
use rusqlite::Transaction;
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PullRequestKey {
    pub(crate) host: String,
    pub(crate) repository: String,
    pub(crate) number: i64,
}

#[derive(Debug)]
struct LegacyRow {
    thread_id: String,
    updated_at: String,
    linked_json: String,
}

/// Apply the migration body. Call from the standard per-migration transaction;
/// the outer runner records migration 050 only after this returns successfully.
pub fn apply_migration_050(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(include_str!("../migrations/050.sql"))?;
    let rows = {
        let mut statement = tx.prepare(
            "SELECT thread_id, updated_at, linked_pull_request_json \
             FROM projection_threads WHERE linked_pull_request_json IS NOT NULL",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(LegacyRow {
                    thread_id: row.get(0)?,
                    updated_at: row.get(1)?,
                    linked_json: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    for row in rows {
        let Some((repository, number, url)) = parse_legacy_link(&row.linked_json) else {
            continue;
        };
        let key = legacy_pull_request_key(&repository, number, &url);
        tx.execute(
            "INSERT OR IGNORE INTO projection_thread_pull_requests (\
               thread_id, host, repository, number, url, source, linked_at, snapshot_json, stack_json\
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'manual', ?6, NULL, NULL)",
            (
                row.thread_id,
                key.host,
                key.repository,
                number,
                url,
                row.updated_at,
            ),
        )?;
    }
    Ok(())
}

pub(crate) fn parse_legacy_link(json: &str) -> Option<(String, i64, String)> {
    let value: Value = serde_json::from_str(json).ok()?;
    let repository = value.get("repository")?.as_str()?;
    if repository.trim().is_empty() {
        return None;
    }
    let raw_number = value.get("number")?.as_f64()?;
    if !raw_number.is_finite()
        || raw_number.fract() != 0.0
        || raw_number < 1.0
        || raw_number > i64::MAX as f64
    {
        return None;
    }
    let number = raw_number as i64;
    let url = value.get("url")?.as_str()?;
    if url.trim().is_empty() {
        return None;
    }
    Some((repository.to_owned(), number, url.to_owned()))
}

pub(crate) fn legacy_pull_request_key(
    repository: &str,
    number: i64,
    target_url: &str,
) -> PullRequestKey {
    if let Some(parsed) = parse_change_request_url(target_url) {
        if parsed.key.number == number {
            let canonical =
                canonical_repository_key(&format!("{}/{}", parsed.key.host, parsed.key.repository));
            if parsed.authority.is_some() || canonical.starts_with("dev.azure.com/") {
                return normalize_key(
                    parsed.authority.as_deref().unwrap_or(&parsed.key.host),
                    &parsed.key.repository,
                    number,
                );
            }
        }
    }

    let host = Url::parse(target_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned());
    PullRequestKey {
        host: if host.trim().is_empty() {
            "unknown".to_owned()
        } else {
            host.trim().to_lowercase()
        },
        repository: repository.trim().to_lowercase(),
        number,
    }
}

#[derive(Debug)]
struct ParsedLink {
    key: PullRequestKey,
    authority: Option<String>,
}

#[derive(Debug)]
struct ParsedUrl {
    hostname: String,
    host: String,
    pathname: String,
    port: String,
}

/// A deliberately small HTTP(S) URL parser for the frozen migration rules.
/// It handles authority/userinfo/port/path/query forms used by accepted forge
/// URLs and falls back to `unknown` for malformed and non-HTTP(S) strings.
fn parse_url(input: &str) -> Option<ParsedUrl> {
    let url = Url::parse(input).ok()?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let hostname = url.host_str()?.to_ascii_lowercase();
    let port = url.port().map(|port| port.to_string()).unwrap_or_default();
    let host = match url.host() {
        Some(url::Host::Ipv6(_)) => match url.port() {
            Some(port) => format!("{hostname}:{port}"),
            None => hostname.clone(),
        },
        Some(_) => match url.port() {
            Some(port) => format!("{hostname}:{port}"),
            None => hostname.clone(),
        },
        None => return None,
    };
    Some(ParsedUrl {
        hostname,
        host,
        pathname: url.path().to_owned(),
        port,
    })
}

fn parse_change_request_url(target_url: &str) -> Option<ParsedLink> {
    let url = parse_url(target_url)?;
    let host = url.hostname.to_ascii_lowercase();
    let path = url.pathname.as_str();
    let path_segments: Vec<_> = path.split('/').skip(1).collect();

    if host == "git.cafe" || host == "staging.git.cafe" {
        if let Some(key) = parse_two_segment_route(&path_segments, &["pull", "pulls"]) {
            return Some(ParsedLink {
                key: PullRequestKey { host, ..key },
                authority: None,
            });
        }
    } else {
        if is_host_of(&host, "github.com", "github") {
            if let Some(key) = parse_two_segment_route(&path_segments, &["pull"]) {
                return Some(ParsedLink {
                    key: PullRequestKey { host, ..key },
                    authority: None,
                });
            }
        }
        if let Some(key) = parse_multi_segment_route(&path_segments, &["pulls"]) {
            return Some(ParsedLink {
                key: PullRequestKey { host, ..key },
                authority: Some(url.host),
            });
        }
        if let Some(key) = parse_gitlab_route(&path_segments) {
            return Some(ParsedLink {
                key: PullRequestKey { host, ..key },
                authority: None,
            });
        }
        if is_host_of(&host, "bitbucket.org", "bitbucket") {
            if let Some(key) = parse_two_segment_route(&path_segments, &["pull-requests"]) {
                return Some(ParsedLink {
                    key: PullRequestKey { host, ..key },
                    authority: None,
                });
            }
        }
    }
    let key = parse_azure_route(&path_segments)?;
    Some(ParsedLink {
        key: PullRequestKey { host, ..key },
        authority: (!url.port.is_empty()).then_some(url.host),
    })
}

fn parse_two_segment_route(segments: &[&str], markers: &[&str]) -> Option<PullRequestKey> {
    if segments.len() < 4 || segments[0].is_empty() || segments[1].is_empty() {
        return None;
    }
    let marker = segments[2];
    if !markers.contains(&marker) {
        return None;
    }
    let number = parse_path_number(segments[3])?;
    Some(PullRequestKey {
        host: String::new(),
        repository: format!("{}/{}", segments[0], segments[1]).to_ascii_lowercase(),
        number,
    })
}

fn parse_multi_segment_route(segments: &[&str], markers: &[&str]) -> Option<PullRequestKey> {
    let marker = segments
        .iter()
        .rposition(|segment| markers.contains(segment))?;
    if marker < 2 {
        return None;
    }
    let number = parse_path_number(segments.get(marker + 1)?)?;
    Some(PullRequestKey {
        host: String::new(),
        repository: segments[..marker].join("/").to_ascii_lowercase(),
        number,
    })
}

fn parse_gitlab_route(segments: &[&str]) -> Option<PullRequestKey> {
    let marker = segments.iter().rposition(|segment| *segment == "-")?;
    if marker < 2 || segments.get(marker + 1)? != &"merge_requests" {
        return None;
    }
    let number = parse_path_number(segments.get(marker + 2)?)?;
    Some(PullRequestKey {
        host: String::new(),
        repository: segments[..marker].join("/").to_ascii_lowercase(),
        number,
    })
}

fn parse_azure_route(segments: &[&str]) -> Option<PullRequestKey> {
    let marker = segments
        .iter()
        .rposition(|segment| *segment == "pullrequest")?;
    if marker < 2 {
        return None;
    }
    let number = parse_path_number(segments.get(marker + 1)?)?;
    if segments[marker - 1].is_empty() || segments[marker - 2] != "_git" {
        return None;
    }
    Some(PullRequestKey {
        host: String::new(),
        repository: segments[..marker].join("/").to_ascii_lowercase(),
        number,
    })
}

fn parse_path_number(segment: &str) -> Option<i64> {
    if segment.is_empty() || !segment.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let number = segment.parse::<i64>().ok()?;
    (number > 0 && number <= 9_007_199_254_740_991).then_some(number)
}

fn is_host_of(hostname: &str, apex: &str, label: &str) -> bool {
    hostname == apex
        || hostname.ends_with(&format!(".{apex}"))
        || hostname.split('.').any(|part| part == label)
}

fn canonical_repository_key(key: &str) -> String {
    if let Some(rest) = key
        .strip_prefix("ssh.dev.azure.com/v3/")
        .or_else(|| key.strip_prefix("vs-ssh.visualstudio.com/v3/"))
    {
        let parts: Vec<_> = rest.split('/').collect();
        if parts.len() == 3 {
            return format!("dev.azure.com/{}/{}/_git/{}", parts[0], parts[1], parts[2]);
        }
    }
    if let Some((organization, rest)) = key.split_once(".visualstudio.com/") {
        if !organization.contains('.') {
            let parts: Vec<_> = rest.split('/').collect();
            let parts = if parts.first() == Some(&"defaultcollection") {
                &parts[1..]
            } else {
                &parts[..]
            };
            if parts.len() == 3 && parts[1] == "_git" {
                return format!(
                    "dev.azure.com/{}/{}/_git/{}",
                    organization, parts[0], parts[2]
                );
            }
        }
    }
    key.to_owned()
}

pub(crate) fn normalize_key(host: &str, repository: &str, number: i64) -> PullRequestKey {
    let canonical = canonical_repository_key(&format!(
        "{}/{}",
        host.trim().to_ascii_lowercase(),
        repository.trim().to_ascii_lowercase()
    ));
    let (host, repository) = canonical
        .split_once('/')
        .unwrap_or((canonical.as_str(), ""));
    PullRequestKey {
        host: host.to_owned(),
        repository: repository.to_owned(),
        number,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn source_migration_fixture_creates_table_and_backfills_only_valid_links() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE projection_threads(thread_id TEXT, updated_at TEXT, linked_pull_request_json TEXT);\
             INSERT INTO projection_threads VALUES\
               ('thread-github','2026-03-02T00:00:00.000Z','{\"repository\":\"PingDotGG/T3Code\",\"number\":42,\"url\":\"https://GitHub.com/pingdotgg/t3code/pull/42\"}'),\
               ('thread-bad-url','2026-03-03T00:00:00.000Z','{\"repository\":\"acme/widgets\",\"number\":7,\"url\":\"not a url\"}'),\
               ('thread-malformed','2026-03-04T00:00:00.000Z','{\"repository\":\"acme/widgets\"}'),\
               ('thread-unlinked','2026-03-05T00:00:00.000Z',NULL);",
        )
        .unwrap();
        let tx = db.transaction().unwrap();
        apply_migration_050(&tx).unwrap();
        tx.commit().unwrap();
        let rows: Vec<(String, String, String, i64, String)> = db
            .prepare(
                "SELECT thread_id, host, repository, number, linked_at \
                 FROM projection_thread_pull_requests ORDER BY thread_id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (
                    "thread-bad-url".into(),
                    "unknown".into(),
                    "acme/widgets".into(),
                    7,
                    "2026-03-03T00:00:00.000Z".into()
                ),
                (
                    "thread-github".into(),
                    "github.com".into(),
                    "pingdotgg/t3code".into(),
                    42,
                    "2026-03-02T00:00:00.000Z".into()
                ),
            ]
        );
        assert_eq!(
            db.query_row("SELECT source FROM projection_thread_pull_requests WHERE thread_id='thread-github'", [], |r| r.get::<_, String>(0)).unwrap(),
            "manual"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM projection_thread_pull_requests WHERE snapshot_json IS NOT NULL OR stack_json IS NOT NULL", [], |r| r.get::<_, i64>(0)).unwrap(),
            0
        );
    }

    #[test]
    fn frozen_url_rules_and_azure_organization_keys_match_source() {
        assert_eq!(
            parse_gitlab_route(&["group", "sub", "-", "merge_requests", "9"])
                .unwrap()
                .repository,
            "group/sub"
        );
        let examples = [
            (
                "https://dev.azure.com/org-a/project/_git/web/pullrequest/7",
                "web",
                7,
                "dev.azure.com",
                "org-a/project/_git/web",
            ),
            (
                "https://dev.azure.com/org-b/project/_git/web/pullrequest/7",
                "web",
                7,
                "dev.azure.com",
                "org-b/project/_git/web",
            ),
            (
                "https://ssh.dev.azure.com/v3/org/project/_git/web/pullrequest/7",
                "web",
                7,
                "ssh.dev.azure.com",
                "web",
            ),
            (
                "https://team.visualstudio.com/defaultcollection/Project/_git/Web/pullrequest/7",
                "web",
                7,
                "dev.azure.com",
                "team/project/_git/web",
            ),
            (
                "https://gitlab.example/group/sub/-/merge_requests/9",
                "x",
                9,
                "gitlab.example",
                "x",
            ),
            (
                "https://forge.example/group/sub/pulls/11",
                "x",
                11,
                "forge.example",
                "group/sub",
            ),
        ];
        for (url, repository, number, expected_host, expected_repo) in examples {
            let key = legacy_pull_request_key(repository, number, url);
            assert_eq!(
                (key.host.as_str(), key.repository.as_str()),
                (expected_host, expected_repo),
                "{url}"
            );
        }
        assert_eq!(
            canonical_repository_key("ssh.dev.azure.com/v3/ORG/Project/Web"),
            "dev.azure.com/ORG/Project/_git/Web"
        );
        assert_eq!(
            canonical_repository_key("vs-ssh.visualstudio.com/v3/ORG/Project/Web"),
            "dev.azure.com/ORG/Project/_git/Web"
        );
        assert_eq!(
            canonical_repository_key("team.visualstudio.com/defaultcollection/Project/_git/Web"),
            "dev.azure.com/team/Project/_git/Web"
        );
    }

    #[test]
    fn url_canonicalization_matches_whatwg_host_and_path_rules() {
        let idn = legacy_pull_request_key("Repo", 5, "https://bücher.example/acme/widgets/pull/5");
        assert_eq!(idn.host, "xn--bcher-kva.example");
        assert_eq!(idn.repository, "repo");

        let invalid_port =
            legacy_pull_request_key("Repo", 5, "https://example.com:invalid/x/y/pull/5");
        assert_eq!(invalid_port.host, "unknown");

        let numeric_host = legacy_pull_request_key("Repo", 5, "http://0x7f.1/x/y/pull/5");
        assert_eq!(numeric_host.host, "127.0.0.1");

        // URL.pathname remains percent encoded, so `%2F` does not become a
        // path separator for the frozen forge route matcher.
        let encoded = legacy_pull_request_key(
            "Acme/Widgets",
            5,
            "https://github.com/acme%2Fwidgets/pull/5",
        );
        assert_eq!(encoded.host, "github.com");
        assert_eq!(encoded.repository, "acme/widgets");
    }

    #[test]
    fn malformed_or_mismatched_urls_fall_back_to_legacy_key() {
        let key = legacy_pull_request_key(
            "  ACME/Widgets  ",
            13,
            "https://github.com/acme/widgets/pull/12",
        );
        assert_eq!(key.host, "github.com");
        assert_eq!(key.repository, "acme/widgets");
        assert_eq!(key.number, 13);
        let key = legacy_pull_request_key("repo", 1, "mailto:team@example.com");
        assert_eq!(key.host, "unknown");
        let key = legacy_pull_request_key("Repo", 1, "ftp://Example.com/path");
        assert_eq!(key.host, "example.com");
    }

    #[test]
    fn integral_json_floats_are_valid_legacy_numbers() {
        assert_eq!(
            parse_legacy_link(r#"{"repository":"repo","number":1.0,"url":"not a url"}"#),
            Some(("repo".to_owned(), 1, "not a url".to_owned()))
        );
    }
}

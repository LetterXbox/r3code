//! Create and persist projects in the server-managed `projects` directory.
use crate::{
    event_bus::{BusError, EventBus},
    project_commands::CreateProject,
    project_sink::{self, ProjectCommitError},
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};

const MAX_FOLDER_ATTEMPTS: usize = 100;
const GIT_SHORT_TIMEOUT: Duration = Duration::from_secs(10);
const GIT_COMMIT_TIMEOUT: Duration = Duration::from_secs(30);
const ICON_BACKGROUNDS: [&str; 15] = [
    "#dc2626", "#ea580c", "#d97706", "#16a34a", "#059669", "#0d9488", "#0891b2", "#0284c7",
    "#2563eb", "#4f46e5", "#7c3aed", "#9333ea", "#c026d3", "#db2777", "#e11d48",
];

#[derive(Debug)]
pub enum CreateNewError {
    Folder {
        folder: PathBuf,
        cause: String,
    },
    Project {
        workspace_root: PathBuf,
        cause: String,
    },
}

impl std::fmt::Display for CreateNewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Folder { cause, .. } if cause.contains("Git isn't installed") => {
                f.write_str("Git isn't installed on this machine. Install Git to create a project.")
            }
            Self::Folder { .. } => f.write_str("Failed to create the project folder."),
            Self::Project { .. } => f.write_str("Failed to create the project."),
        }
    }
}
impl std::error::Error for CreateNewError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateNewResult {
    pub project_id: String,
    pub workspace_root: PathBuf,
    pub commit_error: Option<String>,
}

/// Atomically claims a unique managed folder, scaffolds and initializes it,
/// then commits the project through the event bus. Failed unowned folders are removed.
pub fn create_new(
    bus: &EventBus,
    named_projects_root: &Path,
    name: &str,
) -> Result<CreateNewResult, CreateNewError> {
    let folder_name = folder_name(name);
    fs::create_dir_all(named_projects_root).map_err(|error| CreateNewError::Folder {
        folder: named_projects_root.to_owned(),
        cause: error.to_string(),
    })?;
    let workspace_root = claim_folder(named_projects_root, &folder_name)?;

    let prepared = (|| {
        let commit_error =
            scaffold(&workspace_root, name).map_err(|error| CreateNewError::Folder {
                folder: workspace_root.clone(),
                cause: error,
            })?;
        let project_id = uuid::Uuid::new_v4().to_string();
        let command_id = format!("named-project:{project_id}");
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let committed = project_sink::create_project_ordered(
            bus,
            CreateProject {
                command_id: &command_id,
                project_id: &project_id,
                title: name,
                workspace_root: &workspace_root.to_string_lossy(),
                scripts: None,
            },
            &uuid::Uuid::new_v4().to_string(),
            &now,
        )
        .map_err(|error: ProjectCommitError| CreateNewError::Project {
            workspace_root: workspace_root.clone(),
            cause: error.to_string(),
        })?;
        if committed.receipt.status != "accepted" {
            return Err(CreateNewError::Project {
                workspace_root: workspace_root.clone(),
                cause: committed
                    .receipt
                    .error
                    .unwrap_or_else(|| "Project creation rejected".into()),
            });
        }
        Ok(CreateNewResult {
            project_id,
            workspace_root: workspace_root.clone(),
            commit_error,
        })
    })();

    if prepared.is_err() && !is_project_owned(bus, &workspace_root) {
        let _ = fs::remove_dir_all(&workspace_root);
    }
    prepared
}

fn claim_folder(root: &Path, base: &str) -> Result<PathBuf, CreateNewError> {
    for attempt in 1..=MAX_FOLDER_ATTEMPTS {
        let name = if attempt == 1 {
            base.to_owned()
        } else {
            format!("{base}-{attempt}")
        };
        let folder = root.join(name);
        match fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(CreateNewError::Folder {
                    folder,
                    cause: error.to_string(),
                })
            }
        }
    }
    Err(CreateNewError::Folder {
        folder: root.join(base),
        cause: format!("Every folder name for \"{base}\" is taken."),
    })
}

fn folder_name(name: &str) -> String {
    let slug: String = name
        .nfkd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>() // collapse punctuation runs
        .join("-");
    let slug = slug
        .chars()
        .take(64)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned();
    if slug.is_empty() {
        return "project".into();
    }
    let reserved_number = slug.len() == 4
        && (slug.starts_with("com") || slug.starts_with("lpt"))
        && matches!(slug.as_bytes()[3], b'1'..=b'9');
    if matches!(slug.as_str(), "con" | "prn" | "aux" | "nul") || reserved_number {
        format!("{slug}-project")
    } else {
        slug
    }
}

use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

fn scaffold(folder: &Path, name: &str) -> Result<Option<String>, String> {
    let branch = git(
        folder,
        &["config", "--get", "init.defaultBranch"],
        GIT_SHORT_TIMEOUT,
    )
    .ok()
    .filter(|output| output.status.success())
    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    .filter(|branch| !branch.is_empty())
    .unwrap_or_else(|| "main".into());
    let init = git(
        folder,
        &["init", &format!("--initial-branch={branch}")],
        GIT_SHORT_TIMEOUT,
    )?;
    if !init.status.success() {
        return Err(command_error("git init", &init));
    }
    fs::write(folder.join("README.md"), readme(name)).map_err(|error| error.to_string())?;
    fs::create_dir(folder.join("assets")).map_err(|error| error.to_string())?;
    fs::write(folder.join("assets/icon.svg"), icon_svg(name)).map_err(|error| error.to_string())?;
    let add = git(
        folder,
        &[
            "-c",
            "core.safecrlf=false",
            "add",
            "--force",
            "--",
            "README.md",
            "assets/icon.svg",
        ],
        GIT_SHORT_TIMEOUT,
    )?;
    if !add.status.success() {
        return Err(command_error("git add", &add));
    }
    let commit = match git(
        folder,
        &["commit", "--message", "Initial commit"],
        GIT_COMMIT_TIMEOUT,
    ) {
        Ok(commit) => commit,
        Err(error) => return Ok(Some(error)),
    };
    if commit.status.success() {
        Ok(None)
    } else {
        Ok(Some(describe_commit_failure(&String::from_utf8_lossy(
            &commit.stderr,
        ))))
    }
}

fn git(folder: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    run_process(std::ffi::OsStr::new("git"), args, folder, timeout).map_err(|error| {
        if error == "git executable not found" {
            "Git isn't installed on this machine. Install Git to create a project.".into()
        } else {
            error
        }
    })
}

fn run_process(
    program: &std::ffi::OsStr,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<Output, String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(cwd);
    crate::vcs_worktree::run_command(&mut command, timeout).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "git executable not found".to_owned(),
        std::io::ErrorKind::TimedOut => {
            format!("Git command timed out after {} seconds.", timeout.as_secs())
        }
        _ => format!("Git command failed: {error}"),
    })
}

fn command_error(operation: &str, output: &Output) -> String {
    format!(
        "{operation} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

fn describe_commit_failure(stderr: &str) -> String {
    if regex::Regex::new(r"(?i)identity unknown|tell me who you are|no (name|email) was given")
        .unwrap()
        .is_match(stderr)
    {
        return "Git has no name or email on this machine. Set user.name and user.email, then commit.".into();
    }
    stderr
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .unwrap_or("Git could not make the first commit.")
        .to_owned()
}

fn readme(name: &str) -> String {
    format!("<img src=\"assets/icon.svg\" width=\"64\" height=\"64\" alt=\"\">\n\n# {name}\n\nCreated in [T3 Code](https://t3.codes).\n")
}

fn icon_svg(name: &str) -> String {
    let words = name
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty());
    let mut initials = words
        .take(2)
        .filter_map(|word| word.chars().next())
        .collect::<String>()
        .to_uppercase();
    if initials.is_empty() {
        initials = name
            .trim()
            .chars()
            .next()
            .unwrap_or('?')
            .to_uppercase()
            .collect();
    }
    let hash = name.chars().fold(0u32, |hash, character| {
        hash.wrapping_mul(31).wrapping_add(character as u32)
    });
    let background = ICON_BACKGROUNDS[(hash as usize) % ICON_BACKGROUNDS.len()];
    let font_size = if initials.chars().count() > 1 { 26 } else { 32 };
    format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">\n  <rect width=\"64\" height=\"64\" rx=\"14\" fill=\"{background}\"/>\n  <text x=\"32\" y=\"32\" dy=\"0.35em\" text-anchor=\"middle\" font-family=\"ui-sans-serif, system-ui, -apple-system, sans-serif\" font-size=\"{font_size}\" font-weight=\"600\" fill=\"#ffffff\">{}</text>\n</svg>\n", escape_xml(&initials))
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn is_project_owned(bus: &EventBus, root: &Path) -> bool {
    let Ok(root) = root.to_str().ok_or(BusError::Poisoned) else {
        return true;
    };
    bus.with_autocommit(|db| {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM projection_projects WHERE workspace_root=?1)",
            [root],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(true)
    })
    .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{database, event_bus::EventBus, migrations};

    fn fixture() -> (PathBuf, EventBus) {
        let root =
            std::env::temp_dir().join(format!("t3-managed-project-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut db = database::open_writer(&root.join("state.sqlite")).unwrap();
        migrations::run_ported_migrations(&mut db).unwrap();
        (root, EventBus::new(db, 16))
    }

    #[test]
    fn creates_unique_scaffold_and_persists_project() {
        let (root, bus) = fixture();
        let projects_root = root.join("projects");
        let first = create_new(&bus, &projects_root, "Café & Crème!").unwrap();
        let second = create_new(&bus, &projects_root, "Café & Crème!").unwrap();
        assert_eq!(first.workspace_root, projects_root.join("cafe-creme"));
        assert_eq!(second.workspace_root, projects_root.join("cafe-creme-2"));
        for result in [&first, &second] {
            assert!(result.workspace_root.join(".git").is_dir());
            assert!(result.workspace_root.join("README.md").is_file());
            assert!(result.workspace_root.join("assets/icon.svg").is_file());
            bus.with_autocommit(|db| {
                let title: String = db
                    .query_row(
                        "SELECT title FROM projection_projects WHERE project_id=?1",
                        [&result.project_id],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert_eq!(title, "Café & Crème!");
            })
            .unwrap();
        }
        drop(bus);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slug_is_safe_and_reserved_names_are_adjusted() {
        assert_eq!(folder_name("../../etc"), "etc");
        assert_eq!(folder_name("🎱🎱"), "project");
        assert_eq!(folder_name("Con"), "con-project");
    }

    #[test]
    fn scaffold_escapes_icon_text() {
        assert!(icon_svg("<").contains("&lt;"));
        assert!(readme("../name").contains("# ../name"));
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_git_process_is_killed_and_reaped() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("t3-git-timeout-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("slow-git");
        fs::write(&executable, "#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let error = run_process(
            executable.as_os_str(),
            &[],
            &root,
            Duration::from_millis(30),
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn completed_git_does_not_wait_for_a_hook_holding_pipes_open() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("t3-git-hook-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let executable = root.join("git-with-hook");
        fs::write(&executable, "#!/bin/sh\nsleep 30 &\nexit 0\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        assert!(
            run_process(executable.as_os_str(), &[], &root, Duration::from_secs(2))
                .unwrap()
                .status
                .success()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        fs::remove_dir_all(root).unwrap();
    }
}

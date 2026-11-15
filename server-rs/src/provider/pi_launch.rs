//! Pi RPC launch argument validation and extension materialization.
use std::path::{Path, PathBuf};
const SOURCE: &str = include_str!("pi_extension.ts");
const RESERVED: &[&str] = &[
    "--continue",
    "-c",
    "--export",
    "--fork",
    "--help",
    "-h",
    "--list-models",
    "--mode",
    "--no-session",
    "--print",
    "-p",
    "--resume",
    "-r",
    "--session",
    "--session-id",
    "--version",
    "-v",
];
const WITH_VALUE: &[&str] = &[
    "--api-key",
    "--append-system-prompt",
    "--exclude-tools",
    "-xt",
    "--extension",
    "-e",
    "--model",
    "--models",
    "--name",
    "-n",
    "--prompt-template",
    "--provider",
    "--session-dir",
    "--skill",
    "--system-prompt",
    "--theme",
    "--thinking",
    "--tools",
    "-t",
    "--tui-mode",
    "--use-theme",
];
const NO_VALUE: &[&str] = &[
    "--approve",
    "-a",
    "--no-approve",
    "-na",
    "--no-builtin-tools",
    "-nbt",
    "--no-context-files",
    "-nc",
    "--no-extensions",
    "-ne",
    "--no-prompt-templates",
    "-np",
    "--no-skills",
    "-ns",
    "--no-themes",
    "--no-tools",
    "-nt",
    "--offline",
    "--verbose",
];
pub(crate) fn resolve_args(input: &str) -> Result<Vec<String>, String> {
    let parsed = shlex::split(input).ok_or("Invalid Pi launch arguments")?;
    let mut args = Vec::new();
    for arg in parsed {
        if let Some((key, value)) = arg.split_once('=') {
            if WITH_VALUE.contains(&key) {
                args.push(key.to_owned());
                args.push(value.to_owned());
                continue;
            }
        }
        args.push(arg);
    }
    let (mut provider, mut model) = (false, false);
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(reserved) = RESERVED.iter().find(|value| {
            arg == **value || (value.starts_with("--") && arg.starts_with(&format!("{value}=")))
        }) {
            return Err(format!("Pi launch argument '{reserved}' is controlled by T3 Code and cannot be overridden."));
        }
        if arg == "--" {
            return Err("Pi launch arguments cannot include positional prompts.".into());
        }
        if WITH_VALUE.contains(&arg.as_str()) {
            if i + 1 >= args.len() {
                return Err(format!("Pi launch argument '{arg}' requires a value."));
            }
            provider |= arg == "--provider";
            model |= arg == "--model";
            i += 2;
            continue;
        }
        if NO_VALUE.contains(&arg.as_str()) || (arg.starts_with("--") && arg.contains('=')) {
            i += 1;
            continue;
        }
        if arg.starts_with("--") {
            i += 1;
            if i < args.len() && !args[i].starts_with('-') && !args[i].starts_with('@') {
                i += 1;
            }
            continue;
        }
        if arg.starts_with('-') {
            return Err(format!(
                "Pi launch argument '{arg}' is not supported by T3 Code."
            ));
        }
        return Err(format!(
            "Pi launch arguments cannot include positional prompt '{arg}'."
        ));
    }
    if provider && !model {
        return Err("Pi launch argument '--provider' requires '--model'.".into());
    }
    Ok(args)
}
pub(crate) fn materialize_extension(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|_| "Could not create Pi extension directory")?;
    let path = dir.join("pi-t3-mcp-extension.ts");
    // A temporary sibling plus rename keeps concurrent launches from observing partial code.
    let tmp = dir.join(format!(".pi-extension-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, SOURCE).map_err(|_| "Could not write Pi extension")?;
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err("Could not install Pi extension".into());
    }
    Ok(path)
}
pub(crate) fn args(
    input: &str,
    extension: &Path,
    session: Option<&Path>,
) -> Result<Vec<String>, String> {
    let launch = resolve_args(input)?;
    let mut result = vec!["--mode".into(), "rpc".into()];
    if let Some(session) = session {
        result.extend(["--session".into(), session.to_string_lossy().into_owned()]);
    }
    result.extend(launch);
    if !result.windows(2).any(|pair| {
        (pair[0] == "--extension" || pair[0] == "-e") && pair[1] == extension.to_string_lossy()
    }) {
        result.extend([
            "--extension".into(),
            extension.to_string_lossy().into_owned(),
        ]);
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_owned_flags_and_positional_prompts() {
        assert!(resolve_args("--mode text").is_err());
        assert!(resolve_args("--session=old").is_err());
        assert!(resolve_args("hello").is_err());
        assert!(resolve_args("--provider openrouter").is_err());
        assert_eq!(
            resolve_args("--extension --no-session").unwrap(),
            vec!["--extension", "--no-session"]
        );
        assert_eq!(
            resolve_args("--provider=openrouter --model 'a/b' --no-skills").unwrap(),
            vec!["--provider", "openrouter", "--model", "a/b", "--no-skills"]
        );
    }
}

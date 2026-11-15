//! Discover and launch locally installed editors and file managers.
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

struct Editor {
    id: &'static str,
    commands: &'static [&'static str],
    style: &'static str,
    base: &'static [&'static str],
}
const EDITORS: &[Editor] = &[
    Editor {
        id: "cursor",
        commands: &["cursor"],
        style: "goto",
        base: &["--classic"],
    },
    Editor {
        id: "trae",
        commands: &["trae"],
        style: "goto",
        base: &[],
    },
    Editor {
        id: "kiro",
        commands: &["kiro"],
        style: "goto",
        base: &["ide"],
    },
    Editor {
        id: "vscode",
        commands: &["code"],
        style: "goto",
        base: &[],
    },
    Editor {
        id: "vscode-insiders",
        commands: &["code-insiders"],
        style: "goto",
        base: &[],
    },
    Editor {
        id: "vscodium",
        commands: &["codium"],
        style: "goto",
        base: &[],
    },
    Editor {
        id: "zed",
        commands: &["zed", "zeditor"],
        style: "direct",
        base: &[],
    },
    Editor {
        id: "antigravity",
        commands: &["antigravity-ide", "agy-ide"],
        style: "goto",
        base: &[],
    },
    Editor {
        id: "idea",
        commands: &["idea"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "aqua",
        commands: &["aqua"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "clion",
        commands: &["clion"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "datagrip",
        commands: &["datagrip"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "dataspell",
        commands: &["dataspell"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "goland",
        commands: &["goland"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "phpstorm",
        commands: &["phpstorm"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "pycharm",
        commands: &["pycharm"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "rider",
        commands: &["rider"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "rubymine",
        commands: &["rubymine"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "rustrover",
        commands: &["rustrover"],
        style: "line",
        base: &[],
    },
    Editor {
        id: "webstorm",
        commands: &["webstorm"],
        style: "line",
        base: &[],
    },
];
fn executable(path: &Path) -> bool {
    let Ok(m) = path.metadata() else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        m.is_file()
    }
}
fn find_path_command(name: &str) -> Option<PathBuf> {
    let extensions: Vec<String> = if cfg!(windows) && Path::new(name).extension().is_none() {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .map(str::to_owned)
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|v| std::env::split_paths(&v).collect::<Vec<_>>())
        .flat_map(|d| {
            extensions
                .iter()
                .map(|ext| d.join(format!("{name}{ext}")))
                .collect::<Vec<_>>()
        })
        .find(|p| executable(p))
}
fn find_command(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs.extend(["/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    dirs.into_iter()
        .map(|d| d.join(name))
        .find(|p| executable(p))
}
// Bound probes: desktop helpers can hang indefinitely when the session bus is broken.
fn probe(command: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut output = String::new();
                child.stdout.take()?.read_to_string(&mut output).ok()?;
                return Some(output);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
fn install_names(editor: &Editor) -> Vec<&'static str> {
    match editor.id {
        "vscode" => vec!["Visual Studio Code"],
        "vscode-insiders" => vec!["Visual Studio Code - Insiders"],
        "antigravity" => vec!["Antigravity IDE"],
        "idea" => vec![
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        "pycharm" => vec!["PyCharm", "PyCharm CE"],
        "rider" => vec!["Rider", "JetBrains Rider"],
        "vscodium" => vec!["VSCodium"],
        "zed" => vec!["Zed"],
        "cursor" => vec!["Cursor"],
        "trae" => vec!["Trae"],
        "kiro" => vec!["Kiro"],
        "aqua" => vec!["Aqua"],
        "clion" => vec!["CLion"],
        "datagrip" => vec!["DataGrip"],
        "dataspell" => vec!["DataSpell"],
        "goland" => vec!["GoLand"],
        "phpstorm" => vec!["PhpStorm"],
        "rubymine" => vec!["RubyMine"],
        "rustrover" => vec!["RustRover"],
        "webstorm" => vec!["WebStorm"],
        _ => vec![],
    }
}
fn bundle_matches(entry: &str, name: &str) -> bool {
    if entry == format!("{name}.app") {
        return true;
    }
    entry
        .strip_prefix(&format!("{name} "))
        .and_then(|s| s.strip_suffix(".app"))
        .is_some_and(|version| {
            !version.is_empty()
                && version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                && version.bytes().any(|b| b.is_ascii_digit())
        })
}
fn platform_candidates(
    editor: &Editor,
    platform: &str,
    home: Option<&Path>,
    roots: &[PathBuf],
) -> Vec<PathBuf> {
    let names = install_names(editor);
    let command = editor.commands[0];
    let mut candidates = Vec::new();
    if platform == "macos" {
        for root in roots {
            for name in &names {
                let mut bundles = vec![root.join(format!("{name}.app"))];
                if let Ok(entries) = std::fs::read_dir(root) {
                    for entry in entries.flatten() {
                        if bundle_matches(&entry.file_name().to_string_lossy(), name)
                            && !bundles.contains(&entry.path())
                        {
                            bundles.push(entry.path());
                        }
                    }
                }
                for bundle in bundles {
                    if editor.style == "line" || editor.id == "zed" {
                        candidates.push(
                            bundle.join("Contents/MacOS").join(if editor.id == "zed" {
                                "cli"
                            } else {
                                command
                            }),
                        );
                    } else {
                        for bin in [command, "code"] {
                            candidates.push(bundle.join("Contents/Resources/app/bin").join(bin));
                        }
                    }
                }
            }
        }
        if editor.style == "line" {
            if let Some(home) = home {
                candidates.push(
                    home.join("Library/Application Support/JetBrains/Toolbox/scripts")
                        .join(command),
                );
            }
        }
    } else if platform == "windows" {
        if editor.style == "line" {
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                candidates.push(
                    PathBuf::from(local)
                        .join("JetBrains/Toolbox/scripts")
                        .join(format!("{command}.cmd")),
                );
            }
            for root in roots {
                for dir in [root.clone(), root.join("JetBrains")] {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let entry_name = entry.file_name().to_string_lossy().into_owned();
                            if names.iter().any(|name| {
                                entry_name == *name || entry_name.starts_with(&format!("{name} "))
                            }) {
                                for exe in [format!("{command}64.exe"), format!("{command}.exe")] {
                                    candidates.push(entry.path().join("bin").join(exe));
                                }
                            }
                        }
                    }
                }
            }
        } else {
            let name = match editor.id {
                "vscode" => "Microsoft VS Code",
                "vscode-insiders" => "Microsoft VS Code Insiders",
                _ => names.first().copied().unwrap_or(""),
            };
            for root in roots {
                let dir = root.join(name);
                for bin in [format!("{command}.cmd"), "code.cmd".to_owned()] {
                    candidates.push(dir.join("resources/app/bin").join(&bin));
                }
                for bin in [format!("{command}.cmd"), "code.cmd".to_owned()] {
                    candidates.push(dir.join("bin").join(bin));
                }
                if editor.id == "zed" {
                    candidates.push(dir.join("bin/zed.exe"));
                    candidates.push(dir.join("zed.exe"));
                }
            }
        }
    }
    candidates
}
fn resolve(editor: &Editor) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "linux") && editor.id == "zed" {
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|v| std::env::split_paths(&v).collect())
            .unwrap_or_default();
        if let Some(home) = &home {
            dirs.push(home.join(".local/bin"));
        }
        dirs.extend(["/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
        return resolve_zed(&dirs);
    }
    let mac = cfg!(target_os = "macos");
    let windows = cfg!(target_os = "windows");
    if !(mac && editor.id == "zed") {
        if let Some(path) = editor
            .commands
            .iter()
            .find_map(|name| find_path_command(name))
        {
            return Some(path);
        }
    }
    if mac || windows {
        let roots: Vec<PathBuf> = if mac {
            home.iter()
                .map(|h| h.join("Applications"))
                .chain(std::iter::once(PathBuf::from("/Applications")))
                .collect()
        } else {
            [
                "LOCALAPPDATA",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
            ]
            .iter()
            .filter_map(|key| {
                std::env::var_os(key).map(|v| {
                    if *key == "LOCALAPPDATA" {
                        PathBuf::from(v).join("Programs")
                    } else {
                        PathBuf::from(v)
                    }
                })
            })
            .collect()
        };
        if let Some(path) = platform_candidates(
            editor,
            if mac { "macos" } else { "windows" },
            home.as_deref(),
            &roots,
        )
        .into_iter()
        .find(|p| executable(p))
        {
            return Some(path);
        }
        return editor
            .commands
            .iter()
            .find_map(|name| find_path_command(name));
    }
    editor
        .commands
        .iter()
        .find_map(|name| find_command(name))
        .or_else(|| {
            if editor.style != "line" {
                return None;
            }
            let data = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| home.map(|h| h.join(".local/share")))?;
            let path = data
                .join("JetBrains/Toolbox/scripts")
                .join(editor.commands[0]);
            executable(&path).then_some(path)
        })
}
fn resolve_zed(dirs: &[PathBuf]) -> Option<PathBuf> {
    for name in ["zeditor", "zed"] {
        for dir in dirs {
            let path = dir.join(name);
            if executable(&path)
                && (name != "zed"
                    || probe(&path, &["--version"]).is_some_and(|v| v.starts_with("Zed")))
            {
                return Some(path);
            }
        }
    }
    None
}
fn graphical_session() -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|key| std::env::var(key).is_ok_and(|v| !v.trim().is_empty()))
}
fn wsl_host() -> bool {
    (std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some())
        && ["SSH_CONNECTION", "SSH_TTY", "container"]
            .iter()
            .all(|key| std::env::var_os(key).is_none())
}
fn linux_directory_handler() -> bool {
    find_path_command("xdg-mime")
        .and_then(|cmd| probe(&cmd, &["query", "default", "inode/directory"]))
        .is_some_and(|out| !out.trim().is_empty())
}
fn file_manager() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return find_path_command("open");
    }
    if cfg!(target_os = "windows") {
        return find_path_command("explorer");
    }
    if wsl_host() && std::env::var("WSL_DISTRO_NAME").is_ok_and(|v| !v.trim().is_empty()) {
        if let Some(cmd) = find_path_command("explorer.exe") {
            return Some(cmd);
        }
    }
    if graphical_session() && linux_directory_handler() {
        return find_path_command("xdg-open");
    }
    None
}
pub fn reveal_kind() -> Option<&'static str> {
    let command = file_manager()?;
    if cfg!(target_os = "macos") {
        return Some("finder");
    }
    if cfg!(target_os = "windows") {
        return executable(&powershell_path()).then_some("file-explorer");
    }
    if command
        .file_name()
        .is_some_and(|name| name == "explorer.exe")
    {
        if find_path_command("powershell.exe").is_some() {
            return Some("file-explorer");
        }
        return (graphical_session()
            && linux_directory_handler()
            && find_path_command("xdg-open").is_some())
        .then_some("files");
    }
    Some("files")
}
pub fn available() -> Vec<&'static str> {
    let mut editors: Vec<_> = EDITORS
        .iter()
        .filter(|e| resolve(e).is_some())
        .map(|e| e.id)
        .collect();
    if file_manager().is_some() {
        editors.push("file-manager");
    }
    editors
}
fn positioned(target: &str) -> Option<(&str, &str, Option<&str>)> {
    let (prefix, last) = target.rsplit_once(':')?;
    if last.is_empty() || !last.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if let Some((path, line)) = prefix.rsplit_once(':') {
        if !path.is_empty() && !line.is_empty() && line.bytes().all(|c| c.is_ascii_digit()) {
            return Some((path, line, Some(last)));
        }
    }
    (!prefix.is_empty()).then_some((prefix, last, None))
}
fn arguments(editor: &Editor, target: &str, root: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = editor.base.iter().map(|s| (*s).to_owned()).collect();
    let position = positioned(target);
    match (editor.style, position) {
        ("goto", Some(_)) => {
            args.push("--goto".into());
            args.push(target.into());
        }
        ("goto", None) if Path::new(target).is_dir() => {
            args.push("--new-window".into());
            args.push(target.into());
        }
        ("line", Some((path, line, column))) => {
            if let Some(root) = root {
                args.push(root.into());
            }
            args.extend(["--line".into(), line.into()]);
            if let Some(column) = column {
                args.extend([
                    "--column".into(),
                    column
                        .parse::<u64>()
                        .unwrap_or(0)
                        .saturating_sub(1)
                        .to_string(),
                ]);
            }
            args.push(path.into());
        }
        _ => args.push(target.into()),
    }
    args
}
fn expand_home(target: &str) -> String {
    if target == "~" || target.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}{}", PathBuf::from(home).to_string_lossy(), &target[1..]);
        }
    }
    target.to_owned()
}
fn wsl_path(target: &str, distro: &str) -> String {
    let tail = target.trim_start_matches('/').replace('/', "\\");
    if tail.is_empty() {
        format!("\\\\wsl.localhost\\{distro}")
    } else {
        format!("\\\\wsl.localhost\\{distro}\\{tail}")
    }
}
fn powershell_path() -> PathBuf {
    PathBuf::from(
        std::env::var_os("SYSTEMROOT")
            .or_else(|| std::env::var_os("windir"))
            .unwrap_or_else(|| r"C:\Windows".into()),
    )
    .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
}
fn reveal_script(target: &str, parent: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "''"));
    format!(
        r#"$ProgressPreference = 'SilentlyContinue'; $folderVerb = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\Directory\shell' -ErrorAction SilentlyContinue).'(default)'; if ($folderVerb -and $folderVerb -ne 'none') {{ Invoke-Item -LiteralPath {} }} else {{ Start-Process 'explorer.exe' -ArgumentList ('/select,"' + {} + '"') }}"#,
        quote(parent),
        quote(target)
    )
}
fn powershell_args(script: &str) -> Vec<String> {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut args: Vec<String> = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(base64::engine::general_purpose::STANDARD.encode(bytes));
    args
}
fn windows_parent(target: &str) -> &str {
    match target.rfind('\\') {
        Some(0) => &target[..1],
        Some(2) if target.as_bytes().get(1) == Some(&b':') => &target[..3],
        Some(i) => &target[..i],
        None => ".",
    }
}
fn unsafe_shim_arg(arg: &str) -> bool {
    arg.chars()
        .any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == '"')
}
#[cfg(any(windows, test))]
fn escape_cmd_arg(arg: &str) -> String {
    let mut result = String::from("^\"");
    for c in arg.chars() {
        if matches!(
            c,
            ' ' | '\t' | '^' | '&' | '|' | '<' | '>' | '(' | ')' | '%' | '!'
        ) {
            result.push('^');
        }
        result.push(c);
    }
    result.push_str("^\"");
    result
}
fn launch_file_manager(target: &str, reveal: bool) -> Result<Value, Value> {
    let id = "file-manager";
    let mut command = file_manager()
        .ok_or_else(|| json!({"_tag":"ExternalLauncherUnsupportedEditorError","editor":id}))?;
    let target = expand_home(target);
    let parent = Path::new(&target)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut args = Vec::new();
    if cfg!(target_os = "windows") {
        let normalized = target.replace('/', "\\");
        if reveal {
            command = powershell_path();
            args = powershell_args(&reveal_script(&normalized, windows_parent(&normalized)));
        } else {
            args.push(normalized);
        }
    } else if reveal && cfg!(target_os = "macos") {
        args.extend(["-R".to_owned(), target.clone()]);
    } else if command.file_name().is_some_and(|n| n == "explorer.exe") {
        let distro = std::env::var("WSL_DISTRO_NAME").unwrap_or_default();
        if reveal {
            if let Some(ps) = find_path_command("powershell.exe") {
                let target_unc = wsl_path(&target, &distro);
                let parent_unc = wsl_path(&parent.to_string_lossy(), &distro);
                let script = if target_unc.contains('"') {
                    format!(
                        "Invoke-Item -LiteralPath '{}'",
                        parent_unc.replace('\'', "''")
                    )
                } else {
                    reveal_script(&target_unc, &parent_unc)
                };
                command = ps;
                args = powershell_args(&script);
            } else if graphical_session()
                && linux_directory_handler()
                && find_path_command("xdg-open").is_some()
            {
                command = find_path_command("xdg-open").unwrap();
                args.push(parent.to_string_lossy().into_owned());
            } else {
                args.push(wsl_path(&parent.to_string_lossy(), &distro));
            }
        } else {
            args.push(wsl_path(&target, &distro));
        }
    } else if reveal {
        if command.file_name().is_some_and(|n| n == "xdg-open") {
            if let (Some(gdbus), Ok(url)) = (
                find_path_command("gdbus"),
                url::Url::from_file_path(&target),
            ) {
                let items = format!("[\"{}\"]", url.as_str());
                if probe(
                    &gdbus,
                    &[
                        "call",
                        "--session",
                        "--dest",
                        "org.freedesktop.FileManager1",
                        "--object-path",
                        "/org/freedesktop/FileManager1",
                        "--method",
                        "org.freedesktop.FileManager1.ShowItems",
                        &items,
                        "",
                    ],
                )
                .is_some()
                {
                    return Ok(Value::Null);
                }
            }
        }
        args.push(parent.to_string_lossy().into_owned());
    } else {
        args.push(target.clone());
    }
    let mut child = Command::new(&command).args(&args).env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        .map_err(|error| json!({"_tag":"ExternalLauncherEditorSpawnError","editor":id,"target":target,"command":command.to_string_lossy(),"args":args,"cause":error.to_string()}))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(Value::Null)
}
pub fn launch(input: &Value) -> Result<Value, Value> {
    let target = input
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| json!({"_tag":"ExternalLauncherUnsupportedTargetError","editor":""}))?;
    let id = input
        .get("editor")
        .and_then(Value::as_str)
        .ok_or_else(|| json!({"_tag":"ExternalLauncherUnknownEditorError","editor":""}))?;
    if id == "file-manager" {
        return launch_file_manager(
            target,
            input
                .get("reveal")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        );
    }
    let Some(editor) = EDITORS.iter().find(|e| e.id == id) else {
        return Err(json!({"_tag":"ExternalLauncherUnknownEditorError","editor":id}));
    };
    let Some(command) = resolve(editor) else {
        return Err(
            json!({"_tag":"ExternalLauncherCommandNotFoundError","editor":id,"command":editor.commands[0]}),
        );
    };
    let root = input.get("projectRoot").and_then(Value::as_str);
    let mut args = arguments(editor, target, root);
    if (cfg!(target_os = "macos") || cfg!(target_os = "windows"))
        && editor.id == "kiro"
        && args.first().is_some_and(|arg| arg == "ide")
    {
        args.remove(0);
    }
    if cfg!(target_os = "windows")
        && command
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        && (unsafe_shim_arg(&command.to_string_lossy())
            || args.iter().any(|arg| unsafe_shim_arg(arg)))
    {
        return Err(json!({"_tag":"ExternalLauncherUnsupportedTargetError","editor":id}));
    }
    #[cfg(windows)]
    let child = if command
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
    {
        use std::os::windows::process::CommandExt;
        let line = std::iter::once(command.to_string_lossy().into_owned())
            .chain(args.iter().cloned())
            .map(|arg| escape_cmd_arg(&arg))
            .collect::<Vec<_>>()
            .join(" ");
        Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()))
            .args(["/d", "/s", "/c"])
            .raw_arg(line)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    } else {
        Command::new(&command)
            .args(&args)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    #[cfg(not(windows))]
    let child = Command::new(&command)
        .args(&args)
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = child.map_err(|error| json!({"_tag":"ExternalLauncherEditorSpawnError","editor":id,"target":target,"command":command.to_string_lossy(),"args":args,"cause":error.to_string()}))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(Value::Null)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_bundle_names_respect_version_boundaries() {
        assert!(bundle_matches("WebStorm.app", "WebStorm"));
        assert!(bundle_matches("WebStorm 2026.2.app", "WebStorm"));
        assert!(!bundle_matches("WebStormHelper.app", "WebStorm"));
        assert!(!bundle_matches(
            "Visual Studio Code - Insiders.app",
            "Visual Studio Code"
        ));
    }
    #[test]
    fn mac_and_windows_candidates_follow_install_layouts() {
        let root = std::env::temp_dir().join(format!("t3-editor-layout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("WebStorm 2026.2.app")).unwrap();
        std::fs::create_dir_all(root.join("JetBrains/WebStorm 2026.2")).unwrap();
        let editor = EDITORS.iter().find(|e| e.id == "webstorm").unwrap();
        let mac = platform_candidates(editor, "macos", None, std::slice::from_ref(&root));
        assert!(mac.contains(&root.join("WebStorm 2026.2.app/Contents/MacOS/webstorm")));
        let windows = platform_candidates(editor, "windows", None, std::slice::from_ref(&root));
        assert!(windows.contains(&root.join("JetBrains/WebStorm 2026.2/bin/webstorm64.exe")));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn builds_positioned_launches_without_shell_parsing() {
        let code = EDITORS.iter().find(|e| e.id == "vscode").unwrap();
        assert_eq!(
            arguments(code, "/tmp/a b.rs:12:4", None),
            vec!["--goto", "/tmp/a b.rs:12:4"]
        );
        let idea = EDITORS.iter().find(|e| e.id == "idea").unwrap();
        assert_eq!(
            arguments(idea, "/tmp/a.rs:12:4", Some("/tmp")),
            vec!["/tmp", "--line", "12", "--column", "3", "/tmp/a.rs"]
        );
    }
    #[test]
    fn windows_shim_escaping_and_safety() {
        assert_eq!(
            escape_cmd_arg(r"C:\Users\jö\R&D (100%)\naïve ^file!.ts:3:7"),
            r#"^"C:\Users\jö\R^&D^ ^(100^%^)\naïve^ ^^file^!.ts:3:7^""#
        );
        assert!(unsafe_shim_arg("bad\npath"));
        assert!(unsafe_shim_arg("bad\"path"));
        assert!(!unsafe_shim_arg("R&D (100%)"));
    }
    #[test]
    fn windows_reveal_quotes_and_parent() {
        let path = r"C:\Users\O'Brien\file.txt";
        assert_eq!(windows_parent(path), r"C:\Users\O'Brien");
        assert_eq!(windows_parent(r"C:\file.txt"), "C:\\");
        let script = reveal_script(path, windows_parent(path));
        assert!(script.contains(r"'C:\Users\O''Brien\file.txt'"));
        assert!(script.contains(r"'C:\Users\O''Brien'"));
        assert_eq!(powershell_args(&script).len(), 6);
    }
    #[test]
    fn wsl_paths_preserve_spaces_and_normalize_separators() {
        assert_eq!(
            wsl_path("/home/me/a b", "Ubuntu"),
            r"\\wsl.localhost\Ubuntu\home\me\a b"
        );
        assert_eq!(wsl_path("/", "Ubuntu"), r"\\wsl.localhost\Ubuntu");
    }
    #[cfg(unix)]
    #[test]
    fn zed_prefers_zeditor_and_rejects_the_zfs_daemon() {
        use std::os::unix::fs::PermissionsExt;
        let temp = std::env::temp_dir().join(format!("t3-editor-test-{}", uuid::Uuid::new_v4()));
        let first = temp.join("first");
        let second = temp.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let write = |path: &Path, body: &str| {
            std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        write(&first.join("zed"), "exit 1");
        assert_eq!(resolve_zed(&[first.clone(), second.clone()]), None);
        write(&second.join("zed"), "echo 'Zed 0.200.0'");
        assert_eq!(
            resolve_zed(&[first.clone(), second.clone()]),
            Some(second.join("zed"))
        );
        write(&second.join("zeditor"), "exit 0");
        assert_eq!(
            resolve_zed(&[first.clone(), second.clone()]),
            Some(second.join("zeditor"))
        );
        std::fs::remove_dir_all(temp).unwrap();
    }
}

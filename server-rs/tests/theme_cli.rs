use std::{fs, process::Command};

#[test]
fn cli_sets_shows_and_clears_theme() {
    let root = std::env::temp_dir().join(format!("t3-cli-theme-{}", uuid::Uuid::new_v4()));
    let invoke = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_t3code"))
            .args(["theme"])
            .args(args)
            .arg("--base-dir")
            .arg(&root)
            .output()
            .unwrap()
    };
    let set = invoke(&["set", "grove"]);
    assert!(
        set.status.success(),
        "{}",
        String::from_utf8_lossy(&set.stderr)
    );
    let show = invoke(&["show"]);
    assert!(String::from_utf8_lossy(&show.stdout).contains("Environment theme: \"grove\""));
    assert!(invoke(&["clear"]).status.success());
    let show = invoke(&["show"]);
    assert!(String::from_utf8_lossy(&show.stdout).contains("Environment theme: not set"));
    fs::remove_dir_all(root).unwrap();
}

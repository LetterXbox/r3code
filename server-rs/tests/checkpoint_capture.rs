use std::{fs, path::Path, process::Command};
use t3code_server::checkpoint::{capture, checkpoint_ref, has_ref};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}
#[test]
fn snapshots_workspace_without_changing_index_or_head() {
    let dir = std::env::temp_dir().join(format!("checkpoint-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    fs::write(dir.join("tracked"), "initial\n").unwrap();
    fs::write(dir.join(".gitignore"), "ignored\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "initial"]);
    fs::write(dir.join("tracked"), "staged\n").unwrap();
    git(&dir, &["add", "tracked"]);
    fs::write(dir.join("tracked"), "working\n").unwrap();
    fs::write(dir.join("new"), "new\n").unwrap();
    fs::write(dir.join("ignored"), "secret\n").unwrap();
    let index = fs::read(dir.join(".git/index")).unwrap();
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let reference = checkpoint_ref("scope", 1);
    assert!(!has_ref(&dir, &reference).unwrap());
    let oid = capture(&dir, &reference).unwrap();
    assert!(has_ref(&dir, &reference).unwrap());
    assert_eq!(git(&dir, &["show", &format!("{oid}:tracked")]), "working");
    assert_eq!(git(&dir, &["show", &format!("{oid}:new")]), "new");
    assert!(!Command::new("git")
        .current_dir(&dir)
        .args(["cat-file", "-e", &format!("{oid}:ignored")])
        .status()
        .unwrap()
        .success());
    assert_eq!(fs::read(dir.join(".git/index")).unwrap(), index);
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn skips_unborn_embedded_repository_and_keeps_other_files() {
    let dir = std::env::temp_dir().join(format!("checkpoint-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "user.name", "Test"]);
    git(&dir, &["config", "user.email", "test@example.com"]);
    fs::write(dir.join("tracked"), "initial\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "initial"]);
    fs::create_dir(dir.join("empty")).unwrap();
    git(&dir.join("empty"), &["init", "-q"]);
    fs::write(dir.join("new"), "included\n").unwrap();
    let index = fs::read(dir.join(".git/index")).unwrap();
    let oid = capture(&dir, &checkpoint_ref("nested", 1)).unwrap();
    assert_eq!(git(&dir, &["show", &format!("{oid}:new")]), "included");
    assert_eq!(git(&dir, &["ls-tree", &oid, "empty"]), "");
    assert_eq!(fs::read(dir.join(".git/index")).unwrap(), index);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rejects_sparse_checkout_without_publishing_a_ref() {
    let dir = std::env::temp_dir().join(format!("checkpoint-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    git(&dir, &["config", "core.sparseCheckout", "true"]);
    let reference = checkpoint_ref("sparse", 1);
    assert!(capture(&dir, &reference).is_err());
    assert!(!has_ref(&dir, &reference).unwrap());
    fs::remove_dir_all(dir).unwrap();
}

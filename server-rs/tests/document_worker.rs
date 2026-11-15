use std::{fs, process::Command};

#[test]
fn document_worker_is_a_real_subprocess_and_classifies_failures() {
    let dir = std::env::temp_dir().join(format!("t3-doc-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.ipynb");
    fs::write(
        &path,
        r#"{"cells":[{"cell_type":"markdown","source":["Hello"]}]}"#,
    )
    .unwrap();
    let run = |path: &std::path::Path, ext: &str| {
        Command::new(env!("CARGO_BIN_EXE_t3code"))
            .arg("__document-text")
            .arg(path)
            .arg(ext)
            .output()
            .unwrap()
    };
    let success = run(&path, ".ipynb");
    assert!(success.status.success());
    assert_eq!(success.stdout, b"## Cell 1 (markdown)\nHello");
    assert_eq!(run(&path, ".unknown").status.code(), Some(2));
    fs::write(&path, "invalid").unwrap();
    assert_eq!(run(&path, ".ipynb").status.code(), Some(2));
    fs::remove_file(&path).unwrap();
    assert_eq!(run(&path, ".ipynb").status.code(), Some(1));
    fs::remove_dir_all(dir).unwrap();
}

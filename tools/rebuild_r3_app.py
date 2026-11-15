#!/usr/bin/env python3
"""Prepare one signed R3 bundle using the user's saved theme and contrast.

The output is staged for review; this command never stops or opens an app.  In
particular, the theme metadata and the compiled UI come from the same staged
source, rather than copying metadata from an older bundle.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tools import build_identity, build_theme, stage_python_runtime, stage_r3_source  # noqa: E402

HOST_WORKSPACE = ROOT / "third_party/nsh-host-combined-src/crates/gpui"
RELEASE_HOST = ROOT / "third_party/nsh-host-combined-src/target/release/nsh-gpui-host"
RUST_SERVER_WORKSPACE = ROOT / "server-rs"
RELEASE_RUST_SERVER = RUST_SERVER_WORKSPACE / "target/release/t3code"
DEFAULT_THEME_REQUEST = Path.home() / ".t3codegpui/bootstrap/theme-last.json"
HOST_PATCHES = (
    "clipboard_image", "keyed_list", "macos_drop", "markdown_table",
    "scroll_gesture", "titlebar_inset", "trailing_space", "webview_background",
    "macos_momentum", "macos_drop_read", "websocket_large", "focus_modifiers", "macos_about", "window_title", "wait_for_ui", "wait_for_ui_error", "dashed_border", "backdrop_blur",
)


def read_saved_theme(path: Path) -> dict:
    """Use the saved request if present; invalid saved data is an error, not a reset."""
    return build_theme.read_request_file(path) or build_theme.default_request()


def select_build_theme(path: Path, *, default_theme: bool) -> dict:
    """Release builds can opt out of embedding the packager's personal theme."""
    return build_theme.default_request() if default_theme else read_saved_theme(path)


def prepare_host_sources() -> None:
    for patch in HOST_PATCHES:
        subprocess.run([sys.executable, str(ROOT / f"tools/apply_nsh_{patch}_patch.py")], cwd=ROOT, check=True)


def validate_host(host: Path) -> None:
    # Refuse to package a launcher whose required startup flags the host lacks.
    host_bytes = host.read_bytes()
    if b"--window-title" not in host_bytes or b"--wait-for-ui" not in host_bytes:
        raise RuntimeError("The selected host lacks R3's startup options; rebuild the release host before packaging")


def prepare_app(output: Path, theme_request: Path, host: Path, *, build_host: bool, rust_server: Path | None = None, build_rust_server: bool = False, python_archive: Path | None = None, default_theme: bool = False, capture_source: bool = False) -> None:
    output = output.absolute()
    if output.exists():
        raise FileExistsError(f"{output} already exists; choose another output")
    if default_theme and capture_source and python_archive is None:
        raise ValueError("A source-captured release candidate requires the pinned Python archive")
    request = select_build_theme(theme_request, default_theme=default_theme)
    if build_host:
        prepare_host_sources()
    host_source = ROOT / "third_party/nsh-host-combined-src"
    source_digests = None
    if capture_source:
        source_digests = {
            "r3SourceTreeSha256": stage_r3_source.source_tree_digest(ROOT),
            "hostSourceTreeSha256": stage_r3_source.source_tree_digest(host_source),
            "hostBuiltFromSource": build_host,
        }
    if build_host:
        subprocess.run(["cargo", "build", "--release", "-p", "nsh-gpui-host"], cwd=HOST_WORKSPACE, check=True)
    host = host.resolve(strict=True)
    validate_host(host)
    if build_rust_server:
        if not (RUST_SERVER_WORKSPACE / "Cargo.toml").is_file():
            raise FileNotFoundError(f"Rust server workspace not found at {RUST_SERVER_WORKSPACE}")
        subprocess.run(["cargo", "build", "--release", "--bin", "t3code"], cwd=RUST_SERVER_WORKSPACE, check=True)
        rust_server = RELEASE_RUST_SERVER
    if rust_server is not None:
        rust_server = rust_server.resolve(strict=True)
    nsh = shutil.which("nsh")
    if not nsh:
        raise RuntimeError("nsh is not available on PATH")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-rebuild-", dir=output.parent) as temporary:
        temporary = Path(temporary)
        stage, ui = temporary / "theme-stage", temporary / "ui"
        python_runtime = None
        python_metadata = None
        if python_archive is not None:
            python_metadata = json.loads((ROOT / "python-runtime.json").read_text())
            python_runtime = stage_python_runtime.stage_runtime(python_archive.resolve(strict=True), temporary / "python-stage", python_metadata)
        meta = build_theme.stage_theme_build(ROOT / "t3ui/App.tsx", stage, request, build_theme.Sources())
        identity = build_identity.build_identity(host=host)
        if python_metadata:
            identity.update({"pythonVersion": python_metadata["version"], "pythonArchiveSha256": python_metadata["archiveSha256"]})
        if source_digests:
            identity.update(source_digests)
        build_identity.write_identity(stage / "buildIdentity.ts", identity)
        (stage / "build-identity.json").write_text(json.dumps(identity))
        print(f"Building UI with light={meta['light']} dark={meta['dark']} contrast={meta['contrast']}", flush=True)
        subprocess.run([nsh, "build", str(stage / "App.tsx"), "--release", "--out", str(ui)], cwd=ROOT, check=True)
        candidate = temporary / "R3 Code.app"
        command = [
            sys.executable, str(ROOT / "tools/build_r3_app.py"), "--ui", str(ui),
            "--theme-meta", str(stage / "theme-built.json"), "--identity", str(stage / "build-identity.json"), "--host", str(host), "--output", str(candidate),
        ]
        if rust_server is not None:
            command.extend(["--rust-server", str(rust_server)])
        if python_runtime is not None:
            command.extend(["--python-runtime", str(python_runtime)])
        subprocess.run(command, cwd=ROOT, check=True)
        if source_digests:
            stage_r3_source.verify_candidate_sources(identity, ROOT, host_source)
        # The destination is created only after build and source checks pass.
        candidate.rename(output)
        print(f"Prepared {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "build/.R3-rebuild-ready.app")
    parser.add_argument("--theme-request", type=Path, default=DEFAULT_THEME_REQUEST)
    parser.add_argument("--host", type=Path, default=RELEASE_HOST)
    parser.add_argument("--skip-host-build", action="store_true", help="Reuse the specified release host")
    parser.add_argument("--skip-rust-server-build", action="store_true", help="Reuse the release R3 Rust server binary if present")
    parser.add_argument("--default-theme", action="store_true", help="Use product defaults instead of the current user's saved theme")
    parser.add_argument("--capture-source", action="store_true", help="Record and verify checkout fingerprints across the build")
    parser.add_argument("--python-archive", type=Path, help="Pinned standalone Python archive for the theme helper")
    rust = parser.add_mutually_exclusive_group()
    rust.add_argument("--rust-server", type=Path, help="Compiled R3 Rust server binary (t3code) to bundle")
    rust.add_argument("--no-rust-server", action="store_true", help="Omit the bundled R3 Rust server")
    args = parser.parse_args()
    rust_server = args.rust_server
    build_rust_server = False
    if rust_server is None and not args.no_rust_server:
        if args.skip_rust_server_build and RELEASE_RUST_SERVER.is_file() and os.access(RELEASE_RUST_SERVER, os.X_OK):
            rust_server = RELEASE_RUST_SERVER
            print(f"Using release R3 Rust server: {rust_server}", flush=True)
        elif (RUST_SERVER_WORKSPACE / "Cargo.toml").is_file():
            build_rust_server = True
    prepare_app(args.output, args.theme_request, args.host, build_host=not args.skip_host_build, rust_server=rust_server, build_rust_server=build_rust_server, python_archive=args.python_archive, default_theme=args.default_theme, capture_source=args.capture_source)


if __name__ == "__main__":
    main()

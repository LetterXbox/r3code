#!/usr/bin/env python3
"""Reconstruct R3's patched NSH source from pinned upstream inputs."""
from __future__ import annotations

import argparse
import hashlib
import io
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://github.com/longbridge/nsh.git"
NSH_COMMIT = "e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3"
# Patched host tree includes the upstream memo, dialog, and QuickJS interrupt fixes.
PATCHED_TREE = "6b6294a8ad07ec923cd8263f5696e51847752428"
OVERLAY = ROOT / "third_party/nsh-host-patches/production-nsh-v0.4.0.patch"
GPUI_VERSION = "0.1.9"
GPUI_ARCHIVES = {
    "gpui-fast-apple": "f0f7e8b94df58e003dbad2a5b21cf6000a928b7a49020b0b68573e514a5a9888",
    "gpui-fast-macos": "c733dfacfc499748568f8fc0e2e268077259fcd4a2c306257c9dfda7c1a8a5fe",
}
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024


def unpack_crate(root: Path, name: str, digest: str, crate_dir: Path | None) -> None:
    package = f"{name}-{GPUI_VERSION}"
    archive = f"{package}.crate"
    if crate_dir is None:
        url = f"https://static.crates.io/crates/{name}/{archive}"
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(MAX_ARCHIVE_BYTES + 1)
    else:
        with (crate_dir / archive).open("rb") as source:
            data = source.read(MAX_ARCHIVE_BYTES + 1)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"Checksum mismatch for {archive}")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for entry in tar:
            if entry.isdir():
                continue
            relative = PurePosixPath(entry.name).relative_to(package)
            if not entry.isfile() or not relative.parts or ".." in relative.parts:
                raise ValueError(f"Unexpected archive member in {archive}: {entry.name}")
            if relative.name.endswith(".orig") or (name == "gpui-fast-apple" and relative == PurePosixPath("Cargo.lock")):
                continue
            destination = root / "vendor" / name / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(entry)
            if source is None:
                raise ValueError(f"Missing file content in {archive}: {entry.name}")
            with source, destination.open("xb") as output:
                output.write(source.read())
            destination.chmod(entry.mode & 0o777)


def verify_prepared_host(checkout: Path) -> None:
    marker = checkout / ".git/r3-prepared-host"
    if not marker.is_file() or marker.read_text().strip() != NSH_COMMIT:
        raise ValueError(f"Host checkout at {checkout} was not prepared from the pinned NSH commit")
    git = ["git", "-C", str(checkout)]
    tree = subprocess.check_output([*git, "write-tree"], text=True).strip()
    changed = subprocess.check_output([*git, "diff", "--name-only"], text=True)
    untracked = subprocess.check_output([*git, "ls-files", "--others", "--exclude-standard"], text=True)
    if tree != PATCHED_TREE or changed or untracked:
        raise ValueError(f"Host checkout at {checkout} differs from the pinned patched source")


def prepare_host(output: Path, upstream: str = ORIGIN, crate_dir: Path | None = None) -> None:
    output = output.absolute()
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"Host source destination already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-nsh-source-", dir=output.parent) as temporary:
        checkout = Path(temporary) / "checkout"
        checkout.mkdir()

        def git(*args: str) -> None:
            subprocess.run(["git", "-C", str(checkout), *args], check=True)

        git("init", "--quiet")
        git("remote", "add", "origin", upstream)
        git("fetch", "--quiet", "--depth=1", "origin", NSH_COMMIT)
        git("checkout", "--quiet", "--detach", NSH_COMMIT)
        for name, digest in GPUI_ARCHIVES.items():
            unpack_crate(checkout, name, digest, crate_dir)
        git("add", "--", "vendor")
        git("apply", "--index", "--whitespace=nowarn", str(OVERLAY))
        tree = subprocess.check_output(["git", "-C", str(checkout), "write-tree"], text=True).strip()
        if tree != PATCHED_TREE:
            raise ValueError(f"Patched NSH tree {tree} does not match the recorded host source")
        (checkout / ".git/r3-prepared-host").write_text(f"{NSH_COMMIT}\n")
        if output.exists() or output.is_symlink():
            raise FileExistsError(f"Host source destination already exists: {output}")
        checkout.rename(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--upstream", default=ORIGIN, help="Optional local mirror of the official NSH repository")
    parser.add_argument("--crate-dir", type=Path, help="Use local copies of the pinned crates.io archives")
    args = parser.parse_args()
    prepare_host(args.output, args.upstream, args.crate_dir)
    print(f"Prepared patched NSH source at {args.output}")


if __name__ == "__main__":
    main()

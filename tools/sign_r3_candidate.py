#!/usr/bin/env python3
"""Create a Developer ID signed copy of an R3 candidate, without publishing it."""
from __future__ import annotations

import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MACHO_MAGICS = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf", b"\xbe\xba\xfe\xca", b"\xbf\xba\xfe\xca"}


def runtime_macho_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    paths = []
    for path in root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as stream:
            if stream.read(4) in MACHO_MAGICS:
                paths.append(path)
    return sorted(paths)


def sign_candidate(source: Path, output: Path, identity: str) -> None:
    source = source.resolve(strict=True)
    output = output.absolute()
    if output.exists():
        raise FileExistsError(f"{output} already exists")
    if not identity or identity == "-":
        raise ValueError("A Developer ID Application identity is required")
    with (source / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != "com.jasonkneen.r3code":
        raise ValueError("The candidate does not have the R3 Code bundle identifier")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-sign-", dir=output.parent) as temporary:
        app = Path(temporary) / output.name
        shutil.copytree(source, app, symlinks=True)
        executable = app / "Contents/MacOS"
        host = executable / "nsh-gpui-host"
        supervisor = executable / "r3-server-supervisor"
        rust_server = app / "Contents/Resources/r3-server/t3code"
        if not all(path.is_file() for path in (host, supervisor, rust_server)):
            raise ValueError("Candidate is missing its host, server supervisor or bundled R3 Rust server")
        common = ["codesign", "--force", "--sign", identity, "--options", "runtime", "--timestamp"]
        subprocess.run([*common, "--entitlements", str(ROOT / "tools/r3-release.entitlements"), str(host)], check=True)
        subprocess.run([*common, str(supervisor)], check=True)
        subprocess.run([*common, str(rust_server)], check=True)
        for path in runtime_macho_files(app / "Contents/Resources/r3-server/node_modules"):
            subprocess.run([*common, str(path)], check=True)
        # Python extensions must share the Developer ID team for hardened-runtime library validation.
        for path in runtime_macho_files(app / "Contents/Resources/python"):
            subprocess.run([*common, str(path)], check=True)
        subprocess.run([*common, str(app)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        app.rename(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--identity", required=True, help="Developer ID Application signing identity")
    args = parser.parse_args()
    sign_candidate(args.input, args.output, args.identity)
    print(f"Signed candidate: {args.output}")


if __name__ == "__main__":
    main()

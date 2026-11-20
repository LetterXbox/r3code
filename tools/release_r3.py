#!/usr/bin/env python3
"""Version, build and tag a macOS R3 release locally."""
from __future__ import annotations

import argparse
import json
import plistlib
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.build_identity import ROOT, git, sha256_file

VERSION = ROOT / "R3_VERSION"


def version_parts(version: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version)
    if match is None:
        raise ValueError(f"Expected a stable SemVer version, got {version!r}")
    major, minor, patch = map(int, match.groups())
    return major, minor, patch


def bump(version: str, level: str) -> str:
    parts = list(version_parts(version))
    index = ("major", "minor", "patch").index(level)
    parts[index] += 1
    parts[index + 1:] = [0] * (2 - index)
    return ".".join(map(str, parts))


def run(*args: str) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def clean_commit() -> str:
    if git(ROOT, "status", "--porcelain"):
        raise ValueError("Commit the intended release source and build from a clean checkout")
    return git(ROOT, "rev-parse", "HEAD")


def build(args, version: str, commit: str) -> None:
    archive = args.python_archive.resolve(strict=True)
    out = args.output.resolve()
    if out.is_relative_to(ROOT) and subprocess.run(
            ["git", "check-ignore", "-q", "--", str(out)], cwd=ROOT).returncode != 0:
        raise ValueError("Use an ignored output directory or a path outside the checkout")
    out.mkdir(parents=True, exist_ok=False)
    app = out / "staged/R3 Code.app"
    signed = out / "signed/R3 Code.app"
    dmg = out / f"R3Code-{version}.dmg"
    run(sys.executable, "tools/rebuild_r3_app.py", "--default-theme", "--capture-source",
        "--python-archive", str(archive), "--output", str(app))
    with (app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    for key in ("CFBundleShortVersionString", "CFBundleVersion"):
        if info.get(key) != version:
            raise ValueError(f"{key} does not match R3_VERSION")
    if clean_commit() != commit:
        raise ValueError("Release checkout changed during build")
    run(sys.executable, "tools/sign_r3_candidate.py", "--input", str(app),
        "--output", str(signed), "--identity", args.identity)
    run(sys.executable, "tools/make_r3_dmg.py", "--app", str(signed),
        "--output", str(dmg), "--identity", args.identity)
    result = subprocess.check_output(
        ["xcrun", "notarytool", "submit", str(dmg), "--keychain-profile", args.notary_profile,
         "--no-s3-acceleration", "--wait", "--output-format", "json"], text=True)
    (out / "notarization.json").write_text(result)
    if json.loads(result).get("status") != "Accepted":
        raise ValueError("Apple did not accept notarization. See notarization.json")
    verify_dmg(dmg)
    digest = sha256_file(dmg)
    (out / "SHA256SUMS").write_text(f"{digest}  {dmg.name}\n")
    (out / "release.json").write_text(json.dumps(
        {"version": version, "commit": commit, "sha256": digest}, indent=2) + "\n")
    print(dmg)


def verify_dmg(dmg: Path, *, staple: bool = True) -> None:
    if staple:
        run("xcrun", "stapler", "staple", str(dmg))
    run("xcrun", "stapler", "validate", str(dmg))
    run("spctl", "-a", "-vv", "-t", "open", "--context", "context:primary-signature", str(dmg))
    run("hdiutil", "verify", str(dmg))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    increment = commands.add_parser("bump")
    increment.add_argument("level", choices=("major", "minor", "patch"))
    package = commands.add_parser("build")
    package.add_argument("--python-archive", required=True, type=Path)
    package.add_argument("--output", required=True, type=Path)
    package.add_argument("--identity", required=True)
    package.add_argument("--notary-profile", required=True)
    tag = commands.add_parser("tag")
    tag.add_argument("output", type=Path, help="Verified build output directory")
    args = parser.parse_args()
    version = VERSION.read_text().strip()
    version_parts(version)
    if args.command == "bump":
        version = bump(version, args.level)
        VERSION.write_text(version + "\n")
        print(version)
        return
    commit = clean_commit()
    if args.command == "build":
        build(args, version, commit)
        return
    receipt = json.loads((args.output / "release.json").read_text())
    dmg = (args.output / f"R3Code-{version}.dmg").resolve(strict=True)
    if receipt != {"version": version, "commit": commit, "sha256": sha256_file(dmg)}:
        raise ValueError("Release receipt does not match the current commit, version and DMG")
    verify_dmg(dmg, staple=False)
    run("git", "tag", "-a", f"v{version}", commit, "-m", f"R3 Code {version}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))

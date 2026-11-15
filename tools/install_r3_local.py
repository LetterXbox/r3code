#!/usr/bin/env python3
"""Replace the local Applications copy with a verified R3 bundle, without launching it."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def install(candidate: Path, applications: Path, *, name: str = "R3 Code.app") -> tuple[Path, Path | None]:
    candidate = candidate.resolve(strict=True)
    applications = applications.resolve(strict=True)
    if name not in ("R3 Code.app", "R3Code.app"):
        raise ValueError("Unsupported R3 application name")
    target = applications / name
    alternate = applications / ("R3Code.app" if name == "R3 Code.app" else "R3 Code.app")
    if target.is_symlink() or alternate.is_symlink():
        raise RuntimeError("Applications copy is a symlink; installation was not performed")
    if target.exists() and alternate.exists():
        raise RuntimeError("Both R3 app names already exist; installation was not performed")
    existing = target if target.exists() else alternate
    if not (candidate / "Contents/Info.plist").is_file():
        raise ValueError("Candidate is not an app bundle")
    with tempfile.TemporaryDirectory(prefix=".r3-install-", dir=applications) as temporary:
        incoming = Path(temporary) / name
        shutil.copytree(candidate, incoming, symlinks=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(incoming)], check=True)
        processes = subprocess.check_output(["ps", "-axo", "command="], text=True)
        prefix = str(existing / "Contents/MacOS") + "/"
        if any(line.strip().startswith(prefix) for line in processes.splitlines()):
            raise RuntimeError("R3 Code is running from Applications; installation was not performed")
        previous = None
        if existing.exists():
            name = datetime.now(timezone.utc).strftime(".R3 Code-previous-%Y%m%dT%H%M%S%fZ.app")
            previous = applications / name
            if previous.exists():
                raise FileExistsError(f"Backup already exists: {previous}")
            os.rename(existing, previous)
        try:
            os.rename(incoming, target)
        except BaseException:
            if previous is not None:
                os.rename(previous, existing)
            raise
    return target, previous


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--applications", type=Path, default=Path("/Applications"))
    parser.add_argument("--name", choices=("R3 Code.app", "R3Code.app"), default="R3 Code.app")
    args = parser.parse_args()
    target, previous = install(args.candidate, args.applications, name=args.name)
    print(f"Installed: {target}")
    if previous is not None:
        print(f"Previous app: {previous}")


if __name__ == "__main__":
    main()

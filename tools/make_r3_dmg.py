#!/usr/bin/env python3
"""Build a local Developer ID signed R3 DMG; never upload or publish it."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile


def make_dmg(app: Path, output: Path, identity: str | None = None) -> None:
    app = app.resolve(strict=True)
    output = output.absolute()
    if output.exists():
        raise FileExistsError(f"{output} already exists")
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if info.get("CFBundleIdentifier") != "com.jasonkneen.r3code":
        raise ValueError("The app does not have the R3 Code bundle identifier")
    if not (app / "Contents/Resources/r3-server/t3code").is_file():
        raise ValueError("The app does not contain the R3 Rust server")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    details = subprocess.run(["codesign", "-dv", "--verbose=2", str(app)], capture_output=True, text=True, check=True).stderr
    if "Authority=Developer ID Application:" not in details or "TeamIdentifier=not set" in details:
        raise ValueError("The app needs a Developer ID Application signature")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-dmg-", dir=output.parent) as temporary:
        root = Path(temporary)
        stage = root / "contents"
        stage.mkdir()
        shutil.copytree(app, stage / "R3 Code.app", symlinks=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(stage / "R3 Code.app")], check=True)
        (stage / "Applications").symlink_to("/Applications")
        image = root / "R3Code.dmg"
        subprocess.run(["hdiutil", "create", "-volname", "R3 Code", "-srcfolder", str(stage), "-format", "UDZO", str(image)], check=True)
        if identity is not None:
            if not identity or identity == "-":
                raise ValueError("A Developer ID Application identity is required to sign the DMG")
            subprocess.run(["codesign", "--force", "--sign", identity, "--timestamp", str(image)], check=True)
            subprocess.run(["codesign", "--verify", "--strict", str(image)], check=True)
        os.rename(image, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--identity", help="Developer ID Application identity for signing the DMG")
    args = parser.parse_args()
    make_dmg(args.app, args.output, args.identity)
    print(f"Local DMG: {args.output}")


if __name__ == "__main__":
    main()

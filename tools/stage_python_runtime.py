"""Verify and safely extract the pinned standalone Python runtime."""
from __future__ import annotations

import hashlib
from pathlib import Path, PurePosixPath
import tarfile


def stage_runtime(archive: Path, destination: Path, metadata: dict) -> Path:
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != metadata.get("archiveSha256"):
        raise ValueError("Python runtime archive does not match the pinned checksum")
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        seen = set()
        links = set()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or not path.parts or path.parts[0] != "python" or ".." in path.parts or member.name in seen:
                raise ValueError("Python runtime archive contains an unsafe path")
            seen.add(member.name)
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or not target.parts or ".." in target.parts:
                    raise ValueError("Python runtime archive contains an unsafe link")
                links.add(path)
            elif not (member.isfile() or member.isdir()):
                raise ValueError("Python runtime archive contains an unsupported entry")
        if any(link in path.parents for member in members for path in [PurePosixPath(member.name)] for link in links):
            raise ValueError("Python runtime archive contains a symlink directory")
        tar.extractall(destination)
    runtime = destination / "python"
    if not (runtime / "bin/python3.11").is_file() or not (runtime / "lib/python3.11/LICENSE.txt").is_file():
        raise ValueError("Python runtime archive is missing its executable or license")
    return runtime

#!/usr/bin/env python3
"""Stage a local source snapshot for review; this does not publish or push it."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import stat
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args])


def source_files(root: Path) -> list[str]:
    raw = git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    names = sorted(set(os.fsdecode(name) for name in raw.split(b"\0") if name))
    files = []
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError(f"Unsafe source path: {name}")
        if path.name.endswith(".orig"):
            continue
        if path.name == ".env" or path.name.startswith(".env.") or path.suffix.lower() in {".pem", ".p12", ".p8", ".sqlite", ".db"}:
            raise ValueError(f"Review sensitive-looking source path before staging: {name}")
        local = root / name
        if local.is_symlink():
            destination = local.resolve(strict=True)
            if root.resolve() not in destination.parents:
                raise ValueError(f"Source symlink leaves its checkout: {name}")
        if local.is_file() or local.is_symlink():
            files.append(name)
    return files


def source_tree_digest(root: Path) -> str:
    """Fingerprint the non-ignored checkout inputs, including symlinks and file modes.

    This is an input inventory, not a claim that the compiler is reproducible or
    that ignored dependencies are captured by the source archive.
    """
    entries = []
    for name in source_files(root):
        path = root / name
        info = path.lstat()
        if path.is_symlink():
            entries.append([name, "symlink", os.readlink(path)])
        else:
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            entries.append([name, "file", stat.S_IMODE(info.st_mode), digest.hexdigest()])
    encoded = json.dumps(entries, ensure_ascii=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def verify_candidate_sources(identity: dict, r3: Path, host: Path) -> None:
    """Reject a snapshot which differs from input fingerprints recorded at build time."""
    for field, root in (("r3SourceTreeSha256", r3), ("hostSourceTreeSha256", host)):
        expected = identity.get(field)
        if expected is not None and source_tree_digest(root) != expected:
            raise RuntimeError(f"{field} differs from the candidate's build inputs")


def stage_source(output: Path, identity_path: Path) -> None:
    output = output.absolute()
    if output.exists():
        raise FileExistsError(f"{output} already exists")
    identity = json.loads(identity_path.read_text())
    upstream = ROOT.parent / "T3code"
    host = ROOT / "third_party/nsh-host-combined-src"
    if git(upstream, "status", "--porcelain", "--untracked-files=normal").strip():
        raise RuntimeError("T3 reference checkout is dirty; cannot archive its exact state")
    reference = git(upstream, "rev-parse", "HEAD").decode().strip()
    release = json.loads((ROOT / "t3-release.json").read_text())["commit"]
    if not reference.startswith(identity["referenceT3Sha"]) or not release.startswith(identity["officialT3Sha"]):
        raise RuntimeError("Current upstream revisions do not match the candidate identity")
    snapshots = [("r3", ROOT, source_files(ROOT)), ("nsh-host", host, source_files(host))]
    verify_candidate_sources(identity, ROOT, host)
    manifest = {
        "candidateIdentity": identity,
        "r3HeadAtSnapshot": git(ROOT, "rev-parse", "HEAD").decode().strip(),
        "r3DirtyAtSnapshot": bool(git(ROOT, "status", "--porcelain", "--untracked-files=normal").strip()),
        "hostHeadAtSnapshot": git(host, "rev-parse", "HEAD").decode().strip(),
        "hostDirtyAtSnapshot": bool(git(host, "status", "--porcelain", "--untracked-files=normal").strip()),
        "referenceT3Commit": reference,
        "officialT3Commit": release,
        "notice": "Review this snapshot for rights and sensitive content. A dirty checkout snapshot is not proof of the candidate's exact source.",
        "files": {},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-source-", dir=output.parent) as temporary:
        base = Path(temporary)
        for name, commit in (("t3-reference.tar", reference), ("t3-official-release.tar", release)):
            with (base / name).open("wb") as stream:
                subprocess.run(["git", "-C", str(upstream), "archive", "--format=tar", commit], stdout=stream, check=True)
        archive = base / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for label, root, files in snapshots:
                for name in files:
                    path = root / name
                    key = f"{label}/{name}"
                    tar.add(path, arcname=key, recursive=False)
                    if not path.is_symlink():
                        with path.open("rb") as stream:
                            digest = hashlib.sha256()
                            for block in iter(lambda: stream.read(1024 * 1024), b""):
                                digest.update(block)
                        manifest["files"][key] = digest.hexdigest()
            for name in ("t3-reference.tar", "t3-official-release.tar"):
                tar.add(base / name, arcname=f"upstream/{name}", recursive=False)
            data = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
            info = tarfile.TarInfo("SOURCE_INVENTORY.json")
            info.size = len(data)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(data))
        verify_candidate_sources(identity, ROOT, host)
        os.rename(archive, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    stage_source(args.output, args.identity)
    print(f"Source snapshot for review: {args.output}")


if __name__ == "__main__":
    main()

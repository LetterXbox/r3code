#!/usr/bin/env python3
"""Make a private, consistent SQLite backup before a local server upgrade."""
from __future__ import annotations

from datetime import datetime, timezone
import argparse
import hashlib
import os
from pathlib import Path
import sqlite3
import stat
import subprocess


def private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"Backup directory is not private: {path}")


def offline_database_digest(path: Path) -> str:
    """Only use an immutable SQLite snapshot when no writer or journal is present."""
    for suffix in ("-wal", "-shm", "-journal"):
        if Path(str(path) + suffix).exists():
            raise RuntimeError("Cannot snapshot a database with an active journal")
    result = subprocess.run(["/usr/sbin/lsof", "-t", str(path)], capture_output=True, check=False)
    if result.returncode != 1 or result.stdout or result.stderr:
        raise RuntimeError("Cannot snapshot a database that may be in use")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def open_backup_source(path: Path) -> tuple[sqlite3.Connection, str | None]:
    """Use normal SQLite locking when possible; safely handle an offline WAL database."""
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    try:
        connection.execute("PRAGMA schema_version").fetchone()
        return connection, None
    except sqlite3.OperationalError:
        connection.close()
    digest = offline_database_digest(path)
    connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        connection.execute("PRAGMA schema_version").fetchone()
    except BaseException:
        connection.close()
        raise
    return connection, digest


def backup_databases(home: Path, *, include_t3: bool = False) -> Path | None:
    root = home / ".t3codegpui"
    source = root / "server/userdata"
    names = ("statev2.sqlite", "server-owner.sqlite")
    sources = [(source / name, None) for name in names]
    sources.extend((home / ".r3/server/userdata" / name, "r3-native") for name in names)
    if include_t3:
        sources.extend((home / ".t3/userdata" / name, "t3") for name in names)
    existing = [(path, group) for path, group in sources if path.exists()]
    if not existing:
        return None
    private_directory(root)
    backups = root / "release-backups"
    private_directory(backups)
    target = backups / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target.mkdir(mode=0o700)
    try:
        for source_file, group in existing:
            info = source_file.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise RuntimeError("Database source is not an owned regular file")
            source_connection, offline_digest = open_backup_source(source_file)
            destination_directory = target
            if group:
                destination_directory = target / group
                private_directory(destination_directory)
            destination = destination_directory / source_file.name
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.close(fd)
            try:
                with sqlite3.connect(destination) as destination_connection:
                    source_connection.backup(destination_connection)
                    if destination_connection.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                        raise RuntimeError("Database backup integrity check failed")
            finally:
                source_connection.close()
            if offline_digest is not None and offline_database_digest(source_file) != offline_digest:
                raise RuntimeError("Database changed during the offline backup")
    except BaseException:
        # Keep partial backups for inspection; never delete a user's source.
        raise
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-t3", action="store_true", help="Also back up the local T3 Code databases separately")
    args = parser.parse_args()
    result = backup_databases(Path.home(), include_t3=args.include_t3)
    print(f"Database backup: {result}" if result else "No existing server databases to back up")

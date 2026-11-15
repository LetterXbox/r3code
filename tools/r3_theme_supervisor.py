#!/usr/bin/env python3
"""Answer live theme requests while the bundled R3 host is running."""
import fcntl
import os
from pathlib import Path
import stat
import sys
import time

HERE = Path(__file__).resolve().parent
os.environ['T3_INDEX_CSS'] = str(HERE / 'index.css')
os.environ['T3_THEME_PALETTES'] = str(HERE / 'themePalettes.ts')
# Isolated Python excludes the script directory; import only our bundled helpers.
sys.path.insert(0, str(HERE))
import build_theme  # noqa: E402


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def main():
    pid = int(sys.argv[1])
    bootstrap = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home() / '.t3codegpui/bootstrap'
    bootstrap.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = bootstrap.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('R3 theme directory must be private')
    fd = os.open(bootstrap / 'theme-supervisor.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'a') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError('R3 theme lock must be private')
        for _ in range(30):
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not alive(pid): return
                time.sleep(0.1)
        else:
            return
        sources = None
        def get_sources():
            nonlocal sources
            if sources is None: sources = build_theme.Sources()
            return sources
        watcher = build_theme.LiveThemeWatcher(bootstrap, get_sources)
        watcher.start()
        try:
            while alive(pid): time.sleep(0.2)
        finally:
            watcher.stop()


if __name__ == '__main__':
    main()

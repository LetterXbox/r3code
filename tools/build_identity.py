"""Identify the checked-out sources and the selected official T3 release."""
from __future__ import annotations

import json
import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
T3_ROOT = ROOT.parent / 'T3code'


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def build_identity(root: Path = ROOT, t3_root: Path = T3_ROOT, host: Path | None = None, *, host_source: Path | None = None) -> dict:
    source_version = json.loads((t3_root / 'apps/desktop/package.json').read_text())['version']
    release = json.loads((root / 't3-release.json').read_text())
    release_commit = git(t3_root, 'rev-parse', '--verify', f"refs/tags/{release['tag']}^{{commit}}")
    if release_commit != release['commit']:
        raise ValueError('Selected T3 release tag does not match its recorded commit')
    official_version = release['version']
    reference_sha = git(t3_root, 'rev-parse', '--short=9', 'HEAD')
    reference_dirty = bool(git(t3_root, 'status', '--porcelain', '--untracked-files=normal'))
    result = {
        'r3Version': (root / 'R3_VERSION').read_text().strip(),
        'r3Sha': git(root, 'rev-parse', '--short=9', 'HEAD'),
        'r3Dirty': bool(git(root, 'status', '--porcelain', '--untracked-files=normal')),
        't3Version': source_version,
        't3Sha': reference_sha,
        't3Dirty': reference_dirty,
        'referenceT3Version': source_version,
        'referenceT3Sha': reference_sha,
        'referenceT3Dirty': reference_dirty,
        'officialT3Version': official_version,
        'officialT3Sha': release_commit[:9],
    }
    host_source = host_source or root / 'third_party/nsh-host-combined-src'
    if (host_source / '.git').exists():
        # This records the checkout at packaging time, not proof that a reused host was built from it.
        result['hostSourceShaAtPackaging'] = git(host_source, 'rev-parse', 'HEAD')
        result['hostSourceDirtyAtPackaging'] = bool(git(host_source, 'status', '--porcelain', '--untracked-files=normal'))
    if host is not None:
        result['hostExecutableSha256'] = sha256_file(host.resolve(strict=True))
    return result


def write_identity(path: Path, identity: dict) -> None:
    path.write_text('// Generated for this build; do not edit.\nexport const buildIdentity = ' + json.dumps(identity, ensure_ascii=False) + ' as const;\n')

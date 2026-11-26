#!/usr/bin/env python3
"""Prepare, build, and package the Windows thin client for R3 Code."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = "https://github.com/longbridge/nsh.git"
NSH_VERSION = "0.7.1"
NSH_COMMIT = "f78eace7af23a9c1c72605c7ee46204f57f3e8e6"
WINDOWS_PATCH = ROOT / "third_party/nsh-host-patches/windows-nsh-v0.7.1.patch"
DEFAULT_NSH_SOURCE = ROOT / "build/nsh-windows-sources" / f"v{NSH_VERSION}-{NSH_COMMIT[:12]}"

SPEECH_IMPORT_RE = re.compile(
    r'(import\s*\{[^}]*?),\s*Speech\b([^}]*\}\s*from\s*"nsh";)'
)
SPEECH_SHIM = (
    "\nconst Speech = {\n"
    "  available: async () => false,\n"
    "  start: () => ({ stop() {}, abort() {} }),\n"
    "};\n"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def marker_value(patch_path: Path = WINDOWS_PATCH) -> str:
    normalized = patch_path.read_bytes().replace(b"\r\n", b"\n")
    digest = hashlib.sha256(normalized).hexdigest()
    return f"{NSH_COMMIT}:{digest}\n"


def prepare_nsh_source(output: Path, upstream: str = ORIGIN, patch_path: Path = WINDOWS_PATCH) -> Path:
    output = output.absolute()
    marker = output / ".git/r3-windows-nsh"
    expected = marker_value(patch_path)
    if marker.is_file() and marker.read_text(encoding="utf-8") == expected:
        return output
    if output.exists() or output.is_symlink():
        raise FileExistsError(
            f"Windows NSH source destination already exists with unexpected state: {output}"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".r3-nsh-win-", dir=output.parent) as temporary:
        temp_path = Path(temporary)
        checkout = temp_path / "checkout"
        checkout.mkdir()

        def git(*args: str) -> None:
            subprocess.run(["git", "-C", str(checkout), *args], check=True)

        git("init", "--quiet")
        git("config", "core.autocrlf", "false")
        git("config", "core.eol", "lf")
        git("remote", "add", "origin", upstream)
        git("fetch", "--quiet", "--depth=1", "origin", NSH_COMMIT)
        git("checkout", "--quiet", "--detach", NSH_COMMIT)
        lf_patch = temp_path / "windows-nsh.patch"
        lf_patch.write_bytes(patch_path.resolve(strict=True).read_bytes().replace(b"\r\n", b"\n"))
        git("apply", "--index", "--whitespace=nowarn", str(lf_patch))
        (checkout / ".git/r3-windows-nsh").write_text(expected, encoding="utf-8")
        checkout.rename(output)
    return output


def windows_manifest(manifest: dict) -> dict:
    updated = json.loads(json.dumps(manifest))
    caps = updated.setdefault("capabilities", {})
    caps["windows"] = True
    caps["homeDir"] = True
    caps["application"] = True
    caps["notifications"] = True
    caps["audio"] = True

    fs_caps = caps.setdefault("fs", {})
    fs_read = list(fs_caps.get("read", []))
    for entry in ("${homeDir}", "${dataDir}"):
        if entry not in fs_read:
            fs_read.append(entry)
    fs_caps["read"] = fs_read

    proc_caps = caps.setdefault("process", {})
    proc_env = list(proc_caps.get("env", []))
    for var in ("USERPROFILE", "APPDATA", "LOCALAPPDATA"):
        if var not in proc_env:
            proc_env.append(var)
    proc_caps["env"] = proc_env

    proc_exec = list(proc_caps.get("execute", []))
    if "ssh.exe" not in proc_exec:
        proc_exec.append("ssh.exe")
    proc_caps["execute"] = proc_exec

    host_caps = list(caps.get("host", []))
    for capability in ("secureStorage.*", "dialogs.pickFiles"):
        if capability not in host_caps:
            host_caps.append(capability)
    caps["host"] = host_caps
    return updated


def adapt_composer_for_v07(source: str) -> str:
    """NSH 0.7 moved Speech into nsh-extra; replace the nsh import in the staged Windows copy."""
    updated, count = SPEECH_IMPORT_RE.subn(r"\1\2" + SPEECH_SHIM, source, count=1)
    if count != 1:
        raise ValueError("Could not locate Speech import in Composer.tsx for NSH 0.7 staging")
    return updated


def standalone_build_identity(
    root: Path = ROOT,
    host_exe: Path | None = None,
    nsh_commit: str = NSH_COMMIT,
) -> dict:
    def git_out(*args: str) -> str:
        try:
            return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
        except Exception:
            return "unknown"

    release = json.loads((root / "t3-release.json").read_text(encoding="utf-8"))
    official_version = release["version"]
    official_sha = release["commit"][:9]
    dirty = bool(git_out("status", "--porcelain", "--untracked-files=normal"))
    identity: dict = {
        "r3Version": (root / "R3_VERSION").read_text(encoding="utf-8").strip(),
        "r3Sha": git_out("rev-parse", "--short=9", "HEAD"),
        "r3Dirty": dirty,
        "t3Version": official_version,
        "t3Sha": official_sha,
        "t3Dirty": False,
        "referenceT3Version": official_version,
        "referenceT3Sha": official_sha,
        "referenceT3Dirty": False,
        "officialT3Version": official_version,
        "officialT3Sha": official_sha,
        "nshVersion": NSH_VERSION,
        "nshCommit": nsh_commit,
        "platform": "windows",
    }
    if host_exe is not None and host_exe.is_file():
        identity["hostExecutableSha256"] = sha256_file(host_exe)
    return identity


def _copy_ignore(app_dir: Path):
    def ignore(directory: str, names: list[str]) -> set[str]:
        here = Path(directory)
        ignored: set[str] = set()
        for name in names:
            if (
                name in {".nsh", "node_modules", "__pycache__"}
                or name.endswith((".test.ts", ".test.tsx", ".log"))
                or "Fixture" in name
            ):
                ignored.add(name)
        if here == app_dir:
            for name in names:
                if name.endswith(".png") or name == "usage-probe":
                    ignored.add(name)
        return ignored

    return ignore


def stage_windows_ui(stage_dir: Path, root: Path = ROOT, identity: dict | None = None) -> None:
    app_dir = root / "t3ui"
    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    shutil.copytree(app_dir, stage_dir, ignore=_copy_ignore(app_dir), symlinks=False)

    manifest_path = stage_dir / "nsh.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_path.write_text(
        json.dumps(windows_manifest(manifest), indent=2) + "\n",
        encoding="utf-8",
    )

    composer_path = stage_dir / "components/Composer.tsx"
    composer_path.write_text(
        adapt_composer_for_v07(composer_path.read_text(encoding="utf-8")),
        encoding="utf-8",
    )

    if identity is not None:
        (stage_dir / "buildIdentity.ts").write_text(
            "// Generated for this build; do not edit.\nexport const buildIdentity = "
            + json.dumps(identity, ensure_ascii=False)
            + " as const;\n",
            encoding="utf-8",
        )
        (stage_dir / "build-identity.json").write_text(
            json.dumps(identity, indent=2) + "\n",
            encoding="utf-8",
        )


def extract_ico_from_icns(icns_path: Path, ico_path: Path) -> bool:
    """Wrap the embedded PNG icons from r3-icon.icns into a Vista+ Windows .ico file."""
    data = icns_path.read_bytes()
    if len(data) < 8 or data[:4] != b"icns":
        return False
    png_chunks: list[tuple[int, bytes]] = []
    offset = 8
    size_by_type = {b"icp4": 16, b"icp5": 32, b"icp6": 64, b"ic07": 128, b"ic08": 256}
    while offset + 8 <= len(data):
        tag = data[offset : offset + 4]
        length = struct.unpack(">I", data[offset + 4 : offset + 8])[0]
        if length < 8 or offset + length > len(data):
            break
        payload = data[offset + 8 : offset + length]
        if tag in size_by_type and payload.startswith(b"\x89PNG\r\n\x1a\n"):
            png_chunks.append((size_by_type[tag], payload))
        offset += length
    if not png_chunks:
        return False

    header = struct.pack("<HHH", 0, 1, len(png_chunks))
    entries = bytearray()
    body = bytearray()
    image_offset = 6 + 16 * len(png_chunks)
    for dim, png in png_chunks:
        dim_byte = 0 if dim >= 256 else dim
        entries.extend(struct.pack("<BBBBHHII", dim_byte, dim_byte, 0, 0, 1, 32, len(png), image_offset))
        body.extend(png)
        image_offset += len(png)
    ico_path.parent.mkdir(parents=True, exist_ok=True)
    ico_path.write_bytes(header + bytes(entries) + bytes(body))
    return True


def package_windows_bundle(
    ui_dir: Path,
    host_exe: Path,
    output_dir: Path,
    *,
    identity: dict | None = None,
    root: Path = ROOT,
    zip_path: Path | None = None,
) -> Path:
    output_dir = output_dir.absolute()
    if output_dir.exists():
        shutil.rmtree(output_dir)
    nsh_dir = output_dir / "nsh"
    nsh_dir.mkdir(parents=True)

    shutil.copy2(host_exe, output_dir / "R3 Code.exe")
    shutil.copy2(ui_dir / "bundle.nshc", nsh_dir / "bundle.nshc")
    assets_src = ui_dir / "assets"
    if assets_src.is_dir():
        shutil.copytree(assets_src, nsh_dir / "assets")

    icns = root / "assets/r3-icon.icns"
    if icns.is_file():
        extract_ico_from_icns(icns, nsh_dir / "icon.ico")

    manifest = windows_manifest(json.loads((root / "t3ui/nsh.json").read_text(encoding="utf-8")))
    app_json = {
        "name": manifest.get("name", "R3 Code"),
        "id": manifest.get("id", "com.example.t3ui"),
        "version": manifest.get("version", "1.0.0"),
        "singleInstance": True,
    }
    (nsh_dir / "app.json").write_text(json.dumps(app_json, indent=2) + "\n", encoding="utf-8")
    if isinstance(manifest.get("capabilities"), dict):
        (nsh_dir / "capabilities.json").write_text(
            json.dumps(manifest["capabilities"], indent=2) + "\n",
            encoding="utf-8",
        )

    if identity is not None:
        (nsh_dir / "build-identity.json").write_text(
            json.dumps(identity, indent=2) + "\n",
            encoding="utf-8",
        )

    for license_name in ("LICENSE", "LICENSING.md", "COMPONENT-LICENSES.md"):
        src = root / license_name
        if src.is_file():
            dst_name = "LICENSE.txt" if license_name == "LICENSE" else license_name
            shutil.copy2(src, output_dir / dst_name)
    licenses_dir = root / "LICENSES"
    if licenses_dir.is_dir():
        shutil.copytree(licenses_dir, output_dir / "LICENSES")

    if zip_path is not None:
        zip_path = zip_path.absolute()
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for file_path in sorted(output_dir.rglob("*")):
                if file_path.is_file():
                    arcname = Path(output_dir.name) / file_path.relative_to(output_dir)
                    archive.write(file_path, arcname.as_posix())
    return output_dir


def build_nsh_binaries(nsh_source: Path, target_dir: Path | None = None) -> tuple[Path, Path]:
    env = os.environ.copy()
    if target_dir is not None:
        env["CARGO_TARGET_DIR"] = str(target_dir.absolute())
    resolved_target = target_dir.absolute() if target_dir is not None else nsh_source / "target"

    subprocess.run(
        ["cargo", "build", "--locked", "--release", "-p", "nsh-cli", "-p", "nsh-windows-app"],
        cwd=nsh_source,
        env=env,
        check=True,
    )
    exe_suffix = ".exe" if os.name == "nt" else ""
    return (
        resolved_target / "release" / f"nsh{exe_suffix}",
        resolved_target / "release" / f"nsh-windows-app{exe_suffix}",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nsh-source", type=Path, default=DEFAULT_NSH_SOURCE)
    parser.add_argument("--upstream", default=ORIGIN)
    parser.add_argument("--target-dir", type=Path, help="Optional Cargo target directory")
    parser.add_argument("--nsh-bin", type=Path, help="Prebuilt nsh CLI executable")
    parser.add_argument("--host-exe", type=Path, help="Prebuilt nsh-windows-app.exe executable")
    parser.add_argument("--output", type=Path, default=ROOT / "build/R3 Code")
    parser.add_argument("--zip", type=Path, help="Optional portable .zip output path")
    parser.add_argument("--stage-dir", type=Path, help="Optional directory to keep staged Windows t3ui sources")
    parser.add_argument("--prepare-only", action="store_true", help="Only prepare and verify patched NSH source")
    args = parser.parse_args()

    nsh_bin, host_exe = args.nsh_bin, args.host_exe
    if args.prepare_only or nsh_bin is None or host_exe is None:
        nsh_source = prepare_nsh_source(args.nsh_source, upstream=args.upstream)
        print(f"Prepared Windows NSH {NSH_VERSION} source at {nsh_source}", flush=True)
        if args.prepare_only:
            return
        built_cli, built_host = build_nsh_binaries(nsh_source, target_dir=args.target_dir)
        nsh_bin = nsh_bin or built_cli
        host_exe = host_exe or built_host

    nsh_bin = nsh_bin.resolve(strict=True)
    host_exe = host_exe.resolve(strict=True)
    identity = standalone_build_identity(ROOT, host_exe=host_exe)

    with tempfile.TemporaryDirectory(prefix="r3-win-stage-") as temporary:
        temp_root = Path(temporary)
        stage_dir = args.stage_dir.absolute() if args.stage_dir is not None else temp_root / "t3ui"
        ui_out = temp_root / "ui"
        stage_windows_ui(stage_dir, ROOT, identity=identity)
        subprocess.run(
            [str(nsh_bin), "build", str(stage_dir / "App.tsx"), "--release", "--out", str(ui_out)],
            cwd=ROOT,
            check=True,
        )
        packaged = package_windows_bundle(
            ui_out,
            host_exe,
            args.output,
            identity=identity,
            root=ROOT,
            zip_path=args.zip,
        )
    print(f"Packaged Windows bundle at {packaged}", flush=True)
    if args.zip:
        print(f"Created portable archive at {args.zip.absolute()}", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Make a local macOS R3 app from a built UI and the patched GPUI host."""
import argparse
import json
import plistlib
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


MACHO_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf', b'\xbe\xba\xfe\xca', b'\xbf\xba\xfe\xca')


def runtime_macho_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    paths = []
    for path in root.rglob('*'):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open('rb') as stream:
            if stream.read(4) in MACHO_MAGICS:
                paths.append(path)
    return sorted(paths)


def stage_speech_modules(destination: Path) -> None:
    server_nm = ROOT.parent / 'T3code/apps/server/node_modules'
    transcribe_src = (server_nm / 'transcribe-cpp').resolve(strict=True)
    transcribe_peer_nm = transcribe_src.parent
    metal_src = (transcribe_peer_nm / '@transcribe-cpp/darwin-arm64-metal').resolve(strict=True)
    koffi_src = (transcribe_peer_nm / 'koffi').resolve(strict=True)
    koffi_darwin_src = (koffi_src.parent / '@koromix/koffi-darwin-arm64').resolve(strict=True)
    packages = (
        (transcribe_src, destination / 'transcribe-cpp'),
        (metal_src, destination / '@transcribe-cpp/darwin-arm64-metal'),
        (koffi_src, destination / 'koffi'),
        (koffi_darwin_src, destination / '@koromix/koffi-darwin-arm64'),
    )
    ignore = shutil.ignore_patterns('node_modules')
    for src, dst in packages:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, symlinks=False, ignore=ignore)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ui', type=Path, required=True, help='Directory produced by nsh build')
    parser.add_argument('--theme-meta', type=Path, required=True, help='Built theme metadata JSON')
    parser.add_argument('--identity', type=Path, help='Build identity JSON')
    parser.add_argument('--host', type=Path, default=ROOT / 'third_party/nsh-host/nsh-gpui-host')
    parser.add_argument('--rust-server', type=Path, help='Compiled R3 Rust server executable (t3code)')
    parser.add_argument('--python-runtime', type=Path, help='Verified standalone Python runtime directory')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/R3 Code.app')
    args = parser.parse_args()
    ui, host, theme = args.ui.resolve(strict=True), args.host.resolve(strict=True), args.theme_meta.resolve(strict=True)
    output = args.output.absolute()
    if output.exists():
        raise SystemExit(f'{output} already exists; choose another --output')
    json.loads(theme.read_text())
    identity = json.loads(args.identity.read_text()) if args.identity else None
    version = identity['r3Version'] if identity else '0.1.0'
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.r3-app-', dir=output.parent) as temporary:
        app = Path(temporary) / output.name
        contents = app / 'Contents'
        binary = contents / 'MacOS'
        resources = contents / 'Resources'
        binary.mkdir(parents=True)
        resources.mkdir()
        # Keep the first-party and native dependency notices available offline in the bundle.
        shutil.copy2(ROOT / 'LICENSE', resources / 'LICENSE.txt')
        shutil.copy2(ROOT / 'LICENSING.md', resources / 'LICENSING.md')
        shutil.copytree(ROOT / 'LICENSES', resources / 'LICENSES')
        nsh = resources / 'nsh'
        nsh.mkdir()
        shutil.copy2(ui / 'bundle.nshc', nsh / 'bundle.nshc')
        shutil.copy2(ui / 'app.json', nsh / 'app.json')
        shutil.copy2(ui / 'capabilities.json', nsh / 'capabilities.json')
        shutil.copytree(ui / 'assets', nsh / 'assets')
        shutil.copy2(theme, nsh / 'theme-built.json')
        if args.identity:
            # Keep the exact provenance used to compile the UI with the bundle for release audits.
            shutil.copy2(args.identity.resolve(strict=True), resources / 'build-identity.json')
        if args.rust_server:
            rust_bin = args.rust_server.resolve(strict=True)
            if not rust_bin.is_file():
                raise RuntimeError('The selected R3 Rust server path is not a file')
            rust_dir = resources / 'r3-server'
            rust_dir.mkdir()
            rust_dest = rust_dir / 't3code'
            shutil.copy2(rust_bin, rust_dest)
            rust_dest.chmod(0o755)
            stage_speech_modules(rust_dir / 'node_modules')
            subprocess.run(['swiftc', '-O', '-target', 'arm64-apple-macosx13.5', str(ROOT / 'tools/r3_server_supervisor.swift'), '-o', str(binary / 'r3-server-supervisor')], check=True)
        if args.python_runtime:
            runtime = args.python_runtime.resolve(strict=True)
            if not (runtime / 'bin/python3.11').is_file() or not (runtime / 'lib/python3.11/LICENSE.txt').is_file():
                raise RuntimeError('The selected Python runtime is missing its executable or license')
            shutil.copytree(runtime, resources / 'python', symlinks=True)
        theme_resources = resources / 'theme'
        theme_resources.mkdir()
        for name in ('r3_theme_supervisor.py', 'build_theme.py', 'gen_nsh_theme.py', 'gen_theme.py'):
            shutil.copy2(ROOT / 'tools' / name, theme_resources / name)
        shutil.copy2(ROOT.parent / 'T3code/apps/web/src/index.css', theme_resources / 'index.css')
        shutil.copy2(ROOT.parent / 'T3code/packages/shared/src/themePalettes.ts', theme_resources / 'themePalettes.ts')
        shutil.copy2(ROOT / 'assets/r3-icon.icns', resources / 'r3-icon.icns')
        shutil.copy2(host, binary / 'nsh-gpui-host')
        subprocess.run(['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.5', str(ROOT / 'tools/r3_macos_launcher.c'), '-o', str(binary / 'R3Code')], check=True)
        with (contents / 'Info.plist').open('wb') as file:
            plistlib.dump({
                'CFBundleDevelopmentRegion': 'en', 'CFBundleExecutable': 'R3Code',
                # Keep NSH's existing internal app id for its storage directory; macOS gets a product identifier.
                'CFBundleIdentifier': 'com.jasonkneen.r3code', 'CFBundleName': 'R3 Code',
                'CFBundleDisplayName': 'R3 Code', 'CFBundleIconFile': 'r3-icon.icns',
                'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version,
                'LSMinimumSystemVersion': '13.5',
                'NSHumanReadableCopyright': 'Original T3 Code by its authors and contributors. Rust Client by Jason Kneen.',
                'NSHighResolutionCapable': True,
                'NSMicrophoneUsageDescription': 'R3 Code uses the microphone for voice input and dictation.',
                'NSSpeechRecognitionUsageDescription': 'R3 Code transcribes your speech for voice input.',
                'NSAppleEventsUsageDescription': 'R3 Code shows folder pickers and notifications through macOS.',
                'NSScreenCaptureUsageDescription': 'R3 Code captures a window you choose for SnapShots.',
                'NSLocalNetworkUsageDescription': 'R3 Code connects to environments and preview servers on your local network.',
                'NSDesktopFolderUsageDescription': 'R3 Code opens projects and files you choose in your Desktop folder.',
                'NSDocumentsFolderUsageDescription': 'R3 Code opens projects and files you choose in your Documents folder.',
                'NSDownloadsFolderUsageDescription': 'R3 Code opens projects and files you choose in your Downloads folder.',
                'NSRemovableVolumesUsageDescription': 'R3 Code opens projects and files you choose on removable volumes.',
                'NSNetworkVolumesUsageDescription': 'R3 Code opens projects and files you choose on network volumes.',
                'NSCameraUsageDescription': 'R3 Code lets web pages in the browser panel use the camera when you allow it.',
                'NSAudioCaptureUsageDescription': 'R3 Code records system audio for screen recordings you start.',
            }, file)
        subprocess.run(['codesign', '-f', '-s', '-', str(binary / 'nsh-gpui-host')], check=True, capture_output=True)
        if args.rust_server:
            subprocess.run(['codesign', '-f', '-s', '-', str(resources / 'r3-server/t3code')], check=True, capture_output=True)
            for path in runtime_macho_files(resources / 'r3-server/node_modules'):
                subprocess.run(['codesign', '-f', '-s', '-', str(path)], check=True, capture_output=True)
            subprocess.run(['codesign', '-f', '-s', '-', str(binary / 'r3-server-supervisor')], check=True, capture_output=True)
        subprocess.run(['codesign', '-f', '-s', '-', str(app)], check=True, capture_output=True)
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
        app.rename(output)
    print(f'Built {output}')


if __name__ == '__main__':
    main()

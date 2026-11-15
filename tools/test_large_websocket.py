#!/usr/bin/env python3
"""Exercise a GPUI host with a WebSocket frame larger than the old 8 MiB limit."""
import argparse
import base64
import hashlib
import socket
import struct
import subprocess
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIZE = 30_778_647


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', type=Path, default=ROOT / 'third_party/nsh-host/nsh-gpui-host')
    args = parser.parse_args()
    host = args.host.resolve(strict=True)
    with socket.socket() as listener, tempfile.TemporaryDirectory(prefix='r3-websocket-test-') as tmp:
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(35)
        port = listener.getsockname()[1]
        errors = []

        def serve():
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(20)
                    request = b''
                    while b'\r\n\r\n' not in request and len(request) < 16384:
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise RuntimeError('WebSocket client closed during handshake')
                        request += chunk
                    headers = {}
                    for line in request.decode('ascii').split('\r\n')[1:]:
                        if ':' in line:
                            name, value = line.split(':', 1)
                            headers[name.lower()] = value.strip()
                    accept = base64.b64encode(hashlib.sha1((headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest())
                    connection.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
                    connection.sendall(b'\x81\x7f' + struct.pack('!Q', SIZE))
                    chunk = b'x' * (1024 * 1024)
                    for _ in range(SIZE // len(chunk)):
                        connection.sendall(chunk)
                    connection.sendall(chunk[:SIZE % len(chunk)])
            except Exception as exc:
                errors.append(exc)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        path = Path(tmp)
        runtime = path / 'runtime/gpui'
        runtime.mkdir(parents=True)
        (runtime / 'nsh-gpui-host').symlink_to(host)
        (path / 'nsh.json').write_text('{"id":"com.r3.websocketprobe","name":"WebSocket probe","capabilities":{"network":{"hosts":["127.0.0.1"]}}}')
        (path / 'App.tsx').write_text(f'''import {{ mount, signal, Text }} from "nsh";
import {{ connect }} from "websocket";
const status = signal("waiting");
(async () => {{ try {{ const socket = await connect("ws://127.0.0.1:{port}"); const data = await socket.read(); status.set(`received ${{data?.length}}`); await socket.close(); }} catch (error) {{ status.set(`error ${{error}}`); }} }})();
mount(() => <Text>{{status()}}</Text>);
''')
        (path / 'probe.test.tsx').write_text(f'''import {{ expect, open, test }} from "nsh/test";
test("receives a large WebSocket message", async () => {{ const app = await open("./App.tsx", {{ width: 300, height: 200, platform: "macos", network: "live" }}); await app.waitFor("text:received {SIZE}", {{ timeout: 20000 }}); await expect(app.texts()).toContain("received {SIZE}"); }});
''')
        import os
        env = {**os.environ, 'NSH_RUNTIME': str(path / 'runtime')}
        result = subprocess.run([str(Path.home() / '.local/bin/nsh'), 'test', str(path / 'probe.test.tsx'), '--target', 'gpui'], env=env, timeout=40)
        thread.join(timeout=2)
        if result.returncode:
            raise SystemExit(result.returncode)
        if errors:
            raise RuntimeError(f'WebSocket test server failed: {errors[0]}')


if __name__ == '__main__':
    main()

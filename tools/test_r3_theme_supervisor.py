import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ThemeSupervisorTest(unittest.TestCase):
    def test_live_theme_request_is_answered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            theme = root / 'theme'
            bootstrap = root / 'bootstrap'
            theme.mkdir()
            bootstrap.mkdir(mode=0o700)
            for name in ('r3_theme_supervisor.py', 'build_theme.py', 'gen_nsh_theme.py', 'gen_theme.py'):
                shutil.copy2(ROOT / 'tools' / name, theme / name)
            shutil.copy2(ROOT.parent / 'T3code/apps/web/src/index.css', theme / 'index.css')
            shutil.copy2(ROOT.parent / 'T3code/packages/shared/src/themePalettes.ts', theme / 'themePalettes.ts')
            python = os.environ.get('R3_TEST_THEME_PYTHON', sys.executable)
            process = subprocess.Popen([python, '-I', '-S', '-B', str(theme / 'r3_theme_supervisor.py'), str(os.getpid()), str(bootstrap)])
            try:
                request = {'requestId': 'test-1', 'themeLight': 'ember', 'themeDark': 'default', 'contrast': 150, 'customThemes': []}
                (bootstrap / 'theme-live-request.json').write_text(json.dumps(request))
                deadline = time.monotonic() + 10
                status_file = bootstrap / 'theme-live-status.json'
                while not status_file.exists() and time.monotonic() < deadline:
                    if process.poll() is not None: self.fail('Theme supervisor exited before answering')
                    time.sleep(0.05)
                self.assertTrue(status_file.exists(), 'Theme supervisor did not answer')
                status = json.loads(status_file.read_text())
                self.assertTrue(status['ok'], status)
                result = json.loads((bootstrap / 'theme-live.json').read_text())
                self.assertEqual(result['requestId'], 'test-1')
                self.assertEqual(result['meta']['contrast'], 150)
            finally:
                process.terminate()
                process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()

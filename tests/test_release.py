"""No real configuration, applications, providers or credentials are used."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = next((ROOT / 'plugin').iterdir())
spec = importlib.util.spec_from_file_location('setup_keys', PLUGIN / 'tools/setup-keys.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def test_permissions_preservation_and_hidden_output(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            file = home / '.ulanzi/stats.json'
            setup.save(file, {'existing': {'value': 'keep'}})
            with patch.object(Path, 'home', return_value=home), patch('sys.argv', ['setup', 'stripe']), patch('sys.stdin.isatty', return_value=True), patch('getpass.getpass', return_value='synthetic-secret'), contextlib.redirect_stdout(io.StringIO()) as output:
                setup.main()
            self.assertNotIn('synthetic-secret', output.getvalue())
            self.assertEqual(json.loads(file.read_text())['existing'], {'value': 'keep'})
            self.assertEqual(json.loads(file.read_text())['stripe']['secretKey'], 'synthetic-secret')
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(file.parent.stat().st_mode), 0o700)
            self.assertEqual(list(file.parent.glob('.stats-*')), [])
            with patch.object(Path, 'home', return_value=home), patch('sys.argv', ['setup', 'show']), contextlib.redirect_stdout(io.StringIO()) as output:
                setup.main()
            self.assertNotIn('synthetic-secret', output.getvalue())

    def test_invalid_json_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); (home / '.ulanzi').mkdir()
            file = home / '.ulanzi/stats.json'; file.write_text('{invalid')
            with patch.object(Path, 'home', return_value=home), patch('sys.argv', ['setup', 'stripe']), self.assertRaises(ValueError):
                setup.main()
            self.assertEqual(file.read_text(), '{invalid')

    def test_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory); (home / '.ulanzi').mkdir()
            target = home / 'untouched'; target.write_text('keep')
            file = home / '.ulanzi/stats.json'; file.symlink_to(target)
            with self.assertRaises(ValueError): setup.save(file, {})
            self.assertEqual(target.read_text(), 'keep')

    def test_secret_arguments_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['bash', str(PLUGIN / 'tools/setup-keys.sh'), 'stripe', 'synthetic-secret'], env={**os.environ, 'HOME': directory}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((Path(directory) / '.ulanzi').exists())
            self.assertNotIn('synthetic-secret', result.stdout + result.stderr)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.deck = self.home / 'Library/Application Support/Ulanzi/UlanziDeck'
        self.deck.mkdir(parents=True)
        self.bin = self.home / 'bin'; self.bin.mkdir()
        self.mock('uname', 'echo Darwin')
        self.mock('pgrep', 'exit 1')
        self.env = {**os.environ, 'HOME': str(self.home), 'PATH': str(self.bin) + os.pathsep + os.environ['PATH']}

    def mock(self, name, body):
        file = self.bin / name; file.write_text('#!/bin/bash\n' + body + '\n'); file.chmod(0o755)

    def run_install(self, *args):
        return subprocess.run(['bash', str(ROOT / 'install.sh'), *args], env=self.env, capture_output=True, text=True)

    def test_check_has_no_install_side_effects(self):
        result = self.run_install('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.deck.iterdir()), [])
        self.assertFalse((self.home / '.ulanzi').exists())

    def test_refuses_running_studio(self):
        self.mock('pgrep', 'exit 0')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Quit Ulanzi', result.stderr)
        self.assertEqual(list(self.deck.iterdir()), [])

    def test_install_backs_up_existing_plugin_and_rewrites_profile(self):
        dest = self.deck / 'Plugins' / PLUGIN.name
        dest.mkdir(parents=True); (dest / 'marker').write_text('old')
        result = self.run_install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((dest / 'dist/app.js').is_file())
        backups = list((self.home / '.ulanzi/backups').glob('*/' + PLUGIN.name + '/marker'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), 'old')
        profiles = list((self.deck / 'ProfilesV2').glob('*.ulanziProfile'))
        self.assertEqual(len(profiles), 1)
        page = next((profiles[0] / 'Profiles').rglob('manifest.json')).read_text()
        self.assertNotIn('/Users/USERNAME', page)
        self.assertIn(str(self.home), page)

    def test_copy_failure_is_not_reported_as_success(self):
        self.mock('cp', 'exit 1')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Installed plugin:', result.stdout)
        self.assertEqual(list(self.deck.glob('.ai-usage-stage.*')), [])

    def test_failed_profile_move_restores_existing_plugin(self):
        dest = self.deck / 'Plugins' / PLUGIN.name
        dest.mkdir(parents=True); (dest / 'marker').write_text('old')
        self.mock('mv', 'case "$1" in */.ai-usage-stage.*/profile) exit 1;; esac\nexec /bin/mv "$@"')
        result = self.run_install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((dest / 'marker').read_text(), 'old')
        self.assertFalse((dest / 'dist').exists())
        self.assertEqual(list((self.deck / 'ProfilesV2').iterdir()), [])
        self.assertNotIn('Installed plugin:', result.stdout)

if __name__ == '__main__': unittest.main()

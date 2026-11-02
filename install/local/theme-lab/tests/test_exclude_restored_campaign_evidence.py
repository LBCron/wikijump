"""Derived info/exclude entries for restored campaign evidence (#2506)."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

LAB = Path(__file__).resolve().parents[1]
SCRIPT = LAB / 'scripts' / 'exclude-restored-campaign-evidence.sh'
PREFIX = 'install/local/theme-lab/'


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args],
                          check=True, capture_output=True, text=True).stdout


class ExcludeRestoredCampaignEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='theme-lab-campaign-exclude-test-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / 'repo'
        self.repo.mkdir(parents=True)
        git(self.repo, 'init', '-q')
        git(self.repo, 'config', 'user.email', 'test@example.invalid')
        git(self.repo, 'config', 'user.name', 'Test')
        (self.repo / 'seed.txt').write_text('seed\n')
        git(self.repo, 'add', 'seed.txt')
        git(self.repo, 'commit', '-qm', 'seed')
        self.exclude = Path(git(self.repo, 'rev-parse', '--path-format=absolute',
                                '--git-path', 'info/exclude').strip())

    def manifest(self, *relative_paths):
        path = Path(self.temp.name) / 'manifest.json'
        path.write_text(json.dumps({'files': [
            {'relative_path': rel, 'sha256': '0' * 64, 'size_bytes': 1}
            for rel in relative_paths]}))
        return path

    def run_script(self, manifest):
        return subprocess.run(['bash', str(SCRIPT), str(self.repo), str(manifest)],
                              check=True, capture_output=True, text=True).stdout

    def untracked(self):
        return git(self.repo, 'status', '--porcelain=v1', '-uall')

    def restore_file(self, relative_path, body='evidence'):
        target = self.repo / PREFIX / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)
        return target

    def test_manifest_paths_are_excluded_and_authored_files_stay_visible(self):
        manifest = self.manifest('ports/current-acceptance/run/contract.json',
                                 'evidence/search-controls-20261022/receipt.json')
        self.restore_file('ports/current-acceptance/run/contract.json')
        self.restore_file('evidence/search-controls-20261022/receipt.json')
        self.restore_file('ports/current-acceptance/run/not-in-manifest.json')
        output = self.run_script(manifest)
        self.assertIn('2 path(s) added', output)
        status = self.untracked()
        self.assertNotIn('contract.json', status)
        self.assertNotIn('receipt.json', status)
        self.assertIn('not-in-manifest.json', status)

    def test_rerun_adds_nothing_and_existing_lines_survive(self):
        self.exclude.write_text('# local note\n/seed-local\n')
        manifest = self.manifest('current-campaign-acceptance.json')
        self.assertIn('1 path(s) added', self.run_script(manifest))
        self.assertIn('0 path(s) added', self.run_script(manifest))
        lines = self.exclude.read_text().splitlines()
        self.assertEqual(lines[:2], ['# local note', '/seed-local'])
        self.assertEqual(lines.count('/' + PREFIX + 'current-campaign-acceptance.json'), 1)

    def test_glob_characters_in_paths_are_escaped(self):
        manifest = self.manifest('evidence/search-controls-20261022/a[1].json')
        self.restore_file('evidence/search-controls-20261022/a[1].json')
        self.restore_file('evidence/search-controls-20261022/a1.json')
        self.run_script(manifest)
        status = self.untracked()
        self.assertNotIn('a[1].json', status)
        self.assertIn('a1.json', status)


if __name__ == '__main__':
    unittest.main()

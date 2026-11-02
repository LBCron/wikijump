"""Clean-room, integrity and interruption tests for the blob-store transport."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'content-addressed-authority-store.py'
spec = importlib.util.spec_from_file_location('authority_blobs', SCRIPT)
blobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(blobs)
PREFIX = 'install/local/theme-lab/ports/'


class AuthorityBlobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='theme-lab-blobstore-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.dest = self.root / 'destination'
        self.store = self.root / 'object-store'
        for path in (self.source, self.dest, self.store):
            path.mkdir()
        self.body = b'{"immutable":"Wikidot evidence"}\n'
        self.digest = hashlib.sha256(self.body).hexdigest()
        self.a = PREFIX + 'authority-evidence/page/first.json'
        self.b = PREFIX + 'shared-fixtures/another.json'
        for rel in (self.a, self.b):
            target = self.source / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(self.body)
        ledger = self.dest / PREFIX / 'adaptation-authority.json'
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.write_text(json.dumps({'packages': {'theme': {'evidence': [
            {'path': 'authority-evidence/page/first.json', 'sha256': self.digest},
            {'path': 'shared-fixtures/another.json', 'sha256': self.digest},
        ]}}}))
        self.inventory = self.root / 'manifest.json'
        self.entries = [{'relative_path': rel, 'sha256': self.digest,
                         'size_bytes': len(self.body), 'ledger_root': True,
                         'ledger_hash_verified': True} for rel in (self.a, self.b)]
        self.repin()

    def repin(self):
        self.inventory.write_text(json.dumps({'schema': blobs.authority.SCHEMA,
                                              'files': self.entries}))
        self.inventory_sha = blobs.authority.checksum(self.inventory)

    def run_store(self, mode, apply=False, **options):
        return blobs.transfer(options.get('store', self.store), self.dest, self.inventory,
                              options.get('sha', self.inventory_sha), mode=mode,
                              source_root=options.get('source', self.source if mode == 'ingest' else None),
                              apply=apply, link=options.get('link', False))

    def test_deduplicated_ingest_then_cleanroom_restore_without_source(self):
        plan = self.run_store('ingest')
        self.assertEqual((plan['inventory_files'], plan['unique_blobs'], plan['missing_blobs']), (2, 1, 1))
        self.assertFalse((self.store / 'objects').exists())
        self.run_store('ingest', apply=True)
        self.assertEqual(self.run_store('ingest')['missing_blobs'], 0)
        self.assertEqual(self.run_store('restore')['checkout_files_missing'], 2)
        migrated_store = self.root / 'independently-copied-store'
        shutil.copytree(self.store, migrated_store)
        shutil.rmtree(self.source)
        shutil.rmtree(self.store)
        self.store = migrated_store
        # Prove the complete import machine/source tree and old blob directory
        # are unnecessary; even attempted network acquisition fails this test.
        with patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')):
            restored = self.run_store('restore', apply=True)
        self.assertEqual(restored['status'], 'applied')
        self.assertEqual([ (self.dest / rel).read_bytes() for rel in (self.a, self.b)], [self.body] * 2)
        self.assertEqual(self.run_store('restore', apply=True)['checkout_files_missing'], 0)
        for rel in (self.a, self.b):
            self.assertFalse((self.dest / rel).stat().st_mode & 0o222)

    def test_linked_restore_shares_the_read_only_blob_without_copying(self):
        self.run_store('ingest', apply=True)
        result = self.run_store('restore', apply=True, source=None, link=True)
        self.assertEqual(result['status'], 'applied')
        blob = blobs.blob_path(self.store, self.digest)
        for rel in (self.a, self.b):
            restored = self.dest / rel
            self.assertEqual(restored.read_bytes(), self.body)
            self.assertEqual(restored.stat().st_ino, blob.stat().st_ino)
            self.assertFalse(restored.stat().st_mode & 0o222)
        # A second linked restore finds everything present and verified.
        again = self.run_store('restore', apply=True, source=None, link=True)
        self.assertEqual(again['checkout_files_missing'], 0)

    def test_linked_restore_does_not_hash_the_files_it_links_a_second_time(self):
        self.run_store('ingest', apply=True)
        with patch.object(blobs, 'verify_file', side_effect=AssertionError('relinked file was hashed again')):
            self.run_store('restore', apply=True, source=None, link=True)
        for rel in (self.a, self.b):
            self.assertEqual((self.dest / rel).read_bytes(), self.body)

    def test_a_blob_swapped_between_verification_and_linking_is_refused(self):
        self.run_store('ingest', apply=True)
        blob = blobs.blob_path(self.store, self.digest)
        real_link = blobs.os.link

        def swap_then_link(source, destination, **options):
            replacement = blob.with_name('replacement')
            replacement.write_bytes(b'{"swapped":"after verification"}\n')
            replacement.chmod(0o444)
            replacement.replace(blob)
            return real_link(source, destination, **options)

        with patch.object(blobs.os, 'link', side_effect=swap_then_link):
            with self.assertRaisesRegex(ValueError, 'linked evidence size/SHA-256 mismatch'):
                self.run_store('restore', apply=True, source=None, link=True)
        self.assertFalse((self.dest / self.a).exists())

    def test_a_trusted_inode_with_a_different_digest_is_still_hashed(self):
        self.run_store('ingest', apply=True)
        blob = blobs.blob_path(self.store, self.digest)
        info = blob.stat()
        destination = self.dest / 'linked.json'
        # The identity table names this inode under another digest: not a match, so the bytes are hashed.
        with self.assertRaisesRegex(ValueError, 'linked evidence size/SHA-256 mismatch'):
            blobs.link_file(blob, destination, '0' * 64, info.st_size, {(info.st_dev, info.st_ino): self.digest})
        self.assertFalse(destination.exists())
        blobs.link_file(blob, destination, self.digest, info.st_size, {(info.st_dev, info.st_ino): self.digest})
        self.assertEqual(destination.read_bytes(), self.body)

    def test_linked_restore_refuses_a_writable_blob(self):
        self.run_store('ingest', apply=True)
        blobs.blob_path(self.store, self.digest).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'writable'):
            self.run_store('restore', apply=True, source=None, link=True)
        self.assertFalse((self.dest / self.a).exists())

    def test_link_is_rejected_for_ingest(self):
        with self.assertRaisesRegex(ValueError, 'only to restore'):
            self.run_store('ingest', apply=True, link=True)

    def test_tamper_missing_blob_and_existing_destination_fail_closed(self):
        self.run_store('ingest', apply=True)
        blob = self.store / 'objects' / self.digest[:2] / self.digest
        blob.chmod(0o644)
        blob.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'stored blob size/SHA-256 mismatch'):
            self.run_store('restore', apply=True)
        self.assertFalse((self.dest / self.a).exists())
        blob.unlink()
        with self.assertRaisesRegex(ValueError, 'missing SHA-pinned blob'):
            self.run_store('restore', apply=True)
        self.run_store('ingest', apply=True)
        target = self.dest / self.a
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('forged')
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.run_store('restore', apply=True)
        self.assertEqual(target.read_text(), 'forged')
        self.assertFalse((self.dest / self.b).exists())

    def test_pinned_inventory_ledger_and_symlink_paths_fail_closed(self):
        original = self.inventory_sha
        self.entries[0]['size_bytes'] += 1
        self.repin()
        with self.assertRaisesRegex(ValueError, 'inventory SHA-256 mismatch'):
            self.run_store('ingest', apply=True, sha=original)
        self.entries[0]['size_bytes'] -= 1
        self.repin()
        self.entries[0]['ledger_root'] = False
        self.repin()
        with self.assertRaisesRegex(ValueError, 'inventory/ledger'):
            self.run_store('ingest', apply=True)
        self.entries[0]['ledger_root'] = True
        self.repin()
        (self.dest / PREFIX / 'authority-evidence').symlink_to(self.source / PREFIX / 'authority-evidence')
        with self.assertRaisesRegex(ValueError, 'symlink in evidence path'):
            self.run_store('ingest', apply=True)

    def test_restore_is_independent_and_nonexistent_objects_cannot_pass(self):
        with self.assertRaisesRegex(ValueError, 'original source'):
            self.run_store('restore', source=self.source)
        with self.assertRaisesRegex(ValueError, 'independent'):
            self.run_store('ingest', store=self.source)
        with self.assertRaisesRegex(ValueError, 'missing SHA-pinned blob'):
            self.run_store('restore', apply=True)
        self.assertFalse((self.dest / self.a).exists())

    def test_duplicate_and_traversal_manifest_entries_are_rejected(self):
        self.entries.append(dict(self.entries[0]))
        self.repin()
        with self.assertRaisesRegex(ValueError, 'invalid or duplicate inventory entry'):
            self.run_store('ingest', apply=True)
        self.entries.pop()
        self.entries[0]['relative_path'] = PREFIX + 'authority-evidence/../../escape.json'
        self.repin()
        with self.assertRaisesRegex(ValueError, 'unsafe relative path'):
            self.run_store('ingest', apply=True)


if __name__ == '__main__':
    unittest.main()

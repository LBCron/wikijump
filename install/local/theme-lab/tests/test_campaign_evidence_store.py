"""Campaign evidence inventory: build, pinned restore, and fail-closed refusals (#2506)."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'campaign-evidence-store.py'
spec = importlib.util.spec_from_file_location('campaign_evidence_store', SCRIPT)
campaign = importlib.util.module_from_spec(spec)
spec.loader.exec_module(campaign)
authority = campaign.authority
LAB = 'install/local/theme-lab'
PASS = lambda theme_lab, sigma9, sigma10: {'status': 'pass', 'failures': []}


class CampaignEvidenceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='theme-lab-campaign-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.checkout = self.root / 'checkout'
        self.theme_lab = self.checkout / LAB
        self.store = self.root / 'store'
        self.restored = self.root / 'restored'
        self.output = self.root / 'manifest.json'
        self.files = {
            'current-campaign-acceptance.json': b'{"schema":"theme_lab_current_campaign_acceptance.v1"}\n',
            'ports/current-acceptance/run-contract.json': b'{"schema":"scp_jp_interactive_acceptance_run.v1"}\n',
            'sigma10-migration/current-campaign/run-contract.json': b'{"schema":"scp_jp_sigma10_migration_run.v1"}\n',
            'ports/current-acceptance/audit/a.json': b'{"row":"first"}\n',
            'ports/current-acceptance/source-oracles/objects/o.json': b'{"row":"oracle"}\n',
            'ports/black-highlighter-theme/option-scenarios/runs/r.json': b'{"row":"run"}\n',
            'ports/black-highlighter-theme/option-scenarios/captures/c.json': b'{"row":"capture"}\n',
            'evidence/search-controls-20261022/receipt.json': b'{"row":"second"}\n',
            'evidence/nav-source-submenu-20261022/basalt.json': b'{"row":"submenu"}\n',
            'evidence/source-navigation-overlays-20261022/overlay.json': b'{"row":"overlays"}\n',
        }
        for rel, body in self.files.items():
            target = self.theme_lab / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        self.store.mkdir()
        (self.restored / LAB).mkdir(parents=True)

    def build(self, checker=PASS):
        self.output.unlink(missing_ok=True)
        result = campaign.build_inventory(self.checkout, self.store, self.output, checker=checker)
        self.inventory_sha = authority.checksum(self.output)
        return result

    def rewrite(self, mutate):
        doc = json.loads(self.output.read_text())
        mutate(doc)
        self.output.write_text(json.dumps(doc, indent=2) + '\n')
        self.inventory_sha = authority.checksum(self.output)

    def restore(self, *, apply=False, link=False, sha=None, destination=None):
        return campaign.restore(destination or self.restored, self.store, self.output,
                                sha or self.inventory_sha, apply=apply, link=link)

    def blob(self, rel):
        digest = authority.checksum(self.theme_lab / rel)
        return campaign.store.blob_path(self.store, digest)

    def test_build_restore_roundtrip_verifies_receipt_and_run_contracts(self):
        built = self.build()
        self.assertEqual((built['status'], built['inventory_files'], built['checker_status']), ('built', 10, 'pass'))
        doc = json.loads(self.output.read_text())
        self.assertEqual(doc['schema'], campaign.SCHEMA)
        self.assertEqual(doc['checker']['status'], 'pass')
        self.assertEqual(doc['receipt']['path'], 'current-campaign-acceptance.json')
        self.assertEqual(doc['run_contracts']['sigma9']['path'], 'ports/current-acceptance/run-contract.json')
        self.assertEqual(doc['run_contracts']['sigma10']['path'], 'sigma10-migration/current-campaign/run-contract.json')

        planned = self.restore()
        self.assertEqual((planned['status'], planned['checkout_files_missing'], planned['bindings_verified']), ('verified-plan', 10, 0))
        applied = self.restore(apply=True, link=True)
        self.assertEqual((applied['status'], applied['bindings_verified']), ('applied', 3))
        for rel, body in self.files.items():
            restored = self.restored / LAB / rel
            self.assertEqual(restored.read_bytes(), body)
            self.assertFalse(restored.stat().st_mode & 0o222)
            self.assertEqual(restored.stat().st_ino, self.blob(rel).stat().st_ino)
        again = self.restore(apply=True, link=True)
        self.assertEqual((again['checkout_files_missing'], again['bindings_verified']), (0, 3))

    def test_builder_refuses_when_checker_is_not_pass_and_writes_nothing(self):
        for status in ('fail', 'inconclusive', 'error'):
            with self.subTest(status=status):
                with self.assertRaisesRegex(ValueError, 'not pass'):
                    self.build(checker=lambda *_: {'status': status, 'failures': ['x']})
                self.assertFalse(self.output.exists())
        self.assertFalse((self.store / 'objects').exists())

    def test_builder_refuses_symlink_in_campaign_source(self):
        target = self.theme_lab / 'ports/current-acceptance/audit/a.json'
        (self.theme_lab / 'ports/current-acceptance/audit/link.json').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlink in campaign source'):
            self.build()
        self.assertFalse(self.output.exists())
        # A symlinked tree root is refused as well.
        shutil.rmtree(self.theme_lab / 'sigma10-migration/sources', ignore_errors=True)
        (self.theme_lab / 'sigma10-migration/sources').symlink_to(self.theme_lab / 'ports')
        with self.assertRaisesRegex(ValueError, 'symlink in campaign source'):
            self.build()

    def test_builder_refuses_case_colliding_and_duplicate_candidates(self):
        (self.theme_lab / 'ports/current-acceptance/Audit.json').write_bytes(b'x')
        (self.theme_lab / 'ports/current-acceptance/audit.json').write_bytes(b'y')
        with self.assertRaisesRegex(ValueError, 'case-colliding'):
            self.build()

    def test_inventory_sha_mismatch_fails_closed(self):
        self.build()
        with self.assertRaisesRegex(ValueError, 'inventory SHA-256 mismatch'):
            self.restore(sha='0' * 64)
        with self.assertRaisesRegex(ValueError, 'inventory SHA-256 mismatch'):
            self.restore(sha='not-a-sha')
        # Tampering with the inventory after pinning must not be accepted.
        self.output.write_text(self.output.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'inventory SHA-256 mismatch'):
            self.restore(apply=True)
        self.assertFalse((self.restored / LAB / 'ports/current-acceptance/audit/a.json').exists())

    def test_missing_blob_fails_before_any_link(self):
        self.build()
        self.blob('current-campaign-acceptance.json').unlink()
        with self.assertRaisesRegex(ValueError, 'missing SHA-pinned blob'):
            self.restore(apply=True, link=True)
        self.assertFalse((self.restored / LAB / 'current-campaign-acceptance.json').exists())

    def test_size_mismatch_fails_closed(self):
        self.build()
        self.rewrite(lambda doc: doc['files'][0].__setitem__('size_bytes', doc['files'][0]['size_bytes'] + 1))
        with self.assertRaisesRegex(ValueError, 'size/SHA-256 mismatch'):
            self.restore(apply=True)
        self.assertEqual(list((self.restored / LAB).rglob('*.json')), [])

    def test_differing_existing_destination_is_never_overwritten(self):
        self.build()
        self.restore(apply=True, link=True)
        receipt = self.restored / LAB / 'current-campaign-acceptance.json'
        # Replace the hardlink rather than writing through it: writing through
        # would corrupt the shared store blob, which the transfer also refuses.
        receipt.unlink()
        receipt.write_bytes(b'{"forged":true}\n')
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.restore(apply=True, link=True)
        self.assertEqual(receipt.read_bytes(), b'{"forged":true}\n')

    def test_living_ledger_is_accepted_as_checkout_version_and_never_overwritten(self):
        ledger_rel = 'ports/current-acceptance/faithful-design-exemptions.json'
        self.assertIn(ledger_rel, campaign.LIVING_FILES)
        frozen = b'{"entries":"frozen"}\n'
        target = self.theme_lab / ledger_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(frozen)
        self.build()

        applied = self.restore(apply=True, link=True)
        self.assertEqual(applied['living_files'],
                         [{'path': ledger_rel, 'treatment': 'frozen-copy-restored'}])
        restored_ledger = self.restored / LAB / ledger_rel
        self.assertEqual(restored_ledger.read_bytes(), frozen)

        # A later instrument rebind rewrites the ledger in the checkout; the
        # next restore must accept those bytes and leave them untouched,
        # while every frozen file is still byte-verified (see the receipt
        # forgery test above).
        rebound = b'{"entries":"rebound to a newer instrument"}\n'
        restored_ledger.unlink()
        restored_ledger.write_bytes(rebound)
        again = self.restore(apply=True, link=True)
        self.assertEqual(again['living_files'],
                         [{'path': ledger_rel, 'treatment': 'checkout-version-accepted'}])
        self.assertEqual(restored_ledger.read_bytes(), rebound)

    def test_symlink_ancestor_in_destination_is_refused(self):
        self.build()
        elsewhere = self.root / 'elsewhere'
        elsewhere.mkdir()
        (self.restored / LAB / 'ports').symlink_to(elsewhere)
        with self.assertRaisesRegex(ValueError, 'symlink in evidence path'):
            self.restore(apply=True, link=True)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_disallowed_prefix_and_traversal_entries_are_rejected(self):
        self.build()
        def add(rel):
            def mutate(doc):
                doc['files'].append({'relative_path': rel, 'sha256': '1' * 64, 'size_bytes': 1})
            return mutate
        for rel in ('ports/black-highlighter-theme/candidate.css', 'publication/frozen-candidate-set.json',
                    'ports/current-acceptance/../../escape.json', 'current-campaign-acceptance.json.bak'):
            with self.subTest(rel=rel):
                self.rewrite(add(rel))
                with self.assertRaisesRegex(ValueError, 'disallowed or duplicate campaign inventory entry'):
                    self.restore()
                self.build()

    def test_w17_additions_are_inventoried_but_nothing_outside_their_scope(self):
        built = self.build()
        self.assertEqual(built['status'], 'built')
        doc = json.loads(self.output.read_text())
        inventoried = {row['relative_path'] for row in doc['files']}
        for rel in ('evidence/nav-source-submenu-20261022/basalt.json',
                    'evidence/source-navigation-overlays-20261022/overlay.json',
                    'ports/current-acceptance/source-oracles/objects/o.json',
                    'ports/black-highlighter-theme/option-scenarios/runs/r.json',
                    'ports/black-highlighter-theme/option-scenarios/captures/c.json'):
            self.assertIn(rel, inventoried)
        # Out-of-scope campaign trees are silently excluded from the build,
        # never inventoried: option-scenarios outside runs/captures,
        # authority-evidence (covered by the authority restore), and
        # non-allowlisted evidence children.
        extra = {
            'ports/black-highlighter-theme/option-scenarios/sources/x.json': b'{}\n',
            'ports/black-highlighter-theme/option-scenarios/authority.json': b'{}\n',
            'ports/authority-evidence/y.json': b'{}\n',
            'evidence/other-thing-20261022/z.json': b'{}\n',
        }
        for rel, body in extra.items():
            target = self.theme_lab / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
        rebuilt = self.build()
        self.assertEqual(rebuilt['inventory_files'], built['inventory_files'])
        doc = json.loads(self.output.read_text())
        inventoried = {row['relative_path'] for row in doc['files']}
        for rel in extra:
            self.assertNotIn(rel, inventoried)

    def test_out_of_scope_entries_are_refused_on_the_restore_side(self):
        self.build()
        for rel in ('ports/authority-evidence/y.json',
                    'ports/black-highlighter-theme/option-scenarios/sources/x.json',
                    'ports/black-highlighter-theme/candidate.css'):
            with self.subTest(rel=rel):
                self.rewrite(lambda doc, rel=rel: doc['files'].append(
                    {'relative_path': rel, 'sha256': '1' * 64, 'size_bytes': 1}))
                with self.assertRaisesRegex(ValueError, 'disallowed or duplicate campaign inventory entry'):
                    self.restore()
                self.build()

    def test_receipt_and_run_contract_bindings_must_name_inventoried_bytes(self):
        self.build()
        self.rewrite(lambda doc: doc['receipt'].__setitem__('sha256', '2' * 64))
        with self.assertRaisesRegex(ValueError, 'receipt binding'):
            self.restore()
        self.build()
        self.rewrite(lambda doc: doc['run_contracts']['sigma10'].__setitem__('path', 'sigma10-migration/current-campaign/other.json'))
        with self.assertRaisesRegex(ValueError, 'sigma10 run contract binding'):
            self.restore()

    def test_inventory_from_a_non_passing_check_is_refused(self):
        self.build()
        self.rewrite(lambda doc: doc['checker'].__setitem__('status', 'fail'))
        with self.assertRaisesRegex(ValueError, 'passing completion check'):
            self.restore()

    def test_restore_is_independent_of_the_source_checkout(self):
        self.build()
        shutil.rmtree(self.checkout)
        restored = self.restore(apply=True, link=True)
        self.assertEqual(restored['status'], 'applied')
        self.assertEqual((self.restored / LAB / 'current-campaign-acceptance.json').read_bytes(), self.files['current-campaign-acceptance.json'])

    # --- LA-34 successor-bound exception --------------------------------
    RECEIPT_REL = 'ports/black-highlighter-theme/option-scenarios/runs/receipt-a.json'
    REVIEW_REL = 'ports/black-highlighter-theme/option-scenarios/runs/visual-review.json'
    PNG_REL = 'ports/black-highlighter-theme/option-scenarios/captures/sigma10/chromium/shot-a.png'
    PNG2_REL = 'ports/black-highlighter-theme/option-scenarios/captures/sigma10/chromium/shot-b.png'
    CLOSURE_PNG = b'closure-png-bytes'

    def _sha(self, body):
        import hashlib
        return hashlib.sha256(body).hexdigest()

    def _write(self, lab, rel, body):
        target = lab / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(body, str):
            body = body.encode()
        target.write_bytes(body)
        return target

    def _receipt_body(self, png_sha, marker, png_rel=None):
        recorded = f'/home/roku/checkout/install/local/theme-lab/{png_rel or self.PNG_REL}'
        return json.dumps({'schema': 'test-receipt', 'marker': marker,
                           'rows': [{'screenshot': recorded, 'screenshot_sha256': png_sha}]}) + '\n'

    def _successor_fixture(self, *, freeze_receipt_sha=None, freeze_review_sha=None,
                           receipt_unbound=False, png_row=True):
        """Inventory closure BHL bytes, then lay successor bytes plus a
        candidate freeze into the restore destination."""
        successor_png = b'successor-png-bytes!'
        closure_receipt = self._receipt_body(self._sha(self.CLOSURE_PNG), 'closure')
        if png_row:
            successor_receipt = self._receipt_body(self._sha(successor_png), 'successor')
        else:
            successor_receipt = self._receipt_body(self._sha(successor_png), 'successor',
                                                   png_rel=self.PNG2_REL)
        closure_review = b'{"review":"closure"}\n'
        successor_review = b'{"review":"successor"}\n'
        self._write(self.theme_lab, self.RECEIPT_REL, closure_receipt)
        self._write(self.theme_lab, self.REVIEW_REL, closure_review)
        self._write(self.theme_lab, self.PNG_REL, self.CLOSURE_PNG)
        self.build()
        lab = self.restored / LAB
        self._write(lab, self.RECEIPT_REL, successor_receipt)
        self._write(lab, self.REVIEW_REL, successor_review)
        self._write(lab, self.PNG_REL, successor_png)
        bindings = {'scenario_id': 'bhl-options-test',
                    'visual_review': {'path': self.REVIEW_REL,
                                      'sha256': freeze_review_sha or self._sha(successor_review)},
                    'receipts': [] if receipt_unbound else
                                [{'path': self.RECEIPT_REL,
                                  'sha256': freeze_receipt_sha or self._sha(successor_receipt.encode())}]}
        freeze = {'schema': 'test-freeze', 'targeted_evidence_bindings': [bindings]}
        self._write(lab, 'publication/frozen-candidate-set.json', json.dumps(freeze) + '\n')
        return {'png': successor_png, 'receipt': successor_receipt, 'review': successor_review}

    def test_successor_bound_receipt_png_and_review_are_accepted(self):
        bodies = self._successor_fixture()
        result = self.restore(apply=True, link=True)
        self.assertEqual(result['successor_bound_count'], 3)
        self.assertEqual(result['inventory_files'], 10)
        self.assertEqual(result['bindings_verified'], 3)
        bound = {row['path']: row for row in result['successor_bound']}
        self.assertEqual(set(bound), {self.RECEIPT_REL, self.REVIEW_REL, self.PNG_REL})
        self.assertEqual(bound[self.RECEIPT_REL]['bound_by'], 'targeted_evidence_bindings.receipts')
        self.assertEqual(bound[self.REVIEW_REL]['bound_by'], 'targeted_evidence_bindings.visual_review')
        self.assertTrue(bound[self.PNG_REL]['bound_by'].endswith(self.RECEIPT_REL))
        self.assertEqual(bound[self.PNG_REL]['checkout_sha256'], self._sha(bodies['png']))
        self.assertEqual(bound[self.PNG_REL]['inventory_sha256'], self._sha(self.CLOSURE_PNG))
        lab = self.restored / LAB
        self.assertEqual((lab / self.PNG_REL).read_bytes(), bodies['png'])
        self.assertEqual((lab / self.RECEIPT_REL).read_bytes(), bodies['receipt'].encode())
        # The frozen closure blob is still archived and verified.
        campaign.store.verify_file(self.blob(self.PNG_REL), self._sha(self.CLOSURE_PNG),
                                   len(self.CLOSURE_PNG), 'stored blob')

    def test_successor_unbound_receipt_fails_closed(self):
        self._successor_fixture(receipt_unbound=True)
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.restore(apply=True)

    def test_successor_png_with_stale_receipt_binding_fails_closed(self):
        self._successor_fixture(freeze_receipt_sha='0' * 64)
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.restore(apply=True)

    def test_successor_png_without_matching_row_fails_closed(self):
        self._successor_fixture(png_row=False)
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.restore(apply=True)

    def test_successor_review_sha_mismatch_fails_closed(self):
        self._successor_fixture(freeze_review_sha='0' * 64)
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.restore(apply=True)

    def test_successor_binding_outside_the_prefixes_still_fails_closed(self):
        self.build()
        lab = self.restored / LAB
        rel = 'ports/current-acceptance/audit/a.json'
        successor = b'{"row":"successor"}\n'
        self._write(lab, rel, successor)
        bindings = {'scenario_id': 'outside',
                    'visual_review': {'path': self.REVIEW_REL, 'sha256': '1' * 64},
                    'receipts': [{'path': rel, 'sha256': self._sha(successor)}]}
        self._write(lab, 'publication/frozen-candidate-set.json',
                    json.dumps({'targeted_evidence_bindings': [bindings]}) + '\n')
        with self.assertRaisesRegex(ValueError, 'existing checkout evidence size/SHA-256 mismatch'):
            self.restore(apply=True)

    def test_successor_missing_frozen_blob_fails_closed(self):
        self._successor_fixture()
        campaign.store.blob_path(self.store, self._sha(self.CLOSURE_PNG)).unlink()
        with self.assertRaisesRegex(ValueError, 'missing SHA-pinned blob'):
            self.restore(apply=True)

    def test_successor_symlinked_freeze_fails_closed(self):
        self._successor_fixture()
        lab = self.restored / LAB
        freeze = lab / 'publication/frozen-candidate-set.json'
        elsewhere = self.root / 'freeze-copy.json'
        elsewhere.write_bytes(freeze.read_bytes())
        freeze.unlink()
        freeze.symlink_to(elsewhere)
        with self.assertRaisesRegex(ValueError, 'symlink in evidence path'):
            self.restore(apply=True)

    def test_successor_absent_checkout_file_restores_the_frozen_copy(self):
        self._successor_fixture()
        lab = self.restored / LAB
        (lab / self.PNG_REL).unlink()
        result = self.restore(apply=True, link=True)
        self.assertEqual(result['successor_bound_count'], 2)
        self.assertEqual((lab / self.PNG_REL).read_bytes(), self.CLOSURE_PNG)


if __name__ == '__main__':
    unittest.main()

"""Activation catch-up convergence, restore guard, and post-rollback
convergence (BRIEF-TLA-FIX Step 1/2, ruling in tla-pilot ASSESSMENT.md).

T1/T2/T4 run through the FakeStanding harness in test_promote.py. The
real-SQL tests exercise the actual saved_page_staleness /
saved_page_stale_ids / restore_saved_page_output SQL against a disposable
Postgres container owned by this test (distinct name, no named volumes,
removed in teardown); only the Valkey INCR is stubbed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
sys.path.insert(0, str(Path(__file__).parent))
import promote  # noqa: E402
import render_ahead  # noqa: E402
from test_promote import FakeStanding, GENERATION_CHANGE  # noqa: E402


TARGET = GENERATION_CHANGE["expected_compiled_generator"]
OLD_GENERATOR = "ftml v1; deepwell-render/v25"
NEW_IMAGE = "sha256:" + "b0" * 32
OLD_IMAGE = "sha256:" + "a0" * 32


def names(calls):
    return [call[0] for call in calls]


class CatchUpActivationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "home").mkdir()
        self.standing = FakeStanding(self.root / "home")

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_quiet_activation_never_renders_or_restarts(self) -> None:
        self.standing.stale_sequence = [0]
        self.standing.run(self.root / "evidence", GENERATION_CHANGE)
        self.assertNotIn("render-delta", names(self.standing.calls))
        self.assertNotIn("restart-deepwell", names(self.standing.calls))

    def test_t2_non_convergence_rolls_back_after_bounded_rounds(self) -> None:
        self.standing.stale_sequence = [16]
        self.standing.stale_page_ids = list(range(1, 17))
        with self.assertRaisesRegex(RuntimeError, "standing serves 16 stale saved pages"):
            self.standing.run(self.root / "evidence", GENERATION_CHANGE)
        renders = [c for c in self.standing.calls if c[0] == "render-delta" and not c[3] and c[1] == NEW_IMAGE]
        restarts = [c for c in self.standing.calls if c[0] == "restart-deepwell"]
        self.assertEqual(len(renders), render_ahead.CATCH_UP_ROUNDS)
        self.assertGreaterEqual(len(restarts), render_ahead.CATCH_UP_ROUNDS)
        self.assertIn("restore-parked", names(self.standing.calls))

    def test_t4_post_rollback_delta_converges_before_the_final_canary(self) -> None:
        def failing_proof(*args):
            raise RuntimeError("parity differs")

        # Activation count 0; recovery count 2 stale to the old build, then 0.
        self.standing.stale_sequence = [0, 2, 0]
        self.standing.stale_page_ids = [7, 8]
        with self.assertRaisesRegex(RuntimeError, "parity differs") as raised:
            self.standing.run(self.root / "evidence", GENERATION_CHANGE, failing_proof)
        self.assertIn("'stale_after_recovery': 0", str(raised.exception))
        calls = self.standing.calls
        probe = next(c for c in calls if c[0] == "render-delta" and c[3])
        self.assertEqual(probe[1], OLD_IMAGE, "the old generator comes from the old image itself")
        render = next(c for c in calls if c[0] == "render-delta" and not c[3])
        self.assertEqual((render[1], render[2]), (OLD_IMAGE, (7, 8)))
        order = names(calls)
        self.assertLess(calls.index(render), order.index("restart-deepwell", calls.index(render)))
        restart_at = next(i for i, c in enumerate(calls) if c[0] == "restart-deepwell" and i > calls.index(render))
        gateway_after = next(i for i, c in enumerate(calls) if i > restart_at and c[0] == "gateway")
        canary_after = next(i for i, c in enumerate(calls) if i > restart_at and c[0] == "canary")
        self.assertLess(gateway_after, canary_after)

    def test_t4_recovery_failure_never_masks_the_activation_error(self) -> None:
        def failing_proof(*args):
            raise RuntimeError("parity differs")

        self.standing.stale_sequence = [0, 2]
        self.standing.stale_page_ids = [7, 8]
        with self.assertRaisesRegex(RuntimeError, "parity differs") as raised:
            self.standing.run(self.root / "evidence", GENERATION_CHANGE, failing_proof)
        self.assertIn("'stale_after_recovery': 2", str(raised.exception))
        renders = [c for c in self.standing.calls if c[0] == "render-delta" and not c[3]]
        self.assertEqual(len(renders), render_ahead.CATCH_UP_ROUNDS)

    def test_link_readers_settle_after_a_catch_up_moves_links(self) -> None:
        receipt = self.root / "render-ahead-receipt.json"
        receipt.write_text(json.dumps({"link_reader_page_ids": [42]}), encoding="utf-8")
        render_ahead_arg = {
            **GENERATION_CHANGE,
            "receipt": {"path": str(receipt), "sha256": "0" * 64},
        }
        self.standing.stale_sequence = [3, 0, 0]
        self.standing.stale_page_ids = [11, 12, 13]
        self.standing.link_digest_sequence = [
            {"9": "a"}, {"9": "b"}, {"9": "b"}, {"9": "b"},
        ]
        self.standing.run(self.root / "evidence", render_ahead_arg)
        self.assertIn(("mark-readers", (42,)), self.standing.calls)
        reader_render = next(
            c for c in self.standing.calls if c[0] == "render-delta" and c[2] == (42,)
        )
        self.assertEqual(reader_render[1], NEW_IMAGE)


# --- Real SQL against a disposable Postgres -------------------------------

PG_IMAGE = "wikijump-muse-bhl-database:latest"
SCHEMA = """
CREATE TABLE site (site_id bigint PRIMARY KEY);
INSERT INTO site VALUES (1);
CREATE TABLE page (
  page_id bigint PRIMARY KEY, site_id bigint NOT NULL, slug text NOT NULL,
  latest_revision_id bigint, deleted_at timestamptz
);
CREATE TABLE page_revision (
  revision_id bigint PRIMARY KEY,
  compiled_body_html_hash bytea, compiled_body_styles_hash bytea,
  compiled_top_bar_html_hash bytea, compiled_side_bar_html_hash bytea,
  compiled_at timestamptz, compiled_generator text
);
"""


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, capture_output=True, **kwargs)


class RealPostgresTest(unittest.TestCase):
    container = f"tla-fix-pg-{os.getpid()}"

    @classmethod
    def setUpClass(cls) -> None:
        try:
            docker("image", "inspect", PG_IMAGE)
        except subprocess.CalledProcessError:
            raise unittest.SkipTest(f"{PG_IMAGE} not present locally")
        subprocess.run(["docker", "rm", "--force", cls.container], capture_output=True)
        docker(
            "run", "-d", "--name", cls.container,
            "-e", "POSTGRES_PASSWORD=tlafix", "-e", "POSTGRES_USER=wikijump",
            "-e", "POSTGRES_DB=wikijump", PG_IMAGE,
        )
        deadline = time.monotonic() + 60
        while True:
            ready = subprocess.run(
                ["docker", "exec", cls.container, "pg_isready", "-U", "wikijump", "-d", "wikijump"],
                capture_output=True,
            )
            if ready.returncode == 0:
                break
            if time.monotonic() > deadline:
                raise RuntimeError("disposable Postgres did not become ready")
            time.sleep(0.5)
        promote.psql(cls.container, SCHEMA)

    @classmethod
    def tearDownClass(cls) -> None:
        subprocess.run(["docker", "rm", "--force", cls.container], capture_output=True)

    def setUp(self) -> None:
        promote.psql(
            self.container,
            "TRUNCATE page, page_revision;\n",
        )

    def insert_page(self, page_id, revision_id, generator, body, compiled_at, slug=None):
        promote.psql(
            self.container,
            f"INSERT INTO page VALUES ({page_id}, 1, '{slug or f'p{page_id}'}', {revision_id}, NULL);\n"
            f"INSERT INTO page_revision VALUES ({revision_id}, '{body}'::bytea, NULL, NULL, NULL, "
            f"'{compiled_at}', '{generator}');\n",
        )

    def revision(self, revision_id):
        row = promote.psql(
            self.container,
            "SELECT convert_from(compiled_body_html_hash, 'UTF8'), compiled_generator, "
            f"compiled_at FROM page_revision WHERE revision_id = {revision_id};\n",
        ).strip()
        return row.split("|")

    # T1 (real count/ids half; the FakeStanding half is in T1ActivationTest)
    def test_t1_real_count_and_stale_ids_after_a_db_import_batch(self) -> None:
        ids = list(range(1, 17))
        for page_id in ids:
            self.insert_page(page_id, 200 + page_id, TARGET, "old", "2026-11-02 00:00:00+00")
        self.assertEqual(promote.saved_page_staleness(self.container, TARGET), 0)
        # A second connection commits the import batch the db-mode importer
        # writes: new revisions with the placeholder generator, latest moved.
        batch = "".join(
            f"INSERT INTO page_revision VALUES ({300 + p}, 'imported'::bytea, NULL, NULL, NULL, "
            f"now(), 'corpus db import');\nUPDATE page SET latest_revision_id = {300 + p} WHERE page_id = {p};\n"
            for p in ids
        )
        promote.psql(self.container, batch)
        self.assertEqual(promote.saved_page_staleness(self.container, TARGET), 16)
        self.assertEqual(promote.saved_page_stale_ids(self.container, TARGET), ids)

    # T3 (real SQL): the restore guard.
    def test_t3_restore_keeps_post_flip_rerenders(self) -> None:
        switch_start = "2026-11-02 01:00:00+00"
        self.insert_page(1, 101, OLD_GENERATOR, "oldA", "2026-11-02 00:00:00+00")
        self.insert_page(2, 102, OLD_GENERATOR, "oldB", "2026-11-02 00:00:00+00")
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "snapshot.tsv"
            self.assertEqual(promote.snapshot_saved_page_output(snapshot, self.container), 2)
            # Flip: ahead promotion (compiled_at predates the switch), then a
            # post-flip in-place rerender of B (later compiled_at), then a new
            # revision C created after the flip (not in the snapshot).
            promote.psql(
                self.container,
                f"UPDATE page_revision SET compiled_generator = '{TARGET}', "
                "compiled_body_html_hash = 'new'::bytea || revision_id::text::bytea, "
                "compiled_at = '2026-11-02 00:30:00+00' WHERE revision_id IN (101, 102);\n"
                "UPDATE page_revision SET compiled_body_html_hash = 'postB'::bytea, "
                f"compiled_at = '2026-11-02 02:00:00+00' WHERE revision_id = 102;\n",
            )
            self.insert_page(3, 103, TARGET, "newC", "2026-11-02 02:00:00+00")
            with mock.patch.object(
                promote, "run", side_effect=lambda *a, **k: ""
            ):  # the Valkey INCR cannot exist here; stub only that
                restored = promote.restore_saved_page_output(
                    snapshot, TARGET, self.container, "unused-cache",
                    switch_started_at=switch_start,
                )
        self.assertEqual(restored, 1, "only the untouched promoted row A is restored")
        self.assertEqual(self.revision(101)[:2], ["oldA", OLD_GENERATOR])
        self.assertEqual(self.revision(102)[:2], ["postB", TARGET])
        self.assertEqual(self.revision(103)[:2], ["newC", TARGET])


class T1ActivationTest(unittest.TestCase):
    """T1 through FakeStanding, with the sequence the real count produced."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "home").mkdir()
        self.standing = FakeStanding(self.root / "home")

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_t1_import_batch_between_verify_and_activation_converges(self) -> None:
        ids = list(range(1, 17))
        self.standing.stale_sequence = [16, 0]
        self.standing.stale_page_ids = ids
        result = self.standing.run(self.root / "evidence", GENERATION_CHANGE)
        self.assertEqual(result["standing_proof"], {"status": "pass"})
        calls = self.standing.calls
        render = next(c for c in calls if c[0] == "render-delta")
        self.assertEqual((render[1], render[2]), (NEW_IMAGE, tuple(ids)))
        order = names(calls)
        restart_at = order.index("restart-deepwell")
        self.assertLess(calls.index(render), restart_at)
        # Gateway reloads after the restart, the re-count follows, and the
        # canary runs only after the re-count saw zero stale pages.
        self.assertLess(restart_at, order.index("gateway", restart_at))
        self.assertLess(order.index("gateway", restart_at), order.index("canary"))
        self.assertNotIn("restore-pages", order)
        self.assertNotIn("restore-parked", order)


if __name__ == "__main__":
    unittest.main()

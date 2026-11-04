from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[3]
SCRIPT = Path(__file__).parents[1] / "render_ahead.py"
SPEC = importlib.util.spec_from_file_location("standing_render_ahead", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
RENDER_AHEAD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDER_AHEAD)


class RenderAheadMigrationTest(unittest.TestCase):
    def test_the_shipped_migration_is_idempotent(self) -> None:
        migration = ROOT / "deepwell" / "migrations" / Path(RENDER_AHEAD.MIGRATION_PATH).name
        RENDER_AHEAD.require_idempotent_migration(migration.read_text(encoding="utf-8"))

    def test_non_idempotent_statements_are_rejected(self) -> None:
        for sql in (
            "CREATE TABLE page_revision_render_ahead (revision_id BIGINT);",
            "CREATE TABLE IF NOT EXISTS a (b INT);\nALTER TABLE page DROP COLUMN slug;",
            "-- comment only\n",
        ):
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                RENDER_AHEAD.require_idempotent_migration(sql)

    def test_comments_are_not_statements(self) -> None:
        self.assertEqual(
            RENDER_AHEAD.sql_statements(
                "-- a; b\nCREATE TABLE IF NOT EXISTS a (\n  b INT -- c\n);\n"
            ),
            ["CREATE TABLE IF NOT EXISTS a (\n  b INT -- c\n)"],
        )


class RenderAheadRuntimeTest(unittest.TestCase):
    def test_environment_drops_inherited_runtime_actions(self) -> None:
        inspected = {
            "Config": {
                "Env": [
                    "DATABASE_URL=postgres://db",
                    "REDIS_URL=redis://cache",
                    "DEEPWELL_RPC_TOKEN=" + "0" * 64,
                    "DEEPWELL_RUNTIME_ACTION=render-finalize",
                    "DEEPWELL_RENDER_PASS=pass2",
                    "PATH=/usr/bin",
                ]
            }
        }
        self.assertEqual(
            RENDER_AHEAD.runtime_environment(inspected),
            {
                "DATABASE_URL": "postgres://db",
                "REDIS_URL": "redis://cache",
                "DEEPWELL_RPC_TOKEN": "0" * 64,
                "PATH": "/usr/bin",
            },
        )

    def test_environment_requires_backing_services(self) -> None:
        with self.assertRaises(RuntimeError):
            RENDER_AHEAD.runtime_environment({"Config": {"Env": ["REDIS_URL=x"]}})

    def test_config_mount_is_required(self) -> None:
        self.assertEqual(
            RENDER_AHEAD.config_mount(
                {"Mounts": [{"Destination": "/etc/deepwell.toml", "Source": "/srv/config.toml"}]}
            ),
            "/srv/config.toml",
        )
        with self.assertRaises(RuntimeError):
            RENDER_AHEAD.config_mount({"Mounts": []})

    def test_settings_only_name_not_before_for_a_second_pass(self) -> None:
        first = RENDER_AHEAD.render_ahead_settings(8, 100, None)
        self.assertEqual(first["DEEPWELL_RUNTIME_ACTION"], "render-ahead")
        self.assertEqual(first["DEEPWELL_RENDER_AHEAD_DRY_RUN"], "false")
        self.assertNotIn("DEEPWELL_RENDER_AHEAD_NOT_BEFORE", first)
        second = RENDER_AHEAD.render_ahead_settings(8, 100, "2026-10-14T00:00:00Z")
        self.assertEqual(second["DEEPWELL_RENDER_AHEAD_NOT_BEFORE"], "2026-10-14T00:00:00Z")

    def test_link_digest_ignores_row_timestamps(self) -> None:
        for timestamp in ("created_at", "updated_at", "rendered_at"):
            self.assertNotIn(timestamp, RENDER_AHEAD.LINK_DIGEST_QUERY)
        for table in ("page_connection", "page_connection_missing", "page_link"):
            self.assertIn(f"FROM {table}", RENDER_AHEAD.LINK_DIGEST_QUERY)

    def test_link_digest_only_considers_renderable_live_source_pages(self) -> None:
        query = RENDER_AHEAD.LINK_DIGEST_QUERY
        self.assertIn("JOIN page AS source_page ON source_page.page_id = links.page_id", query)
        self.assertIn("source_page.deleted_at IS NULL", query)
        self.assertIn("source_page.latest_revision_id IS NOT NULL", query)

    def test_changed_pages_include_added_and_removed_link_sets(self) -> None:
        self.assertEqual(
            RENDER_AHEAD.changed_pages({"1": "a", "2": "b", "3": "c"}, {"1": "a", "2": "x", "4": "d"}),
            [2, 3, 4],
        )

    def test_settings_limit_pages_and_dry_runs(self) -> None:
        settings = RENDER_AHEAD.render_ahead_settings(1, 100, None, [5, 9], dry_run=True)
        self.assertEqual(settings["DEEPWELL_RENDER_AHEAD_PAGE_IDS"], "5,9")
        self.assertEqual(settings["DEEPWELL_RENDER_AHEAD_DRY_RUN"], "true")
        with self.assertRaises(ValueError):
            RENDER_AHEAD.render_ahead_settings(1, 100, None, [])

    def test_only_deadline_failures_are_retried(self) -> None:
        deadline = {"error": "failed to render\n`-- deadline has elapsed, at service.rs"}
        other = {"error": "include expansion exceeded maximum total includes 256"}
        self.assertTrue(RENDER_AHEAD.deadline_only({"failed": 1, "failures": [deadline]}))
        self.assertFalse(
            RENDER_AHEAD.deadline_only({"failed": 2, "failures": [deadline, other]})
        )
        self.assertFalse(
            RENDER_AHEAD.deadline_only({"failed": 51, "failures": [deadline] * 50}),
            "truncated failure details cannot prove every failure is a deadline",
        )

    def test_tail_retries_cover_storage_timeouts_but_not_other_failures(self) -> None:
        storage = {
            "error": "failed to insert 1 new html text blocks\n"
            "reqwest: error sending request for url (http://127.0.0.1:9000/deepwell-text-blocks/x)\n"
            "`-- operation timed out, at src/services/text_block/service.rs:221:24"
        }
        deadline = {"error": "failed to render\n`-- deadline has elapsed, at service.rs"}
        other = {"error": "include expansion exceeded maximum total includes 256"}
        self.assertTrue(RENDER_AHEAD.tail_retryable_only({"failed": 1, "failures": [storage]}))
        self.assertTrue(
            RENDER_AHEAD.tail_retryable_only({"failed": 2, "failures": [deadline, storage]})
        )
        self.assertFalse(RENDER_AHEAD.deadline_only({"failed": 1, "failures": [storage]}))
        self.assertFalse(
            RENDER_AHEAD.tail_retryable_only({"failed": 2, "failures": [storage, other]})
        )
        self.assertFalse(
            RENDER_AHEAD.tail_retryable_only({"failed": 51, "failures": [storage] * 50}),
            "truncated failure details cannot prove every failure is retryable",
        )

    def test_extended_deadline_replaces_exactly_one_setting(self) -> None:
        config = "[main]\nrender-timeout-ms = 2000\nother = 1\n"
        self.assertEqual(
            RENDER_AHEAD.config_with_render_timeout(config, 300000),
            "[main]\nrender-timeout-ms = 300000\nother = 1\n",
        )
        for bad in ("[main]\n", "render-timeout-ms = 1\nrender-timeout-ms = 2\n"):
            with self.subTest(config=bad), self.assertRaises(ValueError):
                RENDER_AHEAD.config_with_render_timeout(bad, 300000)

    def test_summary_must_be_one_real_run(self) -> None:
        summary = {"action": "render-ahead", "dry_run": False, "failed": 0}
        output = "log line\n" + json.dumps(summary) + "\n"
        self.assertEqual(RENDER_AHEAD.parse_summary(output), summary)
        dry = {**summary, "dry_run": True}
        self.assertEqual(RENDER_AHEAD.parse_summary(json.dumps(dry), dry_run=True), dry)
        for bad in (
            "no summary\n",
            json.dumps(summary) + "\n" + json.dumps(summary) + "\n",
            json.dumps(dry) + "\n",
        ):
            with self.subTest(output=bad), self.assertRaises(RuntimeError):
                RENDER_AHEAD.parse_summary(bad)


class FakeSite:
    """Pages and the links each render writes.

    `links` maps a page to a function of the current links and the render
    count; `readers` are the pages whose render reads the link graph.
    `deadline` maps a page to how hard it misses the render deadline: 1
    renders alone, 2 needs the extended deadline, 3 never renders.
    `storage` maps a page to how hard its text-block PUT times out: 1
    renders alone, 2 never renders."""

    def __init__(self, links, readers=(), deadline=(), storage=()):
        self.produce = links
        self.readers = set(readers)
        self.deadline = dict(deadline)
        self.storage = dict(storage)
        self.links = {str(page): "old" for page in links}
        self.renders = 0
        self.calls = []

    def render(self, name, cutoff, pages=None, *, serial=False, extended=False, dry_run=False):
        self.calls.append((name, cutoff, pages, serial, extended))
        selected = list(pages) if pages is not None else sorted(self.produce)
        failed = []
        errors = []
        for page in selected:
            misses = self.deadline.get(page, 0)
            if misses >= 3 or (misses == 2 and not extended) or (misses == 1 and not serial):
                failed.append(page)
                errors.append("deadline has elapsed")
                continue
            stalls = self.storage.get(page, 0)
            if stalls >= 2 or (stalls == 1 and not serial):
                failed.append(page)
                errors.append("operation timed out, at src/services/text_block/service.rs")
                continue
            self.renders += 1
            self.links[str(page)] = self.produce[page](self.links, self.renders)
        return {
            "candidates": len(selected),
            "failed_page_ids": failed,
            "failed": len(failed),
            "failures": [{"error": error} for error in errors],
            "link_reader_page_ids": sorted(set(selected) & self.readers - set(failed)),
        }

    def settle(self):
        return RENDER_AHEAD.render_until_links_settle(
            self.render, lambda: dict(self.links), "t-start"
        )

    def names(self):
        return [call[0] for call in self.calls]


class RenderUntilLinksSettleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = iter(f"t{index}" for index in range(100))
        self.original_now = RENDER_AHEAD.utc_now
        RENDER_AHEAD.utc_now = lambda: next(self.clock)

    def tearDown(self) -> None:
        RENDER_AHEAD.utc_now = self.original_now

    def test_one_full_pass_suffices_without_link_readers(self) -> None:
        site = FakeSite({1: lambda links, n: "new", 2: lambda links, n: f"random-{n}"})
        self.assertEqual(site.settle(), ([], []))
        self.assertEqual(site.names(), ["full"])

    def test_readers_render_again_after_the_links_they_read_moved(self) -> None:
        # Page 3 lists page 1's links: rendered before page 1 in the full
        # pass, it read the old ones.
        site = FakeSite(
            {3: lambda links, n: "reads-" + links["1"], 1: lambda links, n: "new"},
            readers=[3],
        )
        site.produce = dict(sorted(site.produce.items()))
        site.links = {"1": "old", "3": "old"}
        order = [3, 1]
        original = site.render
        def render(name, cutoff, pages=None, **flags):
            return original(name, cutoff, pages if pages is not None else order, **flags)
        site.render = render
        readers, nondeterministic = site.settle()
        self.assertEqual((readers, nondeterministic), ([3], []))
        self.assertEqual(site.links["3"], "reads-new")
        self.assertEqual(site.names(), ["full", "link-readers-1", "link-readers-2"])
        self.assertEqual(site.calls[1][2], [3], "a reader round renders only the readers")
        self.assertNotEqual(site.calls[1][1], "t-start", "a reader round needs its own cutoff")

    def test_unchanged_links_need_no_reader_round(self) -> None:
        site = FakeSite({1: lambda links, n: "old", 2: lambda links, n: "reads-" + links["1"]}, readers=[2])
        site.links["2"] = "reads-old"
        self.assertEqual(site.settle(), ([2], []))
        self.assertEqual(site.names(), ["full"])

    def test_a_reader_chain_settles_one_level_per_round(self) -> None:
        # 4 reads 3, 3 reads 2, 2 reads 1; the full pass renders readers first.
        site = FakeSite(
            {
                4: lambda links, n: "4<" + links["3"],
                3: lambda links, n: "3<" + links["2"],
                2: lambda links, n: "2<" + links["1"],
                1: lambda links, n: "new",
            },
            readers=[2, 3, 4],
        )
        readers, nondeterministic = site.settle()
        self.assertEqual((readers, nondeterministic), ([2, 3, 4], []))
        self.assertEqual(site.links["4"], "4<3<2<new")

    def test_readers_that_move_on_every_render_block_promotion(self) -> None:
        site = FakeSite(
            {1: lambda links, n: "new", 5: lambda links, n: f"random-{n}"},
            readers=[5],
        )
        with self.assertRaisesRegex(RuntimeError, "did not settle"):
            site.settle()
        self.assertEqual(site.names()[-1], f"link-readers-{RENDER_AHEAD.MAX_READER_ROUNDS}")

    def test_stochastic_reader_makes_another_reader_stale(self) -> None:
        # A random-order ListPages can change its saved links every time.
        # Another link-reading page may render before it in every concurrent
        # pass, leaving an ahead row that reflects a previous link snapshot.
        site = FakeSite(
            {1: lambda links, n: f"random-{n}", 2: lambda links, n: "reads-" + links["1"]},
            readers=[1, 2],
        )
        original = site.render

        def render(name, cutoff, pages=None, **flags):
            selected = set(pages) if pages is not None else {1, 2}
            ordered = [page for page in (2, 1) if page in selected]
            return original(name, cutoff, ordered, **flags)

        site.render = render
        with self.assertRaisesRegex(RuntimeError, "did not settle"):
            site.settle()
        self.assertNotEqual(site.links["2"], "reads-" + site.links["1"])

    def test_deep_reader_chain_is_not_mistaken_for_random_movement(self) -> None:
        # The last reader needs five propagation rounds. Four rounds change
        # overlapping page IDs, but each page is fully deterministic. They
        # still cannot be accepted with an output depending on older links.
        links = {page: (lambda values, _n, page=page: f"{page}<" + values[str(page - 1)])
                 for page in range(2, 7)}
        links[1] = lambda _values, _n: "new"
        site = FakeSite(links, readers=range(2, 7))
        original = site.render

        def render(name, cutoff, pages=None, **flags):
            selected = pages if pages is not None else links
            return original(name, cutoff, sorted(selected, reverse=True), **flags)

        site.render = render
        with self.assertRaisesRegex(RuntimeError, "did not settle"):
            site.settle()
        self.assertNotEqual(site.links["6"], "6<" + site.links["5"])

    def test_links_that_still_settle_after_the_last_round_fail_the_run(self) -> None:
        # Page 6 moves on every render; page 8 first moves in the last round,
        # so it has not been shown to settle.
        site = FakeSite(
            {
                1: lambda links, n: "new",
                6: lambda links, n: f"move-{n}",
                8: lambda links, n: "late" if n >= 11 else "stable",
            },
            readers=[6, 8],
        )
        with self.assertRaisesRegex(RuntimeError, "did not settle"):
            site.settle()

    def test_deadline_misses_are_retried_before_links_are_compared(self) -> None:
        site = FakeSite(
            {1: lambda links, n: "new", 2: lambda links, n: "reads-" + links["1"]},
            readers=[2],
            deadline={1: 2},
        )
        readers, _ = site.settle()
        self.assertEqual(readers, [2])
        self.assertEqual(
            site.names()[:3], ["full", "full-tail-serial", "full-tail-extended-deadline"]
        )
        self.assertEqual(site.calls[1][2], [1])
        self.assertTrue(site.calls[1][3], "the first retry renders alone")
        self.assertTrue(site.calls[2][4], "the second retry uses the extended deadline")
        self.assertFalse(site.calls[2][3], "extended-deadline renders do not race the deadline")
        self.assertEqual(site.links["2"], "reads-new")

    def test_storage_timeouts_are_retried_before_links_are_compared(self) -> None:
        site = FakeSite(
            {1: lambda links, n: "new", 2: lambda links, n: "reads-" + links["1"]},
            readers=[2],
            storage={1: 1},
        )
        readers, _ = site.settle()
        self.assertEqual(readers, [2])
        self.assertEqual(site.names()[:2], ["full", "full-tail-serial"])
        self.assertEqual(site.calls[1][2], [1])
        self.assertTrue(site.calls[1][3], "the storage retry renders alone")
        self.assertEqual(site.links["2"], "reads-new")

    def test_storage_timeouts_that_never_clear_stop_the_run(self) -> None:
        site = FakeSite({1: lambda links, n: "new"}, storage={1: 2})
        with self.assertRaisesRegex(RuntimeError, "even with the extended deadline"):
            site.settle()

    def test_a_storage_timeout_beside_a_real_failure_stops_the_run(self) -> None:
        site = FakeSite(
            {1: lambda links, n: "new", 2: lambda links, n: "new"},
            storage={1: 1},
            deadline={2: 1},
        )
        original = site.render
        def render(*args, **flags):
            summary = original(*args, **flags)
            summary["failures"] = [
                {"error": "include limit"} if page == 2 else failure
                for page, failure in zip(summary["failed_page_ids"], summary["failures"])
            ]
            return summary
        site.render = render
        with self.assertRaisesRegex(RuntimeError, "other than the render deadline"):
            site.settle()

    def test_other_failures_stop_the_run(self) -> None:
        site = FakeSite({1: lambda links, n: "new"}, deadline={1: 1})
        original = site.render
        def render(*args, **flags):
            summary = original(*args, **flags)
            summary["failures"] = [{"error": "include limit"} for _ in summary["failed_page_ids"]]
            return summary
        site.render = render
        with self.assertRaisesRegex(RuntimeError, "other than the render deadline"):
            site.settle()

    def test_pages_that_never_render_stop_the_run(self) -> None:
        site = FakeSite({1: lambda links, n: "new"}, deadline={1: 3})
        with self.assertRaisesRegex(RuntimeError, "even with the extended deadline"):
            site.settle()

    def test_reader_round_must_select_every_reader(self) -> None:
        site = FakeSite(
            {1: lambda links, n: "new", 2: lambda links, n: "reads-" + links["1"]},
            readers=[2],
        )
        site.links["2"] = "stale"
        original = site.render
        def render(name, cutoff, pages=None, **flags):
            summary = original(name, cutoff, pages, **flags)
            if name.startswith("link-readers"):
                summary["candidates"] = 0
            return summary
        site.render = render
        with self.assertRaisesRegex(RuntimeError, r"selected 0 of 1 reader pages"):
            site.settle()

    def test_an_image_without_link_readers_is_refused(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "does not report link readers"):
            RENDER_AHEAD.link_readers({"candidates": 1})


def image_summary(**overrides):
    """A render-ahead pass summary shaped like the image's own report."""
    summary = {
        "action": "render-ahead",
        "compiled_generator": "ftml.test; deepwell-render/v99",
        "dry_run": False,
        "batch_size": 200,
        "concurrency": 16,
        "candidates": 0,
        "rendered": 0,
        "failed": 0,
        "failed_page_ids": [],
        "failures": [],
        "link_reader_page_ids": [],
        "stale_without_valid_ahead": 0,
        "elapsed_ms": 0,
        "rows_per_sec": 0.0,
        "slow_renders": 0,
        "slowest_renders": [],
    }
    summary.update(overrides)
    return summary


class SplitShardsTest(unittest.TestCase):
    def test_single_shard_keeps_everything(self) -> None:
        self.assertEqual(RENDER_AHEAD.split_shards([3, 1, 2], 1), [[3, 1, 2]])

    def test_chunks_are_disjoint_complete_and_ordered(self) -> None:
        ids = list(range(1, 26))
        chunks = RENDER_AHEAD.split_shards(ids, 4)
        self.assertEqual([len(chunk) for chunk in chunks], [7, 6, 6, 6])
        self.assertEqual([page for chunk in chunks for page in chunk], ids)

    def test_more_shards_than_pages_gives_singletons(self) -> None:
        self.assertEqual(RENDER_AHEAD.split_shards([1, 2, 3], 5), [[1], [2], [3]])

    def test_empty_input_never_emits_an_empty_chunk(self) -> None:
        # The image rejects an empty page-ID list, so no chunk may be empty.
        self.assertEqual(RENDER_AHEAD.split_shards([], 3), [])

    def test_non_positive_shards_are_rejected(self) -> None:
        for shards in (0, -2):
            with self.subTest(shards=shards), self.assertRaises(ValueError):
                RENDER_AHEAD.split_shards([1], shards)


class MergeSummariesTest(unittest.TestCase):
    def test_counts_add_and_page_sets_union(self) -> None:
        merged = RENDER_AHEAD.merge_summaries(
            [
                image_summary(
                    candidates=3, rendered=2, failed=1, failed_page_ids=[7],
                    failures=[{"page_id": 7}], link_reader_page_ids=[5],
                    stale_without_valid_ahead=1, elapsed_ms=1000,
                    slow_renders=1,
                    slowest_renders=[{"site_id": 1, "page_id": 5, "elapsed_ms": 1200}],
                ),
                image_summary(
                    candidates=2, rendered=2, failed=0, link_reader_page_ids=[9, 5],
                    elapsed_ms=2000,
                    slowest_renders=[{"site_id": 1, "page_id": 9, "elapsed_ms": 1500}],
                ),
            ]
        )
        self.assertEqual((merged["candidates"], merged["rendered"], merged["failed"]), (5, 4, 1))
        self.assertEqual(merged["failed_page_ids"], [7])
        self.assertEqual(merged["link_reader_page_ids"], [5, 9])
        self.assertEqual(merged["stale_without_valid_ahead"], 1)
        # Concurrent shards: wall-clock is the slowest shard, not the sum.
        self.assertEqual(merged["elapsed_ms"], 2000)
        self.assertAlmostEqual(merged["rows_per_sec"], 2.0)
        self.assertEqual(merged["slow_renders"], 1)
        self.assertEqual(
            [entry["page_id"] for entry in merged["slowest_renders"]], [9, 5]
        )

    def test_failure_details_truncate_but_ids_stay_complete(self) -> None:
        summaries = [
            image_summary(
                failed=30, failed_page_ids=list(range(30)),
                failures=[{"page_id": page} for page in range(30)],
            ),
            image_summary(
                failed=30, failed_page_ids=list(range(30, 60)),
                failures=[{"page_id": page} for page in range(30, 60)],
            ),
        ]
        merged = RENDER_AHEAD.merge_summaries(summaries)
        self.assertEqual(merged["failed"], 60)
        self.assertEqual(merged["failed_page_ids"], list(range(60)))
        self.assertEqual(len(merged["failures"]), RENDER_AHEAD.MAX_REPORTED_FAILURES)

    def test_skewed_shards_refuse_to_merge(self) -> None:
        good = image_summary()
        with self.assertRaisesRegex(RuntimeError, "disagree on compiled_generator"):
            RENDER_AHEAD.merge_summaries([good, image_summary(compiled_generator="other")])
        with self.assertRaisesRegex(RuntimeError, "disagree on concurrency"):
            RENDER_AHEAD.merge_summaries([good, image_summary(concurrency=1)])
        with self.assertRaises(ValueError):
            RENDER_AHEAD.merge_summaries([])


class RecordPassTest(unittest.TestCase):
    def test_overhead_splits_controller_wall_from_render_time(self) -> None:
        passes: list = []
        RENDER_AHEAD.record_pass(
            passes, "full",
            {"DEEPWELL_RUNTIME_ACTION": "render-ahead", "DEEPWELL_RENDER_AHEAD_CONCURRENCY": "16"},
            False, 12.5, image_summary(elapsed_ms=11000),
        )
        (entry,) = passes
        self.assertEqual(entry["pass"], "full")
        self.assertAlmostEqual(entry["overhead_seconds"], 1.5)
        self.assertNotIn("DEEPWELL_RUNTIME_ACTION", entry["settings"])
        self.assertEqual(entry["config"], "serving")


class FakeShards:
    """A `render` callable over fixed chunks, recording shard calls."""

    def __init__(self, readers=()):
        self.readers = set(readers)
        self.calls = []
        self.fail_on: set = set()

    def render(self, name, cutoff, pages=None, *, serial=False, extended=False, dry_run=False):
        self.calls.append((name, list(pages or [])))
        for page in pages or []:
            if page in self.fail_on:
                raise RuntimeError(f"shard failed on page {page}")
        selected = list(pages or [])
        return image_summary(
            candidates=len(selected), rendered=len(selected),
            link_reader_page_ids=sorted(set(selected) & self.readers),
            elapsed_ms=100 * len(selected),
        )


class RenderFullShardedTest(unittest.TestCase):
    def test_each_live_page_renders_in_exactly_one_shard(self) -> None:
        site = FakeShards(readers=[2, 5])
        chunks = RENDER_AHEAD.split_shards([1, 2, 3, 4, 5, 6], 2)
        merged = RENDER_AHEAD.render_full_sharded(site.render, "full", "t-start", chunks)
        rendered = [page for _, pages in site.calls for page in pages]
        self.assertEqual(sorted(rendered), [1, 2, 3, 4, 5, 6])
        self.assertEqual(sorted(call[0] for call in site.calls), ["full-shard-0", "full-shard-1"])
        self.assertEqual((merged["candidates"], merged["rendered"]), (6, 6))
        self.assertEqual(merged["link_reader_page_ids"], [2, 5])

    def test_a_shard_failure_stops_the_run(self) -> None:
        site = FakeShards()
        site.fail_on = {4}
        chunks = RENDER_AHEAD.split_shards([1, 2, 3, 4, 5, 6], 2)
        with self.assertRaisesRegex(RuntimeError, "shard failed on page 4"):
            RENDER_AHEAD.render_full_sharded(site.render, "full", "t-start", chunks)

    def test_empty_chunks_are_rejected(self) -> None:
        site = FakeShards()
        with self.assertRaises(ValueError):
            RENDER_AHEAD.render_full_sharded(site.render, "full", "t-start", [])
        with self.assertRaises(ValueError):
            RENDER_AHEAD.render_full_sharded(site.render, "full", "t-start", [[1], []])


class DigestTimingsTest(unittest.TestCase):
    def test_snapshots_are_timed_when_requested(self) -> None:
        site = FakeSite({1: lambda links, n: "new", 2: lambda links, n: "old"})
        timings: list = []
        readers, nondeterministic = RENDER_AHEAD.render_until_links_settle(
            site.render, lambda: dict(site.links), "t-start", timings
        )
        self.assertEqual((readers, nondeterministic), ([], []))
        self.assertEqual(
            [entry["stage"] for entry in timings],
            ["links-before-full", "links-after-full"],
        )
        for entry in timings:
            self.assertGreaterEqual(entry["digest_seconds"], 0.0)

    def test_reader_rounds_time_every_snapshot(self) -> None:
        site = FakeSite(
            {3: lambda links, n: "reads-" + links["1"], 1: lambda links, n: "new"},
            readers=[3],
        )
        site.produce = dict(sorted(site.produce.items()))
        site.links = {"1": "old", "3": "old"}
        timings: list = []
        RENDER_AHEAD.render_until_links_settle(
            site.render, lambda: dict(site.links), "t-start", timings
        )
        # Natural order renders page 1 before its reader, so the full pass
        # already settled page 3 and one reader round suffices.
        self.assertEqual(
            [entry["stage"] for entry in timings],
            [
                "links-before-full", "links-after-full",
                "links-before-readers-1", "links-after-readers-1",
            ],
        )


if __name__ == "__main__":
    unittest.main()


class VerifyWithCatchUpTest(unittest.TestCase):
    def fake_render(self, stale_by_verify):
        calls = []
        verifies = iter(stale_by_verify)

        def render(name, cutoff, pages=None, *, serial=False, extended=False, dry_run=False):
            calls.append((name, dry_run))
            if dry_run:
                return {"stale_without_valid_ahead": next(verifies), "compiled_generator": "g"}
            return {"stale_without_valid_ahead": 0, "compiled_generator": "g"}

        return render, calls

    def test_a_clean_verify_needs_no_catch_up(self) -> None:
        render, calls = self.fake_render([0])
        final = RENDER_AHEAD.verify_with_catch_up(render, "cutoff")
        self.assertEqual(final["stale_without_valid_ahead"], 0)
        self.assertEqual(calls, [("verify", True)])

    def test_pages_written_during_the_run_are_rendered_and_verified_again(self) -> None:
        render, calls = self.fake_render([2, 0])
        final = RENDER_AHEAD.verify_with_catch_up(render, "cutoff")
        self.assertEqual(final["stale_without_valid_ahead"], 0)
        self.assertEqual(calls, [("verify", True), ("catch-up-1", False), ("verify-1", True)])

    def test_catch_up_is_bounded_and_reports_what_stays_stale(self) -> None:
        render, calls = self.fake_render([1, 1, 1, 1])
        final = RENDER_AHEAD.verify_with_catch_up(render, "cutoff", rounds=3)
        self.assertEqual(final["stale_without_valid_ahead"], 1)
        self.assertEqual([name for name, _ in calls].count("verify"), 1)
        self.assertEqual(len([c for c in calls if not c[1]]), 3)

    def fake_catch_up_site(self, *, link_change: bool, moving_reader: bool = False):
        """A verify/catch-up world: page 9 is written during the run; the
        catch-up render moves page 1's link digest when `link_change`.
        Page 2 is a main-pass link reader of page 1."""
        state = {"links": {"1": "a", "2": "reads-a"}, "rendered_readers": 0}
        calls: list = []

        def render(name, cutoff, pages=None, *, serial=False, extended=False, dry_run=False):
            calls.append((name, dry_run, pages))
            if dry_run:
                stale = 1 if name == "verify" else 0
                return {"stale_without_valid_ahead": stale, "compiled_generator": "g"}
            if name.startswith("catch-up-link-readers"):
                state["rendered_readers"] += 1
                if moving_reader:
                    state["links"]["1"] = f"moved-{state['rendered_readers']}"
                else:
                    state["links"]["2"] = "reads-" + state["links"]["1"]
                return {
                    "stale_without_valid_ahead": 0,
                    "compiled_generator": "g",
                    "candidates": len(pages or []),
                    "rendered": len(pages or []),
                    "failed": 0,
                    "failed_page_ids": [],
                    "link_reader_page_ids": list(pages or []),
                }
            # catch-up render of the edited page
            if link_change:
                state["links"]["1"] = "b"
            return {
                "stale_without_valid_ahead": 0,
                "compiled_generator": "g",
                "candidates": 1,
                "rendered": 1,
                "failed": 0,
                "failed_page_ids": [],
                "link_reader_page_ids": [],
            }

        def digests():
            return dict(state["links"])

        return render, digests, calls, state

    def test_catch_up_link_change_rerenders_main_pass_readers(self) -> None:
        render, digests, calls, state = self.fake_catch_up_site(link_change=True)
        timings: list = []
        final = RENDER_AHEAD.verify_with_catch_up(
            render, "cutoff", digests=digests, timings=timings, readers=[2]
        )
        self.assertEqual(final["stale_without_valid_ahead"], 0)
        names = [name for name, _, _ in calls]
        self.assertEqual(
            names,
            [
                "verify",
                "catch-up-1",
                "verify-1",
                "catch-up-link-readers-1",
                "catch-up-link-readers-2",
                "verify-after-catch-up",
            ],
        )
        self.assertEqual(state["links"]["2"], "reads-b")
        stages = [entry["stage"] for entry in timings]
        self.assertEqual(
            stages,
            [
                "links-before-catch-up",
                "links-after-catch-up",
                "links-before-catch-up-readers-1",
                "links-after-catch-up-readers-1",
                "links-before-catch-up-readers-2",
                "links-after-catch-up-readers-2",
            ],
        )

    def test_catch_up_without_link_change_rerenders_no_readers(self) -> None:
        render, digests, calls, _ = self.fake_catch_up_site(link_change=False)
        final = RENDER_AHEAD.verify_with_catch_up(
            render, "cutoff", digests=digests, readers=[2]
        )
        self.assertEqual(final["stale_without_valid_ahead"], 0)
        names = [name for name, _, _ in calls]
        self.assertEqual(names, ["verify", "catch-up-1", "verify-1"])

    def test_catch_up_link_change_without_readers_needs_no_round(self) -> None:
        render, digests, calls, _ = self.fake_catch_up_site(link_change=True)
        final = RENDER_AHEAD.verify_with_catch_up(render, "cutoff", digests=digests)
        self.assertEqual(final["stale_without_valid_ahead"], 0)
        names = [name for name, _, _ in calls]
        self.assertEqual(names, ["verify", "catch-up-1", "verify-1"])

    def test_catch_up_links_that_never_settle_fail_closed(self) -> None:
        render, digests, _, _ = self.fake_catch_up_site(link_change=True, moving_reader=True)
        with self.assertRaisesRegex(RuntimeError, "did not settle"):
            RENDER_AHEAD.verify_with_catch_up(
                render, "cutoff", digests=digests, readers=[2]
            )

    def test_a_clean_verify_never_snapshots_digests(self) -> None:
        render, calls = self.fake_render([0])
        snapshots = []

        def digests():
            snapshots.append(1)
            return {}

        final = RENDER_AHEAD.verify_with_catch_up(render, "cutoff", digests=digests, readers=[2])
        self.assertEqual(final["stale_without_valid_ahead"], 0)
        self.assertEqual(snapshots, [])

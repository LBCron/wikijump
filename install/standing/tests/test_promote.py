from __future__ import annotations

import inspect
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).parents[1]))
import promote  # noqa: E402




class RehearsalReasonTest(unittest.TestCase):
    def test_new_migrations_are_rehearsed_because_they_cannot_be_undone(self) -> None:
        self.assertEqual(
            promote.rehearsal_reason("auto", ["deepwell/migrations/x.sql"]),
            "the schema migrations change",
        )

    def test_an_undoable_activation_is_not_rehearsed_unless_requested(self) -> None:
        self.assertIsNone(promote.rehearsal_reason("auto", []))
        self.assertEqual(promote.rehearsal_reason("always", []), "requested")


class BrowserReferenceTest(unittest.TestCase):
    def reference(self, directory: Path, ledger_bytes: bytes) -> None:
        (directory / "ledger.json").write_bytes(ledger_bytes)
        (directory / "reference.json").write_text(
            json.dumps(
                {
                    "schema": promote.BROWSER_REFERENCE_SCHEMA,
                    "live_completion_policy": "policy.json",
                    "live_reference_ledger": "ledger.json",
                    "source_response_cache_dir": "/cache",
                    "source_response_cache_identity": "cache-v1",
                    "browser_executable": "/usr/bin/google-chrome",
                    "candidate_public_port": 18560,
                }
            ),
            encoding="utf-8",
        )

    def test_the_retained_reference_resolves_relative_to_its_home(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            self.reference(home, b"{}")
            reference = promote.browser_reference(home)
            self.assertEqual(reference["ledger"], str(home / "ledger.json"))
            self.assertEqual(reference["policy"], str(home / "policy.json"))
            self.assertEqual(reference["candidate_port"], 18560)


class FramerailImageCheckTest(unittest.TestCase):
    def test_the_built_framerail_image_must_load_its_server_entry(self) -> None:
        with mock.patch.object(promote, "run_logged") as run_logged:
            promote.check_framerail_image_loads("image-id", Path("import.log"), Path("root"))
        args, log, cwd = run_logged.call_args.args
        self.assertEqual(
            args,
            [
                "docker", "run", "--rm", "--network", "none",
                "--entrypoint", "node", "image-id",
                "--input-type=module", "-e", 'await import("/app/server.ts")',
            ],
        )
        self.assertEqual(log, Path("import.log"))
        self.assertEqual(cwd, Path("root"))

    def test_an_image_that_cannot_load_its_server_entry_fails_the_stage(self) -> None:
        with mock.patch.object(promote, "run_logged", side_effect=RuntimeError("run failed")):
            with self.assertRaisesRegex(RuntimeError, "cannot load /app/server.ts"):
                promote.check_framerail_image_loads("image-id", Path("import.log"), Path("root"))


class FakeStanding:
    """Containers and calls of a standing runtime for `promote.activate`."""

    IDENTITY = {"wikijump_sha": "1" * 40, "wikijump_tree": "2" * 40, "ftml_sha": "3" * 40, "dependency_lock_sha256": "4" * 64}

    def __init__(self, home: Path):
        self.home = home
        (home / ".env").write_text(
            "STANDING_PROJECT_NAME=wikijump-standing\nSTANDING_NETWORK_NAME=net\n"
            "STANDING_DEEPWELL_IMAGE=sha256:" + "a" * 64 + "\n",
            encoding="utf-8",
        )
        self.calls: list[tuple] = []
        self.switched = False
        # Convergence fixtures for test_promote_catchup.py: staleness values
        # are consumed in order (the last one repeats), and the catch-up
        # primitives record into `calls` like every other fake step.
        self.stale_sequence: list[int] = [0]
        self.stale_page_ids: list[int] = []
        self.catch_up_reader_ids: list[int] = []
        self.known_reader_ids: list[int] = []
        self.link_digest_sequence: list[dict[str, str]] = [{}]
        self.recovery_probe_generator = "ftml v1; deepwell-render/v25"
        self.fail_next_delta_ids: list[int] = []
        self.link_digest_sleep = 0.0

    def containers(self, _home=None):
        generation = "new" if self.switched else "old"
        result = {}
        for index, service in enumerate(("deepwell", "framerail", "wws", "caddy")):
            image = ("b" if self.switched and service != "caddy" else "a") + str(index)
            result[service] = {
                "container_id": (generation if service != "caddy" else "old") + service,
                "image_id": "sha256:" + image * 32,
                "name": f"wikijump-standing-{service}-1",
                "running": True,
                "published_ports": [{"host_port": "443"}] if service == "caddy" else [],
            }
        return result

    def image(self, reference, _home=None):
        return {
            "reference": reference, "id": reference, "repo_digests": [],
            "labels": {
                "com.rokurolize.wikijump.sha": self.IDENTITY["wikijump_sha"],
                "com.rokurolize.wikijump.tree": self.IDENTITY["wikijump_tree"],
                "com.rokurolize.wikijump.ftml_sha": self.IDENTITY["ftml_sha"],
            },
        }

    def command(self, *args, cwd=None):
        self.calls.append(("command",) + args)
        if "--force-recreate" in args:
            self.switched = False
        elif "up" in args:
            self.switched = True
        return "config: {}"

    def _staleness(self, *args, **kwargs):
        self.calls.append(("staleness", self.switched, args[1] if len(args) > 1 else None))
        if len(self.stale_sequence) > 1:
            return self.stale_sequence.pop(0)
        return self.stale_sequence[0]

    def _render_delta(self, image, page_ids, log_path=None, **kwargs):
        ids = tuple(page_ids) if page_ids is not None else ()
        self.calls.append(("render-delta", image, ids, kwargs.get("dry_run", False)))
        generator = self.recovery_probe_generator if kwargs.get("dry_run") else "ftml v1; deepwell-render/v26"
        failed_ids: list[int] = []
        if self.fail_next_delta_ids and not kwargs.get("dry_run"):
            failed_ids, self.fail_next_delta_ids = self.fail_next_delta_ids, []
        return {
            "candidates": len(ids),
            "rendered": len(ids) - len(failed_ids),
            "failed": len(failed_ids), "failed_page_ids": failed_ids,
            "failures": [{"page_id": p, "error": "deadline has elapsed"} for p in failed_ids],
            "link_reader_page_ids": list(self.catch_up_reader_ids),
            "compiled_generator": generator,
        }

    def _link_digests(self, *args, **kwargs):
        if self.link_digest_sleep:
            time.sleep(self.link_digest_sleep)
        if len(self.link_digest_sequence) > 1:
            return self.link_digest_sequence.pop(0)
        return self.link_digest_sequence[0]

    def run(self, evidence: Path, render_ahead: dict, proof=None, *, missing_parked=False, gateway=None):
        new_images = {service: "sha256:" + ("b" + str(index)) * 32 for index, service in enumerate(("deepwell", "framerail", "wws"))}
        (evidence / "build").mkdir(parents=True, exist_ok=True)
        (evidence / "build" / "seal.json").write_text("{}", encoding="utf-8")
        patches = [
            mock.patch.object(promote.refresh, "runtime_containers", side_effect=self.containers),
            mock.patch.object(promote.refresh, "image_identity", side_effect=self.image),
            mock.patch.object(promote.refresh, "command", side_effect=self.command),
            mock.patch.object(promote.refresh, "wait_for_health", side_effect=lambda *a: (self.calls.append(("health",)), {s: "healthy" for s in promote.SERVICES})[1]),
            mock.patch.object(promote.refresh, "park_containers", side_effect=lambda previous, home, run_id: (self.calls.append(("park",)), {s: {"parked_name": f"parked-{s}"} for s in promote.SERVICES})[1]),
            mock.patch.object(promote.refresh, "restore_parked_containers", side_effect=(
                subprocess.CalledProcessError(1, ["docker", "inspect", "parked-deepwell"])
                if missing_parked else lambda parked, home: (
                    self.calls.append(("restore-parked",)), setattr(self, "switched", False)
                )[0]
            )),
            mock.patch.object(promote.refresh, "resource_exists", return_value=not missing_parked),
            mock.patch.object(promote, "reload_gateway", side_effect=gateway or (lambda: (self.calls.append(("gateway", self.switched)), {"status": "pass", "attempts": 1, "config_sha256": "5" * 64})[1])),
            mock.patch.object(promote, "saved_page_staleness", side_effect=self._staleness),
            mock.patch.object(promote, "saved_page_stale_ids", side_effect=lambda *a, **k: (self.calls.append(("stale-ids", a[1] if len(a) > 1 else None)), list(self.stale_page_ids))[1], create=True),
            mock.patch.object(promote, "render_delta_pages", side_effect=self._render_delta, create=True),
            mock.patch.object(promote, "restart_standing_deepwell", side_effect=lambda *a, **k: (self.calls.append(("restart-deepwell", self.switched)), {"deepwell": "healthy"})[1], create=True),
            mock.patch.object(promote, "database_clock", side_effect=lambda *a, **k: (self.calls.append(("db-clock",)), "2026-11-02 00:00:00+00")[1], create=True),
            mock.patch.object(promote, "mark_link_readers_stale", side_effect=lambda ids, *a, **k: self.calls.append(("mark-readers", tuple(ids))), create=True),
            mock.patch.object(promote.render_ahead, "link_digests", side_effect=self._link_digests),
            mock.patch.object(promote, "http_canary", side_effect=lambda *a, **k: (self.calls.append(("canary", self.switched)), {"url": "u", "status": "pass", "required_markers": ["scp-9506", "page-content"]})[1]),
            mock.patch.object(promote, "snapshot_saved_page_output", side_effect=lambda path: (self.calls.append(("snapshot",)), path.write_text("rows", encoding="utf-8"), 24573)[2]),
            mock.patch.object(promote, "restore_saved_page_output", side_effect=lambda path, generator, *a, **k: (self.calls.append(("restore-pages", generator, k.get("switch_started_at"))), 24573)[1]),
            mock.patch.object(promote, "browser_parity", side_effect=proof or (lambda *a: {"status": "pass"})),
            mock.patch.object(promote.subprocess, "run", side_effect=lambda args, **k: self.calls.append(("subprocess",) + tuple(args))),
        ]
        for patch in patches:
            patch.start()
        try:
            return promote.activate(
                Path(promote.__file__).parents[2], self.home, Path("/src/refresh.compose.yaml"), self.IDENTITY, evidence,
                promote.Stages(), new_images, render_ahead, {}, 1,
            )
        finally:
            for patch in reversed(patches):
                patch.stop()


GENERATION_CHANGE = {"status": "pass", "expected_compiled_generator": "ftml v1; deepwell-render/v26", "stale_pages_before": 24573, "receipt": {"path": "/r"}}
NO_RENDER = {"status": "not-needed", "expected_compiled_generator": "ftml v1; deepwell-render/v25", "stale_pages_before": 0}


class ActivationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        (self.root / "home").mkdir()
        self.standing = FakeStanding(self.root / "home")

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_a_passing_activation_removes_the_parked_containers(self) -> None:
        self.standing.run(self.root / "evidence", NO_RENDER)
        removed = [call for call in self.standing.calls if call[:3] == ("subprocess", "docker", "rm")]
        self.assertEqual([call[-1] for call in removed], [f"parked-{s}" for s in promote.SERVICES])
        self.assertNotIn(("snapshot",), self.standing.calls, "no generator change, nothing to keep")
        env = (self.standing.home / ".env").read_text(encoding="utf-8")
        self.assertIn("STANDING_WIKIJUMP_SHA=" + "1" * 40, env)

    def test_the_gateway_reloads_from_the_new_deepwell_before_the_standing_proof(self) -> None:
        order = []
        result = self.standing.run(
            self.root / "evidence", NO_RENDER,
            lambda *a: (order.extend(call[0] for call in self.standing.calls), {"status": "pass"})[1],
        )
        self.assertEqual(result["gateway"]["status"], "pass")
        self.assertIn(("gateway", True), self.standing.calls, "the gateway reloads after the new build starts")
        self.assertLess(order.index("health"), order.index("gateway"))
        self.assertIn("gateway", order, "the reload precedes the standing proof")

    def test_a_failed_gateway_reload_restores_the_old_runtime_and_reloads_it(self) -> None:
        def reload(standing=self.standing, attempts=[]):
            standing.calls.append(("gateway", standing.switched))
            attempts.append(standing.switched)
            if len(attempts) == 1:
                raise RuntimeError("standing Caddy did not load the Caddyfile Deepwell renders")
            return {"status": "pass", "attempts": 1, "config_sha256": "6" * 64}

        proof = mock.Mock(return_value={"status": "pass"})
        with self.assertRaisesRegex(RuntimeError, "activation failed .*did not load.*'status': 'pass'"):
            self.standing.run(self.root / "evidence", NO_RENDER, proof, gateway=reload)
        proof.assert_not_called()
        self.assertEqual(
            [call for call in self.standing.calls if call[0] == "gateway"],
            [("gateway", True), ("gateway", False)],
            "rollback reloads the gateway from the restored Deepwell",
        )

    def test_a_failed_standing_proof_restores_the_old_runtime_and_its_saved_pages(self) -> None:
        def failing_proof(*args):
            raise RuntimeError("parity differs")

        with self.assertRaisesRegex(RuntimeError, "activation failed .*parity differs.*'status': 'pass'"):
            self.standing.run(self.root / "evidence", GENERATION_CHANGE, failing_proof)
        names = [call[0] for call in self.standing.calls]
        self.assertLess(names.index("snapshot"), names.index("park"), "the snapshot precedes the switch")
        self.assertLess(names.index("restore-pages"), names.index("restore-parked"), "pages are put back before the old build starts")
        self.assertIn(("restore-pages", GENERATION_CHANGE["expected_compiled_generator"], "2026-11-02 00:00:00+00"), self.standing.calls)
        new_containers_removed = [call for call in self.standing.calls if call[:4] == ("subprocess", "docker", "rm", "--force")]
        self.assertEqual(len(new_containers_removed), 3)
        env = (self.standing.home / ".env").read_text(encoding="utf-8")
        self.assertIn("STANDING_DEEPWELL_IMAGE=sha256:" + "a0" * 32, env)
        self.assertNotIn("STANDING_WIKIJUMP_SHA=" + "1" * 40, env)

    def test_missing_parked_containers_rebuild_previous_images_after_failed_browser_proof(self) -> None:
        def failing_proof(*args):
            raise RuntimeError("Page.captureScreenshot failed")

        with self.assertRaisesRegex(
            RuntimeError, "activation failed .*captureScreenshot.*'status': 'pass'"
        ) as error:
            self.standing.run(
                self.root / "evidence", GENERATION_CHANGE, failing_proof,
                missing_parked=True,
            )
        self.assertIn("recreated-from-pinned-images", str(error.exception))
        self.assertFalse(self.standing.switched)
        commands = [call for call in self.standing.calls if call[0] == "command"]
        recovered = [call for call in commands if "--force-recreate" in call]
        self.assertEqual(len(recovered), 1)
        self.assertIn("--no-build", recovered[0])
        self.assertIn("--no-deps", recovered[0])
        self.assertNotIn("--volumes", recovered[0])
        self.assertNotIn("database", recovered[0])
        self.assertNotIn("caddy", recovered[0])
        self.assertIn(("restore-pages", GENERATION_CHANGE["expected_compiled_generator"], "2026-11-02 00:00:00+00"), self.standing.calls)
        env = (self.standing.home / ".env").read_text(encoding="utf-8")
        self.assertIn("STANDING_DEEPWELL_IMAGE=sha256:" + "a0" * 32, env)
        self.assertNotIn("STANDING_WIKIJUMP_SHA=" + "1" * 40, env)

    def test_a_standing_change_before_the_switch_touches_nothing(self) -> None:
        original = self.standing.containers

        def drifting(_home=None, calls=[0]):
            calls[0] += 1
            value = original()
            if calls[0] > 1:
                value["deepwell"]["container_id"] = "someone-else"
            return value

        self.standing.containers = drifting
        with self.assertRaisesRegex(RuntimeError, "standing changed"):
            self.standing.run(self.root / "evidence", NO_RENDER)
        self.assertNotIn(("park",), self.standing.calls)
        self.assertFalse(any(call[0] == "subprocess" for call in self.standing.calls))


class PromotionCheckoutTest(unittest.TestCase):
    def git(self, *args, cwd):
        return subprocess.run(["git", *args], cwd=cwd, check=True, text=True, capture_output=True).stdout.strip()

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        self.origin = root / "origin.git"
        self.repository = root / "repository"
        self.checkout = root / "state" / "promotion-checkout"
        self.git("init", "--quiet", "--bare", "--initial-branch=develop", str(self.origin), cwd=root)
        self.git("clone", "--quiet", str(self.origin), str(self.repository), cwd=root)
        for key, value in (("user.email", "test@example.invalid"), ("user.name", "Test")):
            self.git("config", key, value, cwd=self.repository)
        self.commit("first")

    def tearDown(self) -> None:
        self.directory.cleanup()

    def commit(self, text: str) -> str:
        (self.repository / "file.txt").write_text(text, encoding="utf-8")
        self.git("add", "file.txt", cwd=self.repository)
        self.git("commit", "--quiet", "-m", text, cwd=self.repository)
        self.git("push", "--quiet", "origin", "HEAD:develop", cwd=self.repository)
        return self.git("rev-parse", "HEAD", cwd=self.repository)

    def test_the_checkout_is_created_once_and_follows_origin_develop(self) -> None:
        promote.prepare_promotion_checkout(self.repository, self.checkout)
        first = self.git("rev-parse", "HEAD", cwd=self.checkout)
        second = self.commit("second")
        promote.prepare_promotion_checkout(self.repository, self.checkout)
        self.assertNotEqual(first, second)
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=self.checkout), second)

    def test_a_changed_checkout_is_refused_not_reset(self) -> None:
        promote.prepare_promotion_checkout(self.repository, self.checkout)
        (self.checkout / "file.txt").write_text("local edit", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "has local changes"):
            promote.prepare_promotion_checkout(self.repository, self.checkout)
        self.assertEqual((self.checkout / "file.txt").read_text(encoding="utf-8"), "local edit")

    def test_a_foreign_directory_is_refused(self) -> None:
        self.checkout.mkdir(parents=True)
        self.git("init", "--quiet", str(self.checkout), cwd=self.checkout.parent)
        with self.assertRaisesRegex(ValueError, "is not a worktree of"):
            promote.prepare_promotion_checkout(self.repository, self.checkout)

    def test_the_command_runs_from_the_promoted_source(self) -> None:
        own_root = Path(promote.__file__).resolve().parents[2]
        with mock.patch.object(promote.os, "execv") as execv:
            promote.run_from_source_root(own_root)
            execv.assert_not_called()
            with mock.patch.object(promote.sys, "argv", ["promote.py", "--rehearse", "always"]):
                promote.run_from_source_root(self.repository)
        executable, argv = execv.call_args.args
        self.assertEqual(argv[1], str(self.repository / "install" / "standing" / "promote.py"))
        self.assertEqual(argv[2:], ["--source-root", str(self.repository), "--rehearse", "always"])


class SavedPageStalenessTest(unittest.TestCase):
    def query(self, *args):
        with mock.patch.object(promote, "run", return_value="0") as run:
            promote.saved_page_staleness("db", "ftml v1; deepwell-render/v2", *args)
        return run.call_args.args[-1]

    def test_the_whole_site_is_counted_by_default(self) -> None:
        sql = self.query()
        self.assertIn("compiled_generator <> 'ftml v1; deepwell-render/v2'", sql)
        self.assertNotIn("p.slug IN", sql)

    def test_a_rehearsal_after_a_generator_change_counts_only_its_own_pages(self) -> None:
        sql = self.query(["scp-9506", "theme:it's"])
        self.assertIn("slug = 'scp-wiki'", sql)
        self.assertIn("p.slug IN ('scp-9506', 'theme:it''s')", sql)


class RehearsalObjectStoreTest(unittest.TestCase):
    def test_the_text_block_bucket_is_copied_into_the_upper_layer_read_only(self) -> None:
        with mock.patch.object(promote, "run", return_value="/mnt/x") as run:
            promote.overlay_standing_files("wjrehearsal-files", "wjrehearsal-files-upper")
        calls = [call.args for call in run.call_args_list]
        copy = next(args for args in calls if "cp" in args)
        self.assertIn("wikijump-standing-files-data:/lower:ro", copy)
        self.assertIn("wjrehearsal-files-upper:/upper", copy)
        self.assertEqual(copy[-3:], ("-a", "/lower/deepwell-text-blocks", "/upper/data/"))
        for args in calls:
            for value in args:
                if value.startswith("wikijump-standing-files-data:"):
                    self.assertTrue(value.endswith(":ro"), args)

    def missing(self, stored: list[str], named: str) -> list[str]:
        with tempfile.TemporaryDirectory() as root:
            for key in stored:
                path = Path(root, "deepwell-text-blocks", key)
                path.mkdir(parents=True)
                (path / "xl.meta").write_bytes(b"")

            real_run = subprocess.run

            def local_exec(command, **kwargs):
                script = command[-1].replace("/data/", f"{root}/")
                return real_run(["sh", "-c", script], **kwargs)

            with mock.patch.object(promote, "psql", return_value=named) as psql, \
                    mock.patch.object(promote.subprocess, "run", side_effect=local_exec) as run:
                result = promote.missing_text_blocks("rehearsal-database-1", "rehearsal-files-1")
        self.assertEqual(psql.call_args.args[0], "rehearsal-database-1")
        self.assertEqual(run.call_args.args[0][:4], ["docker", "exec", "-i", "rehearsal-files-1"])
        return result

    def test_every_named_text_block_present_is_not_missing(self) -> None:
        keys = ["3000000005_code_1", "text-blocks/3000000693/code/3693aa64"]
        self.assertEqual(self.missing(keys, "\n".join(keys) + "\n"), [])

    def test_text_blocks_deleted_after_the_clone_are_reported(self) -> None:
        named = "3000000005_code_1\ntext-blocks/3000000693/code/old-uuid\n"
        self.assertEqual(
            self.missing(["3000000005_code_1", "text-blocks/3000000693/code/new-uuid"], named),
            ["text-blocks/3000000693/code/old-uuid"],
        )

    def test_the_rehearsal_checks_its_text_blocks_before_parity(self) -> None:
        source = inspect.getsource(promote.rehearse)
        self.assertLess(
            source.index('missing_text_blocks(f"{project}-database-1", f"{project}-files-1")'),
            source.index("browser_parity("),
        )
        self.assertIn("the rehearsal object store lacks", source)


class GatewayReloadTest(unittest.TestCase):
    def test_the_cron_command_runs_as_the_cron_user_in_standing_caddy(self) -> None:
        with mock.patch.object(promote, "run", return_value=f"{'7' * 64} {'7' * 64}") as run:
            result = promote.reload_gateway()
        self.assertEqual(result, {"status": "pass", "attempts": 1, "config_sha256": "7" * 64})
        args = run.call_args.args
        self.assertEqual(args[:5], ("docker", "exec", "--user", "daemon", "wikijump-standing-caddy-1"))
        self.assertIn("/usr/local/bin/wikijump-update-caddyfile", args[-1])

    def test_a_loaded_config_that_differs_from_deepwell_fails(self) -> None:
        with mock.patch.object(promote, "run", return_value=f"{'7' * 64} {'8' * 64}"):
            with self.assertRaisesRegex(RuntimeError, "did not load the Caddyfile Deepwell renders"):
                promote.reload_gateway()

    def test_a_reload_that_keeps_failing_names_the_error(self) -> None:
        failure = subprocess.CalledProcessError(1, ["docker"], stderr="curl: (7) Failed to connect to deepwell\n")
        with mock.patch.object(promote, "run", side_effect=failure) as run, mock.patch.object(promote.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "gateway reload failed: curl: \\(7\\)"):
                promote.reload_gateway(attempts=3)
        self.assertEqual(run.call_count, 3)

    def test_a_reload_succeeds_once_deepwell_answers(self) -> None:
        failure = subprocess.CalledProcessError(1, ["docker"], stderr="curl: (7)\n")
        with mock.patch.object(promote, "run", side_effect=[failure, f"{'9' * 64} {'9' * 64}"]), mock.patch.object(promote.time, "sleep"):
            self.assertEqual(promote.reload_gateway()["attempts"], 2)


class ActivationSafetyTest(unittest.TestCase):
    def test_the_cli_has_no_volume_removal_spelling(self) -> None:
        script = Path(promote.__file__)
        for forbidden in ("-v", "--volumes", "--remove-volumes"):
            with self.subTest(forbidden=forbidden):
                result = subprocess.run(
                    (sys.executable, str(script), forbidden), text=True, capture_output=True
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unrecognized arguments", result.stderr)

    def test_activation_starts_built_images_without_building_or_touching_volumes(self) -> None:
        source = inspect.getsource(promote.activate)
        self.assertIn('"up", "--detach", "--no-deps", "--no-build", *SERVICES', source)
        self.assertNotIn("docker\", \"build", source)
        self.assertNotIn('"down"', source)
        self.assertNotIn("--volumes", source)

    def test_activation_requires_fresh_saved_pages_before_the_canary(self) -> None:
        # The freshness check moved into converge_saved_pages (bounded
        # catch-up loop); activation must still converge before the canary
        # and keep the historical stale failure.
        source = inspect.getsource(promote.activate)
        self.assertLess(
            source.index("converge_saved_pages("),
            source.index("http_canary(refresh.CANARY_URL)"),
        )
        self.assertIn(
            "standing serves {stale} stale saved pages",
            inspect.getsource(promote.converge_saved_pages),
        )

    def test_rehearsal_teardown_only_names_rehearsal_resources(self) -> None:
        source = inspect.getsource(promote.rehearse)
        self.assertIn('project = f"wjcand-rehearsal-{target[:12]}"', source)
        self.assertIn('"down", "--volumes"', source)
        self.assertNotIn("wikijump-standing", source)


class LiveMigrationTest(unittest.TestCase):
    CANDIDATE = ["20260101000000_init.sql", "20261104010000_user_mfa_last_totp_step.sql"]

    def source_root(self, directory: Path) -> Path:
        migrations = directory / "deepwell" / "migrations"
        migrations.mkdir(parents=True)
        for name in self.CANDIDATE:
            (migrations / name).write_text("SELECT 1;\n", encoding="utf-8")
        (migrations / "notes.txt").write_text("not a migration\n", encoding="utf-8")
        return directory

    def test_pending_migrations_are_the_unrecorded_versions_in_apply_order(self) -> None:
        pending = promote.pending_migration_files(
            list(reversed(self.CANDIDATE)), {20260101000000}
        )
        self.assertEqual(pending, ["20261104010000_user_mfa_last_totp_step.sql"])
        self.assertEqual(promote.pending_migration_files(self.CANDIDATE, set()), self.CANDIDATE)
        self.assertEqual(
            promote.pending_migration_files(
                self.CANDIDATE, {20260101000000, 20261104010000}
            ),
            [],
        )

    def test_a_migration_filename_without_a_version_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "not a Deepwell migration filename"):
            promote.migration_version("user_mfa.sql")

    def test_candidate_files_are_the_sql_files_of_the_migrations_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.source_root(Path(directory))
            self.assertEqual(promote.candidate_migration_files(root), self.CANDIDATE)

    def test_applied_versions_come_from_the_sqlx_bookkeeping_table(self) -> None:
        with mock.patch.object(
            promote, "psql", side_effect=["t\n", "20260101000000\n20261104010000\n"]
        ) as psql:
            applied = promote.applied_migration_versions("db")
        self.assertEqual(applied, {20260101000000, 20261104010000})
        self.assertIn("_sqlx_migrations", psql.call_args_list[1].args[1])

    def test_applied_versions_are_empty_until_sqlx_creates_its_table(self) -> None:
        with mock.patch.object(promote, "psql", return_value="f\n") as psql:
            self.assertEqual(promote.applied_migration_versions("db"), set())
        self.assertEqual(psql.call_count, 1)

    def run_live_migration(self, root: Path, applied_sequence, run_logged):
        patches = [
            mock.patch.object(
                promote, "applied_migration_versions", side_effect=applied_sequence
            ),
            mock.patch.object(
                promote.render_ahead, "container_inspect", return_value={}
            ),
            mock.patch.object(
                promote.render_ahead,
                "runtime_environment",
                return_value={"DATABASE_URL": "postgres://standing"},
            ),
            mock.patch.object(promote, "run_logged", side_effect=run_logged),
        ]
        for patch in patches:
            patch.start()
        try:
            return promote.apply_live_migrations(
                "candidate-image", root, root / "live-migration.log"
            )
        finally:
            for patch in reversed(patches):
                patch.stop()

    def test_no_pending_migrations_is_a_noop_that_runs_no_container(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.source_root(Path(directory))
            run_logged = mock.Mock(side_effect=AssertionError("no container may run"))
            with mock.patch.object(
                promote,
                "applied_migration_versions",
                return_value={20260101000000, 20261104010000},
            ):
                result = promote.apply_live_migrations(
                    "candidate-image", root, root / "live-migration.log"
                )
        self.assertEqual(result, {"status": "no-op", "pending": [], "applied": []})
        run_logged.assert_not_called()

    def test_pending_migrations_run_the_candidate_images_own_sqlx(self) -> None:
        seen = {}

        def fake_run_logged(args, log, cwd):
            seen["args"] = args
            env_path = Path(args[args.index("--env-file") + 1])
            seen["env"] = env_path.read_text(encoding="utf-8")
            seen["env_path"] = env_path
            return ""

        with tempfile.TemporaryDirectory() as directory:
            root = self.source_root(Path(directory))
            result = self.run_live_migration(
                root,
                [{20260101000000}, {20260101000000, 20261104010000}],
                fake_run_logged,
            )
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["applied"], ["20261104010000_user_mfa_last_totp_step.sql"])
        args = seen["args"]
        self.assertEqual(args[:3], ["docker", "run", "--rm"])
        self.assertIn(f"container:{promote.STANDING_DEEPWELL}", args)
        self.assertEqual(args[args.index("--entrypoint") + 1], promote.SQLX_BINARY)
        self.assertEqual(args[args.index("candidate-image") + 1:], ["migrate", "run", "--source", promote.MIGRATIONS_IN_IMAGE])
        self.assertIn("DATABASE_URL=postgres://standing", seen["env"])
        self.assertFalse(seen["env_path"].exists(), "the env file is removed after the run")

    def test_a_failed_migration_run_fails_the_stage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.source_root(Path(directory))
            with self.assertRaisesRegex(RuntimeError, "applying the candidate migrations"):
                self.run_live_migration(
                    root,
                    [{20260101000000}],
                    mock.Mock(side_effect=RuntimeError("run failed")),
                )

    def test_migrations_still_pending_after_the_run_fail_the_stage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.source_root(Path(directory))
            with self.assertRaisesRegex(RuntimeError, "still missing migrations"):
                self.run_live_migration(
                    root,
                    [{20260101000000}, {20260101000000}],
                    lambda *a: "",
                )

    def test_a_changed_migration_with_none_pending_still_runs_sqlx(self) -> None:
        run_logged = mock.Mock(return_value="")
        with tempfile.TemporaryDirectory() as directory:
            root = self.source_root(Path(directory))
            patches = [
                mock.patch.object(
                    promote,
                    "applied_migration_versions",
                    return_value={20260101000000, 20261104010000},
                ),
                mock.patch.object(promote.render_ahead, "container_inspect", return_value={}),
                mock.patch.object(
                    promote.render_ahead,
                    "runtime_environment",
                    return_value={"DATABASE_URL": "postgres://standing"},
                ),
                mock.patch.object(promote, "run_logged", run_logged),
            ]
            for patch in patches:
                patch.start()
            try:
                result = promote.apply_live_migrations(
                    "candidate-image", root, root / "live-migration.log",
                    [f"deepwell/migrations/{self.CANDIDATE[0]}"],
                )
            finally:
                for patch in reversed(patches):
                    patch.stop()
        self.assertEqual(result["status"], "pass")
        run_logged.assert_called_once()

    def test_live_migration_runs_after_the_rehearsal_and_before_render_ahead(self) -> None:
        source = inspect.getsource(promote.finish)
        rehearsal = source.index("\n        rehearsal_stage()\n")
        live = source.index('stages.run("live-migration", live_migration_stage)')
        ahead = source.index('stages.run("render-ahead", render_stage)')
        self.assertLess(rehearsal, live)
        self.assertLess(live, ahead)
        self.assertNotIn("ThreadPoolExecutor", source)



if __name__ == "__main__":
    unittest.main()


class DeepwellClonePauseTest(unittest.TestCase):
    def run_fake(self):
        calls = []

        def fake_run(*args):
            calls.append(args)
            if args[:2] == ("docker", "inspect"):
                return "false true"
            return ""

        return calls, fake_run

    def test_the_pause_wraps_the_body_and_resumes(self) -> None:
        calls, fake_run = self.run_fake()
        with mock.patch.object(promote, "run", side_effect=fake_run), \
                mock.patch.object(promote, "deepwell_log_lines", return_value=0), \
                mock.patch.object(promote.time, "sleep"):
            with promote.deepwell_paused_for_clone():
                calls.append(("body",))
        kinds = [call[:2] for call in calls]
        self.assertLess(kinds.index(("docker", "pause")), kinds.index(("body",)))
        self.assertLess(kinds.index(("body",)), kinds.index(("docker", "unpause")))

    def test_the_pause_resumes_even_when_the_clone_fails(self) -> None:
        calls, fake_run = self.run_fake()
        with mock.patch.object(promote, "run", side_effect=fake_run), \
                mock.patch.object(promote, "deepwell_log_lines", return_value=0), \
                mock.patch.object(promote.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "clone failed"):
                with promote.deepwell_paused_for_clone():
                    raise RuntimeError("clone failed")
        self.assertIn(("docker", "unpause", promote.STANDING_DEEPWELL), calls)

    def test_a_deepwell_that_keeps_logging_while_paused_is_refused(self) -> None:
        calls, fake_run = self.run_fake()
        with mock.patch.object(promote, "run", side_effect=fake_run), \
                mock.patch.object(promote, "deepwell_log_lines", side_effect=[3, 4]), \
                mock.patch.object(promote.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "kept logging"):
                with promote.deepwell_paused_for_clone():
                    pass
        self.assertIn(("docker", "unpause", promote.STANDING_DEEPWELL), calls)

    def test_the_clone_stage_clones_under_the_pause(self) -> None:
        source = inspect.getsource(promote.promote)
        clone = source.index("def clone_stage")
        body = source[clone:clone + 500]
        self.assertIn("with deepwell_paused_for_clone():", body)
        self.assertLess(body.index("deepwell_paused_for_clone"), body.index("clone_standing_database"))
        self.assertLess(body.index("deepwell_paused_for_clone"), body.index("overlay_standing_files"))

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "roll-stafflab.py"
SPEC = importlib.util.spec_from_file_location("roll_stafflab", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ROLL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ROLL)


def digest(character: str) -> str:
    return "sha256:" + character * 64


IMAGES = {
    "cache": digest("1"),
    "caddy": digest("2"),
    "database": digest("3"),
    "deepwell": digest("4"),
    "files": digest("5"),
    "framerail": digest("6"),
    "wws": digest("7"),
}
WIKIJUMP_SHA = "a" * 40
FTML_SHA = "b" * 40


def manifest_json(images: dict[str, str]) -> str:
    return json.dumps(
        [{"role": role, "image_id": image_id} for role, image_id in images.items()]
    )


def environment(images: dict[str, str]) -> dict[str, str]:
    return {
        "STANDING_PROJECT_NAME": "wikijump-stafflab",
        "STANDING_DATABASE_IMAGE": images["database"],
        "STANDING_DEEPWELL_IMAGE": images["deepwell"],
        "STANDING_FRAMERAIL_IMAGE": images["framerail"],
        "STANDING_WWS_IMAGE": images["wws"],
        "STANDING_WIKIJUMP_SHA": WIKIJUMP_SHA,
        "STANDING_FTML_SHA": FTML_SHA,
    }


class RollStafflabTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_read_manifest_from_promotion_run_directory(self) -> None:
        manifest = self.root / "build" / "images" / "final-images.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(manifest_json(IMAGES), encoding="utf-8")
        self.assertEqual(ROLL.read_manifest(self.root), IMAGES)

    def test_read_manifest_from_file(self) -> None:
        manifest = self.root / "final-images.json"
        manifest.write_text(manifest_json(IMAGES), encoding="utf-8")
        self.assertEqual(ROLL.read_manifest(manifest), IMAGES)

    def test_read_manifest_rejects_missing_role(self) -> None:
        incomplete = {role: image for role, image in IMAGES.items() if role != "wws"}
        manifest = self.root / "final-images.json"
        manifest.write_text(manifest_json(incomplete), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "no wws image"):
            ROLL.read_manifest(self.root)

    def test_read_manifest_rejects_mutable_reference(self) -> None:
        broken = dict(IMAGES)
        broken["deepwell"] = "wikijump/deepwell:latest"
        manifest = self.root / "final-images.json"
        manifest.write_text(manifest_json(broken), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "invalid final-images.json entry"):
            ROLL.read_manifest(self.root)

    def test_database_pin_mismatch_refuses(self) -> None:
        env = environment(IMAGES)
        other = dict(IMAGES)
        other["database"] = digest("9")
        with self.assertRaisesRegex(ValueError, "database image"):
            ROLL.check_database_pin(env, other)
        ROLL.check_database_pin(env, IMAGES)

    def test_pin_updates_cover_exactly_the_roll_keys(self) -> None:
        updates = ROLL.pin_updates(
            IMAGES, {"wikijump_sha": WIKIJUMP_SHA, "ftml_sha": FTML_SHA}
        )
        self.assertEqual(
            updates,
            {
                "STANDING_DEEPWELL_IMAGE": IMAGES["deepwell"],
                "STANDING_FRAMERAIL_IMAGE": IMAGES["framerail"],
                "STANDING_WWS_IMAGE": IMAGES["wws"],
                "STANDING_WIKIJUMP_SHA": WIKIJUMP_SHA,
                "STANDING_FTML_SHA": FTML_SHA,
            },
        )

    def test_pin_changes_empty_when_already_on_the_build(self) -> None:
        updates = ROLL.pin_updates(
            IMAGES, {"wikijump_sha": WIKIJUMP_SHA, "ftml_sha": FTML_SHA}
        )
        self.assertEqual(ROLL.pin_changes(environment(IMAGES), updates), [])

    def test_pin_changes_lists_only_differing_keys(self) -> None:
        env = environment(IMAGES)
        updates = ROLL.pin_updates(
            IMAGES, {"wikijump_sha": "c" * 40, "ftml_sha": FTML_SHA}
        )
        updates["STANDING_WWS_IMAGE"] = digest("8")
        self.assertEqual(
            ROLL.pin_changes(env, updates),
            [
                ("STANDING_WIKIJUMP_SHA", WIKIJUMP_SHA, "c" * 40),
                ("STANDING_WWS_IMAGE", IMAGES["wws"], digest("8")),
            ],
        )

    def fake_identity(self, shas: dict[str, str]):
        def image_identity(reference: str, cwd: Path) -> dict[str, object]:
            role = next(role for role, image in IMAGES.items() if image == reference)
            return {
                "reference": reference,
                "id": reference,
                "repo_digests": [],
                "labels": {
                    "com.rokurolize.wikijump.sha": shas[role],
                    "com.rokurolize.wikijump.ftml_sha": FTML_SHA,
                },
            }

        return image_identity

    def test_build_identity_reads_the_agreed_head(self) -> None:
        shas = {role: WIKIJUMP_SHA for role in ROLL.APP_ROLES}
        with mock.patch.object(
            ROLL.refresh, "image_identity", self.fake_identity(shas)
        ):
            self.assertEqual(
                ROLL.build_identity(IMAGES, self.root),
                {"wikijump_sha": WIKIJUMP_SHA, "ftml_sha": FTML_SHA},
            )

    def test_build_identity_rejects_disagreeing_images(self) -> None:
        shas = {role: WIKIJUMP_SHA for role in ROLL.APP_ROLES}
        shas["wws"] = "c" * 40
        with mock.patch.object(
            ROLL.refresh, "image_identity", self.fake_identity(shas)
        ):
            with self.assertRaisesRegex(ValueError, "disagree on their source head"):
                ROLL.build_identity(IMAGES, self.root)

    def make_repository(self) -> tuple[Path, str, str]:
        repo = self.root / "repo"
        repo.mkdir()
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "roll-stafflab test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "roll-stafflab test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        }

        def git(*args: str) -> str:
            result = subprocess.run(
                ["git", "-C", str(repo), *args],
                check=True,
                capture_output=True,
                text=True,
                env=env,
            )
            return result.stdout.strip()

        git("init", "--quiet")
        (repo / "page.txt").write_text("one\n", encoding="utf-8")
        git("add", ".")
        git("commit", "--quiet", "-m", "one")
        first = git("rev-parse", "HEAD")
        (repo / "page.txt").write_text("two\n", encoding="utf-8")
        git("add", ".")
        git("commit", "--quiet", "-m", "two")
        second = git("rev-parse", "HEAD")
        return repo, first, second

    def test_descent_allows_forward_and_equal_heads(self) -> None:
        repo, first, second = self.make_repository()
        ROLL.check_descent(repo, first, second, allow_downgrade=False)
        ROLL.check_descent(repo, second, second, allow_downgrade=False)

    def test_descent_refuses_a_backward_roll_unless_forced(self) -> None:
        repo, first, second = self.make_repository()
        with self.assertRaisesRegex(ValueError, "refusing to roll stafflab backward"):
            ROLL.check_descent(repo, second, first, allow_downgrade=False)
        ROLL.check_descent(repo, second, first, allow_downgrade=True)


if __name__ == "__main__":
    unittest.main()

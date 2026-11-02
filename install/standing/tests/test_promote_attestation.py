from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1]))
import promote  # noqa: E402


HEAD = "a" * 40
TREE = "b" * 40
NOTHING = {group: False for group in promote.GROUPS}


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


class CompositionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        git(self.repo, "init", "-b", "main")
        git(self.repo, "config", "user.email", "test@example.invalid")
        git(self.repo, "config", "user.name", "Test")
        git(self.repo, "commit", "--allow-empty", "-m", "base")
        self.base = git(self.repo, "rev-parse", "HEAD")

    def commit(self, message: str) -> str:
        git(self.repo, "commit", "--allow-empty", "-m", message)
        return git(self.repo, "rev-parse", "HEAD")

    def test_merge_and_pr_associated_commits_pass_plain_ones_fail(self) -> None:
        git(self.repo, "switch", "-c", "feature")
        self.commit("branch work")
        git(self.repo, "switch", "main")
        git(self.repo, "merge", "--no-ff", "-m", "merge the feature PR", "feature")
        associated = self.commit("squash-merged PR work")
        plain = self.commit("direct push, no PR")
        head = git(self.repo, "rev-parse", "HEAD")

        def pulls(sha: str):
            if sha == associated:
                return [{"number": 1, "merged_at": "2026-11-01T00:00:00Z"}]
            return []

        result = promote.merged_pr_composition(self.repo, self.base, head, pulls)
        self.assertEqual(result["commits"], 3)
        self.assertEqual(result["merge_commits"], 1)
        self.assertEqual(result["pr_associated"], 1)
        self.assertEqual(result["offenders"], [plain])

    def test_unavailable_gh_leaves_plain_commits_as_offenders(self) -> None:
        plain = self.commit("direct push, no PR")
        result = promote.merged_pr_composition(
            self.repo, self.base, plain, lambda sha: None
        )
        self.assertEqual(result["offenders"], [plain])


def attestation(checks: list[dict[str, str]], **overrides) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": promote.ATTESTATION_SCHEMA,
        "wikijump_commit": HEAD,
        "wikijump_tree": TREE,
        "checks": checks,
    }
    value.update(overrides)
    return value


def entry(area: str, kind: str = "github-actions", conclusion: str = "success"):
    return {
        "area": area,
        "kind": kind,
        "reference": "https://example.invalid/run/1",
        "conclusion": conclusion,
    }


class VerifyAttestationTest(unittest.TestCase):
    def required(self, *groups: str) -> dict[str, bool]:
        return {**NOTHING, **{group: True for group in groups}}

    def test_covers_required_groups(self) -> None:
        result = promote.verify_attestation(
            attestation([entry("deepwell"), entry("theme_lab", kind="local")]),
            HEAD,
            TREE,
            self.required("deepwell", "theme_lab"),
        )
        self.assertEqual(result["errors"], [])
        self.assertEqual(set(result["covered"]), {"deepwell", "theme_lab"})

    def test_theme_lab_evidence_must_be_local(self) -> None:
        result = promote.verify_attestation(
            attestation([entry("theme_lab", kind="github-actions")]),
            HEAD,
            TREE,
            self.required("theme_lab"),
        )
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("theme_lab", result["errors"][0])

    def test_wrong_tree_and_missing_group_are_errors(self) -> None:
        result = promote.verify_attestation(
            attestation([entry("deepwell")], wikijump_tree="c" * 40),
            HEAD,
            TREE,
            self.required("deepwell", "wws"),
        )
        self.assertEqual(len(result["errors"]), 2)

    def test_failed_conclusion_does_not_cover(self) -> None:
        result = promote.verify_attestation(
            attestation([entry("deepwell", conclusion="failure")]),
            HEAD,
            TREE,
            self.required("deepwell"),
        )
        self.assertEqual(len(result["errors"]), 1)


class AttestationValidationTest(unittest.TestCase):
    def test_end_to_end_and_missing_attestation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            git(repo, "init", "-b", "main")
            git(repo, "config", "user.email", "test@example.invalid")
            git(repo, "config", "user.name", "Test")
            git(repo, "commit", "--allow-empty", "-m", "base")
            base = git(repo, "rev-parse", "HEAD")
            git(repo, "switch", "-c", "feature")
            git(repo, "commit", "--allow-empty", "-m", "work")
            git(repo, "switch", "main")
            git(repo, "merge", "--no-ff", "-m", "merge the PR", "feature")
            head = git(repo, "rev-parse", "HEAD")
            tree = git(repo, "rev-parse", "HEAD^{tree}")
            store = root / "store"
            store.mkdir()

            with self.assertRaises(ValueError):
                promote.attestation_validation(repo, store, base, head, tree, NOTHING)

            path = promote.attestation_path(store, head)
            path.write_text(
                json.dumps(
                    {
                        "schema": promote.ATTESTATION_SCHEMA,
                        "wikijump_commit": head,
                        "wikijump_tree": tree,
                        "checks": [entry("deepwell")],
                    }
                ),
                encoding="utf-8",
            )
            result = promote.attestation_validation(
                repo, store, base, head, tree, {**NOTHING, "deepwell": True}
            )
            self.assertEqual(result["mode"], "attestation")
            self.assertEqual(result["composition"]["offenders"], [])
            self.assertIn("deepwell", result["covered"])


if __name__ == "__main__":
    unittest.main()

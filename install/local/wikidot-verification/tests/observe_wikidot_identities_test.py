import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "observe_wikidot_identities.py"
SPEC = importlib.util.spec_from_file_location("observe_wikidot_identities", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

NAMES = ["JakdragonX", "IronDruid", "Lt Flops", "definitely not a real user zzqq", "Jerden"]
BODY = """

<p><span class="printuser"><a href="https://www.wikidot.com/user:info/jakdragonx" onclick="WIKIDOT.page.listeners.userInfo(5588260); return false;">JakdragonX</a></span><br />
<span class="printuser"><a href="https://www.wikidot.com/user:info/irondruid" onclick="WIKIDOT.page.listeners.userInfo(4982339); return false;">IronDruid</a></span><br />
<span class="printuser"><a href="https://www.wikidot.com/user:info/lt-flops" onclick="WIKIDOT.page.listeners.userInfo(1735419); return false;">Lt Flops</a></span><br />
<span class="error-inline"><em>definitely not a real user zzqq</em> does not match any existing user name</span><br />
<span class="printuser"><a href="https://www.wikidot.com/user:info/jerden" onclick="WIKIDOT.page.listeners.userInfo(1637608); return false;">Jerden</a></span></p>"""


class ObserveWikidotIdentitiesTest(unittest.TestCase):
    def test_parse_batch_returns_one_result_per_name_in_order(self):
        results = MODULE.parse_batch(NAMES, BODY)
        self.assertEqual([r["requested"] for r in results], NAMES)
        self.assertEqual(results[0], {"requested": "JakdragonX", "status": "resolved", "user_id": 5588260,
                                      "slug": "jakdragonx", "name": "JakdragonX"})
        self.assertEqual(results[2]["slug"], "lt-flops")
        self.assertEqual(results[2]["name"], "Lt Flops")
        self.assertEqual(results[3], {"requested": "definitely not a real user zzqq", "status": "unresolved"})

    def test_parse_batch_fails_closed_when_lines_do_not_line_up(self):
        with self.assertRaisesRegex(ValueError, "4 lines for 5 names"):
            MODULE.parse_batch(NAMES, BODY.replace('<span class="printuser"><a href="https://www.wikidot.com/user:info/jerden" onclick="WIKIDOT.page.listeners.userInfo(1637608); return false;">Jerden</a></span>', "").replace("<br />\n</p>", "</p>"))
        with self.assertRaisesRegex(ValueError, "unrecognized result"):
            MODULE.parse_batch(["x"], "<p><span class=\"printuser deleted\">gone</span></p>")

    def test_reserved_names_printed_as_plain_text_are_not_identities(self):
        results = MODULE.parse_batch(["Anonymous", "Jerden"], "<p>Anonymous<br />\n" + BODY.split("<br />\n")[-1])
        self.assertEqual(results[0], {"requested": "Anonymous", "status": "special"})
        self.assertEqual(results[1]["user_id"], 1637608)
        self.assertEqual(MODULE.observations([{"batch": 1, "site": "scp-wiki", "names": ["Anonymous"],
                                               "raw_html": "<p>Anonymous</p>", "raw_html_sha256": "", "captured_at": "x"}]),
                         ([], []))

    def test_deleted_accounts_are_reported_not_recorded(self):
        body = ('<p><span class="printuser deleted" data-id="45294"><img class="small" '
                'src="https://www.wikidot.com/common--images/avatars/default/a16.png" alt="" />(account deleted)</span></p>')
        self.assertEqual(MODULE.parse_batch(["user deleted"], body),
                         [{"requested": "user deleted", "status": "deleted", "user_id": 45294}])
        batch = {"batch": 1, "site": "scp-wiki", "names": ["user deleted"], "raw_html": body,
                 "raw_html_sha256": MODULE.sha256_hex(body), "captured_at": "x"}
        self.assertEqual(MODULE.observations([batch]), ([], []))
        self.assertEqual(MODULE.summarize([batch]), {"deleted": 1})

    def test_observations_keep_one_row_per_user_and_refuse_wikijump_ids(self):
        batch = {"batch": 1, "site": "scp-wiki", "names": NAMES, "raw_html": BODY,
                 "raw_html_sha256": MODULE.sha256_hex(BODY), "captured_at": "2026-10-19T00:00:00+00:00"}
        rows, unresolved = MODULE.observations([batch, {**batch, "batch": 2}])
        self.assertEqual([r["user_id"] for r in rows], [1637608, 1735419, 4982339, 5588260])
        self.assertEqual(rows[0]["source_reference"].split(", ")[-1], "identity batch 0001)")
        self.assertEqual(unresolved, ["definitely not a real user zzqq"] * 2)
        high = BODY.replace("userInfo(1637608)", "userInfo(20000001)")
        with self.assertRaisesRegex(ValueError, "outside the Wikidot id range"):
            MODULE.observations([{**batch, "raw_html": high, "raw_html_sha256": MODULE.sha256_hex(high)}])

    def test_build_sql_is_one_idempotent_transaction_with_quoted_values(self):
        sql = MODULE.build_sql([{"user_id": 7, "name": "O'Neil", "slug": "o-neil", "source_sha256": "ab" * 32,
                                 "observed_at": "2026-10-19T00:00:00+00:00", "source_reference": "ref"}])
        self.assertTrue(sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;"))
        self.assertIn("INSERT INTO known_user(user_id) VALUES(7) ON CONFLICT DO NOTHING;", sql)
        self.assertIn("'O''Neil'", sql)
        self.assertEqual(sql.count("ON CONFLICT DO NOTHING"), 2)

    def test_collect_names_dedupes_case_and_orders_by_frequency(self):
        with tempfile.TemporaryDirectory() as directory:
            pages = Path(directory) / "en" / "pages"
            for slug, text in {
                "a": "[[user Alice]] [[*user bob]] [[user  Alice ]]",
                "b": "[[user alice]] x [[user Carol]]\n[[user Dave|x]]",
                "c": "no users",
            }.items():
                (pages / slug).mkdir(parents=True)
                (pages / slug / "source.wikidot.txt").write_text(text, encoding="utf-8")
            self.assertEqual(MODULE.collect_names(Path(directory), "en"), ["Alice", "bob", "Carol"])

    def test_load_batches_rejects_tampered_response(self):
        with tempfile.TemporaryDirectory() as directory:
            record = {"schema": MODULE.SCHEMA, "batch": 1, "site": "scp-wiki", "names": NAMES, "raw_html": BODY,
                      "raw_html_sha256": MODULE.sha256_hex(BODY), "captured_at": "x"}
            (Path(directory) / "batch-0001.json").write_text(json.dumps(record), encoding="utf-8")
            self.assertEqual(len(MODULE.load_batches(Path(directory))), 1)
            record["raw_html"] = BODY + " "
            (Path(directory) / "batch-0001.json").write_text(json.dumps(record), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "does not match its recorded digest"):
                MODULE.load_batches(Path(directory))


if __name__ == "__main__":
    unittest.main()

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import importlib.util

SCRIPT = Path(__file__).parents[1] / "ports" / "scripts" / "freeze-css.py"
SPEC = importlib.util.spec_from_file_location("freeze_css", SCRIPT)
freeze_css = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(freeze_css)


class PlainTextImportedCssTests(unittest.TestCase):
    def test_generated_transport_whitespace_preserves_css_strings(self):
        self.assertEqual(
            freeze_css.normalize_css_transport('/* theme\'s code */  \r\n.a { color: red; }\t\r\n.b { content: "a b "; }\r\n'),
            '/* theme\'s code */\n.a { color: red; }\n.b { content: "a b "; }\n',
        )

    def test_wikidot_text_plain_css_import_is_flattened(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root / "cache"
            digest = hashlib.sha256(b".legacy { color: #123; }").hexdigest()
            object_path = cache / "objects" / digest[:2] / digest
            object_path.parent.mkdir(parents=True)
            object_path.write_bytes(b".legacy { color: #123; }")
            (cache / "manifest.json").write_text(json.dumps({"urls": {"https://local.invalid/theme-code": {"digest": digest}}, "objects": {digest: {"content_type": "text/plain"}}}))
            engine = freeze_css.CacheCSS(cache, root / "assets")
            css, manifest = engine.build('@import url("https://local.invalid/theme-code");', "https://local.invalid/page")
            self.assertIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance"][0]["source_url"], "https://local.invalid/theme-code")
            self.assertEqual(manifest["import_provenance"][0]["sha256"], digest)
            self.assertEqual(manifest["import_provenance"][0]["content_type"], "text/plain")
            self.assertEqual(manifest["import_provenance"][0]["provenance_basis"], "frozen-cache-exact-at-build")
            self.assertEqual(manifest["import_provenance_status"], "complete")
            self.assertEqual((root / "assets" / f"{digest}.css").read_bytes(), b".legacy { color: #123; }")

    def test_exact_localization_transform_is_recorded(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root / "cache"
            (cache / "manifest.json").parent.mkdir(parents=True)
            (cache / "manifest.json").write_text(json.dumps({"urls": {}, "objects": {}}))
            engine = freeze_css.CacheCSS(
                cache,
                root / "assets",
                transforms=[{
                    "id": "jp-title-contrast",
                    "reason": "JP title needs the light token on the dark surface.",
                    "before": "#page-title { color: dark; }",
                    "after": "#page-title { color: light; }",
                    "expected_matches": 1,
                }],
            )
            css, manifest = engine.build("#page-title { color: dark; }", "https://local.invalid/page")
            self.assertEqual(css, "#page-title { color: light; }")
            self.assertEqual(manifest["localization_transforms"][0]["id"], "jp-title-contrast")
            self.assertEqual(manifest["localization_transforms"][0]["matches"], 1)

    def test_simple_import_at_eof_is_frozen_without_a_semicolon(self):
        for text in ['@import url("https://local.invalid/theme-code")',
                     "@import 'https://local.invalid/theme-code'\n"]:
            with self.subTest(text=text), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                cache = root / 'cache'
                body = b'.theme { color: #123; }'
                digest = hashlib.sha256(body).hexdigest()
                target = cache / 'objects' / digest[:2] / digest
                target.parent.mkdir(parents=True)
                target.write_bytes(body)
                (cache / 'manifest.json').write_text(json.dumps({'urls': {'https://local.invalid/theme-code': {'digest': digest}}, 'objects': {digest: {'content_type': 'text/css'}}}))
                css, manifest = freeze_css.CacheCSS(cache, root / 'assets').build(text, 'https://local.invalid/page')
                self.assertIn('.theme { color: #123; }', css)
                self.assertNotIn('@import', css)
                self.assertEqual(manifest['missing'], [])
                self.assertEqual(manifest['import_provenance'][0]['sha256'], digest)

    def test_localization_transform_fails_closed_when_anchor_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root / "cache"
            (cache / "manifest.json").parent.mkdir(parents=True)
            (cache / "manifest.json").write_text(json.dumps({"urls": {}, "objects": {}}))
            engine = freeze_css.CacheCSS(
                cache,
                root / "assets",
                transforms=[{
                    "id": "jp-title-contrast",
                    "reason": "JP title needs the light token on the dark surface.",
                    "before": "#page-title { color: dark; }",
                    "after": "#page-title { color: light; }",
                }],
            )
            with self.assertRaisesRegex(RuntimeError, "requires review"):
                engine.build("#page-title { color: changed-upstream; }", "https://local.invalid/page")

    def test_plain_text_prose_is_not_accepted_as_css(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cache = root / "cache"
            body = b"No such page"
            digest = hashlib.sha256(body).hexdigest()
            object_path = cache / "objects" / digest[:2] / digest
            object_path.parent.mkdir(parents=True)
            object_path.write_bytes(body)
            (cache / "manifest.json").write_text(json.dumps({"urls": {"https://local.invalid/theme-code": {"digest": digest}}, "objects": {digest: {"content_type": "text/plain"}}}))
            engine = freeze_css.CacheCSS(cache, root / "assets")
            css, manifest = engine.build('@import url("https://local.invalid/theme-code");', "https://local.invalid/page")
            self.assertNotIn("No such page", css)
            self.assertEqual(manifest["missing"][0]["reason"], "import-not-css:text/plain")
            self.assertEqual(manifest["import_provenance"], [])
            self.assertEqual(manifest["import_provenance_status"], "incomplete")


class UnflattenedImportProvenanceTests(unittest.TestCase):
    def engine_with_urls(self, root, entries):
        cache = root / "cache"
        urls, objects = {}, {}
        for url, (body, content_type) in entries.items():
            digest = hashlib.sha256(body).hexdigest()
            object_path = cache / "objects" / digest[:2] / digest
            object_path.parent.mkdir(parents=True, exist_ok=True)
            object_path.write_bytes(body)
            urls[url] = {"digest": digest}
            objects[digest] = {"content_type": content_type}
        (cache / "manifest.json").write_text(json.dumps({"urls": urls, "objects": objects}))
        return freeze_css.CacheCSS(cache, root / "assets")

    def engine_with_import(self, root, body=b".legacy { color: #123; }"):
        cache = root / "cache"
        digest = hashlib.sha256(body).hexdigest()
        object_path = cache / "objects" / digest[:2] / digest
        object_path.parent.mkdir(parents=True)
        object_path.write_bytes(body)
        (cache / "manifest.json").write_text(json.dumps({"urls": {"https://local.invalid/theme-code": {"digest": digest}}, "objects": {digest: {"content_type": "text/css"}}}))
        return freeze_css.CacheCSS(cache, root / "assets")

    def test_trailing_import_without_semicolon_is_flattened(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            css, manifest = engine.build('@import url("https://local.invalid/theme-code")', "https://local.invalid/page")
            self.assertIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance_status"], "complete")

    def test_unquoted_url_does_not_swallow_closing_paren(self):
        # url(https://host/path) has no space before ")". The URL reference must
        # stop before ")" or the frozen-cache lookup misses and drops the import.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            css, manifest = engine.build('@import url(https://local.invalid/theme-code);', "https://local.invalid/page")
            self.assertIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance_status"], "complete")

    def test_trailing_unquoted_import_without_semicolon_is_flattened(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            css, manifest = engine.build('@import url(https://local.invalid/theme-code)', "https://local.invalid/page")
            self.assertIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance_status"], "complete")

    def test_consecutive_semicolonless_imports_are_each_flattened(self):
        # Composed candidate files concatenate separate [[module CSS]] leading
        # @import lines without semicolons. The first import must not swallow the
        # following imports and stylesheet text as a fake prelude.
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_urls(root, {
                "https://local.invalid/a.css": (b".a { color: red; }", "text/css"),
                "https://local.invalid/b.css": (b".b { color: blue; }", "text/css"),
            })
            css, manifest = engine.build(
                '@import url("https://local.invalid/a.css")\n\n@import url("https://local.invalid/b.css")\n\n:root { --x: 1; }',
                "https://local.invalid/page",
            )
            self.assertIn(".a { color: red; }", css)
            self.assertIn(".b { color: blue; }", css)
            self.assertIn(":root { --x: 1; }", css)
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance_status"], "complete")

    def test_media_import_prelude_is_preserved_by_wrapping(self):
        # A media condition on @import applies to the imported stylesheet, so it
        # must be preserved instead of silently dropped.
        for source, media in [
            ('@import "https://local.invalid/theme-code" screen;', "screen"),
            ('@import url("https://local.invalid/theme-code") print;', "print"),
            ('@import url(https://local.invalid/theme-code) (min-width: 500px)', "(min-width: 500px)"),
        ]:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                engine = self.engine_with_import(root)
                css, manifest = engine.build(source, "https://local.invalid/page")
                self.assertIn(f"@media {media} {{", css)
                self.assertIn(".legacy { color: #123; }", css)
                self.assertEqual(manifest["missing"], [])
                self.assertEqual(manifest["import_provenance_status"], "complete")

    def test_layer_import_prelude_fails_provenance_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            css, manifest = engine.build('@import url("https://local.invalid/theme-code") layer(base);', "https://local.invalid/page")
            self.assertNotIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["import_provenance_status"], "incomplete")
            self.assertTrue(any(row["reason"] == "css-import-prelude-unsupported" for row in manifest["missing"]))

    def test_supports_import_prelude_fails_provenance_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            css, manifest = engine.build('@import url("https://local.invalid/theme-code") supports(display: grid);', "https://local.invalid/page")
            self.assertNotIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["import_provenance_status"], "incomplete")
            self.assertTrue(any(row["reason"] == "css-import-prelude-unsupported" for row in manifest["missing"]))

    def test_comments_and_strings_do_not_fake_unflattened_imports(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            _css, manifest = engine.build('/* @import "https://local.invalid/theme-code"; */ .a { content: "@import"; }', "https://local.invalid/page")
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance_status"], "complete")

    def test_flattened_import_leaves_no_residual(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            engine = self.engine_with_import(root)
            css, manifest = engine.build('@import url("https://local.invalid/theme-code");', "https://local.invalid/page")
            self.assertIn(".legacy { color: #123; }", css)
            self.assertEqual(manifest["missing"], [])
            self.assertEqual(manifest["import_provenance_status"], "complete")
            self.assertNotIn("@import", css)


if __name__ == "__main__":
    unittest.main()

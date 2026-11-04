import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from wikidot.connector.ajax import AjaxModuleConnectorConfig, AjaxRequestHeader
from wikidot.module.client import Client
from wikidot.module.page import Page
from wikidot.module.site import Site


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
RENDERER = (
    REPOSITORY_ROOT / "framerail/src/lib/server/ajax-module-connector-page-reads.ts"
).as_uri()


def render_edit_meta() -> str:
    script = f"""
import {{ renderWikidotEditMeta }} from {json.dumps(RENDERER)}
console.log(renderWikidotEditMeta([
  {{ name: "robots", content: "noindex", all_pages: true }},
  {{ name: "description", content: "Alpha & <Beta>", all_pages: false }}
]))
"""
    result = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def make_page() -> Page:
    client = object.__new__(Client)
    client.amc_client = MagicMock()
    client.amc_client.header = AjaxRequestHeader()
    client.amc_client.config = AjaxModuleConnectorConfig()
    client.is_logged_in = True
    client.username = "fixture-user"
    client.me = None
    client.login_check = MagicMock()
    site = Site(
        client=client,
        id=6000006,
        title="Test Site",
        unix_name="test-site",
        domain="test-site.wikidot.com",
        ssl_supported=True,
    )
    page = Page(
        site=site,
        fullname="test-page",
        name="test-page",
        category="_default",
        title="Test Page",
        children_count=0,
        comments_count=0,
        size=100,
        rating=0,
        votes_count=0,
        rating_percent=None,
        revisions_count=1,
        parent_fullname=None,
        tags=[],
        created_by=None,
        created_at=None,
        updated_by=None,
        updated_at=None,
        commented_by=None,
        commented_at=None,
    )
    page._id = 1469127852
    return page


class WikidotEditMetaClientContractTest(unittest.TestCase):
    def test_unchanged_client_parses_the_framerail_edit_meta_body(self) -> None:
        page = make_page()
        page.site.amc_request_with_retry = MagicMock(
            return_value=(SimpleNamespace(json=lambda: {"body": render_edit_meta()}),)
        )

        self.assertEqual(
            page.metas,
            {"robots": "noindex", "description": "Alpha & <Beta>"},
        )
        page.site.amc_request_with_retry.assert_called_once_with(
            [
                {
                    "pageId": 1469127852,
                    "moduleName": "edit/EditMetaModule",
                }
            ]
        )

    def test_unchanged_client_sends_the_canonical_meta_actions(self) -> None:
        page = make_page()
        page._metas = {"old": "remove", "description": "Before"}
        page.site.amc_request = MagicMock(
            return_value=(SimpleNamespace(json=lambda: {"status": "ok"}),)
        )

        page.metas = {"description": "After", "keywords": "one,two"}

        self.assertEqual(
            [call.args[0][0] for call in page.site.amc_request.call_args_list],
            [
                {
                    "metaName": "old",
                    "action": "WikiPageAction",
                    "event": "deleteMetaTag",
                    "pageId": 1469127852,
                    "moduleName": "edit/EditMetaModule",
                },
                {
                    "metaName": "keywords",
                    "metaContent": "one,two",
                    "action": "WikiPageAction",
                    "event": "saveMetaTag",
                    "pageId": 1469127852,
                    "moduleName": "edit/EditMetaModule",
                },
                {
                    "metaName": "description",
                    "metaContent": "After",
                    "action": "WikiPageAction",
                    "event": "saveMetaTag",
                    "pageId": 1469127852,
                    "moduleName": "edit/EditMetaModule",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()

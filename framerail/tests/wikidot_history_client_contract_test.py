import json
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from wikidot.connector.ajax import AjaxModuleConnectorConfig, AjaxRequestHeader
from wikidot.module.client import Client
from wikidot.module.page import Page, PageCollection, PageRevisionCollection
from wikidot.module.site import Site


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
RENDERER = (
    REPOSITORY_ROOT / "framerail/src/lib/server/ajax-module-connector-page-reads.ts"
).as_uri()
REVISION = {
    "revision_id": 1000003,
    "revision_type": "move",
    "revision_number": 2,
    "created_at": "2023-11-14T22:46:40Z",
    "user_id": 12345,
    "author": {
        "user-id": 12345,
        "user-slug": "test-user",
        "user-name": "Test User",
    },
    "changes": ["slug"],
    "comments": "Renamed page",
    "wikitext": 'alpha < beta & [[div title="x"]]',
    "compiled_body_html": '<p class="historical">Rendered revision</p>',
}


def render_history_fragments() -> dict[str, str]:
    script = f"""
import {{
  renderWikidotPageRevisionList,
  renderWikidotPageRevisionSource,
  renderWikidotPageRevisionVersion
}} from {json.dumps(RENDERER)}
const revision = {json.dumps(REVISION)}
console.log(JSON.stringify({{
  list: renderWikidotPageRevisionList([revision]),
  source: renderWikidotPageRevisionSource(revision),
  version: renderWikidotPageRevisionVersion(revision)
}}))
"""
    result = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def make_page() -> Page:
    client = object.__new__(Client)
    client.amc_client = MagicMock()
    client.amc_client.header = AjaxRequestHeader()
    client.amc_client.config = AjaxModuleConnectorConfig()
    client.is_logged_in = False
    client.username = None
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
    page._id = 1469071756
    return page


class WikidotHistoryClientContractTest(unittest.TestCase):
    def test_local_wikidot_py_consumes_framerail_history_reads(self) -> None:
        fragments = render_history_fragments()
        page = make_page()
        page.site.amc_request_with_retry = MagicMock(
            return_value=(SimpleNamespace(json=lambda: {"body": fragments["list"]}),)
        )

        PageCollection(page.site, [page]).get_page_revisions()

        assert page._revisions is not None
        revision = page._revisions[0]
        self.assertEqual(revision.id, REVISION["revision_id"])
        self.assertEqual(revision.rev_no, 3)
        self.assertEqual(revision.created_by.id, 12345)
        self.assertEqual(revision.created_by.unix_name, "test-user")
        self.assertEqual(revision.comment, "Renamed page")

        page.site.amc_request_with_retry = MagicMock(
            side_effect=[
                (SimpleNamespace(json=lambda: {"body": fragments["source"]}),),
                (SimpleNamespace(json=lambda: {"body": fragments["version"]}),),
            ]
        )
        selected = PageRevisionCollection(page, [revision])
        selected.get_sources()
        selected.get_htmls()

        self.assertEqual(revision.source.wiki_text, REVISION["wikitext"])
        self.assertEqual(revision.html, REVISION["compiled_body_html"])


if __name__ == "__main__":
    unittest.main()

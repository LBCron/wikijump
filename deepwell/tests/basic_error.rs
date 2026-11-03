/*
 * tests/basic_error.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#[macro_use]
mod common;

use self::common::TestRunner;
use serde_json::json;

fn without_bidi_isolates(text: &str) -> String {
    text.replace(['\u{2068}', '\u{2069}'], "")
}

#[tokio::test]
async fn basic_error_endpoints_generate_localized_html() {
    let runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;

    let site_slug = run_endpoint!(
        runner,
        basic_error_missing_site_slug,
        json!({"locales": ["en"], "site_slug": "missing-site"}),
    );
    assert!(!site_slug.title.is_empty());
    assert!(site_slug.body.contains("wikijump.com"));
    assert!(site_slug.body.contains("missing-site.wikijump.com"));
    assert!(
        site_slug
            .body
            .contains("https://www.wikijump.com/new-site"),
        "missing-site page must offer the site creation flow: {}",
        site_slug.body,
    );

    let custom = run_endpoint!(
        runner,
        basic_error_missing_custom_domain,
        json!({"locales": ["en"], "domain": "example.invalid"}),
    );
    assert!(custom.body.contains("example.invalid"));

    let page_slug = run_endpoint!(
        runner,
        basic_error_missing_page_slug,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "page_slug": "\"><mark data-poc=\"inert\">slug-marker</mark>",
        }),
    );
    assert!(!page_slug.body.contains("slug-marker"));
    assert!(page_slug.body.contains("<h1>This page does not exist</h1>"));
    assert!(
        page_slug
            .body
            .contains("The requested page does not exist.")
    );
    assert!(page_slug.body.contains("site's main page"));

    let page_fetch = run_endpoint!(
        runner,
        basic_error_page_fetch,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "page_slug": "broken-page",
        }),
    );
    assert!(page_fetch.body.contains("broken-page"));

    let file_name = run_endpoint!(
        runner,
        basic_error_missing_file_name,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "page_slug": "page",
            "filename": "missing.png",
        }),
    );
    assert!(file_name.body.contains("missing.png"));

    let file_fetch = run_endpoint!(
        runner,
        basic_error_file_fetch,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "page_slug": "page",
            "filename": "broken.png",
        }),
    );
    assert!(file_fetch.body.contains("broken.png"));

    let text_block = run_endpoint!(
        runner,
        basic_error_text_block,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "index": "2",
            "block_type": "code",
            "reason": "missing",
        }),
    );
    assert!(
        without_bidi_isolates(&text_block.body)
            .contains("No code block with index <code>2</code> exists."),
        "the missing-block message must name the block type: {}",
        text_block.body,
    );

    let html_block = run_endpoint!(
        runner,
        basic_error_text_block,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "index": "3",
            "block_type": "html",
            "reason": "missing",
        }),
    );
    assert!(
        without_bidi_isolates(&html_block.body)
            .contains("No HTML block with index <code>3</code> exists."),
        "the missing-block message must name the block type: {}",
        html_block.body,
    );

    let file_root =
        run_endpoint!(runner, basic_error_file_root, json!({"locales": ["en"]}));
    assert!(file_root.body.contains("wjfiles.com"));
}

#[tokio::test]
async fn basic_error_text_block_index_renders_attacker_markup_inert() {
    let runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;

    let attack = run_endpoint!(
        runner,
        basic_error_text_block,
        json!({
            "locales": ["en"],
            "site_id": site.site_id,
            "index": "9999<img\tsrc=x\tonerror=alert(1)>",
            "block_type": "code",
            "reason": "missing",
        }),
    );
    let body = without_bidi_isolates(&attack.body);
    assert!(
        !body.contains("<img"),
        "attacker markup must not survive into the error body: {}",
        attack.body,
    );
    assert!(
        body.contains("9999&lt;img"),
        "the escaped index must still be visible: {}",
        attack.body,
    );
}

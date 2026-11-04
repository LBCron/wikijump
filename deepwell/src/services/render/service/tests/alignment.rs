/*
 * services/render/service/tests/alignment.rs
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

use super::*;

fn rewrite(source: &str) -> String {
    let mut wikitext = source.to_owned();
    let mut preserved = CompatTextFragments::new(&wikitext);
    RenderService::normalize_wikidot_alignment_markers(&mut wikitext, &mut preserved);
    wikitext
}

#[test]
fn scp744_rate_row_and_article_gate_rewrite_to_divs() {
    let source = concat!(
        "[[>]]\n",
        "[[module Rate]]\n",
        "[[/>]]\n",
        "\n",
        "[[=]]\n",
        "[[<]]\n",
        "article body stays here\n",
        "[[/<]]\n",
        "[[/=]]\n",
        "\n",
        "[[=]]\n",
        "tail block\n",
        "[[/=]]\n",
    );
    let rewritten = rewrite(source);
    assert!(
        rewritten.contains("[[div style=\"text-align: right;\"]]"),
        "right opener must rewrite, got:\n{rewritten}"
    );
    assert!(
        rewritten.contains("[[div style=\"text-align: center;\"]]"),
        "center opener must rewrite, got:\n{rewritten}"
    );
    assert!(
        rewritten.contains("[[div style=\"text-align: left;\"]]"),
        "left opener must rewrite, got:\n{rewritten}"
    );
    assert!(
        !rewritten.contains("[[>]]")
            && !rewritten.contains("[[/>]]")
            && !rewritten.contains("[[=]]")
            && !rewritten.contains("[[/=]]")
            && !rewritten.contains("[[<]]")
            && !rewritten.contains("[[/<]]"),
        "no alignment marker may leak as literal text, got:\n{rewritten}"
    );
    assert!(
        rewritten.contains("article body stays here") && rewritten.contains("tail block"),
        "body text must survive the rewrite, got:\n{rewritten}"
    );
}

#[test]
fn comment_hidden_markers_are_not_rewritten() {
    let source = "[!--\n[[>]]\nbody\n[[/>]]\n--]\n";
    let rewritten = rewrite(source);
    assert!(
        rewritten.contains("[[>]]") && rewritten.contains("[[/>]]"),
        "comment-hidden markers must stay literal, got:\n{rewritten}"
    );
    assert!(
        !rewritten.contains("[[div"),
        "no div may be emitted inside a comment, got:\n{rewritten}"
    );

    let source = "before\n[!--\n[[>]]\n";
    let rewritten = rewrite(source);
    assert!(
        rewritten.contains("[[>]]"),
        "marker after an unclosed comment opener must stay literal, got:\n{rewritten}"
    );
}

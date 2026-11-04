/*
 * services/render/service/tests/postprocess.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::*;

#[test]
fn restores_wikidot_collapsible_legacy_classes() {
    let html = concat!(
        r#"<details class="wj-collapsible" data-show-top>"#,
        r#"<summary class="wj-collapsible-button wj-collapsible-button-top">"#,
        r#"<span class="wj-collapsible-show-text">show</span>"#,
        r#"<span class="wj-collapsible-hide-text">hide</span>"#,
        "</summary>",
        r#"<div class="wj-collapsible-content"><p>body</p></div>"#,
        "</details>",
    );

    let restored = RenderService::restore_wikidot_collapsible_compatibility(html);

    assert!(restored.contains("collapsible-block"));
    assert!(restored.contains("collapsible-block-folded"));
    assert!(restored.contains("collapsible-block-unfolded"));
    assert!(restored.contains("collapsible-block-content"));
    assert!(restored.contains("collapsible-block-link"));
    assert!(restored.contains("collapsible-block-unfolded-link"));
    assert!(restored.contains("<details"));
    assert!(restored.contains("<summary"));
    assert!(!restored.contains("onclick="));
    assert!(!restored.contains("style=\"display:none\""));
    assert!(!restored.contains("wj-collapsible"));
}

#[test]
fn restores_wikidot_code_block_dom_without_internal_language_metadata() {
    let html = concat!(
        r#"<wj-code class="wj-code wj-language-css">"#,
        r#"<div class="wj-code-panel">"#,
        r#"<wj-code-copy type="button" class="wj-code-copy">copy</wj-code-copy>"#,
        r#"<span class="wj-code-language">css</span>"#,
        "</div>",
        "<pre><code>.x { color: red; }</code></pre>",
        "</wj-code>",
    );

    let restored = RenderService::restore_wikidot_code_block_dom_compatibility(html);

    assert!(restored.contains(r#"<div class="code">"#));
    assert!(restored.contains("<pre><code>.x { color: red; }</code></pre>"));
    assert!(!restored.contains("data-wj-language"));
    assert!(!restored.contains("wj-code"));
    assert!(!restored.contains("wj-code-copy"));
    assert!(!restored.contains("wj-code-language"));
}

#[test]
fn restores_language_free_wikidot_code_blocks_without_highlight_metadata() {
    let html = r#"<wj-code class="wj-code"><pre><code>plain</code></pre></wj-code>"#;

    let restored = RenderService::restore_wikidot_code_block_dom_compatibility(html);

    assert_eq!(
        restored,
        r#"<div class="code"><pre><code>plain</code></pre></div>"#
    );
}

#[test]
fn restores_wikidot_tabview_dom_classes() {
    let html = concat!(
        r#"<wj-tabs class="wj-tabs">"#,
        r#"<div class="wj-tabs-button-list" role="tablist">"#,
        r#"<wj-tabs-button class="wj-tabs-button" id="wj-id-a" role="tab" aria-label="One" aria-selected="true" aria-controls="wj-id-pa" tabindex="0">One</wj-tabs-button>"#,
        r#"<wj-tabs-button class="wj-tabs-button" id="wj-id-b" role="tab" aria-label="Two" aria-selected="false" aria-controls="wj-id-pb" tabindex="-1">Two</wj-tabs-button>"#,
        "</div>",
        r#"<div class="wj-tabs-panel-list">"#,
        r#"<div class="wj-tabs-panel" id="wj-id-pa" role="tabpanel" aria-labelledby="wj-id-a" tabindex="0">First</div>"#,
        r#"<div class="wj-tabs-panel" id="wj-id-pb" role="tabpanel" aria-labelledby="wj-id-b" tabindex="0" hidden>Second</div>"#,
        "</div>",
        "</wj-tabs>",
    );

    let restored = RenderService::restore_wikidot_tabview_dom_compatibility(html);

    assert_eq!(restored.matches("tabview-min.js").count(), 0, "{restored}");
    assert_eq!(
        restored.matches("tabview-compat.js").count(),
        1,
        "{restored}"
    );
    assert!(restored.contains(r#"<div class="yui-navset">"#));
    assert!(restored.contains(r#"<ul class="yui-nav">"#));
    assert!(restored.contains(r#"<div class="yui-content">"#));
    assert!(restored.contains(r#"<div style="display: block;">First</div>"#));
    assert!(restored.contains(r#"<div style="display:none">Second</div>"#));
    assert!(
        restored.contains(r#"<li class="selected"><a href="javascript:;">One</a></li>"#)
    );
    assert!(restored.contains(r#"<li><a href="javascript:;">Two</a></li>"#));
    assert!(restored.contains("</a></li>\n<li>"));
    assert!(!restored.contains("wj-tabs"));
    assert!(!restored.contains("aria-selected"));
    assert!(!restored.contains("role=\"tab\""));
    assert!(!restored.contains(" hidden"));
}

#[test]
fn restores_wikidot_tabview_panel_visibility_per_tabview() {
    let html = concat!(
        r#"<wj-tabs class="wj-tabs">"#,
        r#"<div class="wj-tabs-button-list">"#,
        r#"<wj-tabs-button class="wj-tabs-button" aria-selected="true">One</wj-tabs-button>"#,
        r#"<wj-tabs-button class="wj-tabs-button" aria-selected="false">Two</wj-tabs-button>"#,
        "</div>",
        r#"<div class="wj-tabs-panel-list">"#,
        r#"<div class="wj-tabs-panel">First A</div>"#,
        r#"<div class="wj-tabs-panel" hidden>First B</div>"#,
        "</div>",
        "</wj-tabs>",
        r#"<wj-tabs class="wj-tabs">"#,
        r#"<div class="wj-tabs-button-list">"#,
        r#"<wj-tabs-button class="wj-tabs-button" aria-selected="true">Three</wj-tabs-button>"#,
        r#"<wj-tabs-button class="wj-tabs-button" aria-selected="false">Four</wj-tabs-button>"#,
        "</div>",
        r#"<div class="wj-tabs-panel-list">"#,
        r#"<div class="wj-tabs-panel">Second A</div>"#,
        r#"<div class="wj-tabs-panel" hidden>Second B</div>"#,
        "</div>",
        "</wj-tabs>",
    );

    let restored = RenderService::restore_wikidot_tabview_dom_compatibility(html);

    assert!(restored.contains(r#"<div style="display: block;">First A</div>"#));
    assert!(restored.contains(r#"<div style="display:none">First B</div>"#));
    assert!(restored.contains(r#"<div style="display: block;">Second A</div>"#));
    assert!(restored.contains(r#"<div style="display:none">Second B</div>"#));
}

#[test]
fn restores_typed_wikidot_tabview_resource_requirements() {
    let id = "wiki-tabview-0123456789abcdef0123456789abcdef".to_owned();
    let html = format!(
        r#"<p>Before</p><div id="{id}" class="yui-navset"><ul class="yui-nav"><li class="selected"><a href="javascript:;"><em>One</em></a></li><li><a href="javascript:;"><em>Two</em></a></li></ul><div class="yui-content"><div id="wiki-tab-0-0"><p>First</p></div><div id="wiki-tab-0-1"><p>Second</p></div></div></div><p>After</p>"#
    );

    let restored =
        RenderService::restore_wikidot_render_compatibility_for_context_with_resources(
            &html,
            None,
            &Config::integration_testing(),
            true,
            std::slice::from_ref(&id),
        );

    assert!(restored.starts_with(
        r#"<p>Before</p><div id="wiki-tabview-0123456789abcdef0123456789abcdef" class="yui-navset">"#
    ));
    assert!(restored.contains(r#"<li class="selected">"#));
    assert!(restored.contains(
        r#"<div id="wiki-tab-0-0" style="display: block;"><p>First</p></div>"#
    ));
    assert!(
        restored.contains(
            r#"<div id="wiki-tab-0-1" style="display:none"><p>Second</p></div>"#
        )
    );
    assert!(restored.contains(
        r#"<script type="text/javascript" src="/wikidot/scripts/tabview-compat.js"></script>"#
    ));
    assert!(restored.ends_with(
        r#"<script type="text/javascript" src="/wikidot/scripts/tabview-compat.js"></script><p>After</p>"#
    ));
    assert_eq!(restored.matches("tabview-min.js").count(), 0, "{restored}");
}

#[test]
fn initializes_resource_tabviews_during_parse_but_leaves_direct_tabviews_for_hydration() {
    let id = "wiki-tabview-0123456789abcdef0123456789abcdef".to_owned();
    let html = format!(
        concat!(
            r#"<div id="{id}" class="yui-navset"><ul class="yui-nav"><li class="selected"><a href="javascript:;"><em>Resource</em></a></li></ul><div class="yui-content"><div id="wiki-tab-0-0"><p>Resource body</p></div></div></div>"#,
            r#"<wj-tabs class="wj-tabs"><div class="wj-tabs-button-list"><wj-tabs-button class="wj-tabs-button" aria-selected="true">Direct</wj-tabs-button></div><div class="wj-tabs-panel-list"><div class="wj-tabs-panel">Direct body</div></div></wj-tabs>"#,
        ),
        id = id,
    );

    let restored =
        RenderService::restore_wikidot_render_compatibility_for_context_with_resources(
            &html,
            None,
            &Config::integration_testing(),
            true,
            std::slice::from_ref(&id),
        );

    assert_eq!(restored.matches("tabview-min.js").count(), 0, "{restored}");
    assert_eq!(
        restored.matches("tabview-compat.js").count(),
        1,
        "{restored}"
    );
    assert!(
        restored.contains(&format!(r#"<div id="{id}" class="yui-navset">"#, id = id,))
    );
    assert!(restored.contains(
        r#"<script type="text/javascript" src="/wikidot/scripts/tabview-compat.js"></script><div class="yui-navset">"#
    ));
}

#[test]
fn ignores_untrusted_or_unmatched_wikidot_tabview_resource_requirements() {
    let html = r#"<div id="wiki-tabview-0123456789abcdef0123456789abcdef" class="yui-navset"></div>"#;
    assert_eq!(
        RenderService::restore_wikidot_tabview_resource_compatibility(
            html,
            &[
                "wiki-tabview-x');alert(1)//".to_owned(),
                "wiki-tabview-fedcba9876543210fedcba9876543210".to_owned(),
            ],
        ),
        html,
    );
}

#[test]
fn restores_residual_wikidot_div_markers_around_tabview() {
    let html = concat!(
        r#"<p>[[div class=&quot;m-wrapper standalone series&quot;]]</p>"#,
        r#"<div class="yui-navset"><div class="yui-content">"#,
        r#"<div><p>Order by Date of Creation</p></div>"#,
        r#"<div><p>[[/div]]</p></div>"#,
        r#"</div></div>"#,
    );

    let restored = RenderService::restore_residual_wikidot_div_paragraph_markers(html);

    assert!(restored.contains(r#"<div class="m-wrapper standalone series">"#));
    assert!(restored.contains(r#"<div class="yui-navset">"#));
    assert!(!restored.contains("[[div"));
    assert!(!restored.contains("[[/div]]"));
}

#[test]
fn leaves_residual_wikidot_div_closer_without_restored_opener() {
    let html = concat!(
        r#"<p>[[div onclick=&quot;unsupported&quot;]]</p>"#,
        r#"<span>Body</span>"#,
        r#"<p>[[/div]]</p>"#,
    );

    let restored = RenderService::restore_residual_wikidot_div_paragraph_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn restores_standalone_residual_wikidot_div_lines() {
    let html = concat!(
        "====\n",
        r#"[[div class=&quot;preview&quot;]]"#,
        "\nPreview text\n",
        "[[/div]]\n",
        r#"[[div id=&quot;cromthumbnail&quot; style=&quot;display: none;&quot;]]"#,
        "\nHidden text\n",
        "[[/div]]\n",
        "[[div]]\n",
        "Bare body\n",
        "[[/div]]\n",
    );

    let restored = RenderService::restore_residual_wikidot_div_paragraph_markers(html);

    assert!(restored.contains(r#"<div class="preview">"#));
    assert!(restored.contains(r#"<div id="cromthumbnail" style="display: none;">"#));
    assert!(restored.contains("<div>\nBare body\n</div>"));
    assert!(!restored.contains("[[div"));
    assert!(!restored.contains("[[/div]]"));
}

#[test]
fn leaves_standalone_residual_wikidot_div_lines_inside_pre() {
    let html = concat!(
        "<pre>\n",
        r#"[[div class=&quot;literal&quot;]]"#,
        "\nbody\n",
        "[[/div]]\n",
        "</pre>\n",
    );

    let restored = RenderService::restore_residual_wikidot_div_paragraph_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn leaves_standalone_residual_wikidot_div_closer_without_restored_opener() {
    let html = "Before\n[[/div]]\nAfter\n";

    let restored = RenderService::restore_residual_wikidot_div_paragraph_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn restores_residual_wikidot_span_markers() {
    let html = concat!(
        r#"<div class="top-left-box">"#,
        r#"[[span class=&quot;item&quot;]]Item#:[[/span]] "#,
        r#"[[span class=&quot;number&quot; onclick=&quot;bad()&quot;]]SCP-001[[/span]]"#,
        "</div>",
    );

    let restored = RenderService::restore_residual_wikidot_span_markers(html);

    assert!(restored.contains(r#"<span class="item">Item#:</span>"#));
    assert!(restored.contains(r#"<span class="number">SCP-001</span>"#));
    assert!(!restored.contains("[[span"));
    assert!(!restored.contains("onclick"));
}

#[test]
fn restores_multiline_residual_wikidot_span_markers() {
    let html = concat!(
        "<div>\n",
        r#"[[span style=&quot;font-family: Courier New; font-size: 120%;&quot;]]William Shakespeare has a problem. "#,
        "\n\n",
        "None could articulate why.[[/span]]\n",
        "</div>\n",
    );

    let restored = RenderService::restore_residual_wikidot_span_markers(html);

    assert!(restored.contains(
        r#"<span style="font-family: Courier New; font-size: 120%;">William Shakespeare has a problem. "#
    ));
    assert!(restored.contains("None could articulate why.</span>"));
    assert!(!restored.contains("[[span"));
    assert!(!restored.contains("[[/span]]"));
}

#[test]
fn leaves_residual_wikidot_span_markers_inside_pre() {
    let html = concat!(
        "<pre>\n",
        r#"[[span class=&quot;literal&quot;]]body"#,
        "\n",
        "still literal[[/span]]",
        "\n</pre>\n",
    );

    let restored = RenderService::restore_residual_wikidot_span_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn leaves_residual_span_markers_inside_quoted_tag_attributes() {
    let html = concat!(
        r#"<img src=x alt="safe > [[span class=&quot;x onerror=alert(1)//&quot;]]broken[[/span]]">"#,
        r#" [[span class=&quot;safe&quot;]]body[[/span]]"#,
    );

    let restored = RenderService::restore_residual_wikidot_span_markers(html);

    assert!(restored.contains(
        r#"<img src=x alt="safe > [[span class=&quot;x onerror=alert(1)//&quot;]]broken[[/span]]">"#,
    ));
    assert!(restored.contains(r#"<span class="safe">body</span>"#));
    assert!(!restored.contains(r#"<span class="x onerror=alert(1)//">"#));
}

#[test]
fn restores_residual_spans_across_safe_html_elements_only() {
    let html = concat!(
        r#"[[span class=&quot;outer&quot;]]before <strong>bold</strong> "#,
        r#"[[span class=&quot;inner&quot;]]inside[[/span]] after[[/span]]"#,
    );

    assert_eq!(
        RenderService::restore_residual_wikidot_span_markers(html),
        r#"<span class="outer">before <strong>bold</strong> <span class="inner">inside</span> after</span>"#,
    );
}

#[test]
fn leaves_residual_span_markers_in_comments_and_raw_or_foreign_elements() {
    let html = concat!(
        "<!-- [[span class=&quot;comment&quot;]]x[[/span]] -->",
        "<style>[[span class=&quot;style&quot;]]x[[/span]]</style>",
        "<ScRiPt>[[span class=&quot;script&quot;]]x[[/span]]</sCrIpT>",
        "<svg><text>[[span class=&quot;svg&quot;]]x[[/span]]</text></svg>",
    );

    assert_eq!(
        RenderService::restore_residual_wikidot_span_markers(html),
        html
    );
}

#[test]
fn does_not_pair_residual_spans_across_opaque_or_comment_boundaries() {
    for boundary in [
        "<style>body { color: red; }</style>",
        "<script>void 0</script>",
        "<pre>literal</pre>",
        "<svg><text>foreign</text></svg>",
        "<!-- comment -->",
    ] {
        let html =
            format!(r#"[[span class=&quot;outer&quot;]]before{boundary}after[[/span]]"#,);

        assert_eq!(
            RenderService::restore_residual_wikidot_span_markers(&html),
            html,
            "boundary {boundary}",
        );
    }
}

#[test]
fn restores_standalone_residual_wikidot_alignment_lines() {
    let html = concat!(
        "<div>\n",
        "[[=]]\n",
        "**Centered**\n",
        "[[/=]]\n",
        "[[&lt;]]\n",
        "Left\n",
        "[[/&lt;]]\n",
        "[[&gt;]]\n",
        "Right\n",
        "[[/&gt;]]\n",
        "</div>\n",
    );

    let restored = RenderService::restore_residual_wikidot_alignment_markers(html);

    assert!(restored.contains(r#"<div style="text-align: center;">"#,));
    assert!(restored.contains(r#"<div style="text-align: left;">"#));
    assert!(restored.contains(r#"<div style="text-align: right;">"#));
    assert!(!restored.contains("[[=]]"));
    assert!(!restored.contains("[[/=]]"));
    assert!(!restored.contains("[[&lt;]]"));
    assert!(!restored.contains("[[/&lt;]]"));
    assert!(!restored.contains("[[&gt;]]"));
    assert!(!restored.contains("[[/&gt;]]"));
}

#[test]
fn compatibility_pipeline_restores_escaped_right_alignment_around_rate_output() {
    let html = concat!(
        "<p>[[&gt;]]</p>",
        r#"<div class="page-rate-widget-box">rating</div>"#,
        "<p>[[/&gt;]]</p>",
    );

    let restored =
        RenderService::restore_wikidot_render_compatibility_for_context_with_resources(
            html,
            None,
            &Config::integration_testing(),
            true,
            &[],
        );

    assert_eq!(
        restored,
        concat!(
            r#"<div style="text-align: right;">"#,
            r#"<div class="page-rate-widget-box">rating</div>"#,
            "</div>",
        ),
    );
}

#[test]
fn restores_residual_wikidot_alignment_html_markers_around_collapsible() {
    let html = concat!(
        "<hr><p>[[=]]</p>",
        r#"<span style="font-size: 150%;">"#,
        r#"<details class="collapsible-block">"#,
        r#"<summary class="collapsible-block-link">"#,
        r#"<span class="collapsible-block-link">Show</span>"#,
        "</summary></details></span>",
        "<br>[[/=]]<br>",
        "<span>after</span>",
    );

    let restored = RenderService::restore_residual_wikidot_alignment_markers(html);

    assert!(restored.contains(
        r#"<hr><div style="text-align: center;"><span style="font-size: 150%;">"#
    ));
    assert!(restored.contains(r#"</details></span></div><br><span>after</span>"#));
    assert!(!restored.contains("[[=]]"));
    assert!(!restored.contains("[[/=]]"));
}

#[test]
fn restores_repeated_residual_wikidot_alignment_html_markers() {
    let html = "<p>[[=]]</p>".repeat(1024);

    let restored = RenderService::restore_residual_wikidot_alignment_markers(&html);

    assert_eq!(
        restored,
        r#"<div style="text-align: center;">"#.repeat(1024)
    );
}

#[test]
fn restores_every_residual_wikidot_alignment_html_marker() {
    let open_cases = [
        ("<p>[[=]]</p>", r#"<div style="text-align: center;">"#),
        ("<p>[[<]]</p>", r#"<div style="text-align: left;">"#),
        ("<p>[[&lt;]]</p>", r#"<div style="text-align: left;">"#),
        ("<p>[[>]]</p>", r#"<div style="text-align: right;">"#),
        ("<p>[[&gt;]]</p>", r#"<div style="text-align: right;">"#),
    ];
    for (marker, replacement) in open_cases {
        assert_eq!(
            RenderService::restore_residual_wikidot_alignment_html_markers(marker),
            replacement,
            "open marker {marker}",
        );
    }

    let close_cases = [
        ("<p>[[=]]</p>", "<p>[[/=]]</p>", "</div>"),
        ("<p>[[=]]</p>", "<br>[[/=]]<br>", "</div><br>"),
        ("<p>[[=]]</p>", "<br/>[[/=]]<br/>", "</div><br/>"),
        ("<p>[[=]]</p>", "<br />[[/=]]<br />", "</div><br />"),
        ("<p>[[<]]</p>", "<p>[[/<]]</p>", "</div>"),
        ("<p>[[<]]</p>", "<p>[[/&lt;]]</p>", "</div>"),
        ("<p>[[<]]</p>", "<br>[[/<]]<br>", "</div><br>"),
        ("<p>[[<]]</p>", "<br>[[/&lt;]]<br>", "</div><br>"),
        ("<p>[[>]]</p>", "<p>[[/>]]</p>", "</div>"),
        ("<p>[[>]]</p>", "<p>[[/&gt;]]</p>", "</div>"),
        ("<p>[[>]]</p>", "<br>[[/>]]<br>", "</div><br>"),
        ("<p>[[>]]</p>", "<br>[[/&gt;]]<br>", "</div><br>"),
    ];
    for (open, close, close_replacement) in close_cases {
        let input = format!("{open}body{close}");
        let output =
            RenderService::restore_residual_wikidot_alignment_html_markers(&input);
        assert!(output.ends_with(close_replacement), "close marker {close}");
        assert!(!output.contains(close), "close marker leaked: {close}");
    }
}

#[test]
fn alignment_html_marker_scan_preserves_mismatches_and_partial_prefixes() {
    let html = concat!(
        "prefix<<<<<<",
        "<p>[[=]]</p>",
        "<p>[[/<]]</p>",
        "<p>[[/=]]</p>",
        "<p>[[=]</p>",
        "<p>[[=]]</p",
        "suffix",
    );

    let restored = RenderService::restore_residual_wikidot_alignment_html_markers(html);

    assert!(restored.starts_with("prefix<<<<<<"));
    assert!(restored.contains("<p>[[/<]]</p>"));
    assert!(restored.contains("<p>[[=]</p>"));
    assert!(restored.contains("<p>[[=]]</p"));
    assert!(restored.ends_with("suffix"));
}

#[test]
fn alignment_html_marker_scan_handles_dense_adversarial_input() {
    const COUNT: usize = 4_096;
    let mut html = String::new();
    for index in 0..COUNT {
        html.push_str("<not-a-marker data-index=\"");
        html.push_str(&index.to_string());
        html.push_str("\"><p>[[=]</p>");
    }
    html.push_str("<p>[[=]]</p>body<p>[[/=]]</p>");

    let restored = RenderService::restore_residual_wikidot_alignment_html_markers(&html);

    assert_eq!(restored.matches("<not-a-marker").count(), COUNT);
    assert_eq!(restored.matches("<p>[[=]</p>").count(), COUNT);
    assert!(restored.ends_with(r#"<div style="text-align: center;">body</div>"#));
}

#[test]
fn leaves_standalone_residual_wikidot_alignment_lines_inside_pre() {
    let html = concat!("<pre>\n", "[[=]]\n", "literal\n", "[[/=]]\n", "</pre>\n");

    let restored = RenderService::restore_residual_wikidot_alignment_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn leaves_standalone_residual_wikidot_alignment_closer_without_opener() {
    let html = "Before\n[[/=]]\nAfter\n";

    let restored = RenderService::restore_residual_wikidot_alignment_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn restores_standalone_residual_wikidot_separator_lines() {
    let html = concat!(
        "Before\n",
        "------\n",
        "@@ @@\n",
        "<ul><li>item</li></ul><br>\n",
        "~~~~\n",
        "After\n",
    );

    let restored = RenderService::restore_residual_wikidot_separator_markers(html);

    assert!(restored.contains("Before\n<hr>\n"));
    assert!(
        restored.contains(r#"<p><span style="white-space: pre-wrap;"> </span><br></p>"#)
    );
    assert!(
        restored
            .contains(r#"<div style="clear:both; height: 0px; font-size: 1px"></div>"#)
    );
    assert!(!restored.contains("</ul><br>"));
    assert!(!restored.contains("------"));
    assert!(!restored.contains("@@ @@"));
    assert!(!restored.contains("~~~~"));
}

#[test]
fn preserves_non_list_break_before_residual_separator() {
    let html = "<div>before</div><br>\n~~~~\n";

    let restored = RenderService::restore_residual_wikidot_separator_markers(html);

    assert!(restored.contains("</div><br>\n"));
    assert!(
        restored
            .contains(r#"<div style="clear:both; height: 0px; font-size: 1px"></div>"#)
    );
}

#[test]
fn removes_list_break_before_nested_restored_separator() {
    let html = concat!(
        "<ul><li>item</li></ul><br>\n",
        r#"<div style="clear:both; height: 0px; font-size: 1px"></div>"#,
        "\n",
    );

    let restored = RenderService::restore_residual_wikidot_separator_markers(html);

    assert!(!restored.contains("</ul><br>"));
}

#[test]
fn removes_list_break_before_same_line_restored_separator_content() {
    let html = concat!(
        "<ul><li>item</li></ul><br>\n",
        r#"<div style="clear:both; height: 0px; font-size: 1px"></div><div>content</div>"#,
        "\n",
    );

    let restored = RenderService::restore_residual_wikidot_separator_markers(html);

    assert!(!restored.contains("</ul><br>"));
    assert!(restored.contains("</ul>\n"));
    assert!(restored.contains("<div>content</div>"));
}

#[test]
fn normalizes_alignment_markers_that_own_a_block() {
    let mut source = concat!(
        "[[=]]\n",
        "[[<]]\n",
        "body\n",
        "[[/<]]\n",
        "[[/=]]\n",
        "[[code]]\n",
        "[[=]]\n",
        "[[/code]]\n",
    )
    .to_owned();
    let mut preserved = CompatTextFragments::new(&source);

    RenderService::normalize_wikidot_alignment_markers(&mut source, &mut preserved);

    assert!(source.contains("[[div style=\"text-align: center;\"]]\n"));
    assert!(source.contains("[[div style=\"text-align: left;\"]]\n"));
    assert!(source.contains("[[/div]]\n[[/div]]\n"));
    assert!(source.contains("[[code]]\n[[=]]\n[[/code]]"));
}

fn render_wikidot_alignment_body(wikitext: &str) -> String {
    let page_info = fallback_test_page_info("scp-7243", "SCP-7243");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut wikitext = wikitext.to_owned();
    let mut preserved = CompatTextFragments::new(&wikitext);

    RenderService::normalize_wikidot_alignment_markers(&mut wikitext, &mut preserved);
    ftml::preprocess_for_layout(&mut wikitext, settings.layout);
    let tokens = ftml::tokenize(&wikitext);
    let (tree, errors) = ftml::parse(&tokens, &page_info, &settings).into();
    assert!(errors.is_empty(), "{wikitext:?}: {errors:#?}");
    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;

    let site = wikidot_site("scp-wiki", None);
    let config = Config::integration_testing();
    let restored =
        RenderService::restore_wikidot_render_compatibility_for_context_with_resources(
            &rendered,
            Some(&site),
            &config,
            true,
            &[],
        );

    preserved.restore(&restored)
}

#[test]
fn keeps_alignment_markers_with_trailing_whitespace_literal() {
    for source in [
        "[[=]] \nA\n[[/=]]\n\nz",
        "[[=]]\t\nA\n[[/=]]\n\nz",
        "[[=]]  \nA\n[[/=]]\n\nz",
        "[[=]]\nA\n[[/=]] \n\nz",
        "[[=]]\nA\n[[/=]]\t\n\nz",
    ] {
        let body = render_wikidot_alignment_body(source);

        assert_eq!(
            body, "<p>[[=]]<br>\nA<br>\n[[/=]]</p><p>z</p>",
            "poisoned markers print as one literal paragraph: {source:?}",
        );
        assert!(
            !body.contains("text-align"),
            "no alignment block may be rendered: {body}",
        );
    }
}

#[test]
fn keeps_blank_line_separated_poisoned_markers_literal() {
    let body = render_wikidot_alignment_body("[[=]] \n\nA\n\n[[/=]]");

    assert_eq!(
        body, "<p>[[=]]</p><p>A</p><p>[[/=]]</p>",
        "blank-line separated markers print as three paragraphs: {body}",
    );
    assert!(
        !body.contains("text-align"),
        "no alignment block may be rendered: {body}",
    );
}

#[test]
fn keeps_left_and_right_alignment_markers_with_trailing_whitespace_literal() {
    for (source, expected) in [
        (
            "[[<]] \nA\n[[/<]]\n\nz",
            "<p>[[&lt;]]<br>\nA<br>\n[[/&lt;]]</p><p>z</p>",
        ),
        (
            "[[>]] \nA\n[[/>]]\n\nz",
            "<p>[[&gt;]]<br>\nA<br>\n[[/&gt;]]</p><p>z</p>",
        ),
    ] {
        let body = render_wikidot_alignment_body(source);

        assert_eq!(
            body, expected,
            "the markers must print as one literal paragraph: {source:?}",
        );
        assert!(
            !body.contains("text-align"),
            "no alignment block may be rendered: {body}",
        );
    }
}

#[test]
fn keeps_unpaired_alignment_markers_literal() {
    let body = render_wikidot_alignment_body("[[=]]\nA\n");

    assert!(
        body.contains("[[=]]"),
        "the opener must print as text: {body}"
    );
    assert!(
        !body.contains("text-align"),
        "no alignment block may be rendered: {body}",
    );

    let body = render_wikidot_alignment_body("[[/=]]\n\nz");

    assert!(
        body.contains("[[/=]]"),
        "the closer must print as text: {body}",
    );
    assert!(
        !body.contains("text-align"),
        "no alignment block may be rendered: {body}",
    );
}

#[test]
fn renders_paired_alignment_markers_as_a_block() {
    for source in [
        "[[=]]\nA\n[[/=]]\n\nz",
        " [[=]]\nA\n[[/=]]\n\nz",
        "[[=]]\nA\n [[/=]]\n\nz",
    ] {
        let body = render_wikidot_alignment_body(source);

        assert!(
            body.contains("<div style=\"text-align: center;\">"),
            "the alignment block must be rendered: {body}",
        );
        assert!(
            !body.contains("[[=]]") && !body.contains("[[/=]]"),
            "the markers must not print as text: {body}",
        );
    }
}

fn render_wikidot_expanded_alignment_body(top: &str, fragment: &str) -> String {
    let page_info = fallback_test_page_info("scp-7243", "SCP-7243");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);

    let preserved = CompatTextFragments::new(top);
    let (expanded, _) = ftml::include(
        top,
        &settings,
        PreparedIncluder {
            pages: vec![Some(fragment.to_owned())],
            missing_replacements: Default::default(),
        },
        include_error,
    )
    .expect("prepared include should expand");

    let outer = RenderService::prepare_outer_render_wikitext(
        super::super::ExpandedRenderWikitext {
            theme_previewer_blank: false,
            wikidot_compat_html: CompatHtmlFragments::new(&expanded),
            wikidot_compat_text: preserved,
            wikitext: expanded,
            included_pages: Vec::new(),
            expanded_include_count: 1,
            url_offset_list_pages_content_bytes: 0,
            runtime_css_insertions: Vec::new(),
        },
        &page_info,
        &settings,
    );

    let inner = RenderService::prepare_inner_render_wikitext(outer, &settings);
    let tokens = ftml::tokenize(&inner.wikitext);
    let (tree, errors) = ftml::parse(&tokens, &page_info, &settings).into();
    assert!(errors.is_empty(), "{top:?} / {fragment:?}: {errors:#?}");
    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;

    let site = wikidot_site("scp-wiki", None);
    let config = Config::integration_testing();
    let restored =
        RenderService::restore_wikidot_render_compatibility_for_context_with_resources(
            &rendered,
            Some(&site),
            &config,
            true,
            &[],
        );

    inner
        .protection
        .restore(|protection| protection.compat_text().restore(&restored))
}

#[test]
fn pairs_alignment_markers_split_across_include_boundaries() {
    let body = render_wikidot_expanded_alignment_body(
        "[[=]]\nA\n[[include fragment:pair-close]]\n",
        "[[/=]]\n",
    );

    assert!(
        body.contains("<div style=\"text-align: center;\">"),
        "the split pair must own an alignment block: {body}",
    );
    assert!(
        !body.contains("[[=]]") && !body.contains("[[/=]]"),
        "split markers must not print as text: {body}",
    );
}

#[test]
fn leaves_unpaired_opener_in_unexpanded_source_unclaimed() {
    let mut source = "[[=]]\nA\n[[include fragment:pair-close]]\n".to_owned();
    let mut preserved = CompatTextFragments::new(&source);

    RenderService::normalize_wikidot_alignment_markers(&mut source, &mut preserved);

    assert!(
        !source.contains("[[div style="),
        "the lone opener must not be rewritten: {source}",
    );
    assert!(
        preserved.restore(&source).contains("[[=]]"),
        "the lone opener must survive as authored text",
    );
}

#[test]
fn keeps_comment_split_alignment_pair_raw_for_ftml() {
    let body = render_wikidot_alignment_body(concat!(
        "[[>]]\n",
        "Rate module here\n",
        "@@[!--@@\n",
        "[[/>]]\n",
        "--]\n",
        "\n",
        "article content here\n",
    ));

    assert!(
        !body.contains("[[>]]")
            && !body.contains("[[/>]]")
            && !body.contains("[[&gt;]]")
            && !body.contains("[[/&gt;]]"),
        "no alignment marker may print as text: {body}",
    );
    assert!(
        body.contains("text-align: right"),
        "the comment-split pair must still own an alignment block: {body}",
    );
    for witness in ["Rate module here", "article content here"] {
        assert!(
            body.contains(witness),
            "shaped content must survive: {body}",
        );
    }
}

#[test]
fn keeps_trailing_whitespace_poisoned_split_pair_literal() {
    let body = render_wikidot_expanded_alignment_body(
        "[[=]]\nA\n[[include fragment:pair-close]]\n",
        "[[/=]] \n",
    );

    assert!(
        body.contains("[[=]]") && body.contains("[[/=]]"),
        "the poisoned split markers must print as text: {body}",
    );
    assert!(
        !body.contains("text-align"),
        "no alignment block may be rendered: {body}",
    );
}

#[test]
fn leaves_standalone_residual_wikidot_separator_lines_inside_raw_text() {
    let html = concat!(
        "<style>\n",
        "------\n",
        "@@ @@\n",
        "</style>\n",
        "<pre>\n",
        "~~~~\n",
        "</pre>\n",
    );

    let restored = RenderService::restore_residual_wikidot_separator_markers(html);

    assert_eq!(restored, html);
}

#[test]
fn restores_standalone_residual_wikidot_heading_lines() {
    let html = concat!(
        "====\n",
        "++* Info\n",
        "++ 43NET DEVICE REPORT\n",
        "+++ **Chief, Security and Containment Section**\n",
        "=====\n",
    );

    let restored = RenderService::restore_residual_wikidot_heading_markers(html);

    assert!(restored.contains("<h2><span>Info</span></h2>"));
    assert!(restored.contains("<h2><span>43NET DEVICE REPORT</span></h2>"));
    assert!(
        restored.contains(
            "<h3><span>**Chief, Security and Containment Section**</span></h3>"
        )
    );
    assert!(!restored.contains("===="));
    assert!(!restored.contains("====="));
    assert!(!restored.contains("++*"));
    assert!(!restored.contains("++ 43NET"));
}

#[test]
fn leaves_standalone_residual_wikidot_heading_lines_inside_raw_text() {
    let html = concat!(
        "<style>\n",
        "++ hidden\n",
        "====\n",
        "</style>\n",
        "<pre>\n",
        "+++ literal\n",
        "</pre>\n",
    );

    let restored = RenderService::restore_residual_wikidot_heading_markers(html);

    assert_eq!(restored, html);
}

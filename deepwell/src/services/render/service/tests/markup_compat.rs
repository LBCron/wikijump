use super::*;

#[test]
fn defaults_empty_scp_style_page_link_labels_to_canonical_slug_text() {
    assert_eq!(native_list_page_link_default_label("scp-8066"), "SCP-8066");
    assert_eq!(native_list_page_link_default_label("SCP-8091"), "SCP-8091");
    assert_eq!(
        native_list_page_link_default_label("scp-2408-jp"),
        "SCP-2408-JP"
    );
    assert_eq!(
        native_list_page_link_default_label("ordinary-page-name"),
        "Ordinary Page Name"
    );
    assert_eq!(
        native_list_page_link_default_label("scp-foundation"),
        "Scp Foundation"
    );

    assert_eq!(
        render_native_list_page_link("scp-8066", None, None),
        r#"<a href="/scp-8066">SCP-8066</a>"#
    );
    assert_eq!(
        render_native_list_page_link(
            "*http://sandbox-for-codex.wikidot.com/example",
            None,
            None,
        ),
        concat!(
            r#"<a target="_blank" href="http://sandbox-for-codex.wikidot.com/example">"#,
            "http://sandbox-for-codex.wikidot.com/example</a>",
        ),
        "Wikidot removes only the leading new-window marker from an unlabeled \
         absolute link; the displayed default label retains the scheme",
    );
    assert_eq!(
        render_native_list_page_link("scp-8066", Some("the article"), None),
        r#"<a href="/scp-8066">the article</a>"#
    );
    assert_eq!(
        render_native_list_page_link("scp-8596", Some(""), None),
        r#"<a href="/scp-8596">SCP-8596</a>"#
    );
}

#[test]
fn defaults_empty_page_link_labels_to_known_target_titles() {
    let mut titles = WikidotCompatLinkTitleMap::new();
    titles.insert(
        "dr-frueh-s-proposal".to_owned(),
        "DarkStuff's Proposal".to_owned(),
    );

    assert_eq!(
        render_native_list_page_link("dr-frueh-s-proposal", None, Some(&titles)),
        r#"<a href="/dr-frueh-s-proposal">DarkStuff's Proposal</a>"#
    );
    assert_eq!(
        render_native_list_page_link(
            "dr-frueh-s-proposal",
            Some("Family Life"),
            Some(&titles),
        ),
        r#"<a href="/dr-frueh-s-proposal">Family Life</a>"#
    );
    assert_eq!(
        render_native_list_page_link("missing-target", None, Some(&titles)),
        r#"<a href="/missing-target">Missing Target</a>"#
    );
    assert_eq!(
        render_native_list_page_link("scp-8066", None, Some(&titles)),
        r#"<a href="/scp-8066">SCP-8066</a>"#
    );
}

#[test]
fn fallback_page_links_mark_only_resolved_missing_targets_as_newpage() {
    let mut titles = WikidotCompatLinkTitleMap::new();
    titles.set_page_existence(
        "scp-wiki".to_owned(),
        PageExistenceSnapshot::from_pages([
            (("scp-wiki".to_owned(), "present".to_owned()), true),
            (("scp-wiki".to_owned(), "missing".to_owned()), false),
            (
                ("scp-wiki".to_owned(), "missing-empty-label".to_owned()),
                false,
            ),
            (("remote".to_owned(), "missing".to_owned()), false),
        ]),
    );

    assert_eq!(
        render_native_list_page_link("present", None, Some(&titles)),
        r#"<a href="/present">Present</a>"#
    );
    assert_eq!(
        render_native_list_page_link("missing", None, Some(&titles)),
        r#"<a class="newpage" href="/missing">Missing</a>"#
    );
    assert_eq!(
        render_native_list_page_link("missing-empty-label", Some(""), Some(&titles)),
        r#"<a class="newpage" href="/missing-empty-label">missing-empty-label</a>"#
    );
    assert_eq!(
        render_native_list_page_link("unresolved", None, Some(&titles)),
        r#"<a href="/unresolved">Unresolved</a>"#
    );
    assert_eq!(
        render_native_list_page_link(":remote:missing", None, Some(&titles)),
        r#"<a class="newpage" href="/:remote:missing">:remote:missing</a>"#
    );
}

#[test]
fn escapes_known_target_titles_used_for_empty_page_link_labels() {
    let mut titles = WikidotCompatLinkTitleMap::new();
    titles.insert(
        "target-page".to_owned(),
        r#"<img src=x onerror=alert(1)>"#.to_owned(),
    );

    assert_eq!(
        render_native_list_page_link("target-page", None, Some(&titles)),
        r#"<a href="/target-page">&lt;img src=x onerror=alert(1)&gt;</a>"#
    );
}

#[test]
fn wikidot_compatibility_fallback_uses_known_target_titles_for_empty_links() {
    let mut titles = WikidotCompatLinkTitleMap::new();
    titles.insert(
        "dr-frueh-s-proposal".to_owned(),
        "DarkStuff's Proposal".to_owned(),
    );

    let output = RenderService::render_wikidot_compatibility_fallback_output_for_context(
        "[[[dr-frueh-s-proposal|]]]\n[[[scp-8066|]]]\n[[[missing-target|]]]",
        Some("scp-anthology-2024"),
        Some("scp-wiki"),
        Some(&titles),
    );

    assert!(
        output
            .body
            .contains(r#"<a href="/dr-frueh-s-proposal">DarkStuff's Proposal</a>"#),
        "{}",
        output.body,
    );
    assert!(output.body.contains(r#"<a href="/scp-8066">SCP-8066</a>"#));
    assert!(
        output
            .body
            .contains(r#"<a href="/missing-target">Missing Target</a>"#)
    );
}

#[test]
fn finds_balanced_ul_end_for_deep_lists_in_one_forward_pass() {
    let mut html = String::from(
        r#"<ul data-wikijump-compat-list="1">
"#,
    );
    for _ in 0..192 {
        html.push_str("<ul>\n");
    }
    for _ in 0..192 {
        html.push_str("</ul>\n");
    }
    html.push_str("</ul>after");

    let end = find_balanced_ul_end(&html).expect("deep generated list should balance");

    assert_eq!(&html[end..], "after");
}

#[test]
fn extracts_css_modules_before_ftml_parsing() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = concat!(
        "before\n",
        "[[module css]]\n",
        "#u-change{\n",
        "    display:none;\n",
        "}\n",
        "[[/module]]\n",
        "after\n",
    )
    .to_owned();

    let styles = extract_wikidot_css_modules(&mut source, &settings);

    assert_eq!(styles, ["#u-change{\n    display:none;\n}"]);
    assert!(!source.contains(WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX));
    assert!(!source.contains("[[module css]]"));
    assert!(!source.contains("#u-change"));
}

#[test]
fn protects_css_before_list_pages_and_rejoins_the_outer_pipeline() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = concat!(
        "before\n",
        "[[module css]]\n.early { content: \"##\"; }\n[[/module]]\n",
        "[[module ListPages range=\".\"]]%%title%%[[/module]]\n",
        "[[module css]]\n.late { content: \"##\"; }\n[[/module]]\n",
        "after\n",
    )
    .to_owned();

    let protected = RenderService::protect_wikidot_css_modules_before_first_list_pages(
        &mut source,
        &settings,
    )
    .expect("complete prefix CSS should be protected");

    assert!(!source.contains(".early"));
    assert!(source.contains(COMPAT_TEXT_MARKER_PREFIX));
    assert!(source.contains("[[module ListPages"));
    assert!(source.contains(".late"));

    let list_pages_start = source.find("[[module ListPages").unwrap();
    let list_pages_end = list_pages_start
        + source[list_pages_start..].find("[[/module]]").unwrap()
        + "[[/module]]".len();
    source.replace_range(
        list_pages_start..list_pages_end,
        "[[module css]]\n.generated { content: \"##\"; }\n[[/module]]",
    );
    source = protected.restore(&source);
    assert!(source.find(".early").unwrap() < source.find(".generated").unwrap());
    assert!(source.find(".generated").unwrap() < source.find(".late").unwrap());

    let page_info = fallback_test_page_info("css-list-pages", "CSS ListPages");
    let outer = RenderService::prepare_outer_render_wikitext(
        super::super::ExpandedRenderWikitext {
            theme_previewer_blank: false,
            wikidot_compat_html: CompatHtmlFragments::new(&source),
            wikidot_compat_text: CompatTextFragments::new(&source),
            wikitext: source,
            included_pages: Vec::new(),
            expanded_include_count: 0,
            url_offset_list_pages_content_bytes: 0,
            runtime_css_insertions: Vec::new(),
        },
        &page_info,
        &settings,
    );

    let css_modules = outer
        .protection
        .restore(|protection| protection.take_css_modules(|text| text.to_owned()));
    assert_eq!(
        css_modules,
        [
            ".early { content: \"##\"; }",
            ".generated { content: \"##\"; }",
            ".late { content: \"##\"; }",
        ]
    );
}

#[test]
fn css_spanning_a_raw_list_pages_candidate_stays_for_the_full_scanner() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let original = concat!(
        "[[module css]]\n",
        ".literal::after { content: \"[[module ListPages range='.' ]]\"; }\n",
        "[[/module]]\n",
        "[[module ListPages range=\".\"]]%%title%%[[/module]]\n",
    );
    let mut source = original.to_owned();

    let protected = RenderService::protect_wikidot_css_modules_before_first_list_pages(
        &mut source,
        &settings,
    );

    assert!(protected.is_none());
    assert_eq!(source, original);
}

#[test]
fn literal_candidate_boundaries_keep_owned_css_unchanged() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    for original in [
        "[!-- [[module css]]\n.comment {}\n[[/module]] [[module ListPages]] --]\n[[module ListPages]]live[[/module]]",
        "[[code]]\n[[module css]]\n.code {}\n[[/module]] [[module ListPages]]\n[[/code]]\n[[module ListPages]]live[[/module]]",
    ] {
        let mut source = original.to_owned();

        let protected =
            RenderService::protect_wikidot_css_modules_before_first_list_pages(
                &mut source,
                &settings,
            );

        assert!(protected.is_none(), "{original}");
        assert_eq!(source, original);
    }
}

#[test]
fn leaves_quote_prefixed_css_modules_for_ftml_literal_rendering() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    for original in [
        "> [[module CSS]]\n> .one { color: red; }\n> [[/module]]",
        ">> [[module CSS]]\n>> .two { color: red; }\n>> [[/module]]",
        "> > [[module CSS]]\n> > .inner { color: red; }\n> > [[/module]]",
    ] {
        let mut source = original.to_owned();
        let styles = extract_wikidot_css_modules(&mut source, &settings);

        assert_eq!(source, original);
        assert!(styles.is_empty());
    }
}

#[test]
fn css_module_openers_are_recognized_only_at_the_start_of_a_line() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);

    for original in [
        "text {{[[module CSS]]}} more",
        "text [[module CSS]] more\n.x { color: red; }\n[[/module]]",
        "a [[module CSS]].x{color:red}[[/module]] b",
    ] {
        let mut source = original.to_owned();
        let styles = extract_wikidot_css_modules(&mut source, &settings);

        assert_eq!(source, original);
        assert!(styles.is_empty(), "{original}");
    }

    let mut source = concat!(
        "docs: {{[[module CSS]]}}\n\n",
        "[[code type=\"CSS\"]]\n.kept { color: red; }\n[[/code]]\n\n",
        "[[module CSS]]\n.real { color: blue; }\n[[/module]]\n",
    )
    .to_owned();
    let styles = extract_wikidot_css_modules(&mut source, &settings);

    assert_eq!(styles.len(), 1);
    assert!(styles[0].contains(".real"));
    assert!(!styles[0].contains(".kept"));
    assert!(source.contains("docs: {{[[module CSS]]}}"));
    assert!(source.contains(".kept { color: red; }"));

    let mut source =
        " [[module CSS]]\n.indented { color: blue; }\n[[/module]]\n".to_owned();
    let styles = extract_wikidot_css_modules(&mut source, &settings);
    assert_eq!(styles.len(), 1);
    assert!(styles[0].contains(".indented"));
}

#[test]
fn escapes_css_module_style_end_tags() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = concat!(
        "[[module css]]\n",
        "</style><img src=x onerror=alert(1)><style>\n",
        "[[/module]]\n",
    )
    .to_owned();

    let styles = extract_wikidot_css_modules(&mut source, &settings);

    assert_eq!(styles.len(), 1);
    assert!(!styles[0].contains("</style><img"));
    assert!(styles[0].contains(r"\3C /style>\3C img"));
}

#[test]
fn css_registry_handles_multiple_literal_and_malformed_boundaries() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let source = concat!(
        "[[module css]]\n.first { color: red; }\n[[/module]]\n",
        "[!-- comment starts\n[[module css]]\n.comment { color: bad; }\n",
        "[[/module]]\n--]\n",
        "[[module css]]\n.second { color: blue; }\n[[/module]]\n",
        "[[module css]]\n.spanning { color: black; }\n",
        "[!-- [[/module]] --]\n.end { color: white; }\n[[/module]]\n",
        "[[html]]\n[[module css]]\n.html { color: green; }\n[[/module]]\n[[/html]]\n",
        "[[module css]]\n.unclosed { display: none; }\n",
    );
    let mut protected = source.to_owned();
    let styles = extract_wikidot_css_modules(&mut protected, &settings);

    assert_eq!(styles.len(), 3);
    assert!(styles[0].contains(".first { color: red; }"));
    assert!(styles[1].contains(".second { color: blue; }"));
    assert!(styles[2].contains(".spanning { color: black; }"));
    assert!(styles[2].contains(".end { color: white; }"));
    assert!(protected.contains(".comment { color: bad; }"));
    assert!(protected.contains("[[html]]\n[[module css]]\n.html"));
    assert!(protected.contains("[[module css]]\n.unclosed"));
    assert!(!protected.contains(WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX));
}

#[test]
fn css_extraction_keeps_normal_and_fallback_outputs_free_of_style_wrappers() {
    let source = concat!(
        "before\n",
        "[[module css]]\n.a { color: red; }\n[[/module]]\n",
        "[[module css]]\n.b::after { content: \"</style>\"; }\n[[/module]]\n",
        "after\n",
    );

    for fallback in [false, true] {
        let (html, styles) = render_wikidot_css_after_extraction(source, fallback);
        assert_eq!(styles.len(), 2);
        assert!(styles[0].contains(".a { color: red; }"));
        assert!(styles[1].contains(r#".b::after { content: "\3C /style>"; }"#));
        assert!(!html.contains("<style"));
        assert!(!html.contains(WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX));
        assert!(!html.contains("[[module css]]"));
    }
}

#[test]
fn protects_wikidot_bold_underline_spans_before_ftml_parsing() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source =
        "**##C5000B|That might be the reason.**##\n**__10 October 2022**__\n**In which the finale is foreshadowed**\n"
            .to_owned();

    let spans = RenderService::protect_wikidot_inline_html_spans(&mut source, &settings);

    assert_eq!(spans.len(), 2);
    assert!(source.contains(&spans[0].marker));
    assert!(!source.contains("**##C5000B"));
    assert!(!source.contains("**__10 October 2022**__"));
    assert_eq!(
        spans[0].html,
        r#"<strong><span style="color: #c5000b">That might be the reason.</span></strong>"#
    );
    assert_eq!(spans[1].html, r#"<strong><u>10 October 2022</u></strong>"#);

    let restored = RenderService::restore_protected_wikidot_inline_html(source, &spans);
    assert!(restored.contains(
        r#"<strong><span style="color: #c5000b">That might be the reason.</span></strong>"#
    ));
    assert!(restored.contains(r#"<strong><u>10 October 2022</u></strong>"#));
    assert!(restored.contains("**In which the finale is foreshadowed**"));
}

#[test]
fn protects_nested_bold_underline_closers_without_crossing_table_cells() {
    const ROW_COUNT: usize = 128;

    let page_info = fallback_test_page_info("nested-inline-table", "Nested inline table");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let row = concat!(
        "||= 1 || [[span style=\"font-family: 'Handlee' ;\"]]",
        "##000080|**__B-Roll:__** body##[[/span]] || ",
        "**__V.O.:__** narration ||\n",
    );
    let mut source = row.repeat(ROW_COUNT);

    let inline_spans =
        RenderService::protect_wikidot_inline_html_spans(&mut source, &settings);
    let color_spans = RenderService::protect_wikidot_color_spans(&mut source, &settings);
    let mut compat_text = CompatTextFragments::new(&source);
    source = RenderService::protect_unrendered_wikidot_color_markers(
        source,
        &settings,
        &mut compat_text,
    );

    assert_eq!(inline_spans.len(), ROW_COUNT * 2);
    assert_eq!(color_spans.len(), ROW_COUNT);
    assert!(!source.contains("**__"), "{source}");
    assert!(!source.contains("__**"), "{source}");
    assert!(
        inline_spans
            .iter()
            .any(|span| span.html == "<strong><u>B-Roll:</u></strong>"),
    );
    assert!(
        inline_spans
            .iter()
            .any(|span| span.html == "<strong><u>V.O.:</u></strong>"),
    );

    let started = Instant::now();
    ftml::preprocess_for_layout(&mut source, settings.layout);
    let tokens = ftml::tokenize(&source);
    let result = ftml::parse(&tokens, &page_info, &settings);
    let (_tree, errors) = result.into();

    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(errors.is_empty(), "{errors:#?}");
}

#[test]
fn protects_wikidot_escaped_nbsp_entities_before_ftml_parsing() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = r#"Icon @<&nbsp;>@ label"#.to_owned();

    let spans = RenderService::protect_wikidot_inline_html_spans(&mut source, &settings);

    assert_eq!(spans.len(), 1);
    assert!(source.contains(&spans[0].marker));
    assert!(!source.contains("@<&nbsp;>@"));
    assert_eq!(spans[0].html, "&nbsp;");

    let restored = RenderService::restore_protected_wikidot_inline_html(source, &spans);
    assert!(restored.contains("Icon &nbsp; label"));
}

#[test]
fn protects_wikidot_bold_outer_color_spans_before_cross_line_matching() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = concat!(
        "//<Dr. Lillihammer and Thilo Zwist are walking through **##green|a dense and mysterious forest##**. ",
        "As they move down **##sienna|a gently arcing path##**, **##ce005c|enigmatic figures##** can be glimpsed ",
        "in **##green|the distant underbrush##**.>//\n",
        "**##orange|Giftschreiber/Guard##:** **##orange|You're/we're##** not **##red|[SAFEGUARDS ENGAGED]##**.\n",
        "**##ce005c|What## ##blue|the ghost of long-drowned sorrow## ##ce005c|says is true.##**\n",
        "protected from **##ce005c |the fae the fae the fae##** work\n",
        "**##C5000B|That might be the reason.**##\n",
    )
    .to_owned();

    let inline_spans =
        RenderService::protect_wikidot_inline_html_spans(&mut source, &settings);
    let color_spans = RenderService::protect_wikidot_color_spans(&mut source, &settings);

    assert_eq!(inline_spans.len() + color_spans.len(), 12);
    assert!(!source.contains("sienna|a gently"));
    assert!(!source.contains("forest##**"));
    assert!(!source.contains("figures##**"));
    assert!(!source.contains("Dr. Lillihammer##"));
    assert!(!source.contains("##orange|You're/we're"));
    assert!(!source.contains("##blue|the ghost"));
    assert!(!source.contains("##ce005c |the fae"));
    assert!(source.contains("//<Dr. Lillihammer"));
    assert!(inline_spans.iter().any(|span| span.html.contains(
        r#"<strong><span style="color: green">a dense and mysterious forest</span></strong>"#
    )));
    assert!(inline_spans.iter().any(|span| span.html.contains(
        r#"<strong><span style="color: #c5000b">That might be the reason.</span></strong>"#
    )));
    assert!(color_spans.iter().any(|span| span.html.contains(
        r#"<span style="color: blue">the ghost of long-drowned sorrow</span>"#
    )));
}

#[test]
fn protects_wikidot_color_spans_before_ftml_parsing() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = "##blue|**[[include :scp-wiki:component:coltop**##\n".to_owned();

    let spans = RenderService::protect_wikidot_color_spans(&mut source, &settings);

    assert_eq!(spans.len(), 1);
    assert!(source.contains(&spans[0].marker));
    assert!(source.ends_with('\n'));
    assert!(!source.contains("<span"));
    assert!(!source.contains("##blue"));
    assert!(source.contains("**[[include :scp-wiki:component:coltop**"));
    assert_eq!(
        spans[0].html,
        r#"<span style="color: blue">**[[include :scp-wiki:component:coltop**</span>"#
    );

    let restored = RenderService::restore_protected_wikidot_color_spans(source, &spans);
    assert_eq!(
        restored,
        r#"<span style="color: blue">**[[include :scp-wiki:component:coltop**</span>"#
            .to_owned()
            + "\n",
    );
    assert_eq!(
        render_wikidot_inline_markup_after_protection(
            "##blue|**[[include :scp-wiki:component:coltop**##\n"
        ),
        r#"<p><span style="color: blue"><strong>[[include :scp-wiki:component:coltop</strong></span></p>"#,
    );

    let mut compat_text = CompatTextFragments::new("");
    let protected = RenderService::protect_unrendered_wikidot_color_markers(
        "####blue|leftover##".to_owned(),
        &settings,
        &mut compat_text,
    );
    assert_eq!(compat_text.restore(&protected), "####blue|leftover##");

    let mut compat_text = CompatTextFragments::new("");
    let protected = RenderService::protect_unrendered_wikidot_color_markers(
        "[[[home###|Home]]] [[[MAIN/##/page#toc1|Hash routing]]] leftover##".to_owned(),
        &settings,
        &mut compat_text,
    );
    assert_eq!(
        compat_text.restore(&protected),
        "[[[home###|Home]]] [[[MAIN/##/page#toc1|Hash routing]]] leftover##",
    );
}

#[test]
fn protects_colors_only_outside_authored_literal_and_attribute_regions() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = concat!(
        "##red|ordinary##\n",
        "[[span data-color=\"##red|wikidot attribute##\"]]body[[/span]]\n",
        "<span title='quoted > ##red|html attribute##'>body</span>\n",
        "@@##red|escaped##@@\n",
        "[!-- ##red|comment## --]\n",
        "[[code]]\n##red|code##\n[[/code]]\n",
        "[[html]]\n##red|html##\n[[/html]]\n",
    )
    .to_owned();

    let spans = RenderService::protect_wikidot_color_spans(&mut source, &settings);

    assert_eq!(spans.len(), 1);
    assert!(source.starts_with(&spans[0].marker));
    for literal in [
        "##red|wikidot attribute##",
        "##red|html attribute##",
        "##red|escaped##",
        "##red|comment##",
        "##red|code##",
        "##red|html##",
    ] {
        assert!(source.contains(literal), "missing literal {literal}");
    }
}

#[test]
fn restores_registered_colors_only_in_rendered_html_text_nodes_linearly() {
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut source = (0..2_048)
        .map(|index| format!("##red|replacement-{index}##"))
        .collect::<Vec<_>>()
        .join("|");
    let spans = RenderService::protect_wikidot_color_spans(&mut source, &settings);
    assert_eq!(spans.len(), 2_048);

    let protected_marker = spans[0].marker.clone();
    let rendered = format!(
        "{source}<a title=\"quoted > {protected_marker}\">attribute</a><!-- {protected_marker} --><pre>{protected_marker}</pre>",
    );
    let restored = RenderService::restore_protected_wikidot_color_spans(rendered, &spans);

    assert!(restored.starts_with(r#"<span style="color: red">replacement-0</span>"#));
    assert_eq!(
        restored.matches(r#"<span style="color: red">"#).count(),
        2_048
    );
    assert_eq!(restored.matches(&protected_marker).count(), 3);
}

#[test]
fn restores_color_inside_inline_monospace_from_ralliston_authorpage() {
    let page_info =
        fallback_test_page_info("ralliston-s-authorpage", "Ralliston's Authorpage");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut wikitext = "//**{{##f24|the fun never ends.##}}**//".to_owned();

    let inline_spans =
        RenderService::protect_wikidot_inline_html_spans(&mut wikitext, &settings);
    let color_spans =
        RenderService::protect_wikidot_color_spans(&mut wikitext, &settings);
    let mut compat_text = CompatTextFragments::new(&wikitext);
    wikitext = RenderService::protect_unrendered_wikidot_color_markers(
        wikitext,
        &settings,
        &mut compat_text,
    );
    ftml::preprocess_for_layout(&mut wikitext, settings.layout);
    let tokens = ftml::tokenize(&wikitext);
    let result = ftml::parse(&tokens, &page_info, &settings);
    let (tree, errors) = result.into();
    assert!(errors.is_empty(), "{errors:?}");

    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
    let rendered =
        RenderService::restore_protected_wikidot_color_spans(rendered, &color_spans);
    let rendered =
        RenderService::restore_protected_wikidot_inline_html(rendered, &inline_spans);
    let rendered = compat_text.restore(&rendered);

    assert!(rendered.contains(
        r#"<em><strong><tt><span style="color: #f24">the fun never ends.</span></tt></strong></em>"#,
    ));
    assert!(!rendered.contains("WIKIJUMPWIKIDOTCOMPATHTML"));
}

#[test]
fn restores_color_spans_inside_authored_code_div_from_component_coltop() {
    let page_info = fallback_test_page_info("component:coltop", "ColTop Component");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut wikitext = concat!(
        "[[div class=\"code\"]]\n",
        "##blue|**bold**##\n",
        "[[/div]]\n",
        "[[code]]\n",
        "##blue|literal##\n",
        "[[/code]]\n",
    )
    .to_owned();

    let color_spans =
        RenderService::protect_wikidot_color_spans(&mut wikitext, &settings);
    assert_eq!(color_spans.len(), 1);
    assert!(wikitext.contains("##blue|literal##"));

    ftml::preprocess_for_layout(&mut wikitext, settings.layout);
    let tokens = ftml::tokenize(&wikitext);
    let result = ftml::parse(&tokens, &page_info, &settings);
    let (tree, errors) = result.into();
    assert!(errors.is_empty(), "{errors:?}");

    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
    let rendered =
        RenderService::restore_protected_wikidot_color_spans(rendered, &color_spans);

    assert!(rendered.contains(r#"<div class="code">"#));
    assert!(
        rendered.contains(r#"<span style="color: blue"><strong>bold</strong></span>"#)
    );
    assert!(rendered.contains("##blue|literal##"));
    assert!(!rendered.contains(WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX));
}

#[test]
fn protects_wikidot_hash_prefixed_hex_colors_without_shifted_matches() {
    let page_info = fallback_test_page_info("scp-6670", "SCP-6670");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut wikitext = concat!(
        "###880808|plain##\n",
        "**###880808|bold outer##**\n",
        "**###880808|bold inner**##\n",
        "###12345|bad five##\n",
        "###gggggg|bad nonhex##\n",
        "####880808|bad run##\n",
        "###880808;background:red|bad css##\n",
    )
    .to_owned();

    let inline_spans =
        RenderService::protect_wikidot_inline_html_spans(&mut wikitext, &settings);
    let color_spans =
        RenderService::protect_wikidot_color_spans(&mut wikitext, &settings);
    assert_eq!(inline_spans.len(), 2);
    assert_eq!(color_spans.len(), 1);

    let mut compat_text = CompatTextFragments::new(&wikitext);
    wikitext = RenderService::protect_unrendered_wikidot_color_markers(
        wikitext,
        &settings,
        &mut compat_text,
    );
    ftml::preprocess_for_layout(&mut wikitext, settings.layout);
    let tokens = ftml::tokenize(&wikitext);
    let result = ftml::parse(&tokens, &page_info, &settings);
    let (tree, errors) = result.into();
    assert!(errors.is_empty(), "{errors:?}");

    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
    let rendered =
        RenderService::restore_protected_wikidot_color_spans(rendered, &color_spans);
    let rendered =
        RenderService::restore_protected_wikidot_inline_html(rendered, &inline_spans);
    let rendered = compat_text.restore(&rendered);

    assert!(rendered.contains(r#"<span style="color: #880808">plain</span>"#));
    assert!(
        rendered.contains(
            r#"<strong><span style="color: #880808">bold outer</span></strong>"#
        )
    );
    assert!(
        rendered.contains(
            r#"<strong><span style="color: #880808">bold inner</span></strong>"#
        )
    );
    assert!(!rendered.contains(r#"#<span style="color: 880808">"#));
    assert!(!rendered.contains(r#"style="color: 880808""#));
    assert!(!rendered.contains(r#"style="color: 12345""#));
    assert!(!rendered.contains(r#"style="color: gggggg""#));
    assert!(!rendered.contains(r#"style="color: 880808;background"#));
}

#[test]
fn wikidot_color_descriptor_normalizes_three_or_six_hex_digits() {
    assert_eq!(
        parse_wikidot_compat_color_descriptor("###", "abc").as_deref(),
        Some("#abc"),
    );
    assert_eq!(
        parse_wikidot_compat_color_descriptor("###", "880808").as_deref(),
        Some("#880808"),
    );
    assert!(parse_wikidot_compat_color_descriptor("###", "12345").is_none());
    assert!(parse_wikidot_compat_color_descriptor("###", "gggggg").is_none());
    assert!(parse_wikidot_compat_color_descriptor("####", "880808").is_none());
    assert_eq!(
        parse_wikidot_compat_color_descriptor("##", "blue").as_deref(),
        Some("blue"),
    );
    assert_eq!(
        parse_wikidot_compat_color_descriptor("##", "ABC").as_deref(),
        Some("#abc"),
    );
    assert_eq!(
        parse_wikidot_compat_color_descriptor("##", "8E2C4D").as_deref(),
        Some("#8e2c4d"),
    );
}

#[test]
fn renders_protected_wikidot_color_spans_as_html_after_ftml_parsing() {
    let page_info = fallback_test_page_info("scp-8382", "SCP-8382");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut wikitext = concat!(
        "+ ##8E2C4D|Lillian S. Lillihammer##\n\n",
        "**##8E2C4D|Memetics and Countermemetics##**\n",
        "**##ce005c|I am... I //should// be...##**\n",
        "**##C5000B|PATH uses North -- heading for the arctic -- red.##**\n",
        "##C5000B|**That might be the reason.**##\n",
    )
    .to_owned();

    let spans = RenderService::protect_wikidot_color_spans(&mut wikitext, &settings);
    let mut compat_text = CompatTextFragments::new(&wikitext);
    wikitext = RenderService::protect_unrendered_wikidot_color_markers(
        wikitext,
        &settings,
        &mut compat_text,
    );
    ftml::preprocess_for_layout(&mut wikitext, settings.layout);
    let tokens = ftml::tokenize(&wikitext);
    let result = ftml::parse(&tokens, &page_info, &settings);
    let (tree, errors) = result.into();
    assert!(errors.is_empty(), "{errors:?}");

    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
    let rendered = RenderService::restore_protected_wikidot_color_spans(rendered, &spans);
    let rendered = compat_text.restore(&rendered);

    assert!(
        rendered.contains(
            r#"<h1 id="toc0"><span><span style="color: #8e2c4d">Lillian S. Lillihammer</span></span></h1>"#
        ),
        "{rendered}"
    );
    assert!(rendered.contains(
        r#"<strong><span style="color: #8e2c4d">Memetics and Countermemetics</span></strong>"#
    ));
    assert!(
        rendered.contains(
            r#"<strong><span style="color: #ce005c">I am… I <em>should</em> be…</span></strong>"#
        ),
        "{rendered}",
    );
    assert!(rendered.contains(
        r#"<strong><span style="color: #c5000b">PATH uses North — heading for the arctic — red.</span></strong>"#
    ));
    assert!(rendered.contains(
        r#"<span style="color: #c5000b"><strong>That might be the reason.</strong></span>"#
    ));
    assert!(!rendered.contains("&lt;span"));
    assert!(!rendered.contains(WIKIDOT_COLOR_SPAN_SENTINEL_PREFIX));
}

#[test]
fn protected_wikidot_inline_typography_does_not_rewrite_tag_attributes() {
    let rendered = super::super::render_wikidot_protected_inline_body_html(
        "[https://example.com/a--b go -- now...]",
    );

    assert_eq!(
        rendered,
        r#"<a href="https://example.com/a--b">go — now…</a>"#
    );
}

#[test]
fn protected_inline_dash_substitution_preserves_only_closed_comments() {
    let rendered = super::super::substitute_wikidot_protected_inline_dashes(
        "before -- [!-- keep -- unchanged --] after -- [!-- open -- tail",
    );

    assert_eq!(
        rendered,
        "before — [!-- keep -- unchanged --] after — [!— open — tail",
    );
}

#[test]
fn protected_inline_dash_substitution_handles_adjacent_and_empty_comments() {
    let rendered = super::super::substitute_wikidot_protected_inline_dashes(
        "[!----][!-- a -- b --]--[!----]",
    );

    assert_eq!(rendered, "[!----][!-- a -- b --]—[!----]");
}

#[test]
fn malformed_comment_dash_substitution_has_deterministic_linear_scan_growth() {
    fn exercise(marker_count: usize) -> (usize, usize) {
        let input = format!("{}--tail", "[!--".repeat(marker_count));
        let (rendered, scanned_bytes) =
            super::super::substitute_wikidot_protected_inline_dashes_with_scan_count(
                &input,
            );

        assert_eq!(scanned_bytes, input.len());
        assert!(rendered.ends_with("—tail"));
        assert_eq!(rendered.matches("[!—").count(), marker_count);
        (input.len(), scanned_bytes)
    }

    let (small_len, small_scanned) = exercise(10_000);
    let (large_len, large_scanned) = exercise(20_000);

    assert_eq!(large_len - "--tail".len(), 2 * (small_len - "--tail".len()));
    assert_eq!(
        large_scanned - "--tail".len(),
        2 * (small_scanned - "--tail".len())
    );
}

#[test]
fn moves_sentence_punctuation_outside_wikidot_email_anchor() {
    let html = concat!(
        r#"<p>For more information, contact "#,
        r#"<span class="wiki-email" style="visibility: visible;">"#,
        r#"<a href="mailto:training@nfsi.gov.">training@nfsi.gov.</a></span></p>"#,
    );

    assert_eq!(
        RenderService::restore_wikidot_email_obfuscation(html),
        concat!(
            r#"<p>For more information, contact "#,
            r#"<span class="wiki-email" style="visibility: visible;">"#,
            r#"<a href="mailto:training@nfsi.gov">training@nfsi.gov</a></span>."#,
            r#"</p>"#,
        ),
    );
}

#[test]
fn decodes_escaped_wikidot_email_before_rendering_visible_anchor() {
    let html = concat!(
        r#"<span class="wiki-email" style="visibility: visible;">"#,
        r#"<a href="mailto:o&#39;hara@example.com">o&#39;hara@example.com</a></span>"#,
    );

    assert_eq!(
        RenderService::restore_wikidot_email_obfuscation(html),
        concat!(
            r#"<span class="wiki-email" style="visibility: visible;">"#,
            r#"<a href="mailto:o'hara@example.com">o'hara@example.com</a></span>"#,
        ),
    );
}

#[test]
fn leaves_non_matching_email_spans_unchanged() {
    let html = concat!(
        r#"<span class="wiki-email" style="visibility: visible;">"#,
        r#"<a href="mailto:info@nfsi.gov">different@nfsi.gov</a></span>"#,
    );

    assert_eq!(RenderService::restore_wikidot_email_obfuscation(html), html);
}

#[test]
fn removes_spurious_wikidot_email_classes_after_render() {
    let html = concat!(
        r#"<p><span class="wiki-email">]]etontoof/[[.}}@@]]@|{{#]]etontoof/[[.}}@@]]@|{{</span></p>"#,
        r#"<p><span class="wiki-email">vog.ibf|320sggirb.j#vog.ibf|320sggirb.j</span></p>"#,
    );

    assert_eq!(
        RenderService::remove_spurious_wikidot_email_classes(html),
        concat!(
            r#"<p><span>]]etontoof/[[.}}@@]]@|{{#]]etontoof/[[.}}@@]]@|{{</span></p>"#,
            r#"<p><span class="wiki-email">vog.ibf|320sggirb.j#vog.ibf|320sggirb.j</span></p>"#,
        ),
    );
}

#[test]
fn preserves_recoverable_wikidot_email_classes_after_render() {
    let html = concat!(
        r#"<p>Jim Briggs <span class="wiki-email">"#,
        r#"]]naps/[[;tg&vog.ibf|320sggirb.j;tl&#]]naps/[[;tg&vog.ibf|320sggirb.j;tl&"#,
        r#"</span></p>"#,
    );

    assert_eq!(
        RenderService::remove_spurious_wikidot_email_classes(html),
        concat!(
            r#"<p>Jim Briggs <span class="wiki-email">"#,
            r#"vog.ibf|320sggirb.j#vog.ibf|320sggirb.j"#,
            r#"</span></p>"#,
        ),
    );
}

#[test]
fn localizes_matching_wikidot_local_file_urls() {
    let site = wikidot_site(
        "scp-wiki-en-corpus-scp9506-slice-v2",
        Some("scp-wiki.wikidot.com"),
    );
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html = concat!(
        r#"<p><img src="http://scp-wiki.wikidot.com/local--files/scp-9506/NFSI.png?download=true#frag">"#,
        r#"<a href='https://scp-wiki.wdfiles.com:443/local--files/scp-9506/NAME%20HERE.png'>"#,
        r#"file</a>"#,
        r#"<img class="image crom-thumbnail" src="https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.com/local--files/scp-9506/NFSI.png">"#,
        r#"<img src="https://scp-wiki.wjfiles.com/local--resized-images/scp-9506/NFSI.png/medium.jpg">"#,
        r#"<style>:root{--logo:url(http://scp-wiki.wikidot.com/local--files/scp-9506/NFSI.png)}</style>"#,
        r#"<style>.quoted{background:url('http://scp-wiki.wikidot.com/local--files/scp-9506/BG.png')}</style>"#,
        r#"<style>@import "https://scp-wiki.wdfiles.com/local--code/theme%3Abasalt/1";</style>"#,
        r#"<style>@import url(https://scp-wiki.wdfiles.com/local--code/component:betterfootnotes/1)</style>"#,
        r#"</p>"#,
    );

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config,),
        concat!(
            r#"<p><img src="https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--files/scp-9506/NFSI.png?download=true#frag">"#,
            r#"<a href='https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--files/scp-9506/NAME%20HERE.png'>"#,
            r#"file</a>"#,
            r#"<img class="image crom-thumbnail" src="https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--files/scp-9506/NFSI.png">"#,
            r#"<img src="https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--resized-images/scp-9506/NFSI.png/medium.jpg">"#,
            r#"<style>:root{--logo:url(https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--files/scp-9506/NFSI.png)}</style>"#,
            r#"<style>.quoted{background:url('https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--files/scp-9506/BG.png')}</style>"#,
            r#"<style>@import "https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--code/theme%3Abasalt/1";</style>"#,
            r#"<style>@import url(https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--code/component:betterfootnotes/1)</style>"#,
            r#"</p>"#,
        ),
    );
}

#[test]
fn localizes_wikidot_page_code_routes_and_double_slash_code_urls_in_stylesheets() {
    let site = wikidot_site("scp-wiki-en-corpus", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html = concat!(
        r#"<style>@import url(https://scp-wiki.wikidot.com/theme:al-slop/code/1);</style>"#,
        r#"<style>@import url("http://scp-wiki.wikidot.com/component:wide-image-sizer/code/12?x=1");</style>"#,
        r#"<style>@import url(https://scp-wiki.wikidot.com//local--code/theme:much-cool/1);</style>"#,
        r#"<link href="https://scp-wiki.wikidot.com//local--code/theme%3Amuch-cool/2">"#,
        r#"<style>@import url(https://scp-wiki.wikidot.com/theme%3Abasalt/code/3);</style>"#,
    );

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config),
        concat!(
            r#"<style>@import url(https://scp-wiki-en-corpus.wjfiles.localhost/local--code/theme%3Aal-slop/1);</style>"#,
            r#"<style>@import url("https://scp-wiki-en-corpus.wjfiles.localhost/local--code/component%3Awide-image-sizer/12?x=1");</style>"#,
            r#"<style>@import url(https://scp-wiki-en-corpus.wjfiles.localhost/local--code/theme:much-cool/1);</style>"#,
            r#"<link href="https://scp-wiki-en-corpus.wjfiles.localhost/local--code/theme%3Amuch-cool/2">"#,
            r#"<style>@import url(https://scp-wiki-en-corpus.wjfiles.localhost/local--code/theme%3Abasalt/3);</style>"#,
        ),
    );
}

#[test]
fn leaves_other_wikidot_urls_that_only_resemble_the_page_code_route() {
    let site = wikidot_site("scp-wiki-en-corpus", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    for html in [
        r#"<style>@import url(https://scp-wiki.wikidot.com/theme:al-slop/code);</style>"#,
        r#"<style>@import url(https://scp-wiki.wikidot.com/theme:al-slop/code/1/extra);</style>"#,
        r#"<style>@import url(https://scp-wiki.wikidot.com/theme:al-slop/code/x);</style>"#,
        r#"<a href="https://scp-wiki.wikidot.com/theme:al-slop/code/1">code</a>"#,
        r#"<style>@import url(https://example.test/theme:al-slop/code/1);</style>"#,
        r#"<style>@import url(https://another-site.wikidot.com/theme:x/code/1);</style>"#,
    ] {
        assert_eq!(
            RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config),
            html,
        );
    }
}

#[test]
fn renders_and_localizes_wikidot_file_attachment_link() {
    let page_info = fallback_test_page_info("scp-2276", "SCP-2276");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let tokens = ftml::tokenize("[[file elements.tsv | Download Catalog]]");
    let (tree, errors) = ftml::parse(&tokens, &page_info, &settings).into();
    assert!(errors.is_empty(), "{errors:#?}");

    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
    assert_eq!(
        rendered,
        r#"<p><a href="https://scp-wiki.wjfiles.com/local--files/scp-2276/elements.tsv">Download Catalog</a></p>"#,
    );

    let site = wikidot_site("scp-wiki-en-corpus", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();

    assert_eq!(
        RenderService::restore_wikidot_render_compatibility_for_context_with_resources(
            &rendered,
            Some(&site),
            &config,
            true,
            &[],
        ),
        r#"<p><a href="https://scp-wiki-en-corpus.wjfiles.localhost/local--files/scp-2276/elements.tsv">Download Catalog</a></p>"#,
    );
}

#[test]
fn localizes_when_site_slug_is_wikidot_slug() {
    let site = wikidot_site("scp-wiki", None);
    let config = Config::integration_testing();
    let html =
        r#"<img src="http://scp-wiki.wikidot.com/local--files/scp-9506/NFSI.png">"#;

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config,),
        r#"<img src="https://scp-wiki.wjfiles.com/local--files/scp-9506/NFSI.png">"#,
    );
}

#[test]
fn localizes_wikidot_local_file_urls_for_corpus_site_slug() {
    let site = wikidot_site("scp-wiki-en-corpus-scp9506-slice-v2", None);
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html =
        r#"<img src="http://scp-wiki.wikidot.com/local--files/scp-9506/NFSI.png">"#;

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config,),
        r#"<img src="https://scp-wiki-en-corpus-scp9506-slice-v2.wjfiles.localhost/local--files/scp-9506/NFSI.png">"#,
    );
}

#[test]
fn localizes_scp_wiki_source_assets_for_translated_scp_sites() {
    let mut site = wikidot_site(
        "scp-wiki-cn-corpus-scp9506-translation-seed",
        Some("scp-wiki-cn.wikidot.com"),
    );
    site.locale = "cn".to_owned();
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html = concat!(
        r#"<img src="http://scp-wiki.wikidot.com/local--files/scp-9506/NFSI.png">"#,
        r#"<style>@import "https://scp-wiki.wdfiles.com/local--code/theme%3Abasalt/1";</style>"#,
    );

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config,),
        concat!(
            r#"<img src="https://scp-wiki-cn-corpus-scp9506-translation-seed.wjfiles.localhost/local--files/scp-9506/NFSI.png">"#,
            r#"<style>@import "https://scp-wiki-cn-corpus-scp9506-translation-seed.wjfiles.localhost/local--code/theme%3Abasalt/1";</style>"#,
        ),
    );
}

#[test]
fn localizes_reserved_scp_source_assets_to_read_only_local_lab_mirrors() {
    let mut site = wikidot_site("scpaiueouiuiuiui", None);
    site.from_wikidot = false;
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html = concat!(
        r#"<style>.en{background:url(https://scp-wiki.wikidot.com/local--files/theme:ashes-to-ashes/parchment.webp)}</style>"#,
        r#"<img src="https://scp-jp.wdfiles.com/local--files/theme:black-highlighter-theme/logo.svg">"#,
        r#"<img src="https://wanderers-library.wikidot.com/local--files/theme/image.png">"#,
    );

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config),
        concat!(
            r#"<style>.en{background:url(https://scp-wiki.wjfiles.localhost/local--files/theme:ashes-to-ashes/parchment.webp)}</style>"#,
            r#"<img src="https://scp-jp.wjfiles.localhost/local--files/theme:black-highlighter-theme/logo.svg">"#,
            r#"<img src="https://wanderers-library.wdfiles.com/local--files/theme/image.png">"#,
        ),
    );
}

#[test]
fn localizes_reserved_scp_source_assets_in_generated_page_styles() {
    let mut site = wikidot_site("scpaiueouiuiuiui", None);
    site.from_wikidot = false;
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let mut styles = vec![
        ":root { --paper: url(https://scp-wiki.wikidot.com/local--files/theme:ashes-to-ashes/parchment.webp); }".to_owned(),
    ];

    RenderService::localize_wikidot_generated_styles(&mut styles, Some(&site), &config);

    assert_eq!(
        styles,
        [
            ":root { --paper: url(https://scp-wiki.wjfiles.localhost/local--files/theme:ashes-to-ashes/parchment.webp); }"
        ],
    );
}

#[test]
fn localizes_cross_site_wdfiles_local_file_urls_for_imported_corpus_files() {
    let mut site = wikidot_site("scp-wiki", Some("scp-wiki.wikidot.com"));
    site.from_wikidot = false;
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html = concat!(
        r#"<img src="https://scp-sandbox-3.wdfiles.com/local--files/harry-blank-9/Lillihammer_Preview.png">"#,
        r#"<style>.logo{background:url("http://scp-sandbox-3.wdfiles.com/local--files/harry-blank-4/deicidium-logo.svg")}</style>"#,
        r#"<style>@import "https://scp-sandbox-3.wdfiles.com/local--code/theme%3Aforeign/1";</style>"#,
    );

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config,),
        concat!(
            r#"<img src="https://scp-wiki.wjfiles.localhost/local--files/harry-blank-9/Lillihammer_Preview.png">"#,
            r#"<style>.logo{background:url("https://scp-wiki.wjfiles.localhost/local--files/harry-blank-4/deicidium-logo.svg")}</style>"#,
            r#"<style>@import "https://scp-sandbox-3.wdfiles.com/local--code/theme%3Aforeign/1";</style>"#,
        ),
    );
}

#[test]
fn final_render_localizes_restored_wdfiles_urls_in_body_and_generated_styles() {
    let site = wikidot_site("scp-wiki", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let mut body = concat!(
        r#"<img src="https://scp-wiki.wdfiles.com/local--files/scp-3922/theend.jpg?download=true#full">"#,
        r#"<img src="https://assets.example.test/local--files/scp-3922/external.png">"#,
    )
    .to_owned();
    let mut styles = vec![
        r#"@import url("https://scp-wiki.wdfiles.com/local--files/component%3Atheme/font-bauhaus.css");"#.to_owned(),
        r#".external{background:url(https://assets.example.test/local--files/file.png)}"#.to_owned(),
    ];

    RenderService::localize_wikidot_render_output_file_urls(
        &mut body,
        &mut styles,
        Some(&site),
        &config,
    );

    assert_eq!(
        body,
        concat!(
            r#"<img src="https://scp-wiki.wjfiles.localhost/local--files/scp-3922/theend.jpg?download=true#full">"#,
            r#"<img src="https://assets.example.test/local--files/scp-3922/external.png">"#,
        ),
    );
    assert_eq!(
        styles,
        [
            r#"@import url("https://scp-wiki.wjfiles.localhost/local--files/component%3Atheme/font-bauhaus.css");"#,
            r#".external{background:url(https://assets.example.test/local--files/file.png)}"#,
        ],
    );
}

#[test]
fn keeps_wikidot_www_site_attachments_on_their_own_host_in_final_output() {
    let site = wikidot_site("scp-wiki", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let mut body = concat!(
        r#"<img src="https://www.wikidot.com/local--files/files/wikidot_logo_100x30.png">"#,
        r#"<img src="https://www.wdfiles.com/local--files/files/wikidot_logo_100x30.png">"#,
        r#"<img src="https://scp-wiki.wdfiles.com/local--files/scp-3922/theend.jpg">"#,
        r#"<img src="https://scp-sandbox-3.wdfiles.com/local--files/harry-blank-9/Lillihammer_Preview.png">"#,
    )
    .to_owned();
    let mut styles = vec![
        r#".logo{background:url(https://www.wikidot.com/local--files/files/wikidot_logo_100x30.png)}"#.to_owned(),
    ];

    RenderService::localize_wikidot_render_output_file_urls(
        &mut body,
        &mut styles,
        Some(&site),
        &config,
    );

    assert_eq!(
        body,
        concat!(
            r#"<img src="https://www.wikidot.com/local--files/files/wikidot_logo_100x30.png">"#,
            r#"<img src="https://www.wdfiles.com/local--files/files/wikidot_logo_100x30.png">"#,
            r#"<img src="https://scp-wiki.wjfiles.localhost/local--files/scp-3922/theend.jpg">"#,
            r#"<img src="https://scp-wiki.wjfiles.localhost/local--files/harry-blank-9/Lillihammer_Preview.png">"#,
        ),
    );
    assert_eq!(
        styles,
        [
            r#".logo{background:url(https://www.wikidot.com/local--files/files/wikidot_logo_100x30.png)}"#,
        ],
    );
}

#[test]
fn localizes_query_param_asset_urls_in_final_output() {
    let site = wikidot_site("scp-wiki", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let mut body = concat!(
        r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?priority=3&theme=https://scp-wiki.wdfiles.com/local--code/theme%3Abasalt/1&css={$css}" style="display: none"></iframe></p>"#,
        r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?theme=https://scp-wiki.wdfiles.com/local--files/scp-3922/theend.jpg"></iframe></p>"#,
        r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?theme=https://assets.example.test/local--files/scp-3922/external.png"></iframe></p>"#,
        r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?next=https://scp-wiki.wdfiles.com/lily-s-proposal"></iframe></p>"#,
    )
    .to_owned();
    let mut styles: Vec<String> = vec![];

    RenderService::localize_wikidot_render_output_file_urls(
        &mut body,
        &mut styles,
        Some(&site),
        &config,
    );

    assert_eq!(
        body,
        concat!(
            r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?priority=3&theme=https://scp-wiki.wjfiles.localhost/local--code/theme%3Abasalt/1&css={$css}" style="display: none"></iframe></p>"#,
            r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?theme=https://scp-wiki.wjfiles.localhost/local--files/scp-3922/theend.jpg"></iframe></p>"#,
            r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?theme=https://assets.example.test/local--files/scp-3922/external.png"></iframe></p>"#,
            r#"<p><iframe src="/-/wikidot-interwiki/styleFrame.html?next=https://scp-wiki.wdfiles.com/lily-s-proposal"></iframe></p>"#,
        ),
    );
}

#[test]
fn localizes_entity_quoted_urls_in_style_attributes() {
    let site = wikidot_site("scp-wiki", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let mut body = concat!(
        r#"<div class="masthead" style="--_img: url(&#39;https://scp-wiki.wdfiles.com/local--files/theme%3Aredtape/scp_trans.png&#39;)">"#,
        r#"<div class="masthead" style="--_img: url(&#39;https://www.wdfiles.com/local--files/files/wikidot_logo_100x30.png&#39;)">"#,
    )
    .to_owned();
    let mut styles: Vec<String> = vec![];

    RenderService::localize_wikidot_render_output_file_urls(
        &mut body,
        &mut styles,
        Some(&site),
        &config,
    );

    assert_eq!(
        body,
        concat!(
            r#"<div class="masthead" style="--_img: url(&#39;https://scp-wiki.wjfiles.localhost/local--files/theme%3Aredtape/scp_trans.png&#39;)">"#,
            r#"<div class="masthead" style="--_img: url(&#39;https://www.wdfiles.com/local--files/files/wikidot_logo_100x30.png&#39;)">"#,
        ),
    );
}

#[test]
fn keeps_displayed_code_asset_references_literal() {
    let site = wikidot_site("scp-wiki", Some("scp-wiki.wikidot.com"));
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let mut body = r#"<span class="hl-identifier">url(&#39;https://scp-wiki.wdfiles.com/local--files/theme%3Aflopstyle-dark/wl_border.png&#39;)</span>"#
        .to_owned();
    let mut styles: Vec<String> = vec![];

    RenderService::localize_wikidot_render_output_file_urls(
        &mut body,
        &mut styles,
        Some(&site),
        &config,
    );

    assert_eq!(
        body,
        r#"<span class="hl-identifier">url(&#39;https://scp-wiki.wdfiles.com/local--files/theme%3Aflopstyle-dark/wl_border.png&#39;)</span>"#,
    );
}

#[test]
fn sends_cross_site_wikidot_attachments_directly_to_the_file_host() {
    let site = wikidot_site(
        "scp-wiki-en-corpus-scp9506-slice-v2",
        Some("scp-wiki.wikidot.com"),
    );
    let config = Config::integration_testing();
    let html = concat!(
        r#"<img src="https://wanderers-library.wikidot.com/local--files/the-page/image.png">"#,
        r#"<img src="https://wanderers-library.wikidot.com/local--code/theme:basalt/1">"#,
        r#"<style>:root{--logo:url(http://wanderers-library.wikidot.com/local--files/the-page/image.png)}</style>"#,
        r#"<style>@import url(http://wanderers-library.wikidot.com/local--code/the-page/1)</style>"#,
        r#"<img src="https://example.com/local--files/scp-9506/NFSI.png">"#,
    );

    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config,),
        concat!(
            r#"<img src="https://wanderers-library.wdfiles.com/local--files/the-page/image.png">"#,
            r#"<img src="https://wanderers-library.wikidot.com/local--code/theme:basalt/1">"#,
            r#"<style>:root{--logo:url(https://wanderers-library.wdfiles.com/local--files/the-page/image.png)}</style>"#,
            r#"<style>@import url(http://wanderers-library.wikidot.com/local--code/the-page/1)</style>"#,
            r#"<img src="https://example.com/local--files/scp-9506/NFSI.png">"#,
        ),
    );
    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, None, &config),
        html,
    );
}

#[test]
fn code_block_compatibility_preserves_external_css_dependencies() {
    let mut site = wikidot_site(
        "scp-wiki-cn-corpus-scp9506-translation-seed",
        Some("scp-wiki-cn.wikidot.com"),
    );
    site.locale = "cn".to_owned();
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let css = concat!(
        "@import url('https://cdn.scpwiki.com/theme/en/basalt/normalize-min.css');\n",
        "@import url('https://fonts.googleapis.com/css2?family=Sofia+Sans:ital,wght@0,100;0,200;1,900&display=swap');\n",
        "@import url('https://fonts.bunny.net/css2?family=Sofia+Sans:wght@400;900&display=swap');\n",
        "@import url(\"https://scp-wiki-cn-corpus-scp9506-translation-seed.wjfiles.localhost/local--code/theme:basalt/1\");\n",
        "@font-face { src: url('https://cdn.jsdelivr.net/font.woff2') format('woff2'); }\n",
        ".arbitrary { background: url(https://assets.example.test/image.png?size=2x); }\n",
        ".protocol-relative { background: url('//static.example.test/image.svg#icon'); }\n",
        ":root { --logo: url('http://scp-wiki.wikidot.com/local--files/scp-9506/NFSI.png'); }\n",
    );

    let restored = RenderService::restore_wikidot_code_block_compatibility(
        css,
        Some(&site),
        &config,
    );

    let expected = concat!(
        "@import url('https://cdn.scpwiki.com/theme/en/basalt/normalize-min.css');\n",
        "@import url('https://fonts.googleapis.com/css2?family=Sofia+Sans:ital,wght@0,100;0,200;1,900&display=swap');\n",
        "@import url('https://fonts.bunny.net/css2?family=Sofia+Sans:wght@400;900&display=swap');\n",
        "@import url(\"https://scp-wiki-cn-corpus-scp9506-translation-seed.wjfiles.localhost/local--code/theme:basalt/1\");\n",
        "@font-face { src: url('https://cdn.jsdelivr.net/font.woff2') format('woff2'); }\n",
        ".arbitrary { background: url(https://assets.example.test/image.png?size=2x); }\n",
        ".protocol-relative { background: url('//static.example.test/image.svg#icon'); }\n",
        ":root { --logo: url('https://scp-wiki-cn-corpus-scp9506-translation-seed.wjfiles.localhost/local--files/scp-9506/NFSI.png'); }\n",
    );
    assert_eq!(restored, expected);
}

#[test]
fn color_span_bodies_render_nested_inline_syntax_like_wikidot() {
    for (case, source, expected) in [
        (
            "color-sup-italic",
            "##red|^^//a//^^##",
            r#"<span style="color: red"><sup><em>a</em></sup></span>"#,
        ),
        (
            "color-sup-plain",
            "##red|a ^^up^^ b##",
            r#"<span style="color: red">a <sup>up</sup> b</span>"#,
        ),
        (
            "color-sub",
            "##red|a ,,down,, b##",
            r#"<span style="color: red">a <sub>down</sub> b</span>"#,
        ),
        (
            "color-strike",
            "##red|a --gone-- b##",
            r#"<span style="color: red">a <span style="text-decoration: line-through;">gone</span> b</span>"#,
        ),
        (
            "color-mono",
            "##red|a {{mono}} b##",
            r#"<span style="color: red">a <tt>mono</tt> b</span>"#,
        ),
        (
            "color-size",
            "##red|a [[size 80%]]small[[/size]] b##",
            r#"<span style="color: red">a <span style="font-size:80%;">small</span> b</span>"#,
        ),
        (
            "color-link-triple",
            "##red|a [[[scp-173]]] b##",
            r#"<span style="color: red">a <a href="/scp-173">scp-173</a> b</span>"#,
        ),
        (
            "color-italic",
            "##red|a //it// b##",
            r#"<span style="color: red">a <em>it</em> b</span>"#,
        ),
        (
            "color-span-bold",
            "##white|a **bold** c##",
            r#"<span style="color: white">a <strong>bold</strong> c</span>"#,
        ),
    ] {
        assert_eq!(
            render_wikidot_inline_markup_after_protection(&format!("{source}\n\nz")),
            format!("<p>{expected}</p><p>z</p>"),
            "{case}",
        );
    }

    for (case, source, color) in [
        (
            "color-span-footnote-plain",
            "##white|a b[[footnote]]note text[[/footnote]] c##",
            "white",
        ),
        (
            "color-span-footnote-bold",
            "##white|a b[[footnote]]**Bold:** note text[[/footnote]] c##",
            "white",
        ),
        (
            "color-hex-footnote",
            "##ff0000|a b[[footnote]]n[[/footnote]] c##",
            "#ff0000",
        ),
    ] {
        let html =
            render_wikidot_inline_markup_after_protection(&format!("{source}\n\nz"));
        assert!(
            html.starts_with(&format!(
                r#"<p><span style="color: {color}">a b<sup class="footnoteref">"#
            )),
            "{case}: {html}",
        );
        assert!(
            html.contains("</sup> c</span></p><p>z</p>"),
            "{case}: {html}"
        );
        assert!(
            html.contains(r#"<div class="footnotes-footer">"#),
            "{case}: {html}"
        );
        assert!(!html.contains("[[footnote]]"), "{case}: {html}");
    }
}

#[test]
fn color_span_bodies_with_raw_markers_keep_each_span_closed() {
    let html = render_wikidot_inline_markup_after_protection(concat!(
        "it's me, ##transparent|@@@@@@@@@@##. Good thing.\n",
        "\n",
        "**Agent:** ##transparent|@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@##!\n",
    ));

    assert!(!html.contains("WIKIJUMP"), "{html}");
    assert_eq!(
        html.matches(r#"<span style="color: transparent">"#).count(),
        2
    );
    assert!(html.contains("</span>. Good thing.</p>"), "{html}");
    assert!(html.contains("</span>!</p>"), "{html}");
}

fn render_wikidot_inline_markup_after_protection(wikitext: &str) -> String {
    let page_info = fallback_test_page_info("color-span", "Color Span");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let outer = RenderService::prepare_outer_render_wikitext(
        super::super::ExpandedRenderWikitext {
            theme_previewer_blank: false,
            wikidot_compat_html: CompatHtmlFragments::new(wikitext),
            wikidot_compat_text: CompatTextFragments::new(wikitext),
            wikitext: wikitext.to_owned(),
            included_pages: Vec::new(),
            expanded_include_count: 0,
            url_offset_list_pages_content_bytes: 0,
            runtime_css_insertions: Vec::new(),
        },
        &page_info,
        &settings,
    );
    let inner = RenderService::prepare_inner_render_wikitext(outer, &settings);
    let tokens = ftml::tokenize(&inner.wikitext);
    let (tree, _errors) = ftml::parse(&tokens, &page_info, &settings).into();
    let html = HtmlRender.render(&tree, &page_info, &settings).body;
    inner.protection.restore(|protection| {
        let html = RenderService::restore_protected_wikidot_color_spans(
            html,
            protection.color_spans(),
        );
        let html = RenderService::restore_protected_wikidot_inline_html(
            html,
            protection.inline_html(),
        );
        let html = protection.compat_html().restore(&html);
        let html = RenderService::restore_protected_wikidot_color_spans(
            html,
            protection.color_spans(),
        );
        let html = RenderService::restore_protected_wikidot_inline_html(
            html,
            protection.inline_html(),
        );
        protection.compat_text().restore(&html)
    })
}

#[test]
fn div_heads_with_arguments_ignore_trailing_spaces_before_the_line_break() {
    let page_info = fallback_test_page_info("div-head-space", "Div head space");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);

    for original in [
        "[[div class=\"a\"]]  \nA\n[[/div]]\n\nz",
        "[[div style=\"border: solid 2px #000000;\"]] \nA\n[[/div]]\n\nz",
        "[[div class=\"a\"]] \n\nA\n\n[[/div]]\n\nz",
    ] {
        let mut wikitext = original.to_owned();
        ftml::preprocess_for_layout(&mut wikitext, settings.layout);
        let tokens = ftml::tokenize(&wikitext);
        let (tree, errors) = ftml::parse(&tokens, &page_info, &settings).into();
        assert!(errors.is_empty(), "{original}: {errors:?}");

        let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
        assert!(rendered.starts_with("<div "), "{original}: {rendered}");
        assert!(!rendered.contains("[["), "{original}: {rendered}");
        assert!(!rendered.contains("[[/div]]"), "{original}: {rendered}");
    }
}

#[test]
fn localizes_scp_wiki_theme_code_url_to_the_scp_wiki_mirror_for_a_local_custom_domain_site()
 {
    let mut site = wikidot_site("scp-jp", Some("scp-jp.localhost"));
    site.locale = "ja".to_owned();
    site.from_wikidot = false;
    let mut config = Config::integration_testing();
    config.files_domain = ".wjfiles.localhost".to_owned();
    config.files_domain_no_dot = "wjfiles.localhost".to_owned();
    let html = r#"<style>@import url('https://scp-wiki.wdfiles.com/local--code/theme%3Ajust-girly-things/1');</style>"#;
    assert_eq!(
        RenderService::localize_wikidot_local_file_urls(html, Some(&site), &config),
        r#"<style>@import url('https://scp-wiki.wjfiles.localhost/local--code/theme%3Ajust-girly-things/1');</style>"#,
    );
}

#[test]
fn bold_color_span_renders_nested_size_block() {
    let page_info =
        fallback_test_page_info("just-girly-things-hub", "Just Girly Things Hub");
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let mut wikitext =
        "**##hotpink|[[size x-large]]₊˚⊹♡Just Girly Things Homepage!₊˚⊹♡[[/size]]##**\n"
            .to_owned();

    let inline_spans =
        RenderService::protect_wikidot_inline_html_spans(&mut wikitext, &settings);
    let color_spans =
        RenderService::protect_wikidot_color_spans(&mut wikitext, &settings);

    let mut compat_text = CompatTextFragments::new(&wikitext);
    wikitext = RenderService::protect_unrendered_wikidot_color_markers(
        wikitext,
        &settings,
        &mut compat_text,
    );
    ftml::preprocess_for_layout(&mut wikitext, settings.layout);
    let tokens = ftml::tokenize(&wikitext);
    let result = ftml::parse(&tokens, &page_info, &settings);
    let (tree, errors) = result.into();
    assert!(errors.is_empty(), "{errors:?}");

    let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
    let rendered =
        RenderService::restore_protected_wikidot_color_spans(rendered, &color_spans);
    let rendered =
        RenderService::restore_protected_wikidot_inline_html(rendered, &inline_spans);
    let rendered = compat_text.restore(&rendered);

    assert!(
        rendered.contains(
            r#"<strong><span style="color: hotpink"><span style="font-size:x-large;">₊˚⊹♡Just Girly Things Homepage!₊˚⊹♡</span></span></strong>"#
        ),
        "{rendered}",
    );
    assert!(!rendered.contains("[[size"), "{rendered}");
}

#[test]
fn protected_inline_body_renders_size_blocks() {
    let rendered = super::super::render_wikidot_protected_inline_body_html(
        "[[size 75%]]small[[/size]] and [[size larger]]big[[/size]]",
    );

    assert_eq!(
        rendered,
        r#"<span style="font-size:75%;">small</span> and <span style="font-size:larger;">big</span>"#
    );
}

#[test]
fn protected_inline_body_renders_nested_size_blocks() {
    let rendered = super::super::render_wikidot_protected_inline_body_html(
        "[[size large]]a[[size small]]b[[/size]]c[[/size]]",
    );

    assert_eq!(
        rendered,
        r#"<span style="font-size:large;">a<span style="font-size:small;">b</span>c</span>"#
    );
}

#[test]
fn protected_inline_body_leaves_malformed_size_markers_literal() {
    let rendered = super::super::render_wikidot_protected_inline_body_html(
        "[[size bogus]]x[[/size]] and [[size 12px]]unclosed",
    );

    assert!(rendered.contains("[[size bogus]]"), "{rendered}");
    assert!(rendered.contains("[[size 12px]]unclosed"), "{rendered}");
    assert!(!rendered.contains("font-size"), "{rendered}");
}

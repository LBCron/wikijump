//! Persisted presentation state from the frozen blank ThemePreviewer observation.
use super::*;

#[tokio::test]
async fn blank_theme_previewer_survives_save_and_include_but_not_preview_or_removal() {
    const SOURCE: &str = "[[module ThemePreviewer noUi=\"true\" theme_url=\" \"]]";
    let mut runner = TestRunner::setup().await;
    let site_id = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded site")
        .site
        .site_id;
    create_listpages_test_page(
        &mut runner,
        site_id,
        "component:audit-blank-theme",
        "Blank theme component",
        SOURCE,
    )
    .await;
    for (slug, source, expected) in [
        ("audit-blank-theme", SOURCE.to_owned(), true),
        (
            "audit-included-blank-theme",
            "[[include component:audit-blank-theme]]".to_owned(),
            true,
        ),
        (
            "audit-commented-blank-theme",
            format!("[!--{SOURCE}--]"),
            false,
        ),
        (
            "audit-coded-blank-theme",
            format!("[[code]]\n{SOURCE}\n[[/code]]"),
            false,
        ),
    ] {
        let revision = create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            "Blank theme observation",
            &source,
        )
        .await;
        runner.set_request_context(RequestContext {
            site_id: Some(site_id),
            ..Default::default()
        });
        let view = run_endpoint!(
            runner,
            article_view,
            json!({
                "site_id": site_id, "session_token": null,
                "route": {"slug": slug, "extra": ""}, "locales": ["en-US", "en"],
            })
        );
        let GetArticleViewOutput {
            page:
                GetPageViewOutput::Found {
                    theme_previewer_blank,
                    ..
                },
            ..
        } = view
        else {
            panic!("saved page should be found: {slug}");
        };
        assert_eq!(
            theme_previewer_blank, expected,
            "executable resolved source owns saved presentation: {slug}"
        );
        if slug == "audit-blank-theme" {
            let preview = run_endpoint!(
                runner,
                wikidot_page_preview,
                json!({
                    "site_id": site_id, "title": "Blank theme preview", "wikitext": SOURCE,
                })
            );
            assert_eq!(
                preview.body.trim(),
                "",
                "frozen anonymous preview consumes the module"
            );
            assert!(
                preview.styles.is_empty(),
                "PagePreview has no saved-shell style additions"
            );
            set_mutation_request_context(
                &mut runner,
                ADMIN_USER_ID,
                site_id,
                Reference::Slug(Cow::Borrowed(slug)),
            );
            let edit_lease_17 = common::acquire_page_edit_lease(
                &runner,
                site_id,
                &serde_json::json!(slug),
                ADMIN_USER_ID,
            )
            .await;
            run_endpoint!(runner, page_edit, json!({
                "lease": edit_lease_17,
                "site_id": site_id, "page": slug, "last_revision_id": revision,
                "revision_comments": "remove blank theme selection", "user_id": ADMIN_USER_ID,
                "wikitext": "Ordinary page body.", "ip_address": common::IP_ADDRESS,
            })).expect("removal should create a revision");
            runner.set_request_context(RequestContext {
                site_id: Some(site_id),
                ..Default::default()
            });
            let view = run_endpoint!(
                runner,
                page_view,
                json!({
                    "site_id": site_id, "session_token": null,
                    "route": {"slug": slug, "extra": ""}, "locales": ["en-US", "en"],
                })
            );
            let GetPageViewOutput::Found {
                theme_previewer_blank,
                compiled_body_html,
                ..
            } = view
            else {
                panic!("edited page should be found");
            };
            assert!(
                !theme_previewer_blank,
                "removal must clear persisted presentation state"
            );
            assert!(compiled_body_html.contains("Ordinary page body."));
        }
    }
}

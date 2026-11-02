use super::*;

#[test]
fn url_token_is_only_a_delimited_selector() {
    for dynamic in ["@URL", "@url", "@URL|design", "a @URL b", "@URL,@URL"] {
        assert!(is_dynamic_list_pages_value(dynamic), "{dynamic}");
    }
    for literal in ["plain", "email@URL", "@URLx", "x@URL", ""] {
        assert!(!is_dynamic_list_pages_value(literal), "{literal}");
    }
}

#[test]
fn url_fallback_is_only_read_from_a_dynamic_selector() {
    assert_eq!(list_pages_url_fallback("@URL|design"), Some("design"));
    assert_eq!(list_pages_url_fallback("@URL|"), Some(""));
    assert_eq!(list_pages_url_fallback("@URL"), None);
    assert_eq!(list_pages_url_fallback("plain|design"), None);
}

#[test]
fn static_url_fallback_marker_range_requires_a_fallback() {
    assert_eq!(
        list_pages_static_url_fallback_marker_range("@URL|design"),
        Some(0..4)
    );
    assert_eq!(
        list_pages_static_url_fallback_marker_range("a @URL|b"),
        Some(2..6)
    );
    assert_eq!(list_pages_static_url_fallback_marker_range("@URL"), None);
    assert_eq!(
        list_pages_static_url_fallback_marker_range("plain|design"),
        None
    );
}

#[test]
fn numeric_argument_uses_the_url_fallback_and_requires_digits() {
    assert_eq!(parse_list_pages_numeric_argument("5"), Some(5));
    assert_eq!(parse_list_pages_numeric_argument("007"), Some(7));
    assert_eq!(parse_list_pages_numeric_argument("@URL|7"), Some(7));
    assert_eq!(parse_list_pages_numeric_argument("@URL"), None);
    assert_eq!(parse_list_pages_numeric_argument("@URL|"), None);
    assert_eq!(parse_list_pages_numeric_argument(""), None);
    assert_eq!(parse_list_pages_numeric_argument("1x"), None);
}

#[test]
fn url_selector_resolution_matches_the_documented_forms() {
    assert!(matches!(
        resolve_url_selector("plain", Some("x")),
        UrlSelector::Static("plain")
    ));
    assert!(matches!(
        resolve_url_selector("email@URL", Some("x")),
        UrlSelector::Static("email@URL")
    ));
    assert!(matches!(
        resolve_url_selector("@URL", Some("design")),
        UrlSelector::Resolved(resolved) if resolved == "design"
    ));
    assert!(matches!(
        resolve_url_selector("+ko @URL", Some("x")),
        UrlSelector::Resolved(resolved) if resolved == "+ko x"
    ));
    assert!(matches!(
        resolve_url_selector("@URL|design", Some("real")),
        UrlSelector::Resolved(resolved) if resolved == "real"
    ));
    assert!(matches!(
        resolve_url_selector("@URL|design", None),
        UrlSelector::Static("design")
    ));
    assert!(matches!(
        resolve_url_selector("@URL|design", Some("")),
        UrlSelector::Static("design")
    ));
    assert!(matches!(
        resolve_url_selector("@URL", None),
        UrlSelector::Dropped
    ));
    assert!(matches!(
        resolve_url_selector("@URL", Some("")),
        UrlSelector::Dropped
    ));
}

#[test]
fn preflight_reports_unresolved_dynamic_selectors() {
    let mut unsupported = false;
    assert_eq!(
        preflight_static_list_pages_selector("@URL|design", &mut unsupported),
        Some("design")
    );
    assert!(!unsupported);
    assert_eq!(
        preflight_static_list_pages_selector("@URL", &mut unsupported),
        None
    );
    assert!(unsupported);
    assert_eq!(
        preflight_static_list_pages_selector("plain", &mut unsupported),
        Some("plain")
    );
}

#[test]
fn tag_values_split_on_whitespace_and_separators() {
    assert_eq!(
        split_list_pages_tag_values("technology news +apple -funny"),
        vec!["technology", "news", "+apple", "-funny"]
    );
    assert_eq!(split_list_pages_tag_values("a,b;c"), vec!["a", "b", "c"]);
    assert_eq!(
        split_list_pages_tag_values("\"Tag\"  Other"),
        vec!["tag", "other"]
    );
    assert_eq!(split_list_pages_tag_values("   "), Vec::<String>::new());
}

#[test]
fn static_category_preflight_accepts_only_literal_inclusions() {
    assert_eq!(
        list_pages_static_category_preflight(r#"category="Blog""#),
        Some((vec!["blog".to_owned()], true))
    );
    assert_eq!(
        list_pages_static_category_preflight(r#"category="blog,news""#),
        Some((vec!["blog".to_owned(), "news".to_owned()], true))
    );
    assert_eq!(
        list_pages_static_category_preflight(r#"category="blog" wrapper="no""#),
        Some((vec!["blog".to_owned()], false))
    );
    assert_eq!(
        list_pages_static_category_preflight(r#"category="+blog""#),
        Some((vec!["blog".to_owned()], true))
    );
    assert_eq!(
        list_pages_static_category_preflight(
            r#"category="blog" wrapper="yes" name="false""#
        ),
        Some((vec!["blog".to_owned()], true))
    );
    for rejected in [
        r#"tags="blog""#,
        r#"category="*""#,
        r#"category=".""#,
        r#"category="-blog""#,
        r#"category="@URL|blog""#,
        r#"category="blog" category="news""#,
    ] {
        assert_eq!(
            list_pages_static_category_preflight(rejected),
            None,
            "{rejected}"
        );
    }
}

#[test]
fn unsupported_parent_and_page_type_selectors_are_detected() {
    assert!(list_pages_has_unsupported_parent_selector(
        r#"parent="@URL""#
    ));
    assert!(!list_pages_has_unsupported_parent_selector(
        r#"parent="@URL|-=""#
    ));
    assert!(!list_pages_has_unsupported_parent_selector(
        r#"parent="foo""#
    ));

    assert!(!list_pages_has_unsupported_page_type_selector(
        r#"pagetype="0""#
    ));
    assert!(!list_pages_has_unsupported_page_type_selector(
        r#"pagetype="normal""#
    ));
    assert!(!list_pages_has_unsupported_page_type_selector(
        r#"pagetype="@URL|normal""#
    ));
    assert!(list_pages_has_unsupported_page_type_selector(
        r#"pagetype="bogus""#
    ));
    assert!(!list_pages_has_unsupported_page_type_selector(
        r#"tags="x""#
    ));
}

#[test]
fn name_selectors_compose_without_widening() {
    use ListPagesNameSelector::{CurrentPage, Exact, Pattern};

    let none = compose_list_pages_name_selectors(None, None);
    assert!(!none.current_page_only && !none.unsupported);

    let current = compose_list_pages_name_selectors(Some(CurrentPage), None);
    assert!(current.current_page_only && !current.unsupported);

    let exact = compose_list_pages_name_selectors(Some(Exact("a".into())), None);
    assert_eq!(exact.slug.as_deref(), Some("a"));
    assert!(!exact.unsupported);

    let pattern = compose_list_pages_name_selectors(Some(Pattern("p*".into())), None);
    assert_eq!(pattern.name_pattern.as_deref(), Some("p*"));
    assert!(!pattern.unsupported);

    let exact_and_pattern = compose_list_pages_name_selectors(
        Some(Exact("a".into())),
        Some(Pattern("p*".into())),
    );
    assert_eq!(exact_and_pattern.slug.as_deref(), Some("a"));
    assert_eq!(exact_and_pattern.name_pattern.as_deref(), Some("p*"));
    assert!(!exact_and_pattern.unsupported);

    let two_exacts = compose_list_pages_name_selectors(
        Some(Exact("a".into())),
        Some(Exact("b".into())),
    );
    assert_eq!(two_exacts.slug.as_deref(), Some("a"));
    assert_eq!(two_exacts.name_pattern.as_deref(), Some("b"));
    assert!(!two_exacts.unsupported);

    for (canonical, alias) in [
        (CurrentPage, Exact("a".into())),
        (Exact("a".into()), CurrentPage),
        (Pattern("a*".into()), Pattern("b*".into())),
    ] {
        assert!(
            compose_list_pages_name_selectors(Some(canonical), Some(alias)).unsupported,
            "conflicting name selectors must be unsupported",
        );
    }

    let equal_current =
        compose_list_pages_name_selectors(Some(CurrentPage), Some(CurrentPage));
    assert!(equal_current.current_page_only && !equal_current.unsupported);

    let equal_exact = compose_list_pages_name_selectors(
        Some(Exact("a".into())),
        Some(Exact("a".into())),
    );
    assert_eq!(equal_exact.slug.as_deref(), Some("a"));
    assert_eq!(equal_exact.name_pattern, None);
    assert!(!equal_exact.unsupported);

    let equal_pattern = compose_list_pages_name_selectors(
        Some(Pattern("p*".into())),
        Some(Pattern("p*".into())),
    );
    assert_eq!(equal_pattern.name_pattern.as_deref(), Some("p*"));
    assert_eq!(equal_pattern.slug, None);
    assert!(!equal_pattern.unsupported);
}

#[test]
fn data_form_variables_substitute_or_fail_closed() {
    let definition: ListPagesDataFormDefinition =
        serde_json::from_value(serde_json::json!({
            "fields": [{
                "name": "severity",
                "label": "Severity",
                "hint": "Choose a severity",
                "field_type": null,
                "values": [],
                "default_value": null,
                "width": 40,
                "height": 1,
                "match_pattern": null,
                "match_error": null,
            }],
        }))
        .expect("data form definition fixture should deserialize");
    let mut values = BTreeMap::new();
    values.insert("severity".to_owned(), "high".to_owned());

    assert_eq!(
        substitute_list_pages_current_data_form_variables(
            "plain %%title%%",
            &values,
            &definition,
        ),
        None,
        "a source without form variables is not substituted",
    );
    assert_eq!(
        substitute_list_pages_current_data_form_variables(
            "%%form_data{severity}%% / %%form_raw{severity}%% / \
                 %%form_label{severity}%% / %%form_hint{severity}%%",
            &values,
            &definition,
        ),
        Some("high / high / Severity / Choose a severity".to_owned()),
    );

    let mut unsafe_values = BTreeMap::new();
    unsafe_values.insert("severity".to_owned(), "[boom]".to_owned());
    assert_eq!(
        substitute_list_pages_current_data_form_variables(
            "%%form_data{severity}%%",
            &unsafe_values,
            &definition,
        ),
        None,
        "an unsafe replacement must fail closed",
    );
}

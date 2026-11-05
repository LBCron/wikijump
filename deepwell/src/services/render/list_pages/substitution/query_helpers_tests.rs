use super::*;

#[test]
fn comparison_prefixes_are_matched_longest_first() {
    for (value, expected, rest) in [
        (">=5", ComparisonOperation::GreaterOrEqualThan, "5"),
        ("<=5", ComparisonOperation::LessOrEqualThan, "5"),
        ("<>5", ComparisonOperation::NotEqual, "5"),
        (">5", ComparisonOperation::GreaterThan, "5"),
        ("<5", ComparisonOperation::LessThan, "5"),
        ("=5", ComparisonOperation::Equal, "5"),
        ("5", ComparisonOperation::Equal, "5"),
        (" >= 5 ", ComparisonOperation::GreaterOrEqualThan, "5"),
    ] {
        assert_eq!(
            parse_list_pages_comparison(value),
            (expected, rest),
            "{value}"
        );
    }
}

#[test]
fn score_selector_requires_an_integer() {
    assert_eq!(
        parse_list_pages_score_selector("5"),
        Some(ScoreSelector {
            score: ftml::data::ScoreValue::Integer(5),
            comparison: ComparisonOperation::Equal,
        })
    );
    assert_eq!(
        parse_list_pages_score_selector("-5"),
        Some(ScoreSelector {
            score: ftml::data::ScoreValue::Integer(-5),
            comparison: ComparisonOperation::Equal,
        })
    );
    assert_eq!(
        parse_list_pages_score_selector(">=5"),
        Some(ScoreSelector {
            score: ftml::data::ScoreValue::Integer(5),
            comparison: ComparisonOperation::GreaterOrEqualThan,
        })
    );
    assert_eq!(parse_list_pages_score_selector("x"), None);
    assert_eq!(parse_list_pages_score_selector(""), None);
    assert_eq!(parse_list_pages_score_selector(">=x"), None);
    assert_eq!(parse_list_pages_score_selector("+5"), None);
}

#[test]
fn page_type_selector_accepts_only_the_evidenced_values() {
    assert_eq!(parse_list_pages_page_type("*"), Some(PageTypeSelector::All));
    assert_eq!(
        parse_list_pages_page_type("hidden"),
        Some(PageTypeSelector::Hidden)
    );
    assert_eq!(
        parse_list_pages_page_type("normal"),
        Some(PageTypeSelector::Normal)
    );
    assert_eq!(
        parse_list_pages_page_type("0"),
        Some(PageTypeSelector::Normal)
    );
    assert_eq!(
        parse_list_pages_page_type(""),
        Some(PageTypeSelector::Normal)
    );
    assert_eq!(parse_list_pages_page_type("bogus"), None);
}

#[test]
fn order_selector_matches_the_documented_forms() {
    assert_eq!(parse_list_pages_order(""), Some(OrderBySelector::default()));

    let order = |value: &str| parse_list_pages_order(value).unwrap();
    for (value, property, ascending) in [
        ("dateCreatedDesc", OrderProperty::CreatedAt, false),
        ("dateCreatedAsc", OrderProperty::CreatedAt, true),
        ("dateEditedDesc", OrderProperty::UpdatedAt, false),
        ("titleDesc", OrderProperty::Title, false),
        ("ratingDesc", OrderProperty::Score, false),
        ("pageLengthDesc", OrderProperty::Size, false),
        ("random", OrderProperty::Random, true),
        ("name", OrderProperty::PageSlug, true),
        ("-name", OrderProperty::PageSlug, false),
        ("fullname", OrderProperty::FullSlug, true),
        ("alt_title", OrderProperty::AltTitle, true),
        ("alttitle", OrderProperty::AltTitle, true),
        ("rating desc", OrderProperty::Score, false),
        ("rating asc", OrderProperty::Score, true),
        ("rating desc desc", OrderProperty::Score, true),
    ] {
        assert_eq!(
            order(value),
            OrderBySelector {
                property,
                ascending
            },
            "{value}"
        );
    }

    assert_eq!(
        order("_mainword"),
        OrderBySelector {
            property: OrderProperty::DataFormFieldName {
                field: "mainword".into(),
                numeric: false,
            },
            ascending: true,
        }
    );
    assert_eq!(
        order("_albums::integer desc"),
        OrderBySelector {
            property: OrderProperty::DataFormFieldName {
                field: "albums".into(),
                numeric: true,
            },
            ascending: false,
        }
    );

    assert_eq!(
        parse_list_pages_order("bogus"),
        Some(OrderBySelector::default())
    );
    assert_eq!(
        parse_list_pages_order("name asc extra"),
        Some(OrderBySelector::default())
    );
    assert_eq!(
        parse_list_pages_order("rating bogus"),
        Some(OrderBySelector::default())
    );
    assert_eq!(
        parse_list_pages_order("rating desc asc"),
        Some(OrderBySelector::default())
    );
    assert_eq!(parse_list_pages_order("_"), None);
    assert_eq!(parse_list_pages_order("_::integer"), None);
    assert_eq!(parse_list_pages_order("_a::float"), None);
}

#[test]
fn camel_case_order_suffixes_require_a_property() {
    assert_eq!(
        parse_wikidot_camel_case_order("dateCreatedDesc"),
        Some(("dateCreated", false))
    );
    assert_eq!(
        parse_wikidot_camel_case_order("titleAsc"),
        Some(("title", true))
    );
    assert_eq!(parse_wikidot_camel_case_order("desc"), None);
    assert_eq!(parse_wikidot_camel_case_order("random"), None);
}

#[test]
fn name_slug_and_tag_selectors_normalize() {
    assert_eq!(wikidot_list_pages_name_slug(" My Page "), "my-page");
    assert_eq!(
        wikidot_list_pages_name_slug("listpages-category-name?block"),
        "listpages-category-name-block"
    );
    assert_eq!(
        wikidot_list_pages_name_slug("listpages-category-name_block"),
        "listpages-category-name-block"
    );
    assert_eq!(
        wikidot_list_pages_name_slug("listpages-category-name%block"),
        "listpages-category-name-block"
    );
    assert_eq!(
        wikidot_list_pages_name_slug("listpages-category-name*block"),
        "listpages-category-name-block"
    );
    assert_eq!(
        wikidot_list_pages_name_slug("listpages-category-name-%"),
        "listpages-category-name%"
    );
    assert_eq!(
        wikidot_list_pages_name_slug("listpages-category-name-*"),
        "listpages-category-name%"
    );
    assert_eq!(wikidot_list_pages_name_slug("%"), "%");
    assert!(is_current_page_tag_selector("="));
    assert!(is_current_page_tag_selector(" = "));
    assert!(is_current_page_tag_selector("=="));
    assert!(!is_current_page_tag_selector("==="));
    assert!(is_no_tags_selector("-"));
    assert!(is_no_tags_selector(" - "));
    assert!(!is_no_tags_selector("--"));
}

#[test]
fn feed_selector_normalization_joins_and_lowercases() {
    assert_eq!(split_list_pages_values("a,b c"), vec!["a", "b", "c"]);
    assert_eq!(split_list_pages_values("   "), Vec::<String>::new());
    assert_eq!(
        normalize_list_pages_feed_selector("A, B"),
        Some("a,b".to_owned())
    );
    assert_eq!(normalize_list_pages_feed_selector("   "), None);
    assert_eq!(nonempty_list_pages_feed_value(" x "), Some("x".to_owned()));
    assert_eq!(nonempty_list_pages_feed_value("   "), None);
}

#[test]
fn false_only_boolean_argument_defaults_true() {
    assert!(!parse_list_pages_false_only_boolean_argument("no"));
    assert!(!parse_list_pages_false_only_boolean_argument("false"));
    assert!(parse_list_pages_false_only_boolean_argument("yes"));
    assert!(parse_list_pages_false_only_boolean_argument(""));
}

#[test]
fn exact_raw_color_name_requires_a_bounded_color() {
    assert_eq!(
        exact_raw_color_list_pages_name("@@##red|content##@@"),
        Some("content")
    );
    assert_eq!(
        exact_raw_color_list_pages_name("@@###ff0000|content##@@"),
        Some("content")
    );
    let longest = "a".repeat(32);
    assert_eq!(
        exact_raw_color_list_pages_name(&format!("@@##{longest}|content##@@")),
        Some("content")
    );
    let too_long = "a".repeat(33);
    assert_eq!(
        exact_raw_color_list_pages_name(&format!("@@##{too_long}|content##@@")),
        None
    );
    assert_eq!(exact_raw_color_list_pages_name("@@##|content##@@"), None);
    assert_eq!(
        exact_raw_color_list_pages_name("@@##red|con##tent##@@"),
        None
    );
    assert_eq!(exact_raw_color_list_pages_name("plain"), None);
}

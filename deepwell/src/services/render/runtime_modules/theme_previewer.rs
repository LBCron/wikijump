use super::{
    LiteralRegionIndex, STATIC_ACCOUNT_MODULE_REGEX, WikidotModuleArgumentValueKind,
    wikidot_module_arguments,
};

pub(crate) fn has_theme_previewer_no_ui(wikitext: &str) -> bool {
    if !STATIC_ACCOUNT_MODULE_REGEX.is_match(wikitext) {
        return false;
    }
    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(wikitext);
    STATIC_ACCOUNT_MODULE_REGEX
        .captures_iter(wikitext)
        .any(|captures| {
            let matched = captures
                .get(0)
                .expect("a static account module capture always has a complete match");
            if literal_regions.contains(matched.start()) {
                return false;
            }
            if !captures
                .name("name")
                .is_some_and(|name| name.as_str().eq_ignore_ascii_case("ThemePreviewer"))
            {
                return false;
            }
            let Some(head) = captures.name("head").map(|head| head.as_str()) else {
                return false;
            };
            let Some(arguments) = wikidot_module_arguments(head) else {
                return false;
            };
            arguments.len() == 1
                && arguments[0].key == "noUi"
                && arguments[0].op == "="
                && arguments[0].value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
                && arguments[0].value == "true"
        })
}

pub(in crate::services::render) fn has_theme_previewer_blank(wikitext: &str) -> bool {
    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(wikitext);
    STATIC_ACCOUNT_MODULE_REGEX
        .captures_iter(wikitext)
        .any(|captures| {
            let matched = captures.get(0).expect("module capture has complete match");
            !literal_regions.contains(matched.start())
                && captures.name("name").is_some_and(|name| {
                    name.as_str().eq_ignore_ascii_case("ThemePreviewer")
                })
                && captures
                    .name("head")
                    .is_some_and(|head| theme_previewer_blank_head(head.as_str()))
        })
}

pub(in crate::services::render) fn theme_previewer_blank_head(head: &str) -> bool {
    let Some(arguments) = wikidot_module_arguments(head) else {
        return false;
    };
    arguments.len() == 2
        && arguments.iter().any(|argument| {
            argument.key == "noUi"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
                && argument.value == "true"
        })
        && arguments.iter().any(|argument| {
            argument.key == "theme_url"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
                && argument.value == " "
        })
}

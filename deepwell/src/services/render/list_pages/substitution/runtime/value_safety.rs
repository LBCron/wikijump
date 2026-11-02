/*
 * services/render/list_pages/substitution/runtime/value_safety.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::escape_html_text;

fn neutralize_list_pages_substituted_syntax(value: &str) -> String {
    neutralize_list_pages_substituted_brackets(value).replace('"', "&#34;")
}

fn neutralize_list_pages_substituted_brackets(value: &str) -> String {
    value.replace('[', "&#91;").replace(']', "&#93;")
}

pub(super) fn render_list_pages_substituted_identity(
    value: &str,
    inside_html_block: bool,
) -> String {
    if inside_html_block {
        neutralize_list_pages_substituted_syntax(&escape_html_text(value))
    } else {
        neutralize_list_pages_substituted_syntax(value)
    }
}

pub(super) fn render_list_pages_substituted_title(
    value: &str,
    inside_html_block: bool,
    inside_quoted_attribute: bool,
) -> String {
    if inside_html_block {
        neutralize_list_pages_substituted_syntax(&escape_html_text(value))
    } else if inside_quoted_attribute {
        neutralize_list_pages_substituted_syntax(value)
    } else {
        neutralize_list_pages_substituted_brackets(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutralization_keeps_ordinary_values_verbatim() {
        assert_eq!(
            neutralize_list_pages_substituted_syntax("Lt Masipag"),
            "Lt Masipag",
        );
        assert_eq!(
            neutralize_list_pages_substituted_syntax("tale-of _hidden"),
            "tale-of _hidden",
        );
        assert_eq!(
            neutralize_list_pages_substituted_syntax("s&c-plastics"),
            "s&c-plastics",
        );
    }

    #[test]
    fn neutralization_breaks_module_and_attribute_syntax() {
        assert_eq!(
            neutralize_list_pages_substituted_syntax("[[module ListPages]]"),
            "&#91;&#91;module ListPages&#93;&#93;",
        );
        assert_eq!(
            neutralize_list_pages_substituted_syntax("\" onmouseover=\"alert(1)"),
            "&#34; onmouseover=&#34;alert(1)",
        );
    }

    #[test]
    fn wikitext_context_matches_plain_neutralization() {
        assert_eq!(
            render_list_pages_substituted_identity("Lt Masipag & friends", false),
            "Lt Masipag & friends",
        );
        assert_eq!(
            render_list_pages_substituted_identity("[[module ListPages]]", false),
            "&#91;&#91;module ListPages&#93;&#93;",
        );
    }

    #[test]
    fn html_block_context_escapes_html_and_keeps_brackets_neutralized() {
        assert_eq!(
            render_list_pages_substituted_identity("<script>alert(1)</script>", true),
            "&lt;script&gt;alert(1)&lt;/script&gt;",
        );
        assert_eq!(
            render_list_pages_substituted_identity("s&c-plastics", true),
            "s&amp;c-plastics",
        );
        assert_eq!(
            render_list_pages_substituted_identity("[[module ListPages]]", true),
            "&#91;&#91;module ListPages&#93;&#93;",
        );
        assert_eq!(
            render_list_pages_substituted_identity("a\"b", true),
            "a&quot;b",
        );
    }

    #[test]
    fn html_block_context_never_double_encodes_entities() {
        let rendered = render_list_pages_substituted_identity("[a] & <b>", true);
        assert_eq!(rendered, "&#91;a&#93; &amp; &lt;b&gt;");
        assert!(
            !rendered.contains("&amp;#"),
            "neutralization entities must survive escaping: {rendered:?}",
        );
    }

    #[test]
    fn title_keeps_plain_quotes_outside_attributes() {
        assert_eq!(
            render_list_pages_substituted_title("The \"Best\" Page", false, false),
            "The \"Best\" Page",
        );
        assert_eq!(
            render_list_pages_substituted_title("[a] title", false, false),
            "&#91;a&#93; title",
        );
    }

    #[test]
    fn title_cannot_terminate_a_quoted_attribute() {
        assert_eq!(
            render_list_pages_substituted_title("x\" data-injected=\"yes", false, true,),
            "x&#34; data-injected=&#34;yes",
        );
    }

    #[test]
    fn title_is_html_escaped_inside_html_blocks() {
        assert_eq!(
            render_list_pages_substituted_title(
                "<img src=x onerror=\"alert(1)\"><script>alert(2)</script>",
                true,
                false,
            ),
            "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;",
        );
    }
}

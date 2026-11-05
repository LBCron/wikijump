use std::sync::LazyLock;

use ftml::settings::WikitextSettings;
use rand::RngExt;
use regex::Regex;

use super::compat::CompatHtmlFragments;
use super::literal_regions::LiteralRegionIndex;
use super::module_arguments::{WikidotModuleArgumentValueKind, wikidot_module_arguments};
use super::service::escape_list_pages_html_text;
use super::url_arguments::UrlArguments;

const SEARCH_UNAVAILABLE_HTML: &str = r#"<div class="error-block">Search is temporarily unavailable, we are working to bring it online!</div>"#;
const FEED_MISSING_SOURCE_HTML: &str =
    r#"<div class="error-block">No feed source specified ("src" element missing).</div>"#;
const SEARCH_ALL_UNAVAILABLE_HTML: &str =
    r#"<div class="error-block">Couldnt connect to host, ElasticSearch down?</div>"#;
const SEARCH_ALL_FORM_HTML: &str = r#"<div class="search-box">
<div class="query-area">
<form action="dummy" id="search-form-all">
<div>
<input class="text" type="text" size="30" name="query" id="search-form-all-input" value="" aria-label="WIKIJUMP_SEARCH_ALL_QUERY_LABEL"/>
<input class="button" type="submit" value="Search"/>
</div>
<div style="margin-top:5px;">
<input id="search-all-pf" class="radio" type="radio" name="area" value="pf" checked="checked"/><label for="search-all-pf">pages and forums</label>
<input id="search-all-p" class="radio" type="radio" name="area" value="p"/><label for="search-all-p">pages only</label>
<input id="search-all-f" class="radio" type="radio" name="area" value="f"/><label for="search-all-f">forums only</label>
</div>
</form>
</div>
<div class="search-results">
</div>
</div>"#;

static SEARCH_FEED_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?im)^[\t ]*\[\[module\s+(?P<name>Search|Feed)\b(?P<head>(?:[^\]\r\n"]+|"[^"\r\n]*")*)\]\][\t ]*$"#,
    )
    .expect("Search and Feed module expression is valid")
});

static SEARCH_ALL_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?im)^[\t ]*\[\[module\s+SearchAll\b(?:[^\]"]+|"[^"]*")*\]\][\t ]*$"#)
        .expect("SearchAll module expression is valid")
});

fn feed_source(head: &str) -> Option<&str> {
    wikidot_module_arguments(head)?
        .into_iter()
        .rev()
        .find(|argument| {
            argument.key == "src"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
                && !argument.value.is_empty()
        })
        .map(|argument| argument.value)
}

fn render_feed_module(head: &str, page_preview: bool) -> String {
    if !page_preview {
        return render_feed_hybrid_module(head);
    }
    let Some(source) = feed_source(head) else {
        return FEED_MISSING_SOURCE_HTML.to_owned();
    };
    format!(
        r#"<div class="error-block">Error processing the feed "{}". The feed can not be accessed or contains errors. </div>"#,
        escape_list_pages_html_text(source),
    )
}

/// Renders live Wikidot's saved-page representation of `[[module Feed]]`.
///
/// Wikidot's feed widget is a client-side module: the saved route emits the
/// generic `wikidot-hybrid-module` placeholder carrying the module identity
/// and its parameters as a hidden JSON payload, and the browser script builds
/// the widget. The editor preview route instead renders the server-side feed
/// error block (see `render_feed_module`), so the placeholder is saved-page
/// only.
fn render_feed_hybrid_module(head: &str) -> String {
    let params = wikidot_module_arguments(head).unwrap_or_default();
    let mut json = String::from(r#"{"module":"feed\/FeedModule","params":{"#);
    let mut first = true;
    for argument in params {
        if argument.op != "=" {
            continue;
        }
        if !first {
            json.push(',');
        }
        first = false;
        json.push('"');
        json.push_str(&json_escape_string(argument.key));
        json.push_str(r#"":"#);
        json.push('"');
        json.push_str(&json_escape_string(argument.value));
        json.push('"');
    }
    json.push_str("}}");
    let module_id: u32 = rand::rng().random_range(10_000..1_000_000_000);
    format!(
        r#"<div class="wikidot-hybrid-module" id="wikidot-hybrid-module-{module_id}"><div style="display: none">{json}</div></div>"#,
        json = escape_feed_json_html_text(&json),
    )
}

/// Escapes a string the way PHP's default `json_encode` does: quotes,
/// backslashes, forward slashes, control characters, and non-ASCII characters
/// (as `\uXXXX`).
fn json_escape_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '/' => escaped.push_str("\\/"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                escaped.push_str(&format!("\\u{:04x}", character as u32));
            }
            character if character.is_ascii() => escaped.push(character),
            character => {
                let mut buffer = [0u16; 2];
                for unit in character.encode_utf16(&mut buffer) {
                    escaped.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    escaped
}

fn escape_feed_json_html_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn search_all_has_query(url: UrlArguments<'_>) -> bool {
    url.path_arguments
        .iter()
        .rfind(|argument| argument.name == "q")
        .and_then(|argument| argument.value.as_deref())
        .is_some_and(|query| !query.is_empty())
}

fn expand_search_all_modules(
    wikitext: String,
    settings: &WikitextSettings,
    url: UrlArguments<'_>,
    accessible_query_name: &str,
    compat_html: &mut CompatHtmlFragments,
) -> String {
    if !settings.enable_page_syntax || !SEARCH_ALL_MODULE_REGEX.is_match(&wikitext) {
        return wikitext;
    }

    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
    let rendered = if search_all_has_query(url) {
        SEARCH_ALL_UNAVAILABLE_HTML.to_owned()
    } else {
        SEARCH_ALL_FORM_HTML.replace(
            "WIKIJUMP_SEARCH_ALL_QUERY_LABEL",
            &super::service::escape_list_pages_html_attr(accessible_query_name),
        )
    };
    let mut output = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for matched in SEARCH_ALL_MODULE_REGEX.find_iter(&wikitext) {
        if literal_regions.contains(matched.start()) {
            continue;
        }
        output.push_str(&wikitext[cursor..matched.start()]);
        output.push_str(&compat_html.push_block_html(rendered.clone()));
        cursor = matched.end();
    }
    if cursor == 0 {
        return wikitext;
    }
    output.push_str(&wikitext[cursor..]);
    output
}

pub(super) fn expand_search_feed_modules(
    mut wikitext: String,
    settings: &WikitextSettings,
    url: UrlArguments<'_>,
    accessible_query_name: &str,
    page_preview: bool,
    compat_html: &mut CompatHtmlFragments,
) -> String {
    wikitext = expand_search_all_modules(
        wikitext,
        settings,
        url,
        accessible_query_name,
        compat_html,
    );
    if !settings.enable_page_syntax || !SEARCH_FEED_MODULE_REGEX.is_match(&wikitext) {
        return wikitext;
    }

    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
    let mut output = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for captures in SEARCH_FEED_MODULE_REGEX.captures_iter(&wikitext) {
        let matched = captures
            .get(0)
            .expect("a Search or Feed capture always has a complete match");
        if literal_regions.contains(matched.start()) {
            continue;
        }
        let name = captures
            .name("name")
            .expect("a Search or Feed capture always has a name")
            .as_str();
        let head = captures.name("head").map_or("", |head| head.as_str());
        let rendered = if name.eq_ignore_ascii_case("Search") {
            SEARCH_UNAVAILABLE_HTML.to_owned()
        } else {
            render_feed_module(head, page_preview)
        };
        output.push_str(&wikitext[cursor..matched.start()]);
        output.push_str(&compat_html.push_block_html(rendered));
        cursor = matched.end();
    }
    if cursor == 0 {
        return wikitext;
    }
    output.push_str(&wikitext[cursor..]);
    output
}

#[cfg(test)]
mod tests {
    use super::expand_search_feed_modules;
    use crate::services::render::compat::CompatHtmlFragments;
    use crate::services::render::url_arguments::UrlArguments;
    use ftml::layout::Layout;
    use ftml::settings::{WikitextMode, WikitextSettings};

    fn expand_with_mode(source: &str, page_preview: bool) -> String {
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let mut compat_html = CompatHtmlFragments::new(source);
        let expanded = expand_search_feed_modules(
            source.to_owned(),
            &settings,
            UrlArguments::default(),
            "Search all Wikis",
            page_preview,
            &mut compat_html,
        );
        compat_html.restore(&expanded)
    }

    fn expand(source: &str) -> String {
        expand_with_mode(source, true)
    }

    #[test]
    fn renders_the_live_search_unavailable_contract() {
        let expected = r#"<div class="error-block">Search is temporarily unavailable, we are working to bring it online!</div>"#;
        for source in [
            "[[module Search]]",
            "[[module Search mini=\"true\"]]",
            "[[module Search a=\"p\"]]",
            "[[module Search unknown=\"x\"]]",
            "[[module Search mini='true']]",
            "[[module SEARCH]]",
        ] {
            assert_eq!(expand(source), expected, "{source}");
        }
    }

    #[test]
    fn distinguishes_feed_source_recognition_from_missing_source() {
        let missing = r#"<div class="error-block">No feed source specified ("src" element missing).</div>"#;
        for source in [
            "[[module Feed]]",
            "[[module Feed src=\"\"]]",
            "[[module Feed limit=\"1\"]]",
            "[[module Feed src='https://example.com/feed.xml']]",
            "[[module Feed SRC=\"https://example.com/feed.xml\"]]",
        ] {
            assert_eq!(expand(source), missing, "{source}");
        }

        assert_eq!(
            expand("[[module Feed src=\"https://example.com/feed.xml\"]]"),
            r#"<div class="error-block">Error processing the feed "https://example.com/feed.xml". The feed can not be accessed or contains errors. </div>"#,
        );
    }

    #[test]
    fn leaves_search_and_feed_literal_inside_literal_regions() {
        assert_eq!(
            expand("@@[[module Search]]@@\n@@[[module Feed]]@@"),
            "@@[[module Search]]@@\n@@[[module Feed]]@@",
        );
    }

    #[test]
    fn leaves_unobserved_inline_search_and_feed_modules_literal() {
        assert_eq!(
            expand("before [[module Search]] after\nbefore [[module Feed]] after"),
            "before [[module Search]] after\nbefore [[module Feed]] after",
        );
    }

    fn hybrid_payload(rendered: &str) -> (&str, String) {
        let prefix = r#"<div class="wikidot-hybrid-module" id="wikidot-hybrid-module-"#;
        let start = rendered.find(prefix).unwrap_or_else(|| {
            panic!("saved Feed must be a hybrid module placeholder:\n{rendered}")
        });
        let rest = &rendered[start + prefix.len()..];
        let id_end = rest
            .find('"')
            .unwrap_or_else(|| panic!("hybrid module id must be quoted:\n{rendered}"));
        let payload_start =
            rest.find(r#"<div style="display: none">"#)
                .unwrap_or_else(|| {
                    panic!("hybrid module payload must be hidden:\n{rendered}")
                });
        let payload_start = payload_start + r#"<div style="display: none">"#.len();
        let payload_end = rest[payload_start..]
            .find("</div>")
            .unwrap_or_else(|| panic!("hybrid module payload must close:\n{rendered}"));
        (
            &rest[..id_end],
            rest[payload_start..payload_start + payload_end].to_owned(),
        )
    }

    #[test]
    fn saved_pages_render_the_live_feed_hybrid_module_placeholder() {
        let rendered = expand_with_mode("[[module Feed]]", false);
        let (id, payload) = hybrid_payload(&rendered);
        assert!(id.parse::<u32>().is_ok(), "hybrid module id: {id}");
        assert_eq!(
            payload,
            r#"{&quot;module&quot;:&quot;feed\/FeedModule&quot;,&quot;params&quot;:{}}"#,
            "live saved Feed placeholder carries the module identity and empty params",
        );
        assert!(!rendered.contains("error-block"));
    }

    #[test]
    fn saved_feed_hybrid_payload_carries_parameters_in_source_order() {
        let rendered = expand_with_mode(
            "[[module Feed title=\"DH2 feed\" max=\"3\" src=\"https://scp-wiki.wikidot.com/feed/pages\"]]",
            false,
        );
        let (_, payload) = hybrid_payload(&rendered);
        assert_eq!(
            payload,
            concat!(
                r#"{&quot;module&quot;:&quot;feed\/FeedModule&quot;,&quot;params&quot;:{"#,
                r#"&quot;title&quot;:&quot;DH2 feed&quot;,"#,
                r#"&quot;max&quot;:&quot;3&quot;,"#,
                r#"&quot;src&quot;:&quot;https:\/\/scp-wiki.wikidot.com\/feed\/pages&quot;}}"#,
            ),
            "live echoes every authored parameter into the hidden payload",
        );
    }

    #[test]
    fn preview_feed_routes_keep_the_server_error_block() {
        for source in [
            "[[module Feed]]",
            "[[module Feed src=\"\" max=\"3\"]]",
            "[[module Feed src=\"https://example.com/feed.xml\"]]",
        ] {
            let rendered = expand_with_mode(source, true);
            assert!(!rendered.contains("wikidot-hybrid-module"), "{source}");
            assert!(rendered.contains("error-block"), "{source}");
        }
    }

    #[test]
    fn feed_inaccessible_source_error_escapes_the_source_url() {
        let rendered =
            expand("[[module Feed src=\"https://example.com/feed?a=1&b=<x>\"]]");
        assert!(
            rendered.contains("\"https://example.com/feed?a=1&amp;b=&lt;x&gt;\"",),
            "special characters must be escaped:\n{rendered}",
        );
        assert!(
            !rendered.contains("&b=<x>"),
            "no raw markup may reach the error block:\n{rendered}",
        );
    }
}

use super::{LazyLock, Regex, RenderService, escape_list_pages_html_attr};
use ftml::data::PageInfo;

static WIKIDOT_DIRECT_HTML_IFRAME_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)^\s*(?P<iframe><iframe\b(?P<attrs>[^<>]*)>\s*</iframe\s*>)\s*$"#)
        .expect("direct Wikidot HTML iframe expression is valid")
});
static WIKIDOT_DIRECT_HTML_IFRAME_ATTRIBUTE_REGEX: LazyLock<Regex> = LazyLock::new(
    || {
        Regex::new(
            r#"(?is)\s+(?P<name>[a-z][a-z0-9:-]*)(?:\s*=\s*(?P<value>"[^"<>]*"|'[^'<>]*'|[^\s"'=<>`]+))?"#,
        )
        .expect("direct Wikidot HTML iframe attribute expression is valid")
    },
);

pub(in crate::services::render) struct WikidotHtmlBlockIframeAttribute<'a> {
    pub name: String,
    pub value: Option<&'a str>,
}

pub(in crate::services::render) struct WikidotHtmlBlockIframe<'a> {
    pub iframe: &'a str,
    pub attributes: Vec<WikidotHtmlBlockIframeAttribute<'a>>,
}

impl<'a> WikidotHtmlBlockIframe<'a> {
    pub fn attribute_value(&self, name: &str) -> Option<&'a str> {
        self.attributes
            .iter()
            .find(|attribute| attribute.name == name)
            .and_then(|attribute| attribute.value)
    }

    pub fn attribute_count(&self, name: &str) -> usize {
        self.attributes
            .iter()
            .filter(|attribute| attribute.name == name)
            .count()
    }
}

fn unquoted_attribute_value(raw: &str) -> &str {
    raw.strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            raw.strip_prefix('\'')
                .and_then(|rest| rest.strip_suffix('\''))
        })
        .unwrap_or(raw)
}

impl RenderService {
    pub(in crate::services::render) fn parse_wikidot_html_block_iframe(
        html_block: &str,
    ) -> Option<WikidotHtmlBlockIframe<'_>> {
        const ALLOWED_ATTRIBUTES: &[&str] = &[
            "align",
            "allow",
            "allowfullscreen",
            "allowtransparency",
            "class",
            "frameborder",
            "height",
            "loading",
            "referrerpolicy",
            "sandbox",
            "scrolling",
            "src",
            "style",
            "title",
            "width",
        ];

        let captures = WIKIDOT_DIRECT_HTML_IFRAME_REGEX.captures(html_block)?;
        let attributes = captures
            .name("attrs")
            .expect("direct iframe capture has attributes")
            .as_str();
        let mut cursor = 0;
        let mut parsed_attributes = Vec::new();
        for attribute in
            WIKIDOT_DIRECT_HTML_IFRAME_ATTRIBUTE_REGEX.captures_iter(attributes)
        {
            let whole = attribute
                .get(0)
                .expect("direct iframe attribute capture has whole match");
            if !attributes[cursor..whole.start()].trim().is_empty() {
                return None;
            }
            let name = attribute
                .name("name")
                .expect("direct iframe attribute capture has name")
                .as_str()
                .to_ascii_lowercase();
            if !ALLOWED_ATTRIBUTES.contains(&name.as_str()) {
                return None;
            }
            let value = attribute
                .name("value")
                .map(|value| unquoted_attribute_value(value.as_str()));
            parsed_attributes.push(WikidotHtmlBlockIframeAttribute { name, value });
            cursor = whole.end();
        }
        if !attributes[cursor..].trim().is_empty() || parsed_attributes.is_empty() {
            return None;
        }
        captures
            .name("iframe")
            .map(|iframe| WikidotHtmlBlockIframe {
                iframe: iframe.as_str(),
                attributes: parsed_attributes,
            })
    }

    pub(super) fn wikidot_direct_html_iframe(html_block: &str) -> Option<&str> {
        let parsed = Self::parse_wikidot_html_block_iframe(html_block)?;
        let mut src_seen = false;
        for attribute in &parsed.attributes {
            if attribute.name == "src" {
                // Browsers resolve the first src and compare its scheme
                // case-insensitively, so a repeated src cannot be vetted.
                if std::mem::replace(&mut src_seen, true) {
                    return None;
                }
                let unquoted = attribute.value?;
                // Live probes cover HTTP and HTTPS src values for direct
                // emission, and list sandbox among the pass-through
                // attributes, so sandbox stays allowlisted.
                if !(unquoted.starts_with("https://") || unquoted.starts_with("http://"))
                {
                    return None;
                }
            }
        }
        Some(parsed.iframe)
    }

    pub(in crate::services::render) fn rewrite_wikidot_html_block_iframe_urls(
        mut body: String,
        page_info: &PageInfo<'_>,
        html_blocks: &[String],
        html_block_owner_slug: Option<&str>,
    ) -> String {
        const PLACEHOLDER: &str = concat!(
            r#"<iframe src="https://example.com/" allowtransparency="true" "#,
            r#"frameborder="0" class="html-block-iframe"></iframe>"#,
        );
        if html_blocks.is_empty() || !body.contains(PLACEHOLDER) {
            return body;
        }

        let full_slug = Self::page_info_full_slug(page_info);
        // PagePreviewModule uses `search:site` for the otherwise anonymous
        // preview page identity. Keep that route fallback local to HTML-block
        // registration: treating it as the query's current page changes
        // ListPages selection and exclusion semantics.
        let full_slug = if full_slug.is_empty() {
            "search:site".to_owned()
        } else {
            full_slug
        };
        let hosted_slug = html_block_owner_slug.unwrap_or(&full_slug);
        let mut search_start = 0;
        for index in 1..=html_blocks.len() {
            let Some(relative_start) = body[search_start..].find(PLACEHOLDER) else {
                break;
            };
            let start = search_start + relative_start;
            let end = start + PLACEHOLDER.len();
            let iframe = Self::wikidot_html_block_interwiki_iframe(
                &html_blocks[index - 1],
                &full_slug,
                page_info.language.as_ref(),
            )
            .or_else(|| {
                Self::wikidot_direct_html_iframe(&html_blocks[index - 1])
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| {
                format!(
                    concat!(
                        r#"<iframe src="/{}/html/{}" allowtransparency="true" "#,
                        r#"frameborder="0" class="html-block-iframe"></iframe>"#,
                    ),
                    escape_list_pages_html_attr(hosted_slug),
                    index,
                )
            });
            body.replace_range(start..end, &iframe);
            search_start = start + iframe.len();
        }
        body
    }
}

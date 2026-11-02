use super::{
    Config, Cow, LazyLock, Regex, RenderService, SiteModel, percent_encode_path_segment,
};

/// Wikidot's own page-code route, `https://<site>.wikidot.com/<page>/code/<n>`,
/// as written in a stylesheet `url(...)`. Wikidot answers it with a redirect to
/// `https://<site>.wdfiles.com/local--code/<page>/<n>` (observed 2026-10-19 for
/// `/theme:al-slop/code/1`), so it names the same hosted code block.
static WIKIDOT_PAGE_CODE_CSS_URL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?P<prefix>url\(\s*["']?)(?:https?:)?//(?P<host>[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.wikidot\.com)(?::[0-9]+)?/+(?P<page>[^/"')<>\s?#]+)/code/(?P<index>[0-9]+)(?P<tail>[^"')<>\s]*)"#,
    )
    .unwrap()
});

pub(super) fn localize_wikidot_page_code_css_urls(
    html: &str,
    current_site: &SiteModel,
    config: &Config,
) -> String {
    WIKIDOT_PAGE_CODE_CSS_URL_REGEX
        .replace_all(html, |captures: &regex::Captures<'_>| {
            let original = captures.get(0).map_or("", |m| m.as_str()).to_owned();
            let tail = &captures["tail"];
            if !(tail.is_empty() || tail.starts_with('?') || tail.starts_with('#')) {
                return original;
            }
            let page = &captures["page"];
            // Wikidot's redirect target spells the separator `%3A`.
            let page = if page.contains('%') {
                Cow::Borrowed(page)
            } else {
                Cow::Owned(percent_encode_path_segment(page))
            };
            let path = format!("/local--code/{page}/{}", &captures["index"]);
            let Some(localized) = RenderService::localized_wikidot_local_file_url(
                &captures["host"],
                &path,
                current_site,
                config,
            ) else {
                return original;
            };

            format!("{}{}{tail}", &captures["prefix"], localized)
        })
        .into_owned()
}

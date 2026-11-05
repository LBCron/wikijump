use super::super::wikidot_user_resources::{WIKIDOT_AVATAR_BASE, WIKIDOT_USER_INFO_URL};
use super::{
    CompatHtmlFragments, LiteralRegionIndex, Reference, RelationService, RenderService,
    Result, ServiceContext, UserService, WikitextSettings, escape_list_pages_html_attr,
    escape_list_pages_html_text, wikidot_module_argument,
};
use crate::services::user::User;
use regex::Regex;
use std::sync::LazyLock;

pub(super) static WATCHERS_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\[\[module\s+Watchers\b(?P<head>(?:[^\]"]+|"[^"]*")*)\]\]"#)
        .unwrap()
});

const WATCHERS_ROW_PREFIX: &str = "\n\t\t\t";
const WATCHERS_FOOTER: &str = "\n\t\t\t\n\n\n\n";
const WATCHERS_WATCH_ACTIONS: &str = concat!(
    "\t<div class=\"actions\" style=\"margin-top: 10px\">\n",
    "\t\t\t\t\n",
    "\t\t\tWatch:\n",
    "\t\t\t<a href=\"javascript:;\"\n",
    "\t\t\t\tonclick=\"WIKIDOT.page.listeners.awatch(event, 'site', false, true)\"\n",
    "\t\t\t>site</a>\n",
    "                \t\t\t|\n",
    "    \t\t\t<a href=\"javascript:;\"\n",
    "    \t\t\t\tonclick=\"WIKIDOT.page.listeners.awatch(event, 'category', false, true)\"\n",
    "    \t\t\t>category</a> \n",
    "    \t\t\t| \n",
    "    \t\t\t<a href=\"javascript:;\"\n",
    "    \t\t\t\tonclick=\"WIKIDOT.page.listeners.awatch(event, 'page', false, true)\"\n",
    "    \t\t\t>page</a>\n",
    "            \t\t\t</div>",
);
const WATCHERS_UNWATCH_ACTIONS: &str = concat!(
    "\t<div class=\"actions\" style=\"margin-top: 10px\">\n",
    "\t\t\t\t\t\n",
    "\t\t\t                \t\t\t\t    <a href=\"javascript:;\"\n",
    "\t\t\t\t\t    onclick=\"WIKIDOT.page.listeners.awatch(event, 'page', true, true)\"\n",
    "    \t\t\t\t>Unwatch page</a>\n",
    "                \t\t\t\t\t\t</div>",
);

struct WatchersModuleUser {
    user_id: i64,
    name: String,
    slug: Option<String>,
    wikidot: bool,
}

fn watchers_module_user(user: User) -> Option<WatchersModuleUser> {
    match user {
        User::Wikidot(user) => {
            let user_id = i64::from(user.user_id);
            Some(WatchersModuleUser {
                user_id,
                name: user.name?,
                slug: user.slug,
                wikidot: true,
            })
        }
        User::Wikijump(user) => {
            if user.deleted_at.is_some() {
                return None;
            }
            Some(WatchersModuleUser {
                user_id: user.user_id,
                name: user.name,
                slug: Some(user.slug),
                wikidot: false,
            })
        }
    }
}

fn render_watchers_module_user(
    user: &WatchersModuleUser,
    avatar_timestamp: i64,
) -> String {
    let name_text = escape_list_pages_html_text(&user.name);
    let Some(slug) = user.slug.as_deref() else {
        return format!(r#"<span class="printuser">{name_text}</span>"#);
    };
    if !user.wikidot {
        return format!(r#"<span class="printuser">{name_text}</span>"#);
    }
    let profile = escape_list_pages_html_attr(&format!("{WIKIDOT_USER_INFO_URL}{slug}"));
    let name_attr = escape_list_pages_html_attr(&user.name);
    format!(
        concat!(
            r#"<span class="printuser avatarhover"><a href="{profile}" "#,
            r#"onclick="WIKIDOT.page.listeners.userInfo({user_id}); return false;"  >"#,
            r#"<img class="small" src="{avatar_base}/avatar.php?userid={user_id}&amp;amp;size=small&amp;amp;timestamp={avatar_timestamp}" "#,
            r#"alt="{name_attr}" style="background-image:url({avatar_base}/userkarma.php?u={user_id})"/></a>"#,
            r#"<a href="{profile}" onclick="WIKIDOT.page.listeners.userInfo({user_id}); return false;" >{name_text}</a></span>"#,
        ),
        profile = profile,
        user_id = user.user_id,
        avatar_base = WIKIDOT_AVATAR_BASE,
        avatar_timestamp = avatar_timestamp,
        name_attr = name_attr,
        name_text = name_text,
    )
}

fn render_watchers_module_html(
    users: &[WatchersModuleUser],
    avatar_timestamp: i64,
    viewer_watches_page: bool,
    no_actions: bool,
) -> String {
    if users.is_empty() {
        return String::new();
    }
    let mut output = String::new();
    for user in users {
        output.push_str(WATCHERS_ROW_PREFIX);
        output.push_str(&render_watchers_module_user(user, avatar_timestamp));
        output.push_str("<br/>");
    }
    output.push_str(WATCHERS_FOOTER);
    if !no_actions {
        output.push_str(if viewer_watches_page {
            WATCHERS_UNWATCH_ACTIONS
        } else {
            WATCHERS_WATCH_ACTIONS
        });
    }
    output
}

fn watchers_module_no_actions(head: &str) -> bool {
    let Some(value) = wikidot_module_argument(head, "noActions") else {
        return false;
    };
    let value = value.trim();
    !matches!(value, "" | "0")
}

impl RenderService {
    pub(super) async fn expand_watchers_modules(
        ctx: &ServiceContext<'_>,
        wikitext: String,
        settings: &WikitextSettings,
        current_page_id: Option<i64>,
        viewer_user_id: Option<i64>,
        compat_html: &mut CompatHtmlFragments,
    ) -> Result<String> {
        if !settings.enable_page_syntax || !WATCHERS_MODULE_REGEX.is_match(&wikitext) {
            return Ok(wikitext);
        }
        let watcher_ids = match current_page_id {
            Some(page_id) => {
                RelationService::get_all_active_page_watcher_ids(ctx, page_id).await?
            }
            None => Vec::new(),
        };
        let viewer_watches_page =
            viewer_user_id.is_some_and(|viewer| watcher_ids.contains(&viewer));
        let mut users = Vec::with_capacity(watcher_ids.len());
        for user_id in watcher_ids {
            let user = UserService::get_optional(ctx, Reference::Id(user_id)).await?;
            if let Some(user) = user.and_then(watchers_module_user) {
                users.push(user);
            }
        }
        let avatar_timestamp = time::OffsetDateTime::now_utc().unix_timestamp();

        let literal_regions =
            LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
        let mut output = String::with_capacity(wikitext.len());
        let mut cursor = 0;
        for captures in WATCHERS_MODULE_REGEX.captures_iter(&wikitext) {
            let matched = captures
                .get(0)
                .expect("a Watchers capture always has a complete match");
            if literal_regions.contains(matched.start()) {
                continue;
            }
            let head = captures.name("head").map_or("", |head| head.as_str());
            let rendered = render_watchers_module_html(
                &users,
                avatar_timestamp,
                viewer_watches_page,
                watchers_module_no_actions(head),
            );
            output.push_str(&wikitext[cursor..matched.start()]);
            if rendered.is_empty() {
                output.push_str(
                    &compat_html.push_block_html("<p>\n\n\n\n\n</p>".to_owned()),
                );
            } else {
                output.push_str(&compat_html.push_block_html(rendered));
            }
            cursor = matched.end();
        }
        if cursor == 0 {
            return Ok(wikitext);
        }
        output.push_str(&wikitext[cursor..]);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        WATCHERS_WATCH_ACTIONS, WatchersModuleUser, render_watchers_module_html,
        watchers_module_no_actions,
    };

    fn user(user_id: i64, name: &str, wikidot: bool) -> WatchersModuleUser {
        WatchersModuleUser {
            user_id,
            name: name.to_owned(),
            slug: Some(name.to_lowercase().replace(' ', "-")),
            wikidot,
        }
    }

    #[test]
    fn watchers_rows_follow_the_live_printuser_shape() {
        let html = render_watchers_module_html(
            &[
                user(5700026, "Rokurokubi", true),
                user(8955132, "scpaiueouiuiuiui", true),
            ],
            1793894442,
            false,
            true,
        );
        assert!(html.starts_with(concat!(
            "\n\t\t\t<span class=\"printuser avatarhover\">",
            r#"<a href="https://www.wikidot.com/user:info/rokurokubi" "#,
        )));
        assert!(html.contains(concat!(
            r#"<img class="small" src="https://www.wikidot.com/avatar.php?userid=5700026"#,
            r#"&amp;amp;size=small&amp;amp;timestamp=1793894442""#,
            r#" alt="Rokurokubi" "#,
            r#"style="background-image:url(https://www.wikidot.com/userkarma.php?u=5700026)"/>"#,
        )));
        assert!(html.contains(r#">Rokurokubi</a></span><br/>"#));
        assert!(html.contains(r#">scpaiueouiuiuiui</a></span><br/>"#));
        let first = html.find("Rokurokubi").expect("first watcher");
        let second = html.find("scpaiueouiuiuiui").expect("second watcher");
        assert!(first < second);
        assert!(!html.contains("class=\"actions\""), "{html}");
    }

    #[test]
    fn watchers_actions_match_the_live_watch_and_unwatch_blocks() {
        let users = [user(5700026, "Rokurokubi", true)];
        let watch = render_watchers_module_html(&users, 1, false, false);
        assert!(watch.ends_with(WATCHERS_WATCH_ACTIONS), "{watch}");
        assert!(!watch.contains(">Unwatch page"), "{watch}");

        let unwatch = render_watchers_module_html(&users, 1, true, false);
        assert!(unwatch.contains(r#">Unwatch page</a>"#), "{unwatch}");
        assert!(unwatch.contains("'page', true, true"), "{unwatch}");
        assert!(!unwatch.contains(">Watch:"), "{unwatch}");
    }

    #[test]
    fn watchers_noactions_uses_live_php_truthiness() {
        for head in [
            r#" noActions="true""#,
            r#" noActions="false""#,
            r#" noActions="no""#,
            r#" noActions=" true ""#,
        ] {
            assert!(watchers_module_no_actions(head), "{head}");
        }
        for head in ["", r#" noActions="""#, r#" noActions="0""#, r#" other="x""#] {
            assert!(!watchers_module_no_actions(head), "{head}");
        }
    }

    #[test]
    fn watchers_empty_list_renders_no_rows() {
        assert!(render_watchers_module_html(&[], 1, false, false).is_empty());
    }
}

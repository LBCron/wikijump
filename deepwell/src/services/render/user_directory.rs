use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::LazyLock;

use ftml::data::UserInfo;
use rand::RngExt;
use regex::Regex;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    Statement, Value,
};
use serde::Serialize;

use super::ftml_user_info::load_wikidot_user_info_by_ids;
use super::literal_regions::LiteralRegionIndex;
use super::module_arguments::{WikidotModuleArgumentValueKind, wikidot_module_arguments};
use super::service::{
    RenderService, escape_list_pages_html_attr, escape_list_pages_html_text,
    format_wikidot_list_pages_date,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::user::{self, Entity as WikijumpUser};
use crate::services::ServiceContext;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::types::{Action, Permission, Resource};
use crate::utils::now;

pub(super) const MEMBERS_PAGE_SIZE: usize = 100;

pub(super) static MEMBERS_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\[\[module\s+Members\b(?P<head>(?:[^\]"]+|"[^"]*")*)\]\]"#)
        .expect("Members module expression is valid")
});

#[derive(Clone, Debug, Serialize)]
pub struct WikidotMembersListModuleResponse {
    pub status: String,
    pub body: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MembersGroup {
    Members,
    Admins,
    Moderators,
}

impl MembersGroup {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "members" => Some(Self::Members),
            "admins" => Some(Self::Admins),
            "moderators" => Some(Self::Moderators),
            _ => None,
        }
    }

    fn role_name(self) -> Option<&'static str> {
        match self {
            Self::Members => None,
            Self::Admins => Some("admin"),
            Self::Moderators => Some("moderator"),
        }
    }

    fn wikidot_value(self) -> &'static str {
        match self {
            Self::Members => "",
            Self::Admins => "admins",
            Self::Moderators => "moderators",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MembersOrder {
    UserId,
    UserIdDesc,
    Joined,
    JoinedDesc,
    Name,
    NameDesc,
}

impl MembersOrder {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "userId" => Some(Self::UserId),
            "userIdDesc" => Some(Self::UserIdDesc),
            "joined" => Some(Self::Joined),
            "joinedDesc" => Some(Self::JoinedDesc),
            "name" => Some(Self::Name),
            "nameDesc" => Some(Self::NameDesc),
            _ => None,
        }
    }

    fn wikidot_value(self) -> &'static str {
        match self {
            Self::UserId => "userId",
            Self::UserIdDesc => "userIdDesc",
            Self::Joined => "joined",
            Self::JoinedDesc => "joinedDesc",
            Self::Name => "name",
            Self::NameDesc => "nameDesc",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct MembersArguments {
    group: MembersGroup,
    order: MembersOrder,
    show_since: bool,
}

impl MembersArguments {
    pub(super) fn parse(head: &str) -> Option<Self> {
        let arguments = wikidot_module_arguments(head)?;
        let mut group = None;
        let mut order = None;
        let mut show_since = None;
        for argument in arguments {
            if argument.op != "="
                || argument.value_kind != WikidotModuleArgumentValueKind::DoubleQuoted
            {
                return None;
            }
            match argument.key {
                "group" if group.is_none() => {
                    group = Some(MembersGroup::parse(argument.value)?);
                }
                "order" if order.is_none() => {
                    order = Some(MembersOrder::parse(argument.value)?);
                }
                "showSince" if show_since.is_none() => {
                    show_since = Some(match argument.value {
                        "no" | "false" => false,
                        _ => return None,
                    });
                }
                _ => return None,
            }
        }

        let group = group.unwrap_or(MembersGroup::Members);
        if group != MembersGroup::Members && show_since.is_some() {
            return None;
        }
        Some(Self {
            group,
            order: order.unwrap_or(MembersOrder::Joined),
            show_since: show_since.unwrap_or(group == MembersGroup::Members),
        })
    }
}

pub(super) fn wikitext_has_executable_members_module(wikitext: &str) -> bool {
    if !MEMBERS_MODULE_REGEX.is_match(wikitext) {
        return false;
    }
    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(wikitext);
    MEMBERS_MODULE_REGEX
        .captures_iter(wikitext)
        .any(|captures| {
            let module = captures
                .get(0)
                .expect("a Members capture always has a complete match");
            let head = captures.name("head").map_or("", |head| head.as_str());
            !literal_regions.contains(module.start())
                && MembersArguments::parse(head).is_some()
        })
}

#[derive(Clone, Debug)]
enum DirectoryIdentity {
    Wikidot(UserInfo<'static>),
    Wikijump { name: String },
}

#[derive(Clone, Debug)]
struct DirectoryRow {
    identity: DirectoryIdentity,
    joined_at: time::OffsetDateTime,
}

#[derive(Debug, FromQueryResult)]
struct DirectoryCandidate {
    user_id: i64,
    joined_at: time::OffsetDateTime,
    total_count: i64,
}

pub(super) async fn render_members_module(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    viewer_user_id: Option<i64>,
    head: &str,
    module_index: usize,
) -> Result<Option<String>> {
    let Some(arguments) = MembersArguments::parse(head) else {
        return Ok(None);
    };
    if !check_member_directory_site_view(ctx, site_id, viewer_user_id).await? {
        return Ok(Some(String::new()));
    }
    let (rows, total_count) = load_directory_page(ctx, site_id, arguments, 0).await?;
    let total_pages = total_count.div_ceil(MEMBERS_PAGE_SIZE);
    Ok(Some(render_directory(
        &rows,
        arguments,
        module_index,
        total_pages,
    )))
}

impl RenderService {
    pub async fn render_wikidot_members_list_module(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        parameters: &BTreeMap<String, String>,
    ) -> Result<WikidotMembersListModuleResponse> {
        let Some(page) = members_ajax_page(parameters) else {
            return Ok(members_ajax_response("not_ok", String::new()));
        };
        if !check_member_directory_site_view(ctx, site_id, ctx.request().user_id().ok())
            .await?
        {
            return Ok(members_ajax_response("not_ok", String::new()));
        }

        let (page_rows, total_pages) = load_members_ajax_page(ctx, site_id, page).await?;
        let page = usize::try_from(page).expect("u32 page fits the supported targets");
        let module_index: u32 = rand::rng().random_range(10_000..1_000_000);
        Ok(members_ajax_response(
            "ok",
            render_members_ajax_directory(&page_rows, page, total_pages, module_index),
        ))
    }
}

fn members_ajax_page(parameters: &BTreeMap<String, String>) -> Option<u32> {
    if parameters.len() != 3
        || parameters.get("group").map(String::as_str) != Some("")
        || parameters.get("order").map(String::as_str) != Some("joined")
    {
        return None;
    }
    let page = parameters.get("page")?;
    let page_bytes = page.as_bytes();
    let canonical_page = page_bytes == b"0"
        || matches!(page_bytes, [b'1'..=b'9', rest @ ..] if rest.iter().all(u8::is_ascii_digit));
    if !canonical_page {
        return None;
    }
    Some(page.parse::<u32>().ok()?.max(1))
}

async fn check_member_directory_site_view(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    viewer_user_id: Option<i64>,
) -> Result<bool> {
    PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id: viewer_user_id,
            site_id,
            page_reference: None,
        },
        Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::View,
        },
    )
    .await
    .or_raise(|| Error::new("failed to check member directory site", ErrorType::Render))
}

fn members_ajax_response(status: &str, body: String) -> WikidotMembersListModuleResponse {
    WikidotMembersListModuleResponse {
        status: status.to_owned(),
        body,
    }
}

async fn load_directory_page(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    arguments: MembersArguments,
    offset: i64,
) -> Result<(Vec<DirectoryRow>, usize)> {
    let candidates =
        load_directory_candidates(ctx, site_id, arguments.group, arguments.order, offset)
            .await?;
    let total_count = candidates
        .first()
        .map_or(0, |candidate| candidate.total_count);
    let total_count = usize::try_from(total_count).or_raise(|| {
        Error::new(
            "Members directory count cannot be represented",
            ErrorType::Render,
        )
    })?;
    let rows = build_directory_rows(ctx, site_id, candidates).await?;
    Ok((rows, total_count))
}

async fn load_directory_candidates(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    group: MembersGroup,
    order: MembersOrder,
    offset: i64,
) -> Result<Vec<DirectoryCandidate>> {
    let mut values = vec![Value::from(site_id)];
    let role_filter = match group.role_name() {
        Some(role_name) => {
            values.push(Value::from(role_name));
            values.push(Value::from(now()));
            concat!(
                "AND EXISTS (",
                "SELECT 1 FROM user_role assignment ",
                "JOIN role directory_role ",
                "ON directory_role.role_id = assignment.role_id ",
                "WHERE assignment.user_id = membership.from_id ",
                "AND assignment.site_id = $1 ",
                "AND directory_role.site_id = $1 ",
                "AND directory_role.name = $2 ",
                "AND directory_role.is_virtual = FALSE ",
                "AND directory_role.deleted_at IS NULL ",
                "AND assignment.deleted_at IS NULL ",
                "AND (assignment.expires_at IS NULL OR assignment.expires_at > $3)",
                ") ",
            )
        }
        None => "",
    };
    let order_by = match order {
        MembersOrder::UserId => "user_id",
        MembersOrder::UserIdDesc => "user_id DESC",
        MembersOrder::Joined => "joined_at, user_id",
        MembersOrder::JoinedDesc => "joined_at DESC, user_id DESC",
        MembersOrder::Name => "LOWER(display_name), user_id",
        MembersOrder::NameDesc => "LOWER(display_name) DESC, user_id DESC",
    };
    values.push(Value::from(MEMBERS_PAGE_SIZE as i64));
    let limit_index = values.len();
    values.push(Value::from(offset));
    let offset_index = values.len();
    let statement = Statement::from_sql_and_values(
        ctx.transaction().get_database_backend(),
        format!(
            concat!(
                "WITH active_members AS (",
                "SELECT membership.from_id AS user_id, ",
                "MIN(membership.created_at) AS joined_at ",
                "FROM relation membership ",
                "WHERE membership.relation_type IN ('member', 'site-member') ",
                "AND membership.dest_type = 'site' ",
                "AND membership.dest_id = $1 ",
                "AND membership.from_type = 'user' ",
                "AND membership.overwritten_at IS NULL ",
                "AND membership.deleted_at IS NULL ",
                "AND (",
                "EXISTS (SELECT 1 FROM wikidot_user imported_user ",
                "WHERE imported_user.user_id = membership.from_id ",
                "AND imported_user.is_deleted = FALSE ",
                "AND imported_user.name IS NOT NULL ",
                "AND imported_user.slug IS NOT NULL) ",
                "OR EXISTS (SELECT 1 FROM \"user\" local_user ",
                "WHERE local_user.user_id = membership.from_id ",
                "AND local_user.deleted_at IS NULL)",
                ") ",
                "{role_filter}",
                "GROUP BY membership.from_id",
                "), directory AS (",
                "SELECT member.user_id, member.joined_at, ",
                "COALESCE(imported_user.name, local_user.name) AS display_name ",
                "FROM active_members member ",
                "LEFT JOIN wikidot_user imported_user ",
                "ON imported_user.user_id = member.user_id ",
                "AND imported_user.is_deleted = FALSE ",
                "AND imported_user.name IS NOT NULL ",
                "AND imported_user.slug IS NOT NULL ",
                "LEFT JOIN \"user\" local_user ",
                "ON local_user.user_id = member.user_id ",
                "AND local_user.deleted_at IS NULL",
                ") ",
                "SELECT user_id, joined_at, COUNT(*) OVER () AS total_count ",
                "FROM directory ",
                "ORDER BY {order_by} ",
                "LIMIT ${limit_index} OFFSET ${offset_index}",
            ),
            role_filter = role_filter,
            order_by = order_by,
            limit_index = limit_index,
            offset_index = offset_index,
        ),
        values,
    );
    DirectoryCandidate::find_by_statement(statement)
        .all(ctx.transaction())
        .await
        .or_raise(|| {
            Error::new(
                format!("failed to load member directory for site ID {site_id}"),
                ErrorType::Render,
            )
        })
}

async fn build_directory_rows(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    candidates: Vec<DirectoryCandidate>,
) -> Result<Vec<DirectoryRow>> {
    let candidate_ids = candidates
        .iter()
        .map(|candidate| candidate.user_id)
        .collect::<BTreeSet<_>>();
    let mut identities = load_directory_identities(ctx, site_id, &candidate_ids).await?;
    let expected_rows = candidates.len();
    let rows = candidates
        .into_iter()
        .filter_map(|candidate| {
            let identity = identities.remove(&candidate.user_id)?;
            Some(DirectoryRow {
                identity,
                joined_at: candidate.joined_at,
            })
        })
        .collect::<Vec<_>>();
    if rows.len() != expected_rows {
        return Err(Error::new(
            "Members directory identity snapshot did not match its page query",
            ErrorType::Render,
        )
        .into());
    }
    Ok(rows)
}

async fn load_members_ajax_page(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page: u32,
) -> Result<(Vec<DirectoryRow>, usize)> {
    let offset = i64::from(page - 1) * MEMBERS_PAGE_SIZE as i64;
    let (rows, total_count) = load_directory_page(
        ctx,
        site_id,
        MembersArguments {
            group: MembersGroup::Members,
            order: MembersOrder::Joined,
            show_since: true,
        },
        offset,
    )
    .await?;
    Ok((rows, total_count.div_ceil(MEMBERS_PAGE_SIZE)))
}

async fn load_directory_identities(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    candidate_ids: &BTreeSet<i64>,
) -> Result<BTreeMap<i64, DirectoryIdentity>> {
    let make_error = || {
        Error::new(
            format!("failed to load member identities for site ID {site_id}"),
            ErrorType::Render,
        )
    };
    let mut identities = load_wikidot_user_info_by_ids(ctx, candidate_ids)
        .await
        .or_raise(make_error)?
        .into_iter()
        .map(|(user_id, user)| (user_id, DirectoryIdentity::Wikidot(user)))
        .collect::<BTreeMap<_, _>>();
    let missing_ids = candidate_ids
        .iter()
        .copied()
        .filter(|user_id| !identities.contains_key(user_id))
        .collect::<Vec<_>>();
    if !missing_ids.is_empty() {
        let users = WikijumpUser::find()
            .filter(
                Condition::all()
                    .add(user::Column::UserId.is_in(missing_ids))
                    .add(user::Column::DeletedAt.is_null()),
            )
            .all(ctx.transaction())
            .await
            .or_raise(make_error)?;
        identities.extend(users.into_iter().map(|user| {
            (
                user.user_id,
                DirectoryIdentity::Wikijump { name: user.name },
            )
        }));
    }
    Ok(identities)
}

fn render_directory(
    rows: &[DirectoryRow],
    arguments: MembersArguments,
    module_index: usize,
    total_pages: usize,
) -> String {
    let container_id = format!("ml-{module_index}");
    let function_name = format!("updateMemberList{module_index}");
    let supports_continuation = arguments
        == (MembersArguments {
            group: MembersGroup::Members,
            order: MembersOrder::Joined,
            show_since: true,
        });
    let avatar_timestamp = now().unix_timestamp();
    let mut output = format!("<div id=\"{container_id}\">\n\t\t<table>");
    for row in rows {
        output.push_str("\n\t\t\t<tr>\n\t\t\t\t<td>");
        render_directory_identity(&mut output, &row.identity, avatar_timestamp);
        output.push_str("</td>");
        if arguments.show_since {
            let unix = row.joined_at.unix_timestamp();
            let date = format_wikidot_list_pages_date(row.joined_at, "%e %b %Y %H:%M");
            write!(
                output,
                concat!(
                    "\n\t\t\t\t<td style=\"padding-left: 2em\">since ",
                    "<span class=\"odate time_{unix} ",
                    "format_%25e%20%25b%20%25Y%2C%20%25H%3A%25M%20%28%25O%20ago%29\">",
                    "{date}</span></td>",
                ),
                unix = unix,
                date = date,
            )
            .expect("writing a member date to a String cannot fail");
        }
        output.push_str("\n\t\t\t</tr>");
    }
    output.push_str("\n\t\t</table>");
    if supports_continuation {
        write!(
            output,
            concat!(
                "\n\t<script type=\"text/javascript\">\n",
            "\t\tfunction {function_name}(pageNo) {{\n",
            "\t\t\tvar p = {{}};\n",
            "\t\t\tp.group     = '{group}';\n",
            "\t\t\tp.order     = '{order}';\n",
            "\t\t\tvar containerElId = '{container_id}';\n",
            "\t\t\tp.page = pageNo;\n",
            "\t\t\tOZONE.ajax.requestModule(\"membership/MembersListModule\", p, function(r){{\n",
            "\t\t\t\tif (!WIKIDOT.utils.handleError(r)) {{return;}}\n",
            "\t\t\t\tjQuery('#'+containerElId).replaceWith(r.body);\n",
            "\t\t\t}});\n",
                "\t\t}}\n\t</script>",
            ),
            function_name = function_name,
            container_id = container_id,
            group = arguments.group.wikidot_value(),
            order = arguments.order.wikidot_value(),
        )
        .expect("writing the member directory script to a String cannot fail");
        if total_pages > 1 {
            render_pager(&mut output, &function_name, total_pages);
        }
    }
    output.push_str("\n</div>");
    output
}

fn render_members_ajax_directory(
    rows: &[DirectoryRow],
    page: usize,
    total_pages: usize,
    module_index: u32,
) -> String {
    let container_id = format!("ml-{module_index}");
    if rows.is_empty() {
        return format!(
            "\n<div id=\"{container_id}\">\n\t\tNo users.\t\t<div style=\"text-align: center\">\n\t\t\t\t\n\t</div>\n</div>",
        );
    }

    let function_name = format!("updateMemberList{module_index}");
    let avatar_timestamp = now().unix_timestamp();
    let mut output = format!("\n<div id=\"{container_id}\">\n\t\t<table>");
    for row in rows {
        output.push_str("\n\t\t\t<tr>\n\t\t\t\t<td>");
        render_directory_identity(&mut output, &row.identity, avatar_timestamp);
        output.push_str("</td>");
        let unix = row.joined_at.unix_timestamp();
        let date = format_wikidot_list_pages_date(row.joined_at, "%e %b %Y %H:%M");
        write!(
            output,
            concat!(
                "\n\t\t\t\t<td style=\"padding-left: 2em\">since ",
                "<span class=\"odate time_{unix} ",
                "format_%25e%20%25b%20%25Y%2C%20%25H%3A%25M%20%28%25O%20ago%29\">",
                "{date}</span></td>\n\t\t\t</tr>",
            ),
            unix = unix,
            date = date,
        )
        .expect("writing a Members Ajax date to a String cannot fail");
    }
    write!(
        output,
        concat!(
            "\n\t\t</table>\n\t\n\t<script type=\"text/javascript\">\n",
            "\t\tfunction {function_name}(pageNo) {{\n",
            "\t\t\tvar p = {{}};\n\t\t\t\n",
            "\t\t\tp.group     = '';\n",
            "\t\t\tp.order     = 'joined';\n\t\t\t\t\t\t\n",
            "\t\t\tvar containerElId = '{container_id}';\n\t\t\t\n",
            "\t\t\tp.page = pageNo;\n",
            "\t\t\tOZONE.ajax.requestModule(\"membership/MembersListModule\", p, function(r){{\n",
            "\t\t\t\tif (!WIKIDOT.utils.handleError(r)) {{return;}}\n",
            "\t\t\t\tjQuery('#'+containerElId).replaceWith(r.body);\n",
            "\t\t\t}});\n\t\t}}\n\t</script>",
        ),
        function_name = function_name,
        container_id = container_id,
    )
    .expect("writing a Members Ajax script to a String cannot fail");
    if total_pages > 1 {
        render_members_ajax_pager(&mut output, &function_name, page, total_pages);
    }
    output.push_str("\n</div>");
    output
}

fn render_members_ajax_pager(
    output: &mut String,
    function_name: &str,
    current_page: usize,
    total_pages: usize,
) {
    write!(
        output,
        "\n\t\t<div style=\"text-align: center\">\n\t\t\t\t<div class=\"pager\"><span class=\"pager-no\">page {current_page} of {total_pages}</span>",
    )
    .expect("writing a Members Ajax pager header to a String cannot fail");
    if current_page > 1 {
        render_members_ajax_pager_target(
            output,
            function_name,
            current_page - 1,
            "&laquo; previous",
        );
    }

    let mut pages = BTreeSet::from([1, 2, total_pages.saturating_sub(1), total_pages]);
    for page in current_page.saturating_sub(2).max(1)
        ..=current_page.saturating_add(2).min(total_pages)
    {
        pages.insert(page);
    }
    pages.retain(|page| *page > 0 && *page <= total_pages);
    let mut previous_page = None;
    for page in pages {
        if previous_page.is_some_and(|previous| page > previous + 1) {
            output.push_str("<span class=\"dots\">...</span>");
        }
        if page == current_page {
            write!(output, "<span class=\"current\">{page}</span>")
                .expect("writing a Members Ajax current page to a String cannot fail");
        } else {
            render_members_ajax_pager_target(
                output,
                function_name,
                page,
                &page.to_string(),
            );
        }
        previous_page = Some(page);
    }

    if current_page < total_pages {
        render_members_ajax_pager_target(
            output,
            function_name,
            current_page + 1,
            "next &raquo;",
        );
    }
    output.push_str("</div>\n\t</div>");
}

fn render_members_ajax_pager_target(
    output: &mut String,
    function_name: &str,
    page: usize,
    label: &str,
) {
    write!(
        output,
        "<span class=\"target\"><a href=\"javascript:;\" onclick=\"{function_name}({page})\">{label}</a></span>",
    )
    .expect("writing a Members Ajax pager target to a String cannot fail");
}

fn render_directory_identity(
    output: &mut String,
    identity: &DirectoryIdentity,
    avatar_timestamp: i64,
) {
    match identity {
        DirectoryIdentity::Wikijump { name, .. } => {
            output.push_str(&escape_list_pages_html_text(name));
        }
        DirectoryIdentity::Wikidot(user) => {
            let user_id = user.user_id;
            let profile = escape_list_pages_html_attr(&user.user_profile_url);
            let name_attr = escape_list_pages_html_attr(&user.user_name);
            let name_text = escape_list_pages_html_text(&user.user_name);
            write!(
                output,
                concat!(
                    "<span class=\"printuser avatarhover\">",
                    "<a href=\"{profile}\" onclick=\"WIKIDOT.page.listeners.userInfo({user_id}); return false;\">",
                    "<img class=\"small\" src=\"https://www.wikidot.com/avatar.php?userid={user_id}",
                    "&amp;amp;size=small&amp;amp;timestamp={avatar_timestamp}\" alt=\"{name_attr}\" ",
                    "style=\"background-image:url(https://www.wikidot.com/userkarma.php?u={user_id})\"/>",
                    "</a><a href=\"{profile}\" onclick=\"WIKIDOT.page.listeners.userInfo({user_id}); return false;\">",
                    "{name_text}</a></span>",
                ),
                profile = profile,
                user_id = user_id,
                avatar_timestamp = avatar_timestamp,
                name_attr = name_attr,
                name_text = name_text,
            )
            .expect("writing a Wikidot printuser to a String cannot fail");
        }
    }
}

fn render_pager(output: &mut String, function_name: &str, total_pages: usize) {
    write!(
        output,
        "\n\t<div style=\"text-align: center\"><div class=\"pager\"><span class=\"pager-no\">page 1 of {total_pages}</span><span class=\"current\">1</span>",
    )
    .expect("writing a member pager to a String cannot fail");
    for page in 2..=total_pages.min(3) {
        write!(
            output,
            "<span class=\"target\"><a href=\"javascript:;\" onclick=\"{function_name}({page})\">{page}</a></span>",
        )
        .expect("writing a member pager target to a String cannot fail");
    }
    if total_pages > 5 {
        output.push_str("<span class=\"dots\">...</span>");
        for page in [total_pages - 1, total_pages] {
            write!(
                output,
                "<span class=\"target\"><a href=\"javascript:;\" onclick=\"{function_name}({page})\">{page}</a></span>",
            )
            .expect("writing a member pager target to a String cannot fail");
        }
    } else {
        for page in 4..=total_pages {
            write!(
                output,
                "<span class=\"target\"><a href=\"javascript:;\" onclick=\"{function_name}({page})\">{page}</a></span>",
            )
            .expect("writing a member pager target to a String cannot fail");
        }
    }
    write!(
        output,
        "<span class=\"target\"><a href=\"javascript:;\" onclick=\"{function_name}(2)\">next &raquo;</a></span></div></div>",
    )
    .expect("writing a member pager next target to a String cannot fail");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_arguments_accept_only_documented_shapes() {
        assert_eq!(
            MembersArguments::parse(""),
            Some(MembersArguments {
                group: MembersGroup::Members,
                order: MembersOrder::Joined,
                show_since: true,
            }),
        );
        assert_eq!(
            MembersArguments::parse(r#" group="moderators" order="nameDesc""#,),
            Some(MembersArguments {
                group: MembersGroup::Moderators,
                order: MembersOrder::NameDesc,
                show_since: false,
            }),
        );
        for unsupported in [
            r#" group="owners""#,
            r#" group='members'"#,
            r#" Group="members""#,
            r#" showSince="true""#,
            r#" group="admins" showSince="false""#,
            r#" unknown="value""#,
            r#" group="members" group="admins""#,
        ] {
            assert_eq!(MembersArguments::parse(unsupported), None, "{unsupported}");
        }
    }

    #[test]
    fn member_pager_matches_the_observed_page_target_order() {
        let mut output = String::new();
        render_pager(&mut output, "updateMemberList1", 7);

        let page_two = output.find(">2</a>").expect("page 2 target should render");
        let page_three = output.find(">3</a>").expect("page 3 target should render");
        let dots = output
            .find("class=\"dots\"")
            .expect("pager gap should render");
        let page_six = output.find(">6</a>").expect("page 6 target should render");
        let page_seven = output.find(">7</a>").expect("page 7 target should render");
        assert!(page_two < page_three && page_three < dots);
        assert!(dots < page_six && page_six < page_seven);
    }
}

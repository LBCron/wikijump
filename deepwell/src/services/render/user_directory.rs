use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use ftml::data::UserInfo;
use rand::RngExt;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter,
    Statement, Value,
};
use serde::Serialize;

use super::ftml_user_info::load_wikidot_user_info_by_ids;
use super::literal_regions::LiteralRegionIndex;
use super::module_arguments::wikidot_module_double_quoted_arguments;
use super::module_tokens::wikitext_has_source_module;
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

pub(super) const MEMBERS_MODULE_NAMES: &[&str] = &["Members"];

pub(super) const MEMBERS_ORDER_ERROR_HTML: &str =
    r#"<div class="error-block">An error occurred when processing your request.</div>"#;

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
    show_since_false_argument: bool,
    page: u32,
    order_error: bool,
}

impl MembersArguments {
    /// Parses the Members module arguments the way live does: unknown
    /// arguments, unknown values and single-quoted or bare values are ignored
    /// and leave that setting at its default instead of failing the module.
    pub(super) fn parse(head: &str) -> Self {
        let mut arguments = Self {
            group: MembersGroup::Members,
            order: MembersOrder::Joined,
            show_since: true,
            show_since_false_argument: false,
            page: 1,
            order_error: false,
        };
        let mut group_value = None;
        let mut from_value = None;
        for (key, value) in wikidot_module_double_quoted_arguments(head) {
            match key {
                "group" => group_value = Some(value),
                "from" => from_value = Some(value),
                "order" => {
                    if let Some(order) = MembersOrder::parse(value) {
                        arguments.order = order;
                    }
                    if members_order_is_live_error(value) {
                        arguments.order_error = true;
                    }
                }
                "showSince" => {
                    let show_since = !matches!(value, "no" | "false" | "get lost");
                    arguments.show_since = show_since;
                    arguments.show_since_false_argument = !show_since;
                }
                "page" => {
                    if !value.is_empty()
                        && value.bytes().all(|byte| byte.is_ascii_digit())
                        && let Ok(page) = value.parse::<u32>()
                    {
                        arguments.page = page.max(1);
                    }
                }
                _ => {}
            }
        }

        if let Some(from) = from_value {
            arguments.group = MembersGroup::parse(from).unwrap_or(MembersGroup::Members);
        } else if let Some(group) = group_value {
            arguments.group = MembersGroup::parse(group).unwrap_or(MembersGroup::Members);
        }
        arguments
    }
}

/// Live's `order` list includes the `userId` spellings, but selecting them
/// fails inside the module and renders Wikidot's generic processing error.
fn members_order_is_live_error(value: &str) -> bool {
    matches!(value, "userId" | "userIdDesc")
}

pub(super) fn wikitext_has_executable_members_module(wikitext: &str) -> bool {
    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(wikitext);
    wikitext_has_source_module(wikitext, &literal_regions, MEMBERS_MODULE_NAMES)
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
    let arguments = MembersArguments::parse(head);
    if !check_member_directory_site_view(ctx, site_id, viewer_user_id).await? {
        return Ok(Some(String::new()));
    }
    if arguments.order_error {
        return Ok(Some(MEMBERS_ORDER_ERROR_HTML.to_owned()));
    }

    let offset = i64::from(arguments.page - 1) * MEMBERS_PAGE_SIZE as i64;
    let (rows, total_count) =
        load_directory_page(ctx, site_id, arguments, offset).await?;
    let total_pages = total_count.div_ceil(MEMBERS_PAGE_SIZE);
    if rows.is_empty() {
        return Ok(Some(render_empty_directory(module_index)));
    }
    if arguments.page > 1 {
        return Ok(Some(render_continuation_directory(
            &rows,
            arguments,
            arguments.page as usize,
            total_pages,
            module_index,
        )));
    }
    Ok(Some(render_directory(
        &rows,
        arguments,
        total_pages,
        module_index,
    )))
}

impl RenderService {
    pub async fn render_wikidot_members_list_module(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        parameters: &BTreeMap<String, String>,
    ) -> Result<WikidotMembersListModuleResponse> {
        let Some((arguments, page)) = members_ajax_arguments(parameters) else {
            return Ok(members_ajax_response("not_ok", String::new()));
        };
        if !check_member_directory_site_view(ctx, site_id, ctx.request().user_id().ok())
            .await?
        {
            return Ok(members_ajax_response("not_ok", String::new()));
        }

        let (page_rows, total_pages) =
            load_members_ajax_page(ctx, site_id, arguments, page).await?;
        let page = usize::try_from(page).expect("u32 page fits the supported targets");
        let module_index: usize = rand::rng().random_range(10_000..1_000_000);
        Ok(members_ajax_response(
            "ok",
            render_continuation_directory(
                &page_rows,
                arguments,
                page,
                total_pages,
                module_index,
            ),
        ))
    }
}

/// Parses the parameters of the Members continuation script. The script only
/// ever emits the shapes accepted here; anything else keeps the endpoint's
/// strict `not_ok` contract.
fn members_ajax_arguments(
    parameters: &BTreeMap<String, String>,
) -> Option<(MembersArguments, u32)> {
    if parameters
        .keys()
        .any(|key| !matches!(key.as_str(), "group" | "order" | "page" | "showSince"))
    {
        return None;
    }
    let group = match parameters.get("group").map(String::as_str) {
        Some("") => MembersGroup::Members,
        Some("admins") => MembersGroup::Admins,
        Some("moderators") => MembersGroup::Moderators,
        _ => return None,
    };
    let order = match parameters.get("order").map(String::as_str) {
        Some("joined") => MembersOrder::Joined,
        Some("joinedDesc") => MembersOrder::JoinedDesc,
        Some("name") => MembersOrder::Name,
        Some("nameDesc") => MembersOrder::NameDesc,
        _ => return None,
    };
    let show_since_false_argument = match parameters.get("showSince").map(String::as_str)
    {
        None => false,
        Some("false") => true,
        Some(_) => return None,
    };
    let page = parameters.get("page")?;
    let page_bytes = page.as_bytes();
    let canonical_page = page_bytes == b"0"
        || matches!(page_bytes, [b'1'..=b'9', rest @ ..] if rest.iter().all(u8::is_ascii_digit));
    if !canonical_page {
        return None;
    }
    let page = page.parse::<u32>().ok()?.max(1);
    Some((
        MembersArguments {
            group,
            order,
            show_since: !show_since_false_argument,
            show_since_false_argument,
            page,
            order_error: false,
        },
        page,
    ))
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
    arguments: MembersArguments,
    page: u32,
) -> Result<(Vec<DirectoryRow>, usize)> {
    let offset = i64::from(page - 1) * MEMBERS_PAGE_SIZE as i64;
    let (rows, total_count) =
        load_directory_page(ctx, site_id, arguments, offset).await?;
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

fn render_empty_directory(module_index: usize) -> String {
    format!(
        "\n<div id=\"ml-{module_index}\">\n\t\tNo users.\t\t<div style=\"text-align: center\">\n\t\t\t\t\n\t</div>\n</div>",
    )
}

fn render_directory(
    rows: &[DirectoryRow],
    arguments: MembersArguments,
    total_pages: usize,
    module_index: usize,
) -> String {
    let container_id = format!("ml-{module_index}");
    let function_name = format!("updateMemberList{module_index}");
    let avatar_timestamp = now().unix_timestamp();
    let mut output = format!("<div id=\"{container_id}\">\n\t\t<table>");
    for row in rows {
        output.push_str("\n\t\t\t<tr>\n\t\t\t\t<td>");
        render_directory_identity(&mut output, &row.identity, avatar_timestamp);
        output.push_str("</td>");
        if arguments.group == MembersGroup::Members && arguments.show_since {
            render_directory_since_cell(&mut output, row);
        }
        output.push_str("\n\t\t\t</tr>");
    }
    output.push_str("\n\t\t</table>");
    render_directory_script(&mut output, arguments, &function_name, &container_id);
    output.push_str("\n\t<div style=\"text-align: center\">");
    if total_pages > 1 {
        render_pager(&mut output, &function_name, total_pages);
    }
    output.push_str("\n\t</div>\n</div>");
    output
}

fn render_continuation_directory(
    rows: &[DirectoryRow],
    arguments: MembersArguments,
    page: usize,
    total_pages: usize,
    module_index: usize,
) -> String {
    if rows.is_empty() {
        return render_empty_directory(module_index);
    }
    let container_id = format!("ml-{module_index}");
    let function_name = format!("updateMemberList{module_index}");
    let avatar_timestamp = now().unix_timestamp();
    let mut output = format!("\n<div id=\"{container_id}\">\n\t\t<table>");
    for row in rows {
        output.push_str("\n\t\t\t<tr>\n\t\t\t\t<td>");
        render_directory_identity(&mut output, &row.identity, avatar_timestamp);
        output.push_str("</td>");
        if arguments.group == MembersGroup::Members && arguments.show_since {
            render_directory_since_cell(&mut output, row);
        }
        output.push_str("\n\t\t\t</tr>");
    }
    output.push_str("\n\t\t</table>");
    render_directory_script(&mut output, arguments, &function_name, &container_id);
    if total_pages > 1 {
        render_members_ajax_pager(&mut output, &function_name, page, total_pages);
    }
    output.push_str("\n</div>");
    output
}

fn render_directory_since_cell(output: &mut String, row: &DirectoryRow) {
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

fn render_directory_script(
    output: &mut String,
    arguments: MembersArguments,
    function_name: &str,
    container_id: &str,
) {
    let show_since_line = if arguments.show_since_false_argument {
        "\t\t\tp.showSince = 'false';\n"
    } else {
        ""
    };
    write!(
        output,
        concat!(
            "\n\t<script type=\"text/javascript\">\n",
            "\t\tfunction {function_name}(pageNo) {{\n",
            "\t\t\tvar p = {{}};\n\t\t\t\n",
            "\t\t\tp.group     = '{group}';\n",
            "\t\t\tp.order     = '{order}';\n",
            "{show_since_line}",
            "\t\t\t\n",
            "\t\t\tvar containerElId = '{container_id}';\n\t\t\t\n",
            "\t\t\tp.page = pageNo;\n",
            "\t\t\tOZONE.ajax.requestModule(\"membership/MembersListModule\", p, function(r){{\n",
            "\t\t\t\tif (!WIKIDOT.utils.handleError(r)) {{return;}}\n",
            "\t\t\t\tjQuery('#'+containerElId).replaceWith(r.body);\n",
            "\t\t\t}});\n\t\t}}\n\t</script>",
        ),
        function_name = function_name,
        container_id = container_id,
        group = arguments.group.wikidot_value(),
        order = arguments.order.wikidot_value(),
        show_since_line = show_since_line,
    )
    .expect("writing the member directory script to a String cannot fail");
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
        "\n\t\t<div class=\"pager\"><span class=\"pager-no\">page 1 of {total_pages}</span><span class=\"current\">1</span>",
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
        "<span class=\"target\"><a href=\"javascript:;\" onclick=\"{function_name}(2)\">next &raquo;</a></span></div>",
    )
    .expect("writing a member pager next target to a String cannot fail");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn members_arguments(head: &str) -> MembersArguments {
        MembersArguments::parse(head)
    }

    fn default_members_arguments() -> MembersArguments {
        MembersArguments {
            group: MembersGroup::Members,
            order: MembersOrder::Joined,
            show_since: true,
            show_since_false_argument: false,
            page: 1,
            order_error: false,
        }
    }

    #[test]
    fn members_arguments_ignore_unknown_shapes_like_live() {
        assert_eq!(members_arguments(""), default_members_arguments());
        for ignored in [
            r#" group="owners""#,
            r#" group='members'"#,
            r#" Group="members""#,
            r#" unknown="value""#,
            r#" limit="1""#,
            r#" order="abc""#,
            r#" group=" admins ""#,
            " showSince",
            " order='name'",
        ] {
            assert_eq!(
                members_arguments(ignored),
                default_members_arguments(),
                "{ignored}",
            );
        }

        assert_eq!(
            members_arguments(r#" group="moderators" order="nameDesc""#),
            MembersArguments {
                group: MembersGroup::Moderators,
                order: MembersOrder::NameDesc,
                ..default_members_arguments()
            },
        );
        assert_eq!(
            members_arguments(r#" group="members" group="admins""#).group,
            MembersGroup::Admins,
            "live keeps the last parameter value",
        );
        assert_eq!(
            members_arguments(r#" group="moderators" from="admins""#).group,
            MembersGroup::Admins,
            "live's `from` alias overrides `group`",
        );
        assert_eq!(
            members_arguments(r#" from="moderators" group="admins""#).group,
            MembersGroup::Moderators,
        );
        assert_eq!(
            members_arguments(r#" order="name" order="joined""#).order,
            MembersOrder::Joined,
        );
    }

    #[test]
    fn members_arguments_parse_show_since_page_and_live_order_errors() {
        for falsy in [
            r#" showSince="no""#,
            r#" showSince="false""#,
            r#" showSince="get lost""#,
        ] {
            let arguments = members_arguments(falsy);
            assert!(!arguments.show_since, "{falsy}");
            assert!(arguments.show_since_false_argument, "{falsy}");
        }
        for truthy in [
            r#" showSince="yes""#,
            r#" showSince="0""#,
            r#" showSince="NO""#,
        ] {
            let arguments = members_arguments(truthy);
            assert!(arguments.show_since, "{truthy}");
            assert!(!arguments.show_since_false_argument, "{truthy}");
        }

        let admins = members_arguments(r#" group="admins" showSince="false""#);
        assert_eq!(admins.group, MembersGroup::Admins);
        assert!(admins.show_since_false_argument);

        assert_eq!(members_arguments(r#" page="2""#).page, 2);
        assert_eq!(members_arguments(r#" page="0""#).page, 1);
        for ignored in [r#" page="abc""#, r#" page="-1""#, r#" page="" "#] {
            assert_eq!(members_arguments(ignored).page, 1, "{ignored}");
        }

        for error in [r#" order="userId""#, r#" order="userIdDesc""#] {
            assert!(members_arguments(error).order_error, "{error}");
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

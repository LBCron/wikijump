/*
 * services/view/structs.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

use super::options::PageOptions;
use crate::models::page::Model as PageModel;
use crate::models::page_category::Model as PageCategoryModel;
use crate::models::page_revision::Model as PageRevisionModel;
use crate::models::session::Model as SessionModel;
use crate::models::site::Model as SiteModel;
use crate::models::user::Model as WikijumpUserModel;
use crate::services::DataFormEditor;
use crate::services::membership::MembershipBrowserAction;
use crate::services::page_meta_tag::PageMetaTag;
use crate::services::relation::PageAttribution;
use crate::services::render::{LegacyBrowserAction, RateBrowserActionRegistry};
use crate::services::settings::{
    PageDiscussionSettings, PageRatingSettings, ThemeSetting,
};
use crate::services::user::{UserOutput, WikijumpUserOutput};
use crate::types::Reference;
use time::OffsetDateTime;

pub(super) fn is_reserved_admin_slug(slug: &str) -> bool {
    slug.trim_matches('/').eq_ignore_ascii_case("_admin")
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageView {
    pub site_id: i64,
    pub session_token: Option<String>,
    pub route: Option<PageRoute>,
    pub locales: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct PageRoute {
    pub slug: String,
    pub extra: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPreloadView {
    pub site_id: i64,
    pub session_token: Option<String>,
    pub locales: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GetPreloadViewOutput {
    #[serde(flatten)]
    pub viewer: Viewer,
}

#[derive(Serialize, Debug, Clone)]
pub struct GetArticleViewOutput {
    #[serde(flatten)]
    pub viewer: Viewer,
    pub page: GetPageViewOutput,
    pub article_page_cache_key: Option<String>,
    pub public_content_cache_fence: Option<String>,
    pub anonymous_permission_cache_fence: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct GetArticleViewCacheMetadataOutput {
    pub article_page_cache_key: Option<String>,
    pub public_content_cache_fence: Option<String>,
    pub anonymous_permission_cache_fence: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageRedirectKind {
    WikidotModule,
    RandomHelper,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case", tag = "type", content = "data")]
pub enum GetPageViewOutput {
    Found {
        options: PageOptions,
        page: PageModel,
        page_revision: PageRevisionModel,
        wikidot_snapshot: Option<WikidotPageSnapshotView>,
        wikidot_breadcrumbs: Vec<WikidotPageBreadcrumbView>,
        attributions: Vec<PageAttribution>,
        #[serde(default)]
        meta_tags: Vec<PageMetaTag>,
        #[serde(default)]
        page_rating: PageRatingSettings,
        #[serde(default)]
        page_discussion: PageDiscussionSettings,
        #[serde(default)]
        data_form: Option<DataFormEditor>,
        #[serde(default)]
        legacy_actions: Vec<LegacyBrowserAction>,
        #[serde(default)]
        rate_actions: Option<RateBrowserActionRegistry>,
        #[serde(default)]
        membership_actions: Vec<MembershipBrowserAction>,
        #[serde(default)]
        theme_previewer_no_ui: bool,
        #[serde(default)]
        theme_previewer_blank: bool,
        #[serde(default)]
        manage_site_takeover: bool,
        redirect_page: Option<String>,
        #[serde(default)]
        redirect_kind: Option<PageRedirectKind>,
        wikitext: String,
        compiled_body_html: String,
        compiled_body_styles: Vec<String>,
        compiled_top_bar_html: Option<String>,
        compiled_side_bar_html: Option<String>,
        theme: ThemeSetting,
    },

    Missing {
        options: PageOptions,
        redirect_page: Option<String>,
        #[serde(default)]
        redirect_kind: Option<PageRedirectKind>,
        wikitext: String,
        #[serde(default)]
        new_page_wikitext: Option<String>,
        #[serde(default)]
        page_templates: Vec<PageTemplateSummary>,
        #[serde(default)]
        selected_template_page_id: Option<i64>,
        #[serde(default)]
        data_form: Option<DataFormEditor>,
        #[serde(default)]
        can_create: bool,
        #[serde(default)]
        missing_template: bool,
        compiled_body_html: String,
        compiled_body_styles: Vec<String>,
        compiled_top_bar_html: Option<String>,
        compiled_side_bar_html: Option<String>,
        theme: ThemeSetting,
    },

    Permissions {
        options: PageOptions,
        redirect_page: Option<String>,
        #[serde(default)]
        redirect_kind: Option<PageRedirectKind>,
        compiled_body_html: String,
        compiled_body_styles: Vec<String>,
        compiled_top_bar_html: Option<String>,
        compiled_side_bar_html: Option<String>,
        theme: ThemeSetting,
        banned: bool,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WikidotPageSnapshotView {
    pub source_site: String,
    pub source_revision_count: i32,

    #[serde(with = "time::serde::rfc3339")]
    pub source_updated_at: OffsetDateTime,

    pub imported_rating: Option<i64>,
    pub comments: Option<i32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WikidotPageBreadcrumbView {
    pub slug: String,
    pub title: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetUserView<'a> {
    pub site_id: i64,
    pub session_token: Option<String>,
    pub user: Option<Reference<'a>>,
    pub locales: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "snake_case", tag = "type", content = "data")]
pub enum GetUserViewOutput {
    UserFound { user: UserOutput },
    UserMissing,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetAdminView {
    pub site_id: i64,
    pub session_token: Option<String>,
    pub locales: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PageTemplateSummary {
    pub page_id: i64,
    pub slug: String,
    pub title: String,
    pub wikitext: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "snake_case", tag = "type", content = "data")]
pub enum GetAdminViewOutput {
    SiteFound {
        categories: Vec<PageCategoryModel>,
        page_templates: Vec<PageTemplateSummary>,
        is_master_admin: bool,
    },

    AdminPermissions {
        html: String,
    },
}

#[derive(Serialize, Debug, Clone)]
pub struct Viewer {
    pub site: SiteModel,
    pub site_settings: crate::services::settings::SiteSettings,
    pub promoted_sites: Vec<PromotedSiteView>,
    pub site_file_domain: String,
    pub license_name: String,
    pub license_url: &'static str,
    pub license_kind: ViewerLicenseKind,
    pub license_html: Option<String>,
    pub user_session: Option<UserSession>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PromotedSiteView {
    pub slug: String,
    pub name: String,
    pub description: String,
}

#[derive(Serialize, Debug, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewerLicenseKind {
    Standard,
    Other,
    Copyright,
}

#[derive(Serialize, Debug, Clone)]
pub struct UserSession {
    pub session: ViewerSession,
    pub user: WikijumpUserOutput,
}

impl UserSession {
    pub fn new(session: SessionModel, user: WikijumpUserModel) -> Self {
        let user_id = user.user_id;

        UserSession {
            session: ViewerSession::from(session),
            user: WikijumpUserOutput::new(user, Some(user_id)),
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct ViewerSession {
    pub user_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
    pub restricted: bool,
}

impl From<SessionModel> for ViewerSession {
    fn from(session: SessionModel) -> Self {
        ViewerSession {
            user_id: session.user_id,
            created_at: session.created_at,
            expires_at: session.expires_at,
            restricted: session.restricted,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewType {
    Preload,
    Page,
    User,
    Admin,
}

#[cfg(test)]
mod reserved_route_tests {
    use super::is_reserved_admin_slug;

    #[test]
    fn recognizes_admin_route_aliases_without_matching_categories() {
        for slug in ["_admin", "_ADMIN", "/_admin", "//_admin//"] {
            assert!(is_reserved_admin_slug(slug), "{slug}");
        }
        for slug in ["admin", "category:_admin", "_admin:page"] {
            assert!(!is_reserved_admin_slug(slug), "{slug}");
        }
    }
}

#[cfg(test)]
mod user_session_tests {
    use super::UserSession;
    use crate::models::session::Model as SessionModel;
    use crate::models::user::Model as WikijumpUserModel;
    use crate::services::user::{User, UserOutput};
    use crate::types::UserType;
    use sea_orm::prelude::IpNetwork;
    use std::net::{IpAddr, Ipv4Addr};
    use time::OffsetDateTime;

    fn session_test_user() -> WikijumpUserModel {
        let password_value = ["password", "hash", "sentinel"].join("-");
        let mfa_value = ["mfa", "secret", "sentinel"].join("-");
        WikijumpUserModel {
            user_id: 42,
            user_type: UserType::Regular,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: None,
            deleted_at: None,
            name: "Viewer Test".to_owned(),
            slug: "viewer-test".to_owned(),
            name_changes_left: 3,
            last_name_change_added_at: OffsetDateTime::UNIX_EPOCH,
            last_renamed_at: None,
            email: "viewer-test@example.com".to_owned(),
            email_verified_at: None,
            email_validation_info: Some(
                serde_json::json!({"token": "validation-secret"}),
            ),
            email_validation_at: None,
            password: password_value,
            multi_factor_secret: Some(mfa_value),
            multi_factor_recovery_codes: Some(vec!["recovery-code-sentinel".to_owned()]),
            multi_factor_last_totp_step: None,
            locales: vec!["en".to_owned()],
            avatar_s3_hash: None,
            forum_signature: None,
            real_name: None,
            gender: None,
            birthday: None,
            location: None,
            biography: None,
            website: None,
            user_page: None,
        }
    }

    fn session_test_session() -> SessionModel {
        let token_value = ["session", "token", "sentinel"].join("-");
        SessionModel {
            session_token: token_value,
            user_id: 42,
            created_at: OffsetDateTime::UNIX_EPOCH,
            expires_at: OffsetDateTime::UNIX_EPOCH,
            ip_address: IpNetwork::from(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 99))),
            user_agent: "user-agent-sentinel".to_owned(),
            restricted: false,
            mfa_failed_attempts: 0,
        }
    }

    #[test]
    fn user_session_serializes_only_projected_data() {
        let user_session = UserSession::new(session_test_session(), session_test_user());
        let value = serde_json::to_value(&user_session).expect("user session serializes");
        let json = value.to_string();

        let expected_user = serde_json::to_value(UserOutput::new(
            User::Wikijump(session_test_user()),
            Some(42),
        ))
        .expect("user output serializes");
        assert_eq!(value["user"], expected_user);
        assert_eq!(
            value["user"]["email"],
            serde_json::json!("viewer-test@example.com"),
        );

        let session = value["session"].as_object().expect("session object");
        let mut keys: Vec<&str> = session.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["created_at", "expires_at", "restricted", "user_id"]);
        assert_eq!(session["user_id"], serde_json::json!(42));

        for forbidden in [
            "password",
            "password-hash-sentinel",
            "multi_factor_secret",
            "mfa-secret-sentinel",
            "multi_factor_recovery_codes",
            "recovery-code-sentinel",
            "multi_factor_last_totp_step",
            "email_validation_info",
            "validation-secret",
            "session_token",
            "session-token-sentinel",
            "ip_address",
            "203.0.113.99",
            "user_agent",
            "user-agent-sentinel",
        ] {
            assert!(
                !json.contains(forbidden),
                "user session leaked {forbidden}: {json}",
            );
        }
    }
}

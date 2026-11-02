/*
 * services/settings/structs.rs
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

use crate::error::prelude::{Error, ErrorType, Result};

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct GoogleAnalyticsSettings {
    pub enabled: bool,
    pub profile: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct UpdateGoogleAnalyticsSettings {
    pub enabled: bool,
    pub profile: String,
}

impl UpdateGoogleAnalyticsSettings {
    pub fn validated_profile(&self) -> Result<Option<&str>> {
        if !self.enabled && self.profile.is_empty() {
            return Ok(None);
        }

        let valid = self
            .profile
            .strip_prefix("UA-")
            .and_then(|profile| profile.split_once('-'))
            .is_some_and(|(account, property)| {
                !account.is_empty()
                    && account.bytes().all(|byte| byte.is_ascii_digit())
                    && !property.is_empty()
                    && property.bytes().all(|byte| byte.is_ascii_digit())
            });
        if valid {
            Ok(Some(&self.profile))
        } else {
            Err(Error::new(
                "Google Analytics profile must use the UA-<account>-<property> format",
                ErrorType::BadRequest,
            )
            .into())
        }
    }

    pub fn validate(&self) -> Result<()> {
        self.validated_profile()?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
pub struct ToolbarSettings {
    pub top: bool,
    pub bottom: bool,
    pub promote: bool,
}

impl Default for ToolbarSettings {
    fn default() -> Self {
        Self {
            top: false,
            bottom: false,
            promote: true,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct MembershipSettings {
    pub application_enabled: bool,
    pub password_enabled: bool,
    pub password_configured: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateMembershipSettings {
    pub application_enabled: bool,
    pub password_enabled: bool,
    pub password: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SiteSettings {
    pub revision: i64,
    pub welcome_page: String,
    pub google_analytics: GoogleAnalyticsSettings,
    pub toolbars: ToolbarSettings,
    pub membership: MembershipSettings,
}

impl Default for SiteSettings {
    fn default() -> Self {
        Self {
            revision: 0,
            welcome_page: String::from("system:welcome"),
            google_analytics: GoogleAnalyticsSettings::default(),
            toolbars: ToolbarSettings::default(),
            membership: MembershipSettings::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum ThemeSetting {
    Inherit,
    BuiltIn { id: i64 },
    External { url: String },
    Custom { css: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeStorage<'a> {
    pub kind: &'static str,
    pub builtin_id: Option<i64>,
    pub external_url: Option<&'a str>,
    pub custom_css: Option<&'a str>,
}

impl Default for ThemeSetting {
    fn default() -> Self {
        Self::BuiltIn { id: 1 }
    }
}

impl ThemeSetting {
    pub fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Inherit => true,
            Self::BuiltIn { id } => *id > 0,
            Self::External { url } => reqwest::Url::parse(url).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            }),
            Self::Custom { css } => {
                css.len() <= 65_535 && !css.to_ascii_lowercase().contains("</style")
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::new("invalid theme setting", ErrorType::BadRequest).into())
        }
    }

    pub fn to_storage(&self) -> ThemeStorage<'_> {
        match self {
            Self::Inherit => ThemeStorage {
                kind: "inherit",
                builtin_id: None,
                external_url: None,
                custom_css: None,
            },
            Self::BuiltIn { id } => ThemeStorage {
                kind: "built_in",
                builtin_id: Some(*id),
                external_url: None,
                custom_css: None,
            },
            Self::External { url } => ThemeStorage {
                kind: "external",
                builtin_id: None,
                external_url: Some(url),
                custom_css: None,
            },
            Self::Custom { css } => ThemeStorage {
                kind: "custom",
                builtin_id: None,
                external_url: None,
                custom_css: Some(css),
            },
        }
    }
}

#[derive(Debug)]
pub enum NavigationPage {
    Enabled(String),
    Disabled,
}

impl From<String> for NavigationPage {
    fn from(page_slug: String) -> NavigationPage {
        if page_slug.is_empty() {
            NavigationPage::Disabled
        } else {
            NavigationPage::Enabled(page_slug)
        }
    }
}

#[derive(Debug)]
pub struct NavigationPageSlugs {
    pub top_bar_page: NavigationPage,
    pub side_bar_page: NavigationPage,
}

#[derive(Debug)]
pub struct NavigationPageWikitext {
    pub top_bar_page: NavigationPage,
    pub side_bar_page: NavigationPage,
    pub top_bar_page_wikitext: Option<String>,
    pub side_bar_page_wikitext: Option<String>,
}

#[derive(Debug)]
pub struct NavigationPageHtml {
    pub compiled_top_bar_html: Option<String>,
    pub compiled_side_bar_html: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Copy, Clone)]
pub struct ForumStructureSettings {
    pub max_nest_level: i16,
    pub per_page_discussion: bool,
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, Default, PartialEq, Eq)]
pub struct PageDiscussionSettings {
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageRatingPermission {
    Registered,
    Members,
}

impl PageRatingPermission {
    pub const fn as_storage(self) -> &'static str {
        match self {
            Self::Registered => "registered",
            Self::Members => "members",
        }
    }

    pub fn from_storage(value: &str) -> Option<Self> {
        match value {
            "registered" => Some(Self::Registered),
            "members" => Some(Self::Members),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageRatingVisibility {
    Visible,
    Anonymous,
}

impl PageRatingVisibility {
    pub const fn as_storage(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Anonymous => "anonymous",
        }
    }

    pub fn from_storage(value: &str) -> Option<Self> {
        match value {
            "visible" => Some(Self::Visible),
            "anonymous" => Some(Self::Anonymous),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageRatingType {
    Plus,
    PlusMinus,
    Stars,
}

impl PageRatingType {
    pub const fn as_storage(self) -> &'static str {
        match self {
            Self::Plus => "plus",
            Self::PlusMinus => "plus_minus",
            Self::Stars => "stars",
        }
    }

    pub const fn vote_store_key(self) -> &'static str {
        match self {
            Self::Plus | Self::PlusMinus => "points",
            Self::Stars => "stars",
        }
    }

    pub fn from_storage(value: &str) -> Option<Self> {
        match value {
            "plus" => Some(Self::Plus),
            "plus_minus" => Some(Self::PlusMinus),
            "stars" => Some(Self::Stars),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
pub struct PageRatingSettings {
    pub enabled: bool,
    pub permission: PageRatingPermission,
    pub visibility: PageRatingVisibility,
    pub rating_type: PageRatingType,
}

impl Default for PageRatingSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            permission: PageRatingPermission::Registered,
            visibility: PageRatingVisibility::Visible,
            rating_type: PageRatingType::PlusMinus,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_page_from_string_distinguishes_disabled_from_enabled() {
        match NavigationPage::from(String::new()) {
            NavigationPage::Disabled => {}
            NavigationPage::Enabled(value) => panic!("empty slug enabled as {value}"),
        }

        match NavigationPage::from(String::from("_default")) {
            NavigationPage::Enabled(value) => assert_eq!(value, "_default"),
            NavigationPage::Disabled => panic!("non-empty slug was disabled"),
        }
    }

    #[test]
    fn page_rating_storage_values_and_defaults_match_wikidot_contract() {
        let defaults = PageRatingSettings::default();
        assert!(defaults.enabled);
        assert_eq!(defaults.permission, PageRatingPermission::Registered);
        assert_eq!(defaults.visibility, PageRatingVisibility::Visible);
        assert_eq!(defaults.rating_type, PageRatingType::PlusMinus);

        for (stored, value) in [
            ("registered", PageRatingPermission::Registered),
            ("members", PageRatingPermission::Members),
        ] {
            assert_eq!(PageRatingPermission::from_storage(stored), Some(value));
            assert_eq!(value.as_storage(), stored);
        }
        for (stored, value) in [
            ("visible", PageRatingVisibility::Visible),
            ("anonymous", PageRatingVisibility::Anonymous),
        ] {
            assert_eq!(PageRatingVisibility::from_storage(stored), Some(value));
            assert_eq!(value.as_storage(), stored);
        }
        for (stored, value) in [
            ("plus", PageRatingType::Plus),
            ("plus_minus", PageRatingType::PlusMinus),
            ("stars", PageRatingType::Stars),
        ] {
            assert_eq!(PageRatingType::from_storage(stored), Some(value));
            assert_eq!(value.as_storage(), stored);
        }
    }

    #[test]
    fn site_settings_defaults_disable_analytics_and_toolbar_chrome() {
        assert_eq!(
            SiteSettings::default(),
            SiteSettings {
                revision: 0,
                welcome_page: String::from("system:welcome"),
                google_analytics: GoogleAnalyticsSettings::default(),
                toolbars: ToolbarSettings::default(),
                membership: MembershipSettings::default(),
            }
        );
    }

    #[test]
    fn theme_storage_keeps_each_variant_separate_and_rejects_unsafe_urls() {
        let built_in = ThemeSetting::BuiltIn { id: 1 };
        assert_eq!(
            built_in.to_storage(),
            ThemeStorage {
                kind: "built_in",
                builtin_id: Some(1),
                external_url: None,
                custom_css: None,
            }
        );
        assert!(
            ThemeSetting::External {
                url: String::from("https://themes.example/theme.css"),
            }
            .validate()
            .is_ok()
        );
        assert!(
            ThemeSetting::External {
                url: String::from("http://themes.example/theme.css"),
            }
            .validate()
            .is_err()
        );
        assert!(
            ThemeSetting::Custom {
                css: String::from("</style><script>alert(1)</script>"),
            }
            .validate()
            .is_err()
        );
    }
}

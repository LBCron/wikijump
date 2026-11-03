/*
 * services/basic_error.rs
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

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::view::redirect::escape_wikidot_html_text;
use crate::services::{DomainService, SiteService};
use crate::types::Reference;
use crate::utils::strip_fluent_control_chars;
use fluent::{FluentArgs, FluentValue};
use unic_langid::LanguageIdentifier;

#[derive(Serialize, Debug, Clone)]
pub struct BasicErrorOutput {
    pub title: String,
    pub body: String,
}

#[derive(Debug)]
pub struct BasicErrorService;

/// Fluent string argument for basic-error HTML output.
///
/// Every value interpolated into a basic-error message lands in final HTML
/// (element text, or link targets behind fixed `https://{domain}/` prefixes
/// that pin the scheme). Escape uniformly at the argument boundary rather
/// than per-slot, so a future caller passing request-path data into any
/// slot cannot reintroduce reflection (issue #2560).
fn html_arg(value: impl AsRef<str>) -> FluentValue<'static> {
    FluentValue::String(escape_wikidot_html_text(value.as_ref()).into())
}

/// Basic errors are HTML, and their Fluent arguments land inside attribute
/// values such as `href`. Fluent's direction isolates would corrupt those URLs.
fn basic_error_output(
    title: impl Into<String>,
    body: impl Into<String>,
) -> BasicErrorOutput {
    let mut title = title.into();
    let mut body = body.into();
    strip_fluent_control_chars(&mut title);
    strip_fluent_control_chars(&mut body);
    BasicErrorOutput { title, body }
}

impl BasicErrorService {
    pub async fn missing_site_slug(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        site_slug: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate missing_site_slug basic error for site '{}'",
                    site_slug,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let main_domain = config.public_authority(&config.main_domain_no_dot);
        let files_domain = config.public_authority(&config.files_domain_no_dot);
        let mut args = FluentArgs::new();
        args.set("main_domain", html_arg(main_domain));
        args.set("files_domain", html_arg(files_domain));
        args.set("slug", html_arg(site_slug));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-site-slug.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-site-slug", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn missing_custom_domain(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        domain: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate missing_custom_domain basic error for domain '{}'",
                    domain,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let main_domain = config.public_authority(&config.main_domain_no_dot);
        let files_domain = config.public_authority(&config.files_domain_no_dot);
        let mut args = FluentArgs::new();
        args.set("main_domain", html_arg(main_domain));
        args.set("files_domain", html_arg(files_domain));
        args.set("custom_domain", html_arg(domain));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-site-custom.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-site-custom", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn missing_page_slug(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        site_id: i64,
        page_slug: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate missing_page_slug basic error for site ID {} page '{}'",
                    site_id, page_slug,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let mut args = FluentArgs::new();
        let site = SiteService::get(ctx, Reference::Id(site_id))
            .await
            .or_raise(make_error)?;

        let domain = DomainService::preferred_authority(config, &site);
        args.set("domain", html_arg(domain));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-page-slug.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-page-slug", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn page_fetch(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        site_id: i64,
        page_slug: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate page_fetch basic error for site ID {} page '{}'",
                    site_id, page_slug,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let mut args = FluentArgs::new();
        let site = SiteService::get(ctx, Reference::Id(site_id))
            .await
            .or_raise(make_error)?;
        let domain = DomainService::preferred_authority(config, &site);
        args.set("domain", html_arg(domain));
        args.set("page_slug", html_arg(page_slug));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-page-fetch.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-page-fetch", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn missing_file_name(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        site_id: i64,
        page_slug: &str,
        filename: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate missing_file_name basic error for site ID {} page '{}' file '{}'",
                    site_id, page_slug, filename,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let mut args = FluentArgs::new();
        let site = SiteService::get(ctx, Reference::Id(site_id))
            .await
            .or_raise(make_error)?;
        let domain = DomainService::preferred_authority(config, &site);
        args.set("domain", html_arg(domain));
        args.set("page_slug", html_arg(page_slug));
        args.set("filename", html_arg(filename));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-file-name.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-file-name", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn file_fetch(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        site_id: i64,
        page_slug: &str,
        filename: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate file_fetch basic error for site ID {} page '{}' filename '{}'",
                    site_id, page_slug, filename,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let mut args = FluentArgs::new();
        let site = SiteService::get(ctx, Reference::Id(site_id))
            .await
            .or_raise(make_error)?;

        let domain = DomainService::preferred_authority(config, &site);
        args.set("domain", html_arg(domain));
        args.set("page_slug", html_arg(page_slug));
        args.set("filename", html_arg(filename));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-file-fetch.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-file-fetch", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn text_block(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        site_id: i64,
        index: &str,
        block_type: &str,
        reason: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate text_block basic error for site ID {} {} block at index {}, with reason {}",
                    site_id, block_type, index, reason,
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let mut args = FluentArgs::new();
        let site = SiteService::get(ctx, Reference::Id(site_id))
            .await
            .or_raise(make_error)?;
        let domain = DomainService::preferred_authority(config, &site);
        args.set("domain", html_arg(domain));
        args.set("index", html_arg(index));
        args.set("type", html_arg(block_type));
        args.set("reason", html_arg(reason));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-text-block.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-text-block", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn file_root(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                "failed to generate file_root basic error",
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let config = ctx.config();
        let main_domain = config.public_authority(&config.main_domain_no_dot);
        let files_domain = config.public_authority(&config.files_domain_no_dot);
        let mut args = FluentArgs::new();
        args.set("main_domain", html_arg(main_domain));
        args.set("files_domain", html_arg(files_domain));

        let title = ctx
            .localization()
            .translate(locales, "basic-error-file-root.title", &args)
            .or_raise(make_error)?;

        let body = ctx
            .localization()
            .translate(locales, "basic-error-file-root", &args)
            .or_raise(make_error)?;

        Ok(basic_error_output(title, body))
    }

    pub async fn blob_fetch(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        s3_hash: &str,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate blob_fetch basic error for hash '{}'",
                    s3_hash
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let mut args = FluentArgs::new();
        args.set("s3_hash", html_arg(s3_hash));
        let title = ctx
            .localization()
            .translate(locales, "basic-error-blob-fetch.title", &args)
            .or_raise(make_error)?;
        let body = ctx
            .localization()
            .translate(locales, "basic-error-blob-fetch", &args)
            .or_raise(make_error)?;
        Ok(basic_error_output(title, body))
    }

    pub async fn user_fetch(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        user_id: i64,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate user_fetch basic error for user '{}'",
                    user_id
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let mut args = FluentArgs::new();
        let user_id = user_id.to_string();
        args.set("user_id", html_arg(user_id));
        let title = ctx
            .localization()
            .translate(locales, "basic-error-user-fetch.title", &args)
            .or_raise(make_error)?;
        let body = ctx
            .localization()
            .translate(locales, "basic-error-user-fetch", &args)
            .or_raise(make_error)?;
        Ok(basic_error_output(title, body))
    }

    pub async fn user_avatar_error(
        ctx: &ServiceContext<'_>,
        locales: &[LanguageIdentifier],
        user_id: i64,
    ) -> Result<BasicErrorOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to generate user_avatar basic error for user '{}'",
                    user_id
                ),
                ErrorType::BasicError,
            )
        };

        assert!(!locales.is_empty(), "No languages specified");
        let mut args = FluentArgs::new();
        let user_id = user_id.to_string();
        args.set("user_id", html_arg(user_id));
        let title = ctx
            .localization()
            .translate(locales, "basic-error-user-avatar.title", &args)
            .or_raise(make_error)?;
        let body = ctx
            .localization()
            .translate(locales, "basic-error-user-avatar", &args)
            .or_raise(make_error)?;
        Ok(basic_error_output(title, body))
    }
}

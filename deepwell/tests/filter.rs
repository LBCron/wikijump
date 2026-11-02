/*
 * tests/filter.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#[allow(unused_imports)]
#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::error::prelude::*;
use deepwell::models::audit_log::{Column as AuditLogColumn, Entity as AuditLog};
use deepwell::models::site::{Column as SiteColumn, Entity as Site};
use deepwell::services::audit::ObjectScope;
use deepwell::services::filter::{CreateFilter, FilterClass, FilterService, FilterType};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::Value;

fn page_filter(regex: &str, description: &str) -> CreateFilter {
    CreateFilter {
        affects_user: false,
        affects_email: false,
        affects_page: true,
        affects_file: false,
        affects_forum: false,
        case_sensitive: false,
        regex: regex.to_owned(),
        description: description.to_owned(),
    }
}

#[tokio::test]
async fn filter_service_enforces_scope_conflicts_deletion_and_audit_contracts() {
    let runner = TestRunner::setup().await;
    let ctx = runner.context();
    let site_id = Site::find()
        .order_by_asc(SiteColumn::SiteId)
        .one(ctx.transaction())
        .await
        .expect("seed site lookup should succeed")
        .expect("integration seed should contain a site")
        .site_id;

    let platform = FilterService::create(
        ctx,
        None,
        page_filter("quality-needle-1990", "platform quality audit filter"),
    )
    .await
    .expect("platform filter should be created");
    assert_eq!(platform.regex, "(?i)quality-needle-1990");

    let site = FilterService::create(
        ctx,
        Some(site_id),
        page_filter("site-quality-needle-1990", "site quality audit filter"),
    )
    .await
    .expect("site filter should be created");
    assert_eq!(site.site_id, Some(site_id));

    let duplicate = FilterService::create(
        ctx,
        None,
        page_filter("quality-needle-1990", "duplicate platform filter"),
    )
    .await
    .expect_err("duplicate extant filter should be rejected");
    assert_contains_error!(duplicate, ErrorType::FilterExists);

    let platform_only = FilterService::get_all(
        ctx,
        FilterClass::Platform,
        Some(FilterType::Page),
        Some(false),
    )
    .await
    .expect("platform filter query should succeed");
    assert!(
        platform_only
            .iter()
            .any(|filter| filter.filter_id == platform.filter_id)
    );
    assert!(
        !platform_only
            .iter()
            .any(|filter| filter.filter_id == site.filter_id)
    );

    let site_only = FilterService::get_all(
        ctx,
        FilterClass::Site(site_id),
        Some(FilterType::Page),
        Some(false),
    )
    .await
    .expect("site filter query should succeed");
    assert!(
        !site_only
            .iter()
            .any(|filter| filter.filter_id == platform.filter_id)
    );
    assert!(
        site_only
            .iter()
            .any(|filter| filter.filter_id == site.filter_id)
    );

    let combined = FilterService::get_all(
        ctx,
        FilterClass::PlatformAndSite(site_id),
        Some(FilterType::Page),
        Some(false),
    )
    .await
    .expect("combined filter query should succeed");
    assert!(
        combined
            .iter()
            .any(|filter| filter.filter_id == platform.filter_id)
    );
    assert!(
        combined
            .iter()
            .any(|filter| filter.filter_id == site.filter_id)
    );

    let matcher =
        FilterService::get_matcher(ctx, FilterClass::Platform, FilterType::Page)
            .await
            .expect("platform matcher should build");
    matcher
        .verify(
            ctx,
            "title",
            "ordinary page title",
            ObjectScope::Other,
            common::IP_ADDRESS,
        )
        .await
        .expect("unmatched content should pass the filter");
    let violation = matcher
        .verify(
            ctx,
            "title",
            "QUALITY-NEEDLE-1990 in mixed case",
            ObjectScope::Other,
            common::IP_ADDRESS,
        )
        .await
        .expect_err("case-insensitive platform filter should reject a match");
    assert_contains_error!(violation, ErrorType::FilterViolation { .. });

    let audit = AuditLog::find()
        .filter(AuditLogColumn::EventType.eq("filter.violation"))
        .order_by_desc(AuditLogColumn::EventId)
        .one(ctx.transaction())
        .await
        .expect("filter audit query should succeed")
        .expect("filter violation should write an audit event");
    assert_eq!(audit.ip_address.ip(), common::IP_ADDRESS);
    let metadata: Value = serde_json::from_str(
        audit
            .extra_string_1
            .as_deref()
            .expect("filter violation should include metadata"),
    )
    .expect("filter violation metadata should be JSON");
    assert_eq!(metadata["filter_id"], platform.filter_id);
    assert_eq!(metadata["field"], "title");
    assert_eq!(metadata["value"], "QUALITY-NEEDLE-1990 in mixed case");

    FilterService::delete(ctx, platform.filter_id)
        .await
        .expect("platform filter should delete");
    let extant = FilterService::get_all(
        ctx,
        FilterClass::Platform,
        Some(FilterType::Page),
        Some(false),
    )
    .await
    .expect("extant filter query should succeed");
    assert!(
        !extant
            .iter()
            .any(|filter| filter.filter_id == platform.filter_id)
    );
    let deleted = FilterService::get_all(
        ctx,
        FilterClass::Platform,
        Some(FilterType::Page),
        Some(true),
    )
    .await
    .expect("deleted filter query should succeed");
    assert!(
        deleted
            .iter()
            .any(|filter| filter.filter_id == platform.filter_id)
    );

    let matcher_after_delete =
        FilterService::get_matcher(ctx, FilterClass::Platform, FilterType::Page)
            .await
            .expect("matcher after deletion should build");
    matcher_after_delete
        .verify(
            ctx,
            "title",
            "QUALITY-NEEDLE-1990 in mixed case",
            ObjectScope::Other,
            common::IP_ADDRESS,
        )
        .await
        .expect("deleted filters must not be enforced");

    let restored = FilterService::restore(ctx, platform.filter_id)
        .await
        .expect("deleted filter should restore");
    assert_eq!(restored.deleted_at, None);
    let matcher_after_restore =
        FilterService::get_matcher(ctx, FilterClass::Platform, FilterType::Page)
            .await
            .expect("matcher after restore should build");
    let violation = matcher_after_restore
        .verify(
            ctx,
            "title",
            "quality-needle-1990 again",
            ObjectScope::Other,
            common::IP_ADDRESS,
        )
        .await
        .expect_err("restored filter should be enforced again");
    assert_contains_error!(violation, ErrorType::FilterViolation { .. });
}

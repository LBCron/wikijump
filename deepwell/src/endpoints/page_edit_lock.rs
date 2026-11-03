/*
 * endpoints/page_edit_lock.rs
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

use super::prelude::*;
use crate::services::page_edit_lock::{
    AcquirePageEditLock, AcquirePageEditLockInput, AcquirePageEditLockOutput,
    ReleasePageEditLock, ReleasePageEditLockInput, RenewPageEditLock,
    RenewPageEditLockInput, RenewPageEditLockOutput,
};
use crate::services::MutationAuthorization;
use crate::types::{Action, Permission, Reference, Resource};

async fn require_page_edit_permission(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page_ref: Reference<'_>,
    action: &str,
) -> Result<i64> {
    MutationAuthorization::require_permission(
        ctx,
        site_id,
        Some(page_ref),
        Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::Edit,
        },
        action,
    )
    .await
}

fn request_site_id(ctx: &ServiceContext<'_>) -> Result<i64> {
    ctx.request().site_id().or_raise(|| {
        Error::new("no site ID found", ErrorType::Page)
    })
}

pub async fn page_edit_lock_acquire(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<AcquirePageEditLockOutput> {
    acquire_impl(ctx, params, false).await
}

pub async fn page_edit_lock_force_acquire(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<AcquirePageEditLockOutput> {
    acquire_impl(ctx, params, true).await
}

async fn acquire_impl(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
    force: bool,
) -> Result<AcquirePageEditLockOutput> {
    let input: AcquirePageEditLockInput = parse!(params, Page);
    let site_id = request_site_id(ctx)?;
    let user_id = require_page_edit_permission(
        ctx,
        site_id,
        input.page.clone(),
        "acquire a page edit lock",
    )
    .await?;
    info!(
        "Acquiring page edit lock (force: {}) on page {:?} in site {} for user {}",
        force, input.page, site_id, user_id,
    );

    let acquire = AcquirePageEditLock {
        site_id,
        page: input.page.borrow(),
        user_id,
        mode: input.mode,
        section_index: input.section_index,
    };
    let output = if force {
        PageEditLockService::force_acquire(ctx, acquire).await
    } else {
        PageEditLockService::acquire(ctx, acquire).await
    };
    output.or_raise(|| {
        Error::new("failed to acquire page edit lock", ErrorType::Page)
    })
}

pub async fn page_edit_lock_renew(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<RenewPageEditLockOutput> {
    let input: RenewPageEditLockInput = parse!(params, Page);
    let site_id = request_site_id(ctx)?;
    let user_id = require_page_edit_permission(
        ctx,
        site_id,
        input.page.clone(),
        "renew a page edit lock",
    )
    .await?;
    info!(
        "Renewing page edit lock {} on page {:?} in site {} for user {}",
        input.lock_id, input.page, site_id, user_id,
    );

    PageEditLockService::renew(
        ctx,
        RenewPageEditLock {
            site_id,
            page: input.page.borrow(),
            user_id,
            lock_id: input.lock_id,
            lock_secret: input.lock_secret,
            mode: input.mode,
            section_index: input.section_index,
        },
    )
    .await
    .or_raise(|| Error::new("failed to renew page edit lock", ErrorType::Page))
}

pub async fn page_edit_lock_release(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<bool> {
    let input: ReleasePageEditLockInput = parse!(params, Page);
    let site_id = request_site_id(ctx)?;
    let user_id = require_page_edit_permission(
        ctx,
        site_id,
        input.page.clone(),
        "release a page edit lock",
    )
    .await?;
    info!(
        "Releasing page edit lock {} on page {:?} in site {} for user {}",
        input.lock_id, input.page, site_id, user_id,
    );

    PageEditLockService::release(
        ctx,
        ReleasePageEditLock {
            site_id,
            page: input.page.borrow(),
            user_id,
            lock_id: input.lock_id,
            lock_secret: input.lock_secret,
        },
    )
    .await
    .or_raise(|| Error::new("failed to release page edit lock", ErrorType::Page))
}

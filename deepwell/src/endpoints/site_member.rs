/*
 * endpoints/site_member.rs
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
use crate::models::relation::Model as RelationModel;
use crate::services::membership::{
    AcceptMembershipEmailInvitation, ListMembershipApplications,
    MembershipApplicationOutcome, MembershipApplicationStatus, MembershipApplicationView,
    MembershipEmailInvitationOutcome, MembershipJoinOutcome, MembershipPasswordOutcome,
    MembershipService, ReviewMembershipApplication, SubmitMembershipApplication,
    SubmitMembershipPassword,
};
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::relation::{CreateSiteMember, GetSiteMember, RemoveSiteMember};
use crate::types::{Action, Permission, Resource};
use std::net::IpAddr;

#[derive(Deserialize, Debug)]
struct CreateSiteMemberInput {
    #[serde(flatten)]
    input: CreateSiteMember,
    ip_address: IpAddr,
}

#[derive(Deserialize, Debug)]
struct RemoveSiteMemberInput {
    #[serde(flatten)]
    input: RemoveSiteMember,
    ip_address: IpAddr,
    reason: String,
}

pub async fn membership_join(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MembershipJoinOutcome> {
    MembershipService::join(ctx, parse!(params, SiteMembership)).await
}

pub async fn membership_password_submit(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MembershipPasswordOutcome> {
    let input: SubmitMembershipPassword = parse!(params, SiteMembership);
    MembershipService::submit_password(ctx, input).await
}

pub async fn membership_application_submit(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MembershipApplicationOutcome> {
    let input: SubmitMembershipApplication = parse!(params, SiteMembership);
    MembershipService::submit_application(ctx, input).await
}

pub async fn membership_application_review(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MembershipApplicationStatus> {
    let input: ReviewMembershipApplication = parse!(params, SiteMembership);
    let reviewer_user_id = require_role_assign_permission(ctx, input.site_id).await?;
    MembershipService::review_application(ctx, input, reviewer_user_id).await
}

pub async fn membership_application_list(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<MembershipApplicationView>> {
    let input: ListMembershipApplications = parse!(params, SiteMembership);
    require_role_assign_permission(ctx, input.site_id).await?;
    MembershipService::list_applications(ctx, input.site_id).await
}

pub async fn membership_email_invitation_accept(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MembershipEmailInvitationOutcome> {
    let input: AcceptMembershipEmailInvitation = parse!(params, SiteMembership);
    MembershipService::accept_email_invitation(ctx, input).await
}

async fn require_role_assign_permission(
    ctx: &ServiceContext<'_>,
    site_id: i64,
) -> Result<i64> {
    let actor_user_id = ctx.request().user_id().or_raise(|| {
        Error::new(
            "user does not have permission to manage site membership",
            ErrorType::PermissionDenied,
        )
    })?;

    let can_assign = PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id: Some(actor_user_id),
            site_id,
            page_reference: None,
        },
        Permission {
            resource_type: Resource::Role,
            resource_category: None,
            action: Action::Assign,
        },
    )
    .await
    .or_raise(|| {
        Error::new(
            "failed to check site membership permission",
            ErrorType::SiteMembership,
        )
    })?;

    if !can_assign {
        return Err(Error::new(
            "user does not have permission to manage site membership",
            ErrorType::PermissionDenied,
        )
        .into());
    }

    Ok(actor_user_id)
}

pub async fn membership_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<RelationModel>> {
    let input: GetSiteMember = parse!(params, SiteMembership);
    let user_id = input.user_id;
    let site_id = input.site_id;

    RelationService::get_optional_site_member(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to get site member data for user ID {} on site ID {}",
                    user_id, site_id,
                ),
                ErrorType::SiteMembership,
            )
        })
}

pub async fn membership_set(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    let CreateSiteMemberInput {
        mut input,
        ip_address,
    } = parse!(params, SiteMembership);
    let user_id = input.user_id;
    let site_id = input.site_id;
    input.created_by = require_role_assign_permission(ctx, site_id).await?;

    RelationService::create_site_member(ctx, input, ip_address)
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to add user ID {} as a site member of site ID {}",
                    user_id, site_id,
                ),
                ErrorType::SiteMembership,
            )
        })
}

pub async fn membership_remove(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<RelationModel> {
    let RemoveSiteMemberInput {
        mut input,
        ip_address,
        reason,
    } = parse!(params, SiteMembership);
    let user_id = input.user_id;
    let site_id = input.site_id;
    input.removed_by = require_role_assign_permission(ctx, site_id).await?;

    RelationService::remove_site_member(ctx, input, ip_address, &reason)
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to remove site membership for user ID {} from site ID {}",
                    user_id, site_id,
                ),
                ErrorType::SiteMembership,
            )
        })
}

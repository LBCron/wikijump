/*
 * services/membership/service.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::structs::{
    AcceptMembershipEmailInvitation, CreateMembershipEmailInvitation, JoinActorState,
    JoinMembership, JoinModuleState, MembershipApplicationData,
    MembershipApplicationOutcome, MembershipApplicationReviewDecision,
    MembershipApplicationStatus, MembershipApplicationView,
    MembershipEmailInvitationOutcome, MembershipEmailInvitationView,
    MembershipJoinOutcome, MembershipPasswordOutcome, MembershipPolicy,
    ReviewMembershipApplication, SubmitMembershipApplication, SubmitMembershipPassword,
};
use crate::constants::ADMIN_USER_ID;
use crate::error::prelude::{Error, ErrorType, OptionExt, Result, ResultExt};
use crate::models::site::{Entity as Site, Model as SiteModel};
use crate::services::action_throttle::{
    MEMBERSHIP_PASSWORD_THROTTLE, MEMBERSHIP_SELF_JOIN_THROTTLE,
};
use crate::services::relation::{
    CreateSiteMember, GetSiteBan, GetSiteMember, RelationDirection, RelationObject,
    RelationReference, SiteMemberAccepted, SiteMemberData,
};
use crate::services::render::{MembershipActionKind, MembershipActionRegistry};
use crate::services::user::User;
use crate::services::{
    ActionThrottleService, MutationAuthorization, PageRevisionService, PageService,
    PasswordService, RelationService, ServiceContext, TextService, UserService,
};
use crate::types::{Action, Permission, Reference, RelationType, Resource};
use sea_orm::{
    ConnectionTrait, EntityTrait, FromQueryResult, QuerySelect, Statement, Value,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const EDITABLE_LOCAL_SITE_SLUG: &str = "scpaiueouiuiuiui";
const EMAIL_INVITATION_TOKEN_HEX_LENGTH: usize = 20;

#[derive(Debug, FromQueryResult)]
struct EmailInvitationRow {
    invitation_id: i64,
    site_id: i64,
    sender_user_id: i64,
    recipient_name: String,
    email: String,
}

#[derive(Debug, FromQueryResult)]
struct EmailInvitationCreatedRow {
    invitation_id: i64,
}

#[derive(Debug)]
pub struct MembershipService;

impl MembershipService {
    fn email_invitation_token_digest(token: &str) -> String {
        hex::encode(Sha256::digest(token.as_bytes()))
    }

    fn generate_email_invitation_token() -> String {
        let uuid = Uuid::new_v4().simple().to_string();
        uuid[..EMAIL_INVITATION_TOKEN_HEX_LENGTH].to_owned()
    }

    pub async fn create_email_invitation(
        ctx: &ServiceContext<'_>,
        input: CreateMembershipEmailInvitation<'_>,
    ) -> Result<(i64, String)> {
        let email = input.email.trim();
        let recipient_name = input.recipient_name.trim();
        if email.is_empty() || recipient_name.is_empty() {
            return Err(Error::new(
                "membership email invitation requires recipient identity",
                ErrorType::BadRequest,
            )
            .into());
        }
        let token = Self::generate_email_invitation_token();
        let digest = Self::email_invitation_token_digest(&token);
        let transaction = ctx.transaction();
        let row =
            EmailInvitationCreatedRow::find_by_statement(Statement::from_sql_and_values(
                transaction.get_database_backend(),
                r#"
INSERT INTO membership_email_invitation (
    site_id,
    sender_user_id,
    token_digest,
    email,
    recipient_name,
    message,
    to_contacts
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING invitation_id
                "#,
                [
                    Value::from(input.site_id),
                    Value::from(input.sender_user_id),
                    Value::from(digest),
                    Value::from(email.to_owned()),
                    Value::from(recipient_name.to_owned()),
                    Value::from(input.message.to_owned()),
                    Value::from(input.to_contacts),
                ],
            ))
            .one(transaction)
            .await
            .or_raise(|| {
                Error::new(
                    "failed to create membership email invitation",
                    ErrorType::SiteMembership,
                )
            })?
            .ok_or_raise(|| {
                Error::new(
                    "membership email invitation insert returned no row",
                    ErrorType::SiteMembership,
                )
            })?;
        Ok((row.invitation_id, token))
    }

    async fn email_invitation_row(
        ctx: &ServiceContext<'_>,
        token: &str,
        lock: bool,
    ) -> Result<Option<EmailInvitationRow>> {
        if token.len() != EMAIL_INVITATION_TOKEN_HEX_LENGTH
            || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Ok(None);
        }
        let transaction = ctx.transaction();
        let sql = if lock {
            concat!(
                "SELECT invitation_id, site_id, sender_user_id, recipient_name, email ",
                "FROM membership_email_invitation ",
                "WHERE token_digest = $1 AND accepted = FALSE FOR UPDATE",
            )
        } else {
            concat!(
                "SELECT invitation_id, site_id, sender_user_id, recipient_name, email ",
                "FROM membership_email_invitation ",
                "WHERE token_digest = $1 AND accepted = FALSE",
            )
        };
        EmailInvitationRow::find_by_statement(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            sql,
            [Value::from(Self::email_invitation_token_digest(token))],
        ))
        .one(transaction)
        .await
        .or_raise(|| {
            Error::new(
                "failed to resolve membership email invitation",
                ErrorType::SiteMembership,
            )
        })
    }

    pub async fn resolve_email_invitation(
        ctx: &ServiceContext<'_>,
        token: &str,
    ) -> Result<Option<MembershipEmailInvitationView>> {
        let Some(invitation) = Self::email_invitation_row(ctx, token, false).await?
        else {
            return Ok(None);
        };
        let site = Site::find_by_id(invitation.site_id)
            .one(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    "failed to resolve membership invitation site",
                    ErrorType::SiteMembership,
                )
            })?
            .filter(|site| site.deleted_at.is_none());
        let Some(site) = site else {
            return Ok(None);
        };
        let sender = UserService::get(ctx, Reference::Id(invitation.sender_user_id))
            .await?
            .into_public_identity();
        let Some(sender) = sender else {
            return Ok(None);
        };
        Ok(Some(MembershipEmailInvitationView {
            invitation_id: invitation.invitation_id,
            site_id: invitation.site_id,
            site_name: site.name,
            site_slug: site.slug,
            sender_user_id: invitation.sender_user_id,
            sender_user_name: sender.user_name.into_owned(),
            sender_profile_url: sender.user_profile_url.into_owned(),
            recipient_name: invitation.recipient_name,
        }))
    }

    pub async fn accept_email_invitation(
        ctx: &ServiceContext<'_>,
        input: AcceptMembershipEmailInvitation,
    ) -> Result<MembershipEmailInvitationOutcome> {
        let (_renderer_site, actor_user_id) = Self::authorize_renderer_action(
            ctx,
            input.page_id,
            input.last_revision_id,
            MembershipActionKind::Invitation,
            input.action_index,
            &input.action_fingerprint,
        )
        .await?;
        let Some(invitation) = Self::email_invitation_row(ctx, &input.hash, true).await?
        else {
            return Ok(MembershipEmailInvitationOutcome::Unavailable);
        };
        let actor = UserService::get(ctx, Reference::Id(actor_user_id)).await?;
        let recipient_matches = match &actor {
            User::Wikijump(user) => user
                .email
                .trim()
                .eq_ignore_ascii_case(invitation.email.trim()),
            User::Wikidot(_) => false,
        };
        if !recipient_matches {
            return Ok(MembershipEmailInvitationOutcome::Unavailable);
        }
        if RelationService::site_member_exists(
            ctx,
            GetSiteMember {
                site_id: invitation.site_id,
                user_id: actor_user_id,
            },
        )
        .await?
        {
            return Ok(MembershipEmailInvitationOutcome::AlreadyMember);
        }
        RelationService::create_site_member(
            ctx,
            CreateSiteMember {
                site_id: invitation.site_id,
                user_id: actor_user_id,
                metadata: SiteMemberData {
                    accepted: SiteMemberAccepted::Invitation(invitation.sender_user_id),
                },
                created_by: invitation.sender_user_id,
            },
            input.ip_address,
        )
        .await?;

        let invitation_site = Site::find_by_id(invitation.site_id)
            .one(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    "failed to resolve accepted invitation site",
                    ErrorType::SiteMembership,
                )
            })?
            .ok_or_raise(|| {
                Error::new(
                    "accepted invitation site no longer exists",
                    ErrorType::SiteMembership,
                )
            })?;

        let transaction = ctx.transaction();
        transaction
            .execute_raw(Statement::from_sql_and_values(
                transaction.get_database_backend(),
                r#"
UPDATE membership_email_invitation
SET accepted = TRUE, accepted_at = NOW()
WHERE invitation_id = $1 AND accepted = FALSE
                "#,
                [Value::from(invitation.invitation_id)],
            ))
            .await
            .or_raise(|| {
                Error::new(
                    "failed to consume membership email invitation",
                    ErrorType::SiteMembership,
                )
            })?;
        Ok(MembershipEmailInvitationOutcome::Accepted {
            site_name: invitation_site.name,
            site_slug: invitation_site.slug,
        })
    }

    pub async fn cancel_email_invitation(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        invitation_id: i64,
    ) -> Result<bool> {
        let transaction = ctx.transaction();
        let result = transaction
            .execute_raw(Statement::from_sql_and_values(
                transaction.get_database_backend(),
                "DELETE FROM membership_email_invitation WHERE invitation_id = $1 AND site_id = $2",
                [Value::from(invitation_id), Value::from(site_id)],
            ))
            .await
            .or_raise(|| {
                Error::new(
                    "failed to cancel membership email invitation",
                    ErrorType::SiteMembership,
                )
            })?;
        Ok(result.rows_affected() == 1)
    }

    async fn authorize_renderer_action(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        last_revision_id: i64,
        action_kind: MembershipActionKind,
        action_index: usize,
        action_fingerprint: &str,
    ) -> Result<(SiteModel, i64)> {
        let site_id = ctx.request().site_id().or_raise(Self::denied)?;
        let route_page_reference = ctx
            .request()
            .page_reference()
            .or_raise(Self::denied)?
            .clone();
        let route_page = PageService::get(ctx, site_id, route_page_reference)
            .await
            .or_raise(Self::denied)?;
        let actor_user_id = MutationAuthorization::require_permission(
            ctx,
            site_id,
            Some(Reference::Id(route_page.page_id)),
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(route_page.page_category_id)),
                action: Action::View,
            },
            "use this membership action",
        )
        .await
        .or_raise(Self::denied)?;
        if route_page.page_id != page_id {
            return Err(Self::denied().into());
        }

        let site = Site::find_by_id(site_id)
            .lock_exclusive()
            .one(ctx.transaction())
            .await
            .or_raise(Self::denied)?
            .ok_or_raise(Self::denied)?;
        let Some(page) = PageService::get_direct_optional_for_update(ctx, page_id, false)
            .await
            .or_raise(Self::denied)?
        else {
            return Err(Self::denied().into());
        };
        if page.site_id != site_id
            || page.page_id != route_page.page_id
            || page.latest_revision_id != Some(last_revision_id)
        {
            return Err(Self::denied().into());
        }
        let revision = PageRevisionService::get_latest(ctx, site_id, page.page_id)
            .await
            .or_raise(Self::denied)?;
        if revision.revision_id != last_revision_id {
            return Err(Self::denied().into());
        }
        let source = TextService::get(ctx, &revision.wikitext_hash)
            .await
            .or_raise(Self::denied)?;
        if !MembershipActionRegistry::from_wikidot_source(&source).resolve_kind(
            action_kind,
            action_index,
            action_fingerprint,
        ) {
            return Err(Self::denied().into());
        }

        Ok((site, actor_user_id))
    }

    pub fn policy(site: &SiteModel) -> MembershipPolicy {
        if site.deleted_at.is_none() && site.slug == EDITABLE_LOCAL_SITE_SLUG {
            MembershipPolicy::Open
        } else {
            MembershipPolicy::Closed
        }
    }

    pub const fn join_module_state(actor: JoinActorState) -> JoinModuleState {
        match actor {
            JoinActorState::Anonymous
            | JoinActorState::Eligible
            | JoinActorState::Invited => JoinModuleState::Show,
            JoinActorState::Pending
            | JoinActorState::Member
            | JoinActorState::Banned
            | JoinActorState::Admin => JoinModuleState::Hidden,
        }
    }

    pub const fn join_module_preview_state(actor: JoinActorState) -> JoinModuleState {
        match actor {
            JoinActorState::Member => JoinModuleState::Show,
            actor => Self::join_module_state(actor),
        }
    }

    pub async fn current_application_status(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        user_id: i64,
    ) -> Result<Option<MembershipApplicationStatus>> {
        let Some(relation) = RelationService::get_optional(
            ctx,
            RelationReference::Relationship {
                relation_type: RelationType::SiteApplication,
                dest: RelationObject::Site(site_id),
                from: RelationObject::User(user_id),
            },
        )
        .await?
        else {
            return Ok(None);
        };
        let status =
            serde_json::from_value::<MembershipApplicationData>(relation.metadata)
                .map_or(MembershipApplicationStatus::Pending, |data| data.status);
        Ok(Some(status))
    }

    pub async fn actor_state(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        user_id: Option<i64>,
    ) -> Result<JoinActorState> {
        let Some(user_id) = user_id else {
            return Ok(JoinActorState::Anonymous);
        };
        if user_id == ADMIN_USER_ID {
            return Ok(JoinActorState::Admin);
        }
        if RelationService::active_site_ban_exists(ctx, GetSiteBan { site_id, user_id })
            .await?
        {
            return Ok(JoinActorState::Banned);
        }
        if RelationService::site_member_exists(ctx, GetSiteMember { site_id, user_id })
            .await?
        {
            return Ok(JoinActorState::Member);
        }
        let application_status =
            Self::current_application_status(ctx, site_id, user_id).await?;
        Ok(match application_status {
            Some(MembershipApplicationStatus::Pending)
            | Some(MembershipApplicationStatus::Accepted) => JoinActorState::Pending,
            Some(MembershipApplicationStatus::Declined) | None => {
                JoinActorState::Eligible
            }
        })
    }

    pub async fn join(
        ctx: &ServiceContext<'_>,
        input: JoinMembership,
    ) -> Result<MembershipJoinOutcome> {
        let (site, actor_user_id) = Self::authorize_renderer_action(
            ctx,
            input.page_id,
            input.last_revision_id,
            MembershipActionKind::Join,
            input.action_index,
            &input.action_fingerprint,
        )
        .await?;
        let site_id = site.site_id;
        if Self::policy(&site) != MembershipPolicy::Open {
            return Err(Self::denied().into());
        }

        if !ActionThrottleService::consume(
            ctx,
            MEMBERSHIP_SELF_JOIN_THROTTLE,
            site_id,
            actor_user_id,
        )
        .await
        .or_raise(Self::denied)?
        {
            return Err(Self::denied().into());
        }

        match Self::actor_state(ctx, site_id, Some(actor_user_id)).await? {
            JoinActorState::Member | JoinActorState::Admin => {
                return Ok(MembershipJoinOutcome::AlreadyMember);
            }
            JoinActorState::Eligible | JoinActorState::Invited => {}
            JoinActorState::Anonymous
            | JoinActorState::Pending
            | JoinActorState::Banned => return Err(Self::denied().into()),
        }

        RelationService::create_site_member(
            ctx,
            CreateSiteMember {
                site_id,
                user_id: actor_user_id,
                metadata: SiteMemberData {
                    accepted: SiteMemberAccepted::SelfJoined,
                },
                created_by: actor_user_id,
            },
            input.ip_address,
        )
        .await
        .or_raise(Self::denied)?;
        Ok(MembershipJoinOutcome::Joined)
    }

    pub async fn submit_password(
        ctx: &ServiceContext<'_>,
        input: SubmitMembershipPassword,
    ) -> Result<MembershipPasswordOutcome> {
        let (site, actor_user_id) = Self::authorize_renderer_action(
            ctx,
            input.page_id,
            input.last_revision_id,
            MembershipActionKind::Password,
            input.action_index,
            &input.action_fingerprint,
        )
        .await?;
        let site_id = site.site_id;
        if !site.membership_by_password {
            return Err(Self::denied().into());
        }

        if !ActionThrottleService::consume(
            ctx,
            MEMBERSHIP_PASSWORD_THROTTLE,
            site_id,
            actor_user_id,
        )
        .await
        .or_raise(Self::denied)?
        {
            return Err(Self::denied().into());
        }
        if RelationService::site_member_exists(
            ctx,
            GetSiteMember {
                site_id,
                user_id: actor_user_id,
            },
        )
        .await?
        {
            return Ok(MembershipPasswordOutcome::AlreadyMember);
        }
        if RelationService::active_site_ban_exists(
            ctx,
            GetSiteBan {
                site_id,
                user_id: actor_user_id,
            },
        )
        .await?
        {
            return Err(Self::denied().into());
        }
        let Some(password_hash) = site.membership_password_hash.as_deref() else {
            return Err(Self::denied().into());
        };
        if PasswordService::verify_no_sleep(ctx, &input.password, password_hash)
            .await
            .is_err()
        {
            return Ok(MembershipPasswordOutcome::WrongPassword);
        }

        RelationService::create_site_member(
            ctx,
            CreateSiteMember {
                site_id,
                user_id: actor_user_id,
                metadata: SiteMemberData {
                    accepted: SiteMemberAccepted::Password,
                },
                created_by: actor_user_id,
            },
            input.ip_address,
        )
        .await
        .or_raise(Self::denied)?;

        let application = RelationReference::Relationship {
            relation_type: RelationType::SiteApplication,
            dest: RelationObject::Site(site_id),
            from: RelationObject::User(actor_user_id),
        };
        if RelationService::exists(ctx, application).await? {
            RelationService::remove(ctx, application, actor_user_id)
                .await
                .or_raise(Self::denied)?;
        }
        Ok(MembershipPasswordOutcome::Joined)
    }

    pub async fn submit_application(
        ctx: &ServiceContext<'_>,
        input: SubmitMembershipApplication,
    ) -> Result<MembershipApplicationOutcome> {
        let (site, actor_user_id) = Self::authorize_renderer_action(
            ctx,
            input.page_id,
            input.last_revision_id,
            MembershipActionKind::Application,
            input.action_index,
            &input.action_fingerprint,
        )
        .await?;
        let site_id = site.site_id;
        if !site.membership_by_application {
            return Err(Self::denied().into());
        }
        if RelationService::site_member_exists(
            ctx,
            GetSiteMember {
                site_id,
                user_id: actor_user_id,
            },
        )
        .await?
        {
            return Ok(MembershipApplicationOutcome::AlreadyMember);
        }
        if RelationService::active_site_ban_exists(
            ctx,
            GetSiteBan {
                site_id,
                user_id: actor_user_id,
            },
        )
        .await?
        {
            return Err(Self::denied().into());
        }
        let comment = input.comment.trim();
        if comment.is_empty() {
            return Ok(MembershipApplicationOutcome::NoText);
        }
        match Self::current_application_status(ctx, site_id, actor_user_id).await? {
            Some(MembershipApplicationStatus::Pending)
            | Some(MembershipApplicationStatus::Accepted) => {
                return Ok(MembershipApplicationOutcome::AlreadyApplied);
            }
            Some(MembershipApplicationStatus::Declined) | None => {}
        }
        RelationService::create(
            ctx,
            RelationType::SiteApplication,
            RelationObject::Site(site_id),
            RelationObject::User(actor_user_id),
            actor_user_id,
            &MembershipApplicationData {
                status: MembershipApplicationStatus::Pending,
                comment: comment.to_owned(),
                reply: None,
            },
        )
        .await
        .or_raise(Self::denied)?;
        Ok(MembershipApplicationOutcome::Submitted)
    }

    pub async fn review_application(
        ctx: &ServiceContext<'_>,
        input: ReviewMembershipApplication,
        reviewer_user_id: i64,
    ) -> Result<MembershipApplicationStatus> {
        let reference = RelationReference::Relationship {
            relation_type: RelationType::SiteApplication,
            dest: RelationObject::Site(input.site_id),
            from: RelationObject::User(input.user_id),
        };
        let relation = RelationService::get(ctx, reference).await.or_raise(|| {
            Error::new(
                "membership application does not exist",
                ErrorType::SiteMembership,
            )
        })?;
        let current: MembershipApplicationData =
            serde_json::from_value(relation.metadata).or_raise(|| {
                Error::new(
                    "membership application metadata is invalid",
                    ErrorType::SiteMembership,
                )
            })?;
        if current.status != MembershipApplicationStatus::Pending {
            return Err(Error::new(
                "membership application has already been reviewed",
                ErrorType::BadRequest,
            )
            .into());
        }
        let status = match input.decision {
            MembershipApplicationReviewDecision::Accept => {
                if !RelationService::site_member_exists(
                    ctx,
                    GetSiteMember {
                        site_id: input.site_id,
                        user_id: input.user_id,
                    },
                )
                .await?
                {
                    RelationService::create_site_member(
                        ctx,
                        CreateSiteMember {
                            site_id: input.site_id,
                            user_id: input.user_id,
                            metadata: SiteMemberData {
                                accepted: SiteMemberAccepted::Accepted(reviewer_user_id),
                            },
                            created_by: reviewer_user_id,
                        },
                        input.ip_address,
                    )
                    .await?;
                }
                MembershipApplicationStatus::Accepted
            }
            MembershipApplicationReviewDecision::Decline => {
                MembershipApplicationStatus::Declined
            }
        };
        RelationService::create(
            ctx,
            RelationType::SiteApplication,
            RelationObject::Site(input.site_id),
            RelationObject::User(input.user_id),
            reviewer_user_id,
            &MembershipApplicationData {
                status,
                comment: current.comment,
                reply: Some(input.reply),
            },
        )
        .await?;
        Ok(status)
    }

    pub async fn list_applications(
        ctx: &ServiceContext<'_>,
        site_id: i64,
    ) -> Result<Vec<MembershipApplicationView>> {
        let relations = RelationService::get_entries(
            ctx,
            RelationType::SiteApplication,
            RelationObject::Site(site_id),
            RelationDirection::Dest,
        )
        .await?;
        let mut listed = Vec::new();
        let mut applicant_ids = std::collections::BTreeSet::new();
        for relation in relations {
            let metadata: MembershipApplicationData =
                serde_json::from_value(relation.metadata).or_raise(|| {
                    Error::new(
                        "membership application metadata is invalid",
                        ErrorType::SiteMembership,
                    )
                })?;
            if metadata.status == MembershipApplicationStatus::Accepted {
                continue;
            }
            applicant_ids.insert(relation.from_id);
            listed.push((relation.from_id, metadata.status, metadata.comment));
        }

        let identities = UserService::get_public_identities(ctx, &applicant_ids).await?;
        let mut applications = Vec::with_capacity(listed.len());
        for (user_id, status, comment) in listed {
            let Some(identity) = identities.get(&user_id) else {
                continue;
            };
            applications.push(MembershipApplicationView {
                user_id,
                user_name: identity.user_name.to_string(),
                status,
                comment,
            });
        }
        Ok(applications)
    }

    fn denied() -> Error {
        Error::new(
            "membership action is unavailable",
            ErrorType::PermissionDenied,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_visibility_is_table_driven_and_fail_closed() {
        for (actor, expected) in [
            (JoinActorState::Anonymous, JoinModuleState::Show),
            (JoinActorState::Eligible, JoinModuleState::Show),
            (JoinActorState::Invited, JoinModuleState::Show),
            (JoinActorState::Pending, JoinModuleState::Hidden),
            (JoinActorState::Member, JoinModuleState::Hidden),
            (JoinActorState::Banned, JoinModuleState::Hidden),
            (JoinActorState::Admin, JoinModuleState::Hidden),
        ] {
            assert_eq!(MembershipService::join_module_state(actor), expected);
        }
    }

    #[test]
    fn join_preview_shows_members_while_saved_states_stay_hidden() {
        for (actor, expected) in [
            (JoinActorState::Anonymous, JoinModuleState::Show),
            (JoinActorState::Eligible, JoinModuleState::Show),
            (JoinActorState::Invited, JoinModuleState::Show),
            (JoinActorState::Pending, JoinModuleState::Hidden),
            (JoinActorState::Member, JoinModuleState::Show),
            (JoinActorState::Banned, JoinModuleState::Hidden),
            (JoinActorState::Admin, JoinModuleState::Hidden),
        ] {
            assert_eq!(
                MembershipService::join_module_preview_state(actor),
                expected,
            );
        }
    }
}

/*
 * services/membership/structs.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MembershipJoinOutcome {
    Joined,
    AlreadyMember,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MembershipPasswordOutcome {
    Joined,
    AlreadyMember,
    WrongPassword,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MembershipApplicationOutcome {
    Submitted,
    AlreadyApplied,
    AlreadyMember,
    NoText,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum MembershipEmailInvitationOutcome {
    Accepted {
        site_name: String,
        site_slug: String,
    },
    AlreadyMember,
    Unavailable,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct MembershipEmailInvitationView {
    pub invitation_id: i64,
    pub site_id: i64,
    pub site_name: String,
    pub site_slug: String,
    pub sender_user_id: i64,
    pub sender_user_name: String,
    pub sender_profile_url: String,
    pub recipient_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateMembershipEmailInvitation<'a> {
    pub site_id: i64,
    pub sender_user_id: i64,
    pub email: &'a str,
    pub recipient_name: &'a str,
    pub message: &'a str,
    pub to_contacts: bool,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct AcceptMembershipEmailInvitation {
    pub page_id: i64,
    pub last_revision_id: i64,
    pub action_index: usize,
    pub action_fingerprint: String,
    pub hash: String,
    pub ip_address: std::net::IpAddr,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MembershipApplicationStatus {
    Pending,
    Accepted,
    Declined,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct MembershipApplicationView {
    pub user_id: i64,
    pub user_name: String,
    pub status: MembershipApplicationStatus,
    pub comment: String,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListMembershipApplications {
    pub site_id: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MembershipApplicationData {
    pub status: MembershipApplicationStatus,
    pub comment: String,
    pub reply: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SubmitMembershipApplication {
    pub page_id: i64,
    pub last_revision_id: i64,
    pub action_index: usize,
    pub action_fingerprint: String,
    pub comment: String,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SubmitMembershipPassword {
    pub page_id: i64,
    pub last_revision_id: i64,
    pub action_index: usize,
    pub action_fingerprint: String,
    pub password: String,
    pub ip_address: std::net::IpAddr,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MembershipApplicationReviewDecision {
    Accept,
    Decline,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ReviewMembershipApplication {
    pub site_id: i64,
    pub user_id: i64,
    pub decision: MembershipApplicationReviewDecision,
    pub reply: String,
    pub ip_address: std::net::IpAddr,
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct JoinMembership {
    pub page_id: i64,
    pub last_revision_id: i64,
    pub action_index: usize,
    pub action_fingerprint: String,
    pub ip_address: std::net::IpAddr,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum MembershipBrowserAction {
    Join {
        page_id: i64,
        revision_id: i64,
        index: usize,
        fingerprint: String,
    },
    Application {
        page_id: i64,
        revision_id: i64,
        index: usize,
        fingerprint: String,
    },
    Password {
        page_id: i64,
        revision_id: i64,
        index: usize,
        fingerprint: String,
    },
    Invitation {
        page_id: i64,
        revision_id: i64,
        index: usize,
        fingerprint: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipPolicy {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinActorState {
    Anonymous,
    Eligible,
    Pending,
    Invited,
    Member,
    Banned,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinModuleState {
    Show,
    Hidden,
}

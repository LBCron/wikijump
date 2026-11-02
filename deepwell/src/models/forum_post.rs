use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "forum_post")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub forum_post_id: i64,
    pub parent_post_id: Option<i64>,
    pub forum_thread_id: i64,
    pub forum_category_id: i64,
    pub forum_group_id: i64,
    pub site_id: i64,
    pub user_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    pub deleted_by: Option<i64>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    pub from_wikidot: bool,
    pub latest_revision_id: Option<i64>,
    #[sea_orm(column_type = "Text", nullable)]
    pub guest_name: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub guest_email_md5: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::forum_category::Entity",
        from = "Column::ForumCategoryId",
        to = "super::forum_category::Column::ForumCategoryId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumCategory2,
    #[sea_orm(
        belongs_to = "super::forum_category::Entity",
        from = "(Column::ForumCategoryId, Column::SiteId)",
        to = "(super::forum_category::Column::ForumCategoryId, super::forum_category::Column::SiteId)",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumCategory1,
    #[sea_orm(
        belongs_to = "super::forum_group::Entity",
        from = "Column::ForumGroupId",
        to = "super::forum_group::Column::ForumGroupId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumGroup2,
    #[sea_orm(
        belongs_to = "super::forum_group::Entity",
        from = "(Column::ForumGroupId, Column::SiteId)",
        to = "(super::forum_group::Column::ForumGroupId, super::forum_group::Column::SiteId)",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumGroup1,
    #[sea_orm(
        belongs_to = "Entity",
        from = "Column::ParentPostId",
        to = "Column::ForumPostId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    SelfRef,
    #[sea_orm(has_many = "super::forum_post_lock::Entity")]
    ForumPostLock,
    #[sea_orm(
        belongs_to = "super::forum_post_revision::Entity",
        from = "Column::LatestRevisionId",
        to = "super::forum_post_revision::Column::ForumPostRevisionId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumPostRevision,
    #[sea_orm(
        belongs_to = "super::forum_thread::Entity",
        from = "Column::ForumThreadId",
        to = "super::forum_thread::Column::ForumThreadId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumThread2,
    #[sea_orm(
        belongs_to = "super::forum_thread::Entity",
        from = "(Column::ForumThreadId, Column::SiteId)",
        to = "(super::forum_thread::Column::ForumThreadId, super::forum_thread::Column::SiteId)",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumThread1,
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::DeletedBy",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser2,
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::UserId",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser1,
    #[sea_orm(
        belongs_to = "super::site::Entity",
        from = "Column::SiteId",
        to = "super::site::Column::SiteId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Site,
}

impl Related<super::forum_post_lock::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumPostLock.def()
    }
}

impl Related<super::forum_post_revision::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumPostRevision.def()
    }
}

impl Related<super::site::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Site.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

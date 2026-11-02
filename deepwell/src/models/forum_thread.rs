use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "forum_thread")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub forum_thread_id: i64,
    pub forum_category_id: i64,
    pub forum_group_id: i64,
    pub site_id: i64,
    #[sea_orm(unique)]
    pub page_id: Option<i64>,
    pub created_by: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    pub updated_by: Option<i64>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    pub deleted_by: Option<i64>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub description: String,
    pub from_wikidot: bool,
    pub sticky: bool,
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
    #[sea_orm(has_many = "super::forum_thread_lock::Entity")]
    ForumThreadLock,
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::CreatedBy",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser3,
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
        from = "Column::UpdatedBy",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser1,
    #[sea_orm(
        belongs_to = "super::page::Entity",
        from = "Column::PageId",
        to = "super::page::Column::PageId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Page,
    #[sea_orm(
        belongs_to = "super::site::Entity",
        from = "Column::SiteId",
        to = "super::site::Column::SiteId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Site,
}

impl Related<super::forum_thread_lock::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumThreadLock.def()
    }
}

impl Related<super::page::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Page.def()
    }
}

impl Related<super::site::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Site.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

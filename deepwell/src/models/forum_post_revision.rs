use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "forum_post_revision")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub forum_post_revision_id: i64,
    pub forum_post_id: i64,
    pub forum_thread_id: i64,
    pub forum_category_id: i64,
    pub forum_group_id: i64,
    pub site_id: i64,
    pub user_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    pub revision_number: i32,
    pub from_wikidot: bool,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "VarBinary(StringLen::None)")]
    pub wikitext_hash: Vec<u8>,
    #[sea_orm(column_type = "VarBinary(StringLen::None)")]
    pub compiled_html_hash: Vec<u8>,
    #[serde(with = "time::serde::rfc3339")]
    pub compiled_at: TimeDateTimeWithTimeZone,
    #[sea_orm(column_type = "Text")]
    pub compiled_generator: String,
    #[sea_orm(column_type = "Text")]
    pub comments: String,
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
        belongs_to = "super::forum_post::Entity",
        from = "Column::ForumPostId",
        to = "super::forum_post::Column::ForumPostId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumPost2,
    #[sea_orm(
        belongs_to = "super::forum_post::Entity",
        from = "(Column::ForumPostId, Column::SiteId)",
        to = "(super::forum_post::Column::ForumPostId, super::forum_post::Column::SiteId)",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumPost1,
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
        from = "Column::UserId",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser,
    #[sea_orm(
        belongs_to = "super::site::Entity",
        from = "Column::SiteId",
        to = "super::site::Column::SiteId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Site,
    #[sea_orm(
        belongs_to = "super::text::Entity",
        from = "Column::CompiledHtmlHash",
        to = "super::text::Column::Hash",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Text2,
    #[sea_orm(
        belongs_to = "super::text::Entity",
        from = "Column::WikitextHash",
        to = "super::text::Column::Hash",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Text1,
}

impl Related<super::known_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnownUser.def()
    }
}

impl Related<super::site::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Site.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

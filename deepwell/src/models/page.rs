use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "page")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub page_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    pub from_wikidot: bool,
    pub site_id: i64,
    pub latest_revision_id: Option<i64>,
    pub page_category_id: i64,
    #[sea_orm(column_type = "Text")]
    pub slug: String,
    pub discussion_thread_id: Option<i64>,
    #[sea_orm(column_type = "Text", nullable)]
    pub layout: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::file::Entity")]
    File,
    #[sea_orm(has_many = "super::file_revision::Entity")]
    FileRevision,
    #[sea_orm(
        belongs_to = "super::forum_thread::Entity",
        from = "Column::DiscussionThreadId",
        to = "super::forum_thread::Column::ForumThreadId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumThread,
    #[sea_orm(
        belongs_to = "super::page_category::Entity",
        from = "Column::PageCategoryId",
        to = "super::page_category::Column::CategoryId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    PageCategory,
    #[sea_orm(has_many = "super::page_connection_missing::Entity")]
    PageConnectionMissing,
    #[sea_orm(has_many = "super::page_link::Entity")]
    PageLink,
    #[sea_orm(has_many = "super::page_lock::Entity")]
    PageLock,
    #[sea_orm(has_many = "super::page_meta_tag::Entity")]
    PageMetaTag,
    #[sea_orm(
        belongs_to = "super::page_revision::Entity",
        from = "Column::LatestRevisionId",
        to = "super::page_revision::Column::RevisionId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    PageRevision,
    #[sea_orm(has_many = "super::page_vote::Entity")]
    PageVote,
    #[sea_orm(
        belongs_to = "super::site::Entity",
        from = "Column::SiteId",
        to = "super::site::Column::SiteId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Site,
    #[sea_orm(has_many = "super::text_block::Entity")]
    TextBlock,
}

impl Related<super::file::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::File.def()
    }
}

impl Related<super::file_revision::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::FileRevision.def()
    }
}

impl Related<super::forum_thread::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumThread.def()
    }
}

impl Related<super::page_category::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageCategory.def()
    }
}

impl Related<super::page_connection_missing::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageConnectionMissing.def()
    }
}

impl Related<super::page_link::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageLink.def()
    }
}

impl Related<super::page_lock::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageLock.def()
    }
}

impl Related<super::page_meta_tag::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageMetaTag.def()
    }
}

impl Related<super::page_revision::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageRevision.def()
    }
}

impl Related<super::page_vote::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageVote.def()
    }
}

impl Related<super::site::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Site.def()
    }
}

impl Related<super::text_block::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::TextBlock.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

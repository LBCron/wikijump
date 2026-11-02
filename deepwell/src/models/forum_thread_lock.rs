use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "forum_thread_lock")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub forum_thread_lock_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
    pub from_wikidot: bool,
    pub forum_thread_id: i64,
    pub user_id: i64,
    #[sea_orm(column_type = "Text")]
    pub reason: String,
    #[sea_orm(column_type = "Text")]
    pub lock_type: String,
    pub allow_new_posts: bool,
    pub allow_post_edits: bool,
    pub allow_post_deletions: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::forum_thread::Entity",
        from = "Column::ForumThreadId",
        to = "super::forum_thread::Column::ForumThreadId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumThread,
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::UserId",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser,
}

impl Related<super::forum_thread::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumThread.def()
    }
}

impl Related<super::known_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnownUser.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

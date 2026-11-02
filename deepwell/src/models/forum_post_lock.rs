use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "forum_post_lock")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub forum_post_lock_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
    pub forum_post_id: i64,
    pub user_id: i64,
    #[sea_orm(column_type = "Text")]
    pub reason: String,
    #[sea_orm(column_type = "Text")]
    pub lock_type: String,
    pub cascading: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::forum_post::Entity",
        from = "Column::ForumPostId",
        to = "super::forum_post::Column::ForumPostId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    ForumPost,
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::UserId",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser,
}

impl Related<super::forum_post::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumPost.def()
    }
}

impl Related<super::known_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnownUser.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "forum_group")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub forum_group_id: i64,
    pub site_id: i64,
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
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub description: String,
    pub visible: bool,
    pub sort_index: i32,
    pub from_wikidot: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
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
        belongs_to = "super::site::Entity",
        from = "Column::SiteId",
        to = "super::site::Column::SiteId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    Site,
}

impl Related<super::site::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Site.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

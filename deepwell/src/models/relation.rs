use crate::types::{RelationObjectType, RelationType};
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "relation")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub relation_id: i64,
    pub relation_type: RelationType,
    pub dest_type: RelationObjectType,
    pub dest_id: i64,
    pub from_type: RelationObjectType,
    pub from_id: i64,
    #[sea_orm(column_type = "JsonBinary")]
    pub metadata: Json,
    pub created_by: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    pub overwritten_by: Option<i64>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub overwritten_at: Option<TimeDateTimeWithTimeZone>,
    pub deleted_by: Option<i64>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
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
        from = "Column::OverwrittenBy",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser1,
}

impl ActiveModelBehavior for ActiveModel {}

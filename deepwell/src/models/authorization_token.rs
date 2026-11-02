use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "authorization_token")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub token_id: i32,
    #[sea_orm(column_type = "Text", unique)]
    pub token_value: String,
    pub created_by: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[sea_orm(column_type = "Text")]
    pub description: String,
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
    KnownUser,
}

impl Related<super::known_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnownUser.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

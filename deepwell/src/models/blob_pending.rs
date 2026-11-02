use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "blob_pending")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub external_id: String,
    pub created_by: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: TimeDateTimeWithTimeZone,
    pub expected_length: i64,
    #[sea_orm(column_type = "Text")]
    pub s3_path: String,
    #[sea_orm(column_type = "VarBinary(StringLen::None)", nullable)]
    pub s3_hash: Option<Vec<u8>>,
    #[sea_orm(column_type = "Text")]
    pub presign_url: String,
    pub site_id: Option<i64>,
    pub page_id: Option<i64>,
    #[sea_orm(column_type = "Text", nullable)]
    pub content_type_label: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub content_type_description: Option<String>,
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

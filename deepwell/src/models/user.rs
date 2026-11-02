use crate::types::UserType;
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "user")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: i64,
    pub user_type: UserType,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub slug: String,
    pub name_changes_left: i16,
    #[serde(with = "time::serde::rfc3339")]
    pub last_name_change_added_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_renamed_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    pub email: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub email_verified_at: Option<TimeDateTimeWithTimeZone>,
    pub email_validation_info: Option<Json>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub email_validation_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    pub password: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub multi_factor_secret: Option<String>,
    pub multi_factor_recovery_codes: Option<Vec<String>>,
    pub locales: Vec<String>,
    #[sea_orm(column_type = "VarBinary(StringLen::None)", nullable)]
    pub avatar_s3_hash: Option<Vec<u8>>,
    #[sea_orm(column_type = "Text", nullable)]
    pub forum_signature: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub real_name: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub gender: Option<String>,
    pub birthday: Option<TimeDate>,
    #[sea_orm(column_type = "Text", nullable)]
    pub location: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub biography: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub website: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub user_page: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::UserId",
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

use crate::types::FileRevisionType;
use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "file_revision")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub revision_id: i64,
    pub revision_type: FileRevisionType,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    pub revision_number: i32,
    pub file_id: i64,
    pub page_id: i64,
    pub site_id: i64,
    pub user_id: i64,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    #[sea_orm(column_type = "VarBinary(StringLen::None)")]
    pub s3_hash: Vec<u8>,
    #[sea_orm(column_type = "Text")]
    pub mime: String,
    pub size: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub content_type_label: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub content_type_description: Option<String>,
    pub changes: Vec<String>,
    #[sea_orm(column_type = "Text")]
    pub comments: String,
    pub hidden: Vec<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::file::Entity",
        from = "Column::FileId",
        to = "super::file::Column::FileId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    File,
    #[sea_orm(
        belongs_to = "super::known_user::Entity",
        from = "Column::UserId",
        to = "super::known_user::Column::UserId",
        on_update = "NoAction",
        on_delete = "NoAction"
    )]
    KnownUser,
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

impl Related<super::file::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::File.def()
    }
}

impl Related<super::known_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::KnownUser.def()
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

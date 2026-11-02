use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "mirror_scope")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub site_id: i64,
    #[sea_orm(column_type = "Text")]
    pub scope: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub source_pin: Option<String>,
    pub inventoried_source_count: i64,
    pub declared_extras: Vec<String>,
    pub consumed_slugs: Vec<String>,
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::site::Entity",
        from = "Column::SiteId",
        to = "super::site::Column::SiteId",
        on_update = "NoAction",
        on_delete = "Cascade"
    )]
    Site,
}

impl Related<super::site::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Site.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

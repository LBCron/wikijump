use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "known_user")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub user_id: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::alias::Entity")]
    Alias,
    #[sea_orm(has_many = "super::authorization_token::Entity")]
    AuthorizationToken,
    #[sea_orm(has_many = "super::blob_blacklist::Entity")]
    BlobBlacklist,
    #[sea_orm(has_many = "super::blob_pending::Entity")]
    BlobPending,
    #[sea_orm(has_many = "super::file_revision::Entity")]
    FileRevision,
    #[sea_orm(has_many = "super::forum_post_lock::Entity")]
    ForumPostLock,
    #[sea_orm(has_many = "super::forum_post_revision::Entity")]
    ForumPostRevision,
    #[sea_orm(has_many = "super::forum_thread_lock::Entity")]
    ForumThreadLock,
    #[sea_orm(has_many = "super::message::Entity")]
    Message,
    #[sea_orm(has_many = "super::message_draft::Entity")]
    MessageDraft,
    #[sea_orm(has_many = "super::message_recipient::Entity")]
    MessageRecipient,
    #[sea_orm(has_many = "super::message_record::Entity")]
    MessageRecord,
    #[sea_orm(has_many = "super::page_lock::Entity")]
    PageLock,
    #[sea_orm(has_many = "super::page_revision::Entity")]
    PageRevision,
    #[sea_orm(has_many = "super::session::Entity")]
    Session,
    #[sea_orm(has_one = "super::user::Entity")]
    User,
    #[sea_orm(has_one = "super::wikidot_user::Entity")]
    WikidotUser,
}

impl Related<super::alias::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Alias.def()
    }
}

impl Related<super::authorization_token::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::AuthorizationToken.def()
    }
}

impl Related<super::blob_blacklist::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::BlobBlacklist.def()
    }
}

impl Related<super::blob_pending::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::BlobPending.def()
    }
}

impl Related<super::file_revision::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::FileRevision.def()
    }
}

impl Related<super::forum_post_lock::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumPostLock.def()
    }
}

impl Related<super::forum_post_revision::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumPostRevision.def()
    }
}

impl Related<super::forum_thread_lock::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ForumThreadLock.def()
    }
}

impl Related<super::message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Message.def()
    }
}

impl Related<super::message_draft::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MessageDraft.def()
    }
}

impl Related<super::message_recipient::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MessageRecipient.def()
    }
}

impl Related<super::message_record::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::MessageRecord.def()
    }
}

impl Related<super::page_lock::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageLock.def()
    }
}

impl Related<super::page_revision::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::PageRevision.def()
    }
}

impl Related<super::session::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Session.def()
    }
}

impl Related<super::user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::User.def()
    }
}

impl Related<super::wikidot_user::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::WikidotUser.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

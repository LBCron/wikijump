use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq, Serialize, Deserialize)]
#[sea_orm(table_name = "session")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub session_token: String,
    pub user_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: TimeDateTimeWithTimeZone,
    #[sea_orm(column_type = "Inet")]
    #[serde(with = "ip_network_serde")]
    pub ip_address: IpNetwork,
    #[sea_orm(column_type = "Text")]
    pub user_agent: String,
    pub restricted: bool,
    #[serde(skip)]
    pub mfa_failed_attempts: i32,
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

mod ip_network_serde {
    use sea_orm::prelude::IpNetwork;
    use serde::{Deserialize, Deserializer, Serializer};
    use std::net::IpAddr;
    use std::str::FromStr;

    pub fn serialize<S>(value: &IpNetwork, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.ip().to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<IpNetwork, D::Error>
    where
        D: Deserializer<'de>,
    {
        let text = String::deserialize(deserializer)?;
        if let Ok(ip) = IpAddr::from_str(&text) {
            return Ok(IpNetwork::from(ip));
        }
        IpNetwork::from_str(&text).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use sea_orm::prelude::IpNetwork;
    use serde::{Deserialize, Serialize};
    use std::net::{IpAddr, Ipv4Addr};

    #[derive(Serialize, Deserialize)]
    struct IpWrap {
        #[serde(with = "super::ip_network_serde")]
        ip_address: IpNetwork,
    }

    #[test]
    fn ip_network_serde_uses_plain_address() {
        let wrap = IpWrap {
            ip_address: IpNetwork::from(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10))),
        };
        let json = serde_json::to_string(&wrap).expect("serialize");
        assert_eq!(json, "{\"ip_address\":\"127.0.0.10\"}");
        let back: IpWrap = serde_json::from_str(&json).expect("deserialize plain");
        assert_eq!(
            back.ip_address.ip(),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10))
        );
        let cidr: IpWrap = serde_json::from_str("{\"ip_address\":\"127.0.0.10/32\"}")
            .expect("deserialize cidr");
        assert_eq!(
            cidr.ip_address.ip(),
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10))
        );
    }
}

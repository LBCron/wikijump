/*
 * services/caddy/structs.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

use sea_orm::FromQueryResult;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

#[derive(Deserialize, Clone)]
pub struct CaddyfileOptions<'a> {
    #[serde(default)]
    pub debug: bool,

    #[serde(default)]
    pub local: bool,

    #[serde(default)]
    pub http_port: Option<u16>,

    #[serde(default)]
    pub https_port: Option<u16>,

    #[serde(default)]
    pub wildcard_cert: Option<Cow<'a, str>>,

    #[serde(default)]
    pub deploy_host: Option<Cow<'a, str>>,

    pub framerail_host: Cow<'a, str>,

    pub wws_host: Cow<'a, str>,
}

impl fmt::Debug for CaddyfileOptions<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CaddyfileOptions")
            .field("debug", &self.debug)
            .field("local", &self.local)
            .field("http_port", &self.http_port)
            .field("https_port", &self.https_port)
            .field(
                "wildcard_cert",
                &self.wildcard_cert.as_ref().map(|_| "[redacted]"),
            )
            .field("deploy_host", &self.deploy_host)
            .field("framerail_host", &self.framerail_host)
            .field("wws_host", &self.wws_host)
            .finish()
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct SiteData {
    pub sites: Vec<(i64, String, Option<String>)>,
    pub domains: HashMap<i64, SiteDomainData>,
}

#[derive(Deserialize, Debug, Default, Clone)]
pub struct SiteDomainData {
    pub aliases: Vec<String>,
    pub custom_domains: Vec<CustomDomainData>,
}

#[derive(Deserialize, FromQueryResult, Debug, Default, Clone)]
pub struct CustomDomainData {
    pub domain: String,
    pub www_redirect: bool,
}

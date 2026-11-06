/*
 * cache.rs
 *
 * Wilson's Web Server - Serves a zoo of user-generated content
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

use crate::error::Result;
use redis::{AsyncCommands, AsyncConnectionConfig};
use std::future::Future;
use std::time::Duration;

const REDIS_TIMEOUT: Duration = Duration::from_secs(5);

pub const AVATAR_CACHE_TTL: Duration = Duration::from_secs(60);

pub const SITE_DOMAIN_CACHE_TTL: Duration = Duration::from_secs(60);

fn connection_config() -> AsyncConnectionConfig {
    AsyncConnectionConfig::new()
        .set_connection_timeout(Some(REDIS_TIMEOUT))
        .set_response_timeout(Some(REDIS_TIMEOUT))
}

macro_rules! get_connection {
    ($client:expr) => {
        $client
            .get_multiplexed_async_connection_with_config(&connection_config())
            .await?
    };
}

fn site_domain_key(site_id: i64) -> String {
    format!("site_domain:{site_id}")
}

fn user_avatar_key(user_id: i64) -> String {
    format!("user_avatar:{user_id}")
}

#[derive(Debug)]
pub struct Cache {
    client: redis::Client,
}

impl Cache {
    pub fn connect(redis_url: &str) -> Result<Self> {
        let client = redis::Client::open(redis_url)?;
        Ok(Cache { client })
    }

    pub async fn get_or_fetch_site_domain<F, Fut>(
        &self,
        site_id: i64,
        fetch: F,
    ) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String>>,
    {
        let mut conn = get_connection!(self.client);
        read_through_site_domain(&mut conn, site_id, fetch).await
    }

    pub async fn get_avatar(&self, user_id: i64) -> Result<Option<String>> {
        let mut conn = get_connection!(self.client);
        let key = user_avatar_key(user_id);
        Ok(conn.get(key).await?)
    }

    pub async fn set_avatar(&self, user_id: i64, avatar_s3_hash: &str) -> Result<()> {
        let mut conn = get_connection!(self.client);
        let key = user_avatar_key(user_id);
        conn.set_ex::<_, _, ()>(key, avatar_s3_hash, AVATAR_CACHE_TTL.as_secs())
            .await?;
        Ok(())
    }
}

async fn read_site_domain<C: AsyncCommands>(
    conn: &mut C,
    site_id: i64,
) -> Result<Option<String>> {
    let key = site_domain_key(site_id);
    Ok(conn.get(key).await?)
}

async fn write_site_domain<C: AsyncCommands>(
    conn: &mut C,
    site_id: i64,
    preferred_domain: &str,
) -> Result<()> {
    let key = site_domain_key(site_id);
    conn.set_ex::<_, _, ()>(key, preferred_domain, SITE_DOMAIN_CACHE_TTL.as_secs())
        .await?;
    Ok(())
}

async fn read_through_site_domain<C, F, Fut>(
    conn: &mut C,
    site_id: i64,
    fetch: F,
) -> Result<String>
where
    C: AsyncCommands,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String>>,
{
    if let Some(preferred_domain) = read_site_domain(conn, site_id).await? {
        return Ok(preferred_domain);
    }

    let preferred_domain = fetch().await?;
    write_site_domain(conn, site_id, &preferred_domain).await?;
    Ok(preferred_domain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use redis::aio::ConnectionLike;
    use redis::{
        Arg, Cmd, ErrorKind, Pipeline, RedisError, RedisFuture, RedisResult, Value,
    };
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    const SITE_ID: i64 = 42;

    #[derive(Clone, Debug, Default)]
    struct FakeValkey {
        state: Arc<Mutex<FakeState>>,
    }

    #[derive(Debug, Default)]
    struct FakeState {
        now: Duration,
        keys: HashMap<Vec<u8>, (Vec<u8>, Option<Duration>)>,
        commands: Vec<Vec<u8>>,
    }

    impl FakeValkey {
        fn advance(&self, by: Duration) {
            self.state.lock().unwrap().now += by;
        }

        fn commands(&self) -> Vec<String> {
            self.state
                .lock()
                .unwrap()
                .commands
                .iter()
                .map(|command| String::from_utf8_lossy(command).into_owned())
                .collect()
        }

        fn execute(&self, args: Vec<Vec<u8>>) -> RedisResult<Value> {
            let mut state = self.state.lock().unwrap();
            state.commands.push(args.join(&b' '));
            let now = state.now;
            let name = args[0].to_ascii_uppercase();
            match (name.as_slice(), args.len()) {
                (b"GET", 2) => {
                    let live = state
                        .keys
                        .get(&args[1])
                        .filter(|(_, expires_at)| expires_at.is_none_or(|at| now < at));
                    Ok(live.map_or(Value::Nil, |(value, _)| {
                        Value::BulkString(value.clone())
                    }))
                }
                (b"SETEX", 4) => {
                    // redis-rs `set_ex` sends `SETEX key seconds value`.
                    let seconds: u64 =
                        std::str::from_utf8(&args[2]).unwrap().parse().unwrap();
                    let expires_at = now + Duration::from_secs(seconds);
                    state
                        .keys
                        .insert(args[1].clone(), (args[3].clone(), Some(expires_at)));
                    Ok(Value::Okay)
                }
                _ => Err(RedisError::from((
                    ErrorKind::Client,
                    "FakeValkey implements only GET and SETEX",
                ))),
            }
        }
    }

    impl ConnectionLike for FakeValkey {
        fn req_packed_command<'a>(&'a mut self, cmd: &'a Cmd) -> RedisFuture<'a, Value> {
            let args = cmd
                .args_iter()
                .map(|arg| match arg {
                    Arg::Simple(bytes) => bytes.to_vec(),
                    _ => unreachable!("the cache issues only simple arguments"),
                })
                .collect();
            Box::pin(std::future::ready(self.execute(args)))
        }

        fn req_packed_commands<'a>(
            &'a mut self,
            _pipeline: &'a Pipeline,
            _offset: usize,
            _count: usize,
        ) -> RedisFuture<'a, Vec<Value>> {
            Box::pin(std::future::ready(Err(RedisError::from((
                ErrorKind::Client,
                "FakeValkey has no pipelines",
            )))))
        }

        fn get_db(&self) -> i64 {
            0
        }
    }

    #[derive(Clone, Debug)]
    struct FakeDeepwell {
        domain: Arc<Mutex<String>>,
        lookups: Arc<Mutex<usize>>,
    }

    impl FakeDeepwell {
        fn new(domain: &str) -> Self {
            Self {
                domain: Arc::new(Mutex::new(domain.to_owned())),
                lookups: Arc::default(),
            }
        }

        fn change_domain(&self, domain: &str) {
            *self.domain.lock().unwrap() = domain.to_owned();
        }

        fn lookups(&self) -> usize {
            *self.lookups.lock().unwrap()
        }

        async fn site_domain(&self) -> Result<String> {
            *self.lookups.lock().unwrap() += 1;
            Ok(self.domain.lock().unwrap().clone())
        }
    }

    async fn lookup(valkey: &FakeValkey, deepwell: &FakeDeepwell) -> String {
        let mut conn = valkey.clone();
        read_through_site_domain(&mut conn, SITE_ID, || deepwell.site_domain())
            .await
            .unwrap()
    }

    #[test]
    fn redis_keys_include_all_identifying_parts() {
        assert_eq!(site_domain_key(42), "site_domain:42");
        assert_eq!(user_avatar_key(7), "user_avatar:7");
    }

    #[test]
    fn cached_avatars_expire() {
        assert!(AVATAR_CACHE_TTL.as_secs() > 0);
        assert!(AVATAR_CACHE_TTL <= Duration::from_secs(300));
    }

    #[test]
    fn cache_connect_validates_redis_url() {
        assert!(Cache::connect("redis://127.0.0.1/").is_ok());
        assert!(Cache::connect("not a redis url").is_err());
    }

    #[test]
    fn cached_site_domains_expire() {
        assert!(SITE_DOMAIN_CACHE_TTL.as_secs() > 0);
        assert!(SITE_DOMAIN_CACHE_TTL <= Duration::from_secs(300));
    }

    #[tokio::test]
    async fn site_domain_entries_are_written_with_the_ttl() {
        let valkey = FakeValkey::default();
        let deepwell = FakeDeepwell::new("first.example");

        assert_eq!(lookup(&valkey, &deepwell).await, "first.example");

        assert_eq!(
            valkey.commands(),
            [
                "GET site_domain:42",
                "SETEX site_domain:42 60 first.example",
            ],
        );
    }

    #[tokio::test]
    async fn cached_site_domain_is_served_without_deepwell_within_the_ttl() {
        let valkey = FakeValkey::default();
        let deepwell = FakeDeepwell::new("first.example");
        assert_eq!(lookup(&valkey, &deepwell).await, "first.example");

        deepwell.change_domain("changed.example");
        valkey.advance(SITE_DOMAIN_CACHE_TTL - Duration::from_secs(1));

        assert_eq!(lookup(&valkey, &deepwell).await, "first.example");
        assert_eq!(deepwell.lookups(), 1);
    }

    #[tokio::test]
    async fn expired_site_domain_is_refetched_and_recached_with_a_fresh_ttl() {
        let valkey = FakeValkey::default();
        let deepwell = FakeDeepwell::new("first.example");
        assert_eq!(lookup(&valkey, &deepwell).await, "first.example");
        deepwell.change_domain("changed.example");

        valkey.advance(SITE_DOMAIN_CACHE_TTL - Duration::from_secs(1));
        assert_eq!(lookup(&valkey, &deepwell).await, "first.example");
        valkey.advance(Duration::from_secs(1));
        assert_eq!(lookup(&valkey, &deepwell).await, "changed.example");
        assert_eq!(deepwell.lookups(), 2);

        valkey.advance(SITE_DOMAIN_CACHE_TTL - Duration::from_secs(1));
        assert_eq!(lookup(&valkey, &deepwell).await, "changed.example");
        assert_eq!(deepwell.lookups(), 2);
        valkey.advance(Duration::from_secs(1));
        assert_eq!(lookup(&valkey, &deepwell).await, "changed.example");
        assert_eq!(deepwell.lookups(), 3);

        let writes: Vec<String> = valkey
            .commands()
            .into_iter()
            .filter(|command| command.starts_with("SETEX "))
            .collect();
        assert_eq!(
            writes,
            [
                "SETEX site_domain:42 60 first.example",
                "SETEX site_domain:42 60 changed.example",
                "SETEX site_domain:42 60 changed.example",
            ],
        );
    }

    #[tokio::test]
    async fn failed_site_domain_lookup_is_not_cached() {
        let valkey = FakeValkey::default();
        let mut conn = valkey.clone();
        let failed = read_through_site_domain(&mut conn, SITE_ID, || async {
            Err::<String, Error>(Error::DeepwellBusy)
        })
        .await;
        assert!(matches!(failed, Err(Error::DeepwellBusy)));
        assert_eq!(valkey.commands(), ["GET site_domain:42"]);

        let deepwell = FakeDeepwell::new("recovered.example");
        assert_eq!(lookup(&valkey, &deepwell).await, "recovered.example");
        assert_eq!(deepwell.lookups(), 1);
    }
}

//! Shared application state used by transport, services, and background work.

use crate::config::Config;
use crate::locales::Localizations;
use crate::middleware::RpcTokenDigest;
use crate::services::blob::MimeAnalyzer;
use crate::utils::debug_pointer;
use redis::aio::MultiplexedConnection as RedisMultiplexedConnection;
use reqwest::Client as ReqwestClient;
use rsmq_async::Rsmq;
use s3::bucket::Bucket;
use sea_orm::DatabaseConnection;
use std::fmt::{self, Debug};
use std::sync::Arc;
use tokio::sync::Semaphore;

pub type ServerState = Arc<ServerStateInner>;

pub struct ServerStateInner {
    pub config: Config,
    pub(crate) rpc_token_digest: RpcTokenDigest,
    pub database: DatabaseConnection,
    pub redis: RedisMultiplexedConnection,
    pub rsmq: Rsmq,
    pub localizations: Localizations,
    pub mime_analyzer: MimeAnalyzer,
    pub s3_files_bucket: Box<Bucket>,
    pub s3_tblocks_bucket: Box<Bucket>,
    pub mailcheck_api_client: ReqwestClient,
    /// Bounds the number of blocking renders in flight.
    ///
    /// A render takes a permit before it starts and moves it into the blocking
    /// closure, so an abandoned (timed-out) render keeps its slot until the
    /// thread actually finishes. The permit count comes from
    /// `[ftml] render-concurrency`.
    pub render_permits: Arc<Semaphore>,
}

impl Debug for ServerStateInner {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.debug_struct("ServerStateInner")
            .field("config", &self.config)
            .field("rpc_token_digest", &self.rpc_token_digest)
            .field("database", &self.database)
            .field("redis", &self.redis)
            .field("rsmq", &debug_pointer(&self.rsmq))
            .field("localizations", &self.localizations)
            .field("mime_analyzer", &self.mime_analyzer)
            .field("s3_files_bucket", &self.s3_files_bucket)
            .field("s3_tblocks_bucket", &self.s3_tblocks_bucket)
            .field("mailcheck_api_client", &self.mailcheck_api_client)
            .field("render_permits", &self.render_permits.available_permits())
            .finish()
    }
}

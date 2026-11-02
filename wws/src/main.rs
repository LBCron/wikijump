/*
 * main.rs
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

#[macro_use]
extern crate str_macro;

#[macro_use]
extern crate tracing;

#[macro_use]
mod macros;

mod attachment;
mod cache;
mod config;
mod deepwell;
mod error;
mod fetch;
mod handler;
mod info;
mod language;
mod path;
mod range;
mod route;
mod state;
mod trace;

use self::config::load_config;
use self::route::build_router;
use self::state::build_server_state;
use self::trace::setup_tracing;
use anyhow::Result;
use axum::extract::Request;
use axum::http::{StatusCode, header::CACHE_CONTROL};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use std::fs::File;
use std::io::Write;
use std::process;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<()> {
    let (config, secrets) = load_config();

    if config.enable_trace {
        setup_tracing();
    }

    if let Some(ref path) = config.pid_file {
        debug!(pid = process::id(), "Writing PID file");
        let mut file = File::create(path)?;
        writeln!(&mut file, "{}", process::id())?;
    }

    let state = build_server_state(false, secrets).await?;
    let ready = Arc::new(AtomicBool::new(!config.enable_deepwell_check));
    let gate = Arc::clone(&ready);
    let router = build_router(Arc::clone(&state)).layer(middleware::from_fn(
        move |request: Request, next: Next| {
            let gate = Arc::clone(&gate);
            async move {
                if gate.load(Ordering::Acquire) {
                    next.run(request).await
                } else {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        [(CACHE_CONTROL, "no-store")],
                        "Wikijump is starting\n",
                    )
                        .into_response()
                }
            }
        },
    ));
    let app = router.into_make_service();

    info!(
        address = str!(config.address),
        "Listening to connections...",
    );

    let listener = TcpListener::bind(config.address).await?;
    let initialization = tokio::spawn(async move {
        let mut backoff = Duration::from_millis(50);
        while !ready.load(Ordering::Acquire) {
            if state.deepwell.ping().await.is_ok() {
                ready.store(true, Ordering::Release);
                break;
            }
            let jitter = Duration::from_millis(u64::from(rand::random::<u8>()) % 50);
            tokio::time::sleep(backoff + jitter).await;
            backoff = (backoff * 2).min(Duration::from_millis(500));
        }
    });
    let result = axum::serve(listener, app).await;
    initialization.abort();
    result?;
    Ok(())
}

/*
 * services/blob/mime.rs
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

//! Evaluates MIME types and byte-derived content descriptors using libmagic.
//!
//! Because it is a binding to a C library, it cannot be shared among threads.
//! So we cannot use `LazyLock` and we can't have it in a coroutine.
//! We don't load the `Magic` instance locally because it's an expensive operation
//! and it would be inefficient to load it for each invocation.
//!
//! Instead we have it in a thread and ferry requests and responses back and forth.

use super::structs::{ContentAnalysis, ContentTypeDescriptor};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt, StdResult};
use filemagic::{FileMagicError, Flags as MagicFlags, Magic};
use std::thread;
use tokio::sync::{mpsc, oneshot};

type RequestPayload = (Vec<u8>, ResponseSender);
type ResponsePayload = StdResult<(String, String), FileMagicError>;

type RequestSender = mpsc::Sender<RequestPayload>;
type RequestReceiver = mpsc::Receiver<RequestPayload>;

type ResponseSender = oneshot::Sender<ResponsePayload>;
type ResponseReceiver = oneshot::Receiver<ResponsePayload>;

#[derive(Debug, Clone)]
pub struct MimeAnalyzer {
    sink: RequestSender,
}

impl MimeAnalyzer {
    pub fn spawn() -> Self {
        info!("Starting MIME analyzer worker");
        let (sink, source) = mpsc::channel(64);

        thread::spawn(|| {
            let mime_magic = Self::load_magic(MagicFlags::MIME)
                .expect("Unable to load MIME magic database");
            let descriptor_magic = Self::load_magic(MagicFlags::NONE)
                .expect("Unable to load descriptor magic database");
            Self::main_loop(mime_magic, descriptor_magic, source);
        });

        MimeAnalyzer { sink }
    }

    fn load_magic(flags: MagicFlags) -> Result<Magic> {
        const MAGIC_PATHS: &[&str] = &[];

        let make_error = || Error::new("failed to open magic database", ErrorType::Blob);

        info!("Loading magic database data");
        let magic = Magic::open(flags).or_raise(make_error)?;
        magic.load(MAGIC_PATHS).or_raise(make_error)?;
        Ok(magic)
    }

    fn main_loop(
        mime_magic: Magic,
        descriptor_magic: Magic,
        mut source: RequestReceiver,
    ) {
        while let Some((bytes, sender)) = source.blocking_recv() {
            debug!("Received content analysis request ({} bytes)", bytes.len());
            let result = mime_magic.buffer(&bytes).and_then(|mime| {
                descriptor_magic
                    .buffer(&bytes)
                    .map(|description| (mime, description))
            });
            sender.send(result).expect("Response channel is closed");
        }
    }

    pub(crate) async fn analyze(&self, buffer: Vec<u8>) -> Result<ContentAnalysis> {
        let buffer_len = buffer.len();
        let maybe_webp = is_webp(&buffer);
        info!("Sending content analysis request ({} bytes)", buffer_len);

        let (resp_send, resp_recv): (ResponseSender, ResponseReceiver) =
            oneshot::channel();

        self.sink
            .send((buffer, resp_send))
            .await
            .expect("MIME channel is closed");

        let resp = resp_recv.await.expect("Response channel is closed");
        let (mime, description) = resp.or_raise(|| {
            Error::new(
                format!("failed to analyze buffer of length {}", buffer_len,),
                ErrorType::Blob,
            )
        })?;

        // Older libmagic databases predate WebP and report its bytes as
        // `application/octet-stream` (8,786 such rows on Standing, #2067),
        // so correct that specific answer from the bytes themselves instead
        // of trusting the stale database. Answers the database does
        // recognize are left untouched.
        let mime = if mime.starts_with("application/octet-stream") && maybe_webp {
            str!("image/webp; charset=binary")
        } else {
            mime
        };

        let label = description
            .split_once(',')
            .map_or(description.as_str(), |(label, _)| label)
            .trim();
        if label.is_empty()
            || description.is_empty()
            || label.chars().any(|c| matches!(c, '\r' | '\n' | '\0'))
            || description.chars().any(|c| matches!(c, '\r' | '\n' | '\0'))
        {
            bail!(Error::new(
                "libmagic returned an invalid content descriptor",
                ErrorType::Blob,
            ));
        }

        Ok(ContentAnalysis {
            mime,
            content_type: ContentTypeDescriptor {
                label: label.to_owned(),
                description,
            },
        })
    }
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

#[test]
fn is_webp_detects_only_webp_chunks() {
    assert!(is_webp(b"RIFF\x1a\x00\x00\x00WEBPVP8 "));
    assert!(is_webp(b"RIFF\x00\x04\x00\x00WEBPVP8L"));
    assert!(!is_webp(b""));
    assert!(!is_webp(b"RIFF\x1a\x00"));
    assert!(!is_webp(b"RIFF\x1a\x00\x00\x00AVI "));
    assert!(!is_webp(b"WEBP\x1a\x00\x00\x00RIFF"));
}

#[tokio::test]
async fn mime_request() {
    const PNG: &[u8] = b"\x89\x50\x4e\x47\x0d\x0a\x1a\x0a\x00\x00\x00\x0d\x49\x48\x44\x52\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x04\x73\x42\x49\x54\x08\x08\x08\x08\x7c\x08\x64\x88\x00\x00\x00\x0b\x49\x44\x41\x54\x08\x99\x63\xf8\x0f\x04\x00\x09\xfb\x03\xfd\xe3\x55\xf2\x9c\x00\x00\x00\x00\x49\x45\x4e\x44\xae\x42\x60\x82";
    const TAR_GZIP: &[u8] =
        b"\x1f\x8b\x08\x08\xb1\xb7\x8f\x62\x00\x03\x78\x00\x03\x00\x00\x00\x00";

    let analyzer = MimeAnalyzer::spawn();

    macro_rules! check {
        ($bytes:expr, $expected:expr $(,)?) => {{
            let future = analyzer.analyze($bytes.to_vec());
            let actual = future.await.expect("Unable to analyze content").mime;

            assert_eq!(actual, $expected, "Actual MIME type doesn't match expected");
        }};
    }

    check!(b"", "application/x-empty; charset=binary");
    check!(b"Apple banana", "text/plain; charset=us-ascii");
    check!(PNG, "image/png; charset=binary");
    check!(TAR_GZIP, "application/gzip; charset=binary");
    const WEBP: &[u8] = b"RIFF\x1a\x00\x00\x00WEBPVP8 \x0c\x00\x00\x00\x9d\x01\x2a";
    check!(WEBP, "image/webp; charset=binary");

    let png = analyzer
        .analyze(PNG.to_vec())
        .await
        .expect("Unable to analyze PNG content");
    assert_eq!(
        png.content_type,
        ContentTypeDescriptor {
            label: str!("PNG image data"),
            description: str!("PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced"),
        },
    );
}

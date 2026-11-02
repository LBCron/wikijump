/*
 * services/render/list_pages/random_cache.rs
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

use std::borrow::Cow;

use redis::Script;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::super::url_arguments::UrlArguments;
use super::substitution::ListPagesArguments;
use super::template::ListPagesTemplatePlan;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::page_query::OrderProperty;

const RANDOM_LIST_PAGES_CACHE_PREFIX: &str = "listpages:random-order:v1";
const RANDOM_LIST_PAGES_IDLE_TTL_SECONDS: u64 = 60;
const RANDOM_LIST_PAGES_CACHE_SCRIPT: &str = r#"
local seed = redis.call('GET', KEYS[1])
if seed then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return seed
end
redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2])
return ARGV[2]
"#;

pub(in crate::services::render) async fn seed_random_list_pages_order(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    current_page_id: Option<i64>,
    url: UrlArguments<'_>,
    arguments: &mut ListPagesArguments,
    template: &ListPagesTemplatePlan,
) -> Result<()> {
    if !arguments
        .order
        .as_ref()
        .is_some_and(|order| matches!(&order.property, OrderProperty::Random))
    {
        return Ok(());
    }

    let page = url
        .page_for_prefix(arguments.url_attr_prefix.as_deref())
        .unwrap_or(1);
    let cache_key =
        random_order_cache_key(site_id, current_page_id, page, arguments, template);
    let candidate_seed = Uuid::new_v4().as_simple().to_string();
    let mut redis = ctx.redis();
    let seed = resolve_random_seed_cache_result(
        Script::new(RANDOM_LIST_PAGES_CACHE_SCRIPT)
            .key(&cache_key)
            .arg(RANDOM_LIST_PAGES_IDLE_TTL_SECONDS)
            .arg(candidate_seed)
            .invoke_async(&mut redis)
            .await,
    )?;

    arguments
        .order
        .as_mut()
        .expect("random order was checked above")
        .property = OrderProperty::SeededRandom(Cow::Owned(seed));
    Ok(())
}

fn resolve_random_seed_cache_result(
    result: redis::RedisResult<String>,
) -> Result<String> {
    result.or_raise(|| {
        Error::new(
            "failed to read or renew the random ListPages order cache",
            ErrorType::RedisQuery,
        )
    })
}

fn random_order_cache_key(
    site_id: i64,
    current_page_id: Option<i64>,
    page: u32,
    arguments: &ListPagesArguments,
    template: &ListPagesTemplatePlan,
) -> String {
    let mut digest = Sha256::new();
    hash_part(&mut digest, b"site", site_id.to_string().as_bytes());
    hash_optional_i64(&mut digest, b"current-page", current_page_id);
    hash_part(&mut digest, b"pager-page", page.to_string().as_bytes());

    hash_part(
        &mut digest,
        b"parsed-arguments",
        format!("{arguments:?}").as_bytes(),
    );
    hash_optional_str(&mut digest, b"template-head", template.head_section());
    hash_part(&mut digest, b"template-body", template.body().as_bytes());
    hash_optional_str(&mut digest, b"template-foot", template.foot_section());

    let body_hash = hex::encode(Sha256::digest(template.body().as_bytes()));
    format!(
        "{RANDOM_LIST_PAGES_CACHE_PREFIX}:body={body_hash}:invocation={}",
        hex::encode(digest.finalize()),
    )
}

fn hash_optional_i64(digest: &mut Sha256, label: &[u8], value: Option<i64>) {
    match value {
        Some(value) => hash_part(digest, label, format!("some:{value}").as_bytes()),
        None => hash_part(digest, label, b"none"),
    }
}

fn hash_optional_str(digest: &mut Sha256, label: &[u8], value: Option<&str>) {
    match value {
        Some(value) => {
            hash_part(digest, label, b"some");
            hash_part(digest, label, value.as_bytes());
        }
        None => hash_part(digest, label, b"none"),
    }
}

fn hash_part(digest: &mut Sha256, label: &[u8], value: &[u8]) {
    digest.update((label.len() as u64).to_be_bytes());
    digest.update(label);
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::render::list_pages::parse_list_pages_arguments;

    fn arguments() -> ListPagesArguments {
        parse_list_pages_arguments(
            r#" category="doc" order="random" limit="20" perPage="10""#,
        )
        .expect("test ListPages arguments should parse")
    }

    fn template(body: &str) -> ListPagesTemplatePlan {
        ListPagesTemplatePlan::compile(body).expect("test template should compile")
    }

    #[test]
    fn random_order_cache_key_binds_complete_invocation_and_pager_page() {
        let arguments = arguments();
        let body = template("%%fullname%%");
        let base = random_order_cache_key(1, Some(2), 1, &arguments, &body);

        assert_eq!(
            base,
            random_order_cache_key(1, Some(2), 1, &arguments, &body),
        );
        assert_ne!(
            base,
            random_order_cache_key(1, Some(2), 1, &arguments, &template("%%title%%")),
        );
        assert_ne!(
            base,
            random_order_cache_key(1, Some(3), 1, &arguments, &body),
        );
        assert_ne!(
            base,
            random_order_cache_key(1, Some(2), 2, &arguments, &body),
        );
        let different_arguments = parse_list_pages_arguments(
            r#" category="doc" order="random" limit="19" perPage="10""#,
        )
        .expect("different test ListPages arguments should parse");
        assert_ne!(
            base,
            random_order_cache_key(1, Some(2), 1, &different_arguments, &body),
        );
        assert!(
            base.contains(&format!(
                "body={}:",
                hex::encode(Sha256::digest(body.body().as_bytes())),
            )),
            "the opaque body fingerprint keeps TTL diagnostics attributable",
        );
    }

    #[test]
    fn random_order_cache_uses_the_observed_one_minute_idle_lifetime() {
        assert_eq!(RANDOM_LIST_PAGES_IDLE_TTL_SECONDS, 60);
        assert!(RANDOM_LIST_PAGES_CACHE_SCRIPT.contains("EXPIRE"));
        assert!(RANDOM_LIST_PAGES_CACHE_SCRIPT.contains("SETEX"));
    }

    #[test]
    fn redis_failures_remain_typed_and_fail_closed() {
        let redis_error = redis::RedisError::from((
            redis::ErrorKind::Io,
            "controlled random-cache failure",
        ));
        let error = resolve_random_seed_cache_result(Err(redis_error))
            .expect_err("a Redis failure must not silently choose an uncached order");

        assert_eq!(error.error_type, ErrorType::RedisQuery);
        assert_eq!(
            error.message,
            "failed to read or renew the random ListPages order cache",
        );
    }
}

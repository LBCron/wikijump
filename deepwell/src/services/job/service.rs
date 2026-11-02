/*
 * services/job/service.rs
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

use super::structs::Job;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::page_revision::RerenderType;
use crate::types::{PageId, RerenderDepth};
use rsmq_async::{Rsmq, RsmqConnection};
use std::time::Duration;

pub const JOB_QUEUE_NAME: &str = "job";

/// How long messages, after being delivered, cannot be delivered to another consumer.
///
/// This feature is a part of job queues to prevent a job from being run twice by
/// two different consumers. Because a job which fails won't report back to the queue,
/// so you cannot tell the difference between a job which is in progress vs a job that failed.
///
/// The way we resolve this is setting a time limit for "process time", which is the designated
/// period a job is allowed to run. If a job takes longer than that, then we assume it failed or
/// died. This risks a false positive of still-running jobs, but as long as this time is well
/// above what a job should take to run this risk is minimal.
pub const JOB_QUEUE_PROCESS_TIME: Option<Duration> = Some(Duration::from_secs(30));

pub const JOB_QUEUE_DELAY: Option<Duration> = None;

pub const JOB_QUEUE_MAXIMUM_SIZE: Option<i64> = Some(1024);

#[derive(Debug)]
pub struct JobService;

impl JobService {
    pub async fn queue_job(
        ctx: &ServiceContext<'_>,
        job: &Job,
        delay: Option<Duration>,
    ) -> Result<()> {
        let mut rsmq = ctx.rsmq();
        Self::queue_job_inner(&mut rsmq, job, delay).await
    }

    pub async fn queue_job_inner(
        rsmq: &mut Rsmq,
        job: &Job,
        delay: Option<Duration>,
    ) -> Result<()> {
        let job_kind = job.kind();
        let delay_seconds = delay.map(|duration| duration.as_secs());
        info!("Queuing job: kind={job_kind}, delay_seconds={delay_seconds:?}");

        let make_error = || {
            Error::new(
                format!(
                    "failed to queue job to RSMQ: kind={job_kind}, delay_seconds={delay_seconds:?}"
                ),
                ErrorType::Job,
            )
        };

        let payload = serde_json::to_vec(job).or_raise(make_error)?;
        rsmq.send_message(JOB_QUEUE_NAME, payload, delay)
            .await
            .or_raise(make_error)?;

        Ok(())
    }

    pub async fn queue_rerender_page(
        ctx: &ServiceContext<'_>,
        id: PageId,
        depth: RerenderDepth,
    ) -> Result<()> {
        debug!(
            "Queuing page rerender for page ID {} and site ID {}",
            id.page_id, id.site_id,
        );
        Self::queue_job(
            ctx,
            &Job::RerenderPage {
                id,
                depth,
                r#type: RerenderType::Full,
            },
            None,
        )
        .await
    }

    pub async fn queue_rerender_nav_page(
        ctx: &ServiceContext<'_>,
        id: PageId,
        depth: RerenderDepth,
    ) -> Result<()> {
        debug!(
            "Queuing page rerender for page ID {} and site ID {}",
            id.page_id, id.site_id,
        );
        Self::queue_job(
            ctx,
            &Job::RerenderPage {
                id,
                depth,
                r#type: RerenderType::NavigationOnly,
            },
            None,
        )
        .await
    }
}

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
use rsmq_async::{Rsmq, RsmqConnection};
use std::time::Duration;

pub const JOB_QUEUE_NAME: &str = "job";

pub const JOB_QUEUE_PROCESS_TIME: Option<Duration> = Some(Duration::from_secs(30));

pub const JOB_QUEUE_DELAY: Option<Duration> = None;

pub const JOB_QUEUE_MAXIMUM_SIZE: Option<i64> = Some(1024);

#[derive(Debug)]
pub struct JobService;

impl JobService {
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
}

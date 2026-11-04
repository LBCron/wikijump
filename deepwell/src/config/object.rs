/*
 * config/object.rs
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

use super::file::ConfigFile;
use crate::error::prelude::*;
use femme::LevelFilter;
use ftml::layout::Layout;
use std::env;
use std::net::SocketAddr;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::time::Duration as StdDuration;
use time::Duration as TimeDuration;

#[derive(Debug, Clone)]
pub struct Config {
    pub raw_toml: String,

    pub raw_toml_path: PathBuf,

    pub logger: bool,

    pub logger_level: LevelFilter,

    pub address: SocketAddr,

    pub pid_file: Option<PathBuf>,

    pub main_domain: String,

    pub main_domain_no_dot: String,

    pub https_port: u16,

    pub files_domain: String,

    pub files_domain_no_dot: String,

    pub watch_files: bool,

    pub run_seeder: bool,

    pub sqlx_logging: bool,

    pub seeder_path: PathBuf,

    pub localization_path: PathBuf,

    pub authentication_fail_delay: StdDuration,

    pub session_token_prefix: String,

    pub session_token_length: usize,

    pub normal_session_duration: TimeDuration,

    pub restricted_session_duration: TimeDuration,

    pub recovery_code_count: usize,

    pub recovery_code_length: usize,

    pub totp_digits: u32,

    pub totp_time_step: u64,

    pub totp_time_skew: i64,

    pub job_workers: NonZeroU16,

    pub job_max_attempts: u16,

    pub job_work_delay: StdDuration,

    pub job_min_poll_delay: StdDuration,

    pub job_max_poll_delay: StdDuration,

    pub job_prune_session: StdDuration,

    pub job_prune_uploads: StdDuration,

    pub job_prune_text: StdDuration,

    pub job_name_change_refill: StdDuration,

    pub job_lift_expired_punishments: StdDuration,

    pub preprocess_timeout: StdDuration,

    pub render_timeout: StdDuration,

    pub rerender_skip: Vec<(u32, Option<TimeDuration>)>,

    pub message_layout: Layout,

    pub default_page_layout: Layout,

    #[allow(dead_code)]
    pub blueprint_page_prefix: String,

    pub blueprint_page_template: String,

    pub blueprint_page_missing: String,

    pub blueprint_page_private: String,

    pub blueprint_page_banned: String,

    pub default_name_changes: i16,

    pub maximum_name_changes: i16,

    pub refill_name_change: Option<StdDuration>,

    pub minimum_name_bytes: usize,

    pub minimum_name_chars: usize,

    pub mock_mailcheck: bool,

    pub automation_email: String,

    pub notification_email: String,

    pub newsletter_email: String,

    pub presigned_path_length: usize,

    pub presigned_expiry_secs: u32,

    pub maximum_blob_size: i64,

    pub maximum_avatar_size: i64,

    pub maximum_message_subject_bytes: usize,

    pub maximum_message_body_bytes: usize,

    pub maximum_message_recipients: usize,
}

impl Config {
    #[inline]
    pub fn load(path: PathBuf) -> Result<Self> {
        let (config_file, extra) = ConfigFile::load(path).or_raise(|| {
            Error::new("failed to load configuration data", ErrorType::ConfigSetup)
        })?;

        let config = ConfigFile::into_config(config_file, extra);
        Ok(config)
    }

    pub fn public_authority(&self, host: &str) -> String {
        if self.https_port == 443 {
            str!(host)
        } else {
            format!("{host}:{}", self.https_port)
        }
    }

    pub fn operational_logger_level(&self) -> LevelFilter {
        match self.logger_level {
            LevelFilter::Trace => LevelFilter::Debug,
            level => level,
        }
    }

    pub fn log(&self) {
        #[inline]
        fn bool_str(value: bool) -> &'static str {
            if value { "enabled" } else { "disabled" }
        }

        info!("Configuration details:");
        info!(
            "Auto-restart on config change: {}",
            bool_str(self.watch_files),
        );
        info!("Seeder: {}", bool_str(self.run_seeder));
        info!("Localization path: {}", self.localization_path.display());
        info!("Seeder path: {}", self.seeder_path.display());
        info!(
            "Current working directory: {}",
            env::current_dir()
                .expect("Cannot get current working directory")
                .display(),
        );
    }

    pub fn integration_testing() -> Self {
        Config {
            raw_toml: str!("[[ BUILT-IN ]]"),
            raw_toml_path: PathBuf::from("/dev/null"),
            logger: true,
            logger_level: LevelFilter::Debug,
            address: "[::1]:2747".parse().unwrap(),
            pid_file: None,
            main_domain: str!(".wikijump.com"),
            main_domain_no_dot: str!("wikijump.com"),
            https_port: 443,
            files_domain: str!(".wjfiles.com"),
            files_domain_no_dot: str!("wjfiles.com"),
            watch_files: false,
            run_seeder: false,
            sqlx_logging: true,
            seeder_path: PathBuf::from("seeder"),
            localization_path: PathBuf::from("../locales"),
            authentication_fail_delay: StdDuration::from_millis(1),
            session_token_prefix: str!("wj:"),
            session_token_length: 64,
            normal_session_duration: time::Duration::minutes(30),
            restricted_session_duration: time::Duration::minutes(5),
            recovery_code_count: 4,
            recovery_code_length: 8,
            totp_digits: 6,
            totp_time_step: 30,
            totp_time_skew: 1,
            job_workers: NonZeroU16::new(2).unwrap(),
            job_max_attempts: 1,
            job_work_delay: StdDuration::from_millis(1),
            job_min_poll_delay: StdDuration::from_millis(1),
            job_max_poll_delay: StdDuration::from_millis(500),
            job_prune_session: StdDuration::from_secs(60),
            job_prune_uploads: StdDuration::from_secs(60),
            job_prune_text: StdDuration::from_secs(60),
            job_name_change_refill: StdDuration::from_secs(60),
            job_lift_expired_punishments: StdDuration::from_secs(60),
            preprocess_timeout: StdDuration::from_millis(1_000),
            render_timeout: StdDuration::from_millis(9_000),
            rerender_skip: vec![
                (1, Some(time::Duration::milliseconds(100))),
                (5, Some(time::Duration::milliseconds(500))),
                (10, None),
            ],
            message_layout: Layout::Wikijump,
            default_page_layout: Layout::Wikidot,
            blueprint_page_prefix: str!("_"),
            blueprint_page_template: str!("_template"),
            blueprint_page_missing: str!("_404"),
            blueprint_page_private: str!("_public"),
            blueprint_page_banned: str!("_ban"),
            default_name_changes: 2,
            maximum_name_changes: 2,
            refill_name_change: None,
            minimum_name_bytes: 4,
            minimum_name_chars: 2,
            mock_mailcheck: true,
            automation_email: str!("noreply@wikijump.com"),
            notification_email: str!("notifications@wikijump.com"),
            newsletter_email: str!("newsletter@wikijump.com"),
            presigned_path_length: 4,
            presigned_expiry_secs: 60,
            maximum_blob_size: 512 * 1024,
            maximum_avatar_size: 250 * 1024,
            maximum_message_subject_bytes: 128,
            maximum_message_body_bytes: 10_000,
            maximum_message_recipients: 3,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operational_logger_level_caps_trace_at_debug() {
        let mut config = Config::integration_testing();
        config.logger_level = LevelFilter::Trace;
        assert_eq!(config.operational_logger_level(), LevelFilter::Debug);

        config.logger_level = LevelFilter::Info;
        assert_eq!(config.operational_logger_level(), LevelFilter::Info);
    }
}

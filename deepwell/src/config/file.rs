/*
 * config/file.rs
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

use super::Config;
use crate::error::prelude::*;
use femme::LevelFilter;
use ftml::layout::Layout;
use std::convert::TryFrom;
use std::fs::File;
use std::io::Read;
use std::net::SocketAddr;
use std::num::NonZeroU16;
use std::path::PathBuf;
use std::time::Duration as StdDuration;
use time::Duration as TimeDuration;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
pub struct ConfigFile {
    logger: Logger,
    server: Server,
    database: Database,
    security: Security,
    locale: Locale,
    domain: Domain,
    job: Job,
    ftml: Ftml,
    blueprint: Blueprint,
    user: UserSection,
    email: Email,
    file: FileSection,
    message: Message,
}

#[derive(Debug, Clone)]
pub struct ExtraConfig {
    pub raw_toml: String,
    pub raw_toml_path: PathBuf,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Logger {
    enable: bool,
    level: LevelFilter,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Server {
    address: SocketAddr,
    pid_file: Option<PathBuf>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Database {
    run_seeder: bool,
    seeder_path: PathBuf,
    #[serde(default = "default_true")]
    sqlx_logging: bool,
    #[serde(default = "default_database_max_connections")]
    max_connections: u32,
    #[serde(default = "default_database_statement_cache_capacity")]
    statement_cache_capacity: u32,
    /// 0 disables the connection lifetime limit.
    #[serde(default)]
    max_lifetime_secs: u64,
}

fn default_database_max_connections() -> u32 {
    100
}

fn default_database_statement_cache_capacity() -> u32 {
    100
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Security {
    authentication_fail_delay_ms: u64,
    session: Session,
    mfa: Mfa,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Session {
    token_prefix: String,
    token_length: usize,
    duration_session_minutes: u64,
    duration_login_minutes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Mfa {
    recovery_code_count: usize,
    recovery_code_length: usize,
    mfa_digits: u32,
    time_step: u64,
    time_skew: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Job {
    workers: NonZeroU16,
    max_attempts: u16,
    delay_ms: u64,
    min_delay_poll_secs: u64,
    max_delay_poll_secs: u64,
    prune_session_secs: u64,
    prune_upload_secs: u64,
    prune_text_secs: u64,
    name_change_refill_secs: u64,
    lift_expired_punishments_secs: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Locale {
    path: PathBuf,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Domain {
    main: String,
    files: String,
    #[serde(default = "default_https_port")]
    https_port: u16,
}

fn default_https_port() -> u16 {
    443
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Ftml {
    preprocess_timeout_ms: u64,
    render_timeout_ms: u64,
    rerender_skip: Vec<RerenderSkip>,
    layout: FtmlLayout,
    /// Maximum number of blocking renders in flight. 512 is the Tokio
    /// blocking-pool default and therefore the behavior before the cap.
    #[serde(default = "default_render_concurrency")]
    render_concurrency: usize,
    /// How long a request may wait for a render slot before it fails with a
    /// retryable capacity error. This wait is outside the render timeout.
    #[serde(default = "default_render_queue_timeout_ms")]
    render_queue_timeout_ms: u64,
}

fn default_render_concurrency() -> usize {
    512
}

fn default_render_queue_timeout_ms() -> u64 {
    30_000
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct FtmlLayout {
    messages: Layout,
    default_page: Layout,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct RerenderSkip {
    job_depth: u32,
    last_update_ms: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Blueprint {
    template: String,
    missing: String,
    private: String,
    banned: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct UserSection {
    default_name_changes: u8,
    maximum_name_changes: u8,
    refill_name_change_days: u64,
    minimum_name_bytes: usize,
    minimum_name_chars: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Email {
    mock_mailcheck: bool,
    automation_address: String,
    notification_address: String,
    newsletter_address: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct FileSection {
    presigned_path_length: usize,
    presigned_expiration_minutes: u32,
    maximum_blob_size_kb: i64,
    maximum_avatar_size_kb: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct Message {
    maximum_subject_bytes: usize,
    maximum_body_bytes: usize,
    maximum_recipients: usize,
}

fn default_true() -> bool {
    true
}

impl ConfigFile {
    pub fn load(path: PathBuf) -> Result<(Self, ExtraConfig)> {
        let make_error = || {
            Error::new(
                format!("failed to read configuation file '{}'", path.display()),
                ErrorType::ConfigSetup,
            )
        };

        let mut file = File::open(&path).or_raise(make_error)?;
        let mut contents = String::new();
        file.read_to_string(&mut contents).or_raise(make_error)?;

        let config = toml::from_str(&contents).or_raise(make_error)?;
        let extra = ExtraConfig {
            raw_toml: contents,
            raw_toml_path: path,
        };

        Ok((config, extra))
    }

    pub fn into_config(self, extra: ExtraConfig) -> Config {
        macro_rules! time_duration {
            ($method:ident, $value:expr $(,)?) => {{
                let std_duration = StdDuration::$method($value);
                let time_duration = TimeDuration::try_from(std_duration)
                    .expect("Unable to convert from standard to time::Duration");

                time_duration
            }};
        }

        let ExtraConfig {
            raw_toml,
            raw_toml_path,
        } = extra;

        let ConfigFile {
            logger:
                Logger {
                    enable: logger,
                    level: logger_level,
                },
            server:
                Server {
                    address,
                    mut pid_file,
                },
            database:
                Database {
                    run_seeder,
                    seeder_path,
                    sqlx_logging,
                    max_connections: database_max_connections,
                    statement_cache_capacity: database_statement_cache_capacity,
                    max_lifetime_secs: database_max_lifetime_secs,
                },
            security:
                Security {
                    authentication_fail_delay_ms,
                    session:
                        Session {
                            token_prefix,
                            token_length,
                            duration_session_minutes,
                            duration_login_minutes,
                        },
                    mfa:
                        Mfa {
                            recovery_code_count,
                            recovery_code_length,
                            mfa_digits,
                            time_step,
                            time_skew,
                        },
                },
            domain:
                Domain {
                    main: main_domain,
                    files: files_domain,
                    https_port,
                },
            job:
                Job {
                    workers: job_workers,
                    max_attempts: job_max_attempts,
                    delay_ms: job_work_delay_ms,
                    min_delay_poll_secs: job_min_poll_delay_secs,
                    max_delay_poll_secs: job_max_poll_delay_secs,
                    prune_session_secs: job_prune_session_secs,
                    prune_upload_secs: job_prune_upload_secs,
                    prune_text_secs: job_prune_text_secs,
                    name_change_refill_secs: job_name_change_refill_secs,
                    lift_expired_punishments_secs: job_lift_expired_punishments_secs,
                },
            locale: Locale {
                path: localization_path,
            },
            ftml:
                Ftml {
                    preprocess_timeout_ms,
                    render_timeout_ms,
                    rerender_skip,
                    render_concurrency,
                    render_queue_timeout_ms,
                    layout:
                        FtmlLayout {
                            messages: message_layout,
                            default_page: default_page_layout,
                        },
                },
            blueprint:
                Blueprint {
                    template: blueprint_page_template,
                    missing: blueprint_page_missing,
                    private: blueprint_page_private,
                    banned: blueprint_page_banned,
                },
            user:
                UserSection {
                    default_name_changes,
                    maximum_name_changes,
                    refill_name_change_days,
                    minimum_name_bytes,
                    minimum_name_chars,
                },
            email:
                Email {
                    mock_mailcheck,
                    automation_address: automation_email,
                    notification_address: notification_email,
                    newsletter_address: newsletter_email,
                },
            file:
                FileSection {
                    presigned_path_length,
                    presigned_expiration_minutes,
                    maximum_blob_size_kb,
                    maximum_avatar_size_kb,
                },
            message:
                Message {
                    maximum_subject_bytes: maximum_message_subject_bytes,
                    maximum_body_bytes: maximum_message_body_bytes,
                    maximum_recipients: maximum_message_recipients,
                },
        } = self;

        const RSMQ_DELAY_LIMIT: u64 = 9999999;

        assert!(https_port != 0, "Public HTTPS port must not be zero");
        assert!(
            is_bare_hostname(&main_domain),
            "Main domain must be a bare hostname (set the port with https-port): {main_domain:?}",
        );
        assert!(
            is_bare_hostname(&files_domain),
            "Files domain must be a bare hostname (set the port with https-port): {files_domain:?}",
        );

        assert!(
            job_prune_session_secs < RSMQ_DELAY_LIMIT,
            "Session prune job period time too long",
        );
        assert!(
            job_prune_upload_secs < RSMQ_DELAY_LIMIT,
            "Pending upload prune job period time too long",
        );
        assert!(
            job_prune_text_secs < RSMQ_DELAY_LIMIT,
            "Text prune job period time too long",
        );
        assert!(
            job_name_change_refill_secs < RSMQ_DELAY_LIMIT,
            "Name change refill job period time too long",
        );
        assert!(
            job_lift_expired_punishments_secs < RSMQ_DELAY_LIMIT,
            "Expired punishment cleanup job period time too long",
        );

        let (main_domain, main_domain_no_dot) = prefix_domain(main_domain);
        let (files_domain, files_domain_no_dot) = prefix_domain(files_domain);

        if let Some(ref path) = pid_file
            && path.as_os_str().is_empty()
        {
            pid_file = None;
        }

        Config {
            raw_toml,
            raw_toml_path,
            logger,
            logger_level,
            address,
            pid_file,
            main_domain,
            main_domain_no_dot,
            https_port,
            files_domain,
            files_domain_no_dot,
            watch_files: false,
            run_seeder,
            seeder_path,
            sqlx_logging,
            database_max_connections,
            database_statement_cache_capacity,
            database_max_lifetime: if database_max_lifetime_secs == 0 {
                None
            } else {
                Some(StdDuration::from_secs(database_max_lifetime_secs))
            },
            localization_path,
            authentication_fail_delay: StdDuration::from_millis(
                authentication_fail_delay_ms,
            ),
            session_token_prefix: token_prefix,
            session_token_length: token_length,
            normal_session_duration: time_duration!(
                from_secs,
                duration_session_minutes * 60,
            ),
            restricted_session_duration: time_duration!(
                from_secs,
                duration_login_minutes * 60,
            ),
            recovery_code_count,
            recovery_code_length,
            totp_digits: mfa_digits,
            totp_time_step: time_step,
            totp_time_skew: time_skew,
            job_workers,
            job_max_attempts,
            job_work_delay: StdDuration::from_millis(job_work_delay_ms),
            job_min_poll_delay: StdDuration::from_secs(job_min_poll_delay_secs),
            job_max_poll_delay: StdDuration::from_secs(job_max_poll_delay_secs),
            job_prune_session: StdDuration::from_secs(job_prune_session_secs),
            job_prune_uploads: StdDuration::from_secs(job_prune_upload_secs),
            job_prune_text: StdDuration::from_secs(job_prune_text_secs),
            job_name_change_refill: StdDuration::from_secs(job_name_change_refill_secs),
            job_lift_expired_punishments: StdDuration::from_secs(
                job_lift_expired_punishments_secs,
            ),
            preprocess_timeout: StdDuration::from_millis(preprocess_timeout_ms),
            render_timeout: StdDuration::from_millis(render_timeout_ms),
            render_concurrency,
            render_queue_timeout: StdDuration::from_millis(render_queue_timeout_ms),
            rerender_skip: rerender_skip
                .iter()
                .map(
                    |&RerenderSkip {
                         job_depth,
                         last_update_ms,
                     }| {
                        (
                            job_depth,
                            match last_update_ms {
                                0 => None,
                                _ => Some(TimeDuration::milliseconds(i64::from(
                                    last_update_ms,
                                ))),
                            },
                        )
                    },
                )
                .collect(),
            message_layout,
            default_page_layout,
            blueprint_page_template,
            blueprint_page_missing,
            blueprint_page_private,
            blueprint_page_banned,
            default_name_changes: i16::from(default_name_changes),
            maximum_name_changes: i16::from(maximum_name_changes),
            refill_name_change: if refill_name_change_days == 0 {
                None
            } else {
                Some(StdDuration::from_secs(
                    refill_name_change_days * 24 * 60 * 60,
                ))
            },
            minimum_name_bytes,
            minimum_name_chars,
            mock_mailcheck,
            automation_email,
            notification_email,
            newsletter_email,
            presigned_path_length,
            presigned_expiry_secs: presigned_expiration_minutes * 60,
            maximum_blob_size: maximum_blob_size_kb * 1024,
            maximum_avatar_size: maximum_avatar_size_kb * 1024,
            maximum_message_subject_bytes,
            maximum_message_body_bytes,
            maximum_message_recipients,
        }
    }
}

fn is_bare_hostname(domain: &str) -> bool {
    let domain = domain.strip_prefix('.').unwrap_or(domain);
    !domain.is_empty()
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
}

#[test]
fn test_is_bare_hostname() {
    assert!(is_bare_hostname("wikijump.com"));
    assert!(is_bare_hostname(".wikijump.dev.localhost"));
    assert!(!is_bare_hostname("wikijump.localhost:18443"));
    assert!(!is_bare_hostname("https://wikijump.com"));
    assert!(!is_bare_hostname("wikijump..com"));
    assert!(!is_bare_hostname(""));
}

fn prefix_domain(domain: String) -> (String, String) {
    if domain.starts_with('.') {
        let mut no_dot = domain.clone();
        no_dot.remove(0);

        (domain, no_dot)
    } else {
        let dot_domain = format!(".{domain}");

        (dot_domain, domain)
    }
}

#[test]
fn test_prefix_domain() {
    macro_rules! check {
        ($input:expr; $output_1:expr, $output_2:expr $(,)?) => {{
            let (actual_1, actual_2) = prefix_domain(str!($input));

            assert_eq!(actual_1, $output_1, "Actual dot domain doesn't match");
            assert_eq!(actual_2, $output_2, "Actual no-dot domain doesn't match");
        }};
    }

    check!("example.com"; ".example.com", "example.com");
    check!(".example.com"; ".example.com", "example.com");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn sample_config_file() -> ConfigFile {
        ConfigFile {
            logger: Logger {
                enable: true,
                level: LevelFilter::Debug,
            },
            server: Server {
                address: "127.0.0.1:8080".parse().unwrap(),
                pid_file: Some(PathBuf::from("deepwell.pid")),
            },
            database: Database {
                run_seeder: true,
                seeder_path: PathBuf::from("seeder"),
                sqlx_logging: true,
                max_connections: 100,
                statement_cache_capacity: 100,
                max_lifetime_secs: 0,
            },
            security: Security {
                authentication_fail_delay_ms: 250,
                session: Session {
                    token_prefix: str!("wj:"),
                    token_length: 48,
                    duration_session_minutes: 30,
                    duration_login_minutes: 5,
                },
                mfa: Mfa {
                    recovery_code_count: 8,
                    recovery_code_length: 12,
                    mfa_digits: 6,
                    time_step: 30,
                    time_skew: -1,
                },
            },
            locale: Locale {
                path: PathBuf::from("../locales"),
            },
            domain: Domain {
                main: str!("wikijump.example"),
                files: str!(".files.example"),
                https_port: 443,
            },
            job: Job {
                workers: NonZeroU16::new(3).unwrap(),
                max_attempts: 4,
                delay_ms: 50,
                min_delay_poll_secs: 1,
                max_delay_poll_secs: 9,
                prune_session_secs: 60,
                prune_upload_secs: 70,
                prune_text_secs: 80,
                name_change_refill_secs: 90,
                lift_expired_punishments_secs: 100,
            },
            ftml: Ftml {
                preprocess_timeout_ms: 1_000,
                render_timeout_ms: 9_000,
                render_concurrency: 512,
                render_queue_timeout_ms: 30_000,
                rerender_skip: vec![
                    RerenderSkip {
                        job_depth: 2,
                        last_update_ms: 0,
                    },
                    RerenderSkip {
                        job_depth: 5,
                        last_update_ms: 250,
                    },
                ],
                layout: FtmlLayout {
                    messages: Layout::Wikijump,
                    default_page: Layout::Wikidot,
                },
            },
            blueprint: Blueprint {
                template: str!("_template"),
                missing: str!("_404"),
                private: str!("_public"),
                banned: str!("_ban"),
            },
            user: UserSection {
                default_name_changes: 2,
                maximum_name_changes: 5,
                refill_name_change_days: 7,
                minimum_name_bytes: 4,
                minimum_name_chars: 2,
            },
            email: Email {
                mock_mailcheck: true,
                automation_address: str!("noreply@example.com"),
                notification_address: str!("notifications@example.com"),
                newsletter_address: str!("newsletter@example.com"),
            },
            file: FileSection {
                presigned_path_length: 16,
                presigned_expiration_minutes: 3,
                maximum_blob_size_kb: 512,
                maximum_avatar_size_kb: 256,
            },
            message: Message {
                maximum_subject_bytes: 128,
                maximum_body_bytes: 10_000,
                maximum_recipients: 3,
            },
        }
    }

    fn extra_config() -> ExtraConfig {
        ExtraConfig {
            raw_toml: str!("raw"),
            raw_toml_path: PathBuf::from("/tmp/deepwell-test.toml"),
        }
    }

    #[test]
    fn load_reads_toml_and_preserves_raw_metadata() {
        let config_file = sample_config_file();
        let toml = toml::to_string(&config_file).unwrap();
        let path = env::temp_dir()
            .join(format!("deepwell-config-test-{}.toml", std::process::id(),));

        fs::write(&path, &toml).unwrap();
        let (_loaded, extra) = ConfigFile::load(path.clone()).unwrap();
        fs::remove_file(&path).unwrap();

        assert_eq!(extra.raw_toml, toml);
        assert_eq!(extra.raw_toml_path, path);
    }

    #[test]
    fn into_config_flattens_file_values() {
        let config = sample_config_file().into_config(extra_config());

        assert_eq!(config.raw_toml, "raw");
        assert_eq!(
            config.raw_toml_path,
            PathBuf::from("/tmp/deepwell-test.toml")
        );
        assert!(config.logger);
        assert_eq!(config.logger_level, LevelFilter::Debug);
        assert_eq!(
            config.address,
            "127.0.0.1:8080".parse::<SocketAddr>().unwrap(),
        );
        assert_eq!(config.pid_file, Some(PathBuf::from("deepwell.pid")));
        assert_eq!(config.main_domain, ".wikijump.example");
        assert_eq!(config.main_domain_no_dot, "wikijump.example");
        assert_eq!(config.https_port, 443);
        assert_eq!(config.files_domain, ".files.example");
        assert_eq!(config.files_domain_no_dot, "files.example");
        assert!(!config.watch_files);
        assert!(config.run_seeder);
        assert_eq!(config.seeder_path, PathBuf::from("seeder"));
        assert!(config.sqlx_logging);
        assert_eq!(config.localization_path, PathBuf::from("../locales"));
        assert_eq!(
            config.authentication_fail_delay,
            StdDuration::from_millis(250)
        );
        assert_eq!(config.session_token_prefix, "wj:");
        assert_eq!(config.session_token_length, 48);
        assert_eq!(config.normal_session_duration, TimeDuration::minutes(30));
        assert_eq!(config.restricted_session_duration, TimeDuration::minutes(5));
        assert_eq!(config.recovery_code_count, 8);
        assert_eq!(config.recovery_code_length, 12);
        assert_eq!(config.totp_digits, 6);
        assert_eq!(config.totp_time_step, 30);
        assert_eq!(config.totp_time_skew, -1);
        assert_eq!(config.job_workers, NonZeroU16::new(3).unwrap());
        assert_eq!(config.job_max_attempts, 4);
        assert_eq!(config.job_work_delay, StdDuration::from_millis(50));
        assert_eq!(config.job_min_poll_delay, StdDuration::from_secs(1));
        assert_eq!(config.job_max_poll_delay, StdDuration::from_secs(9));
        assert_eq!(config.job_prune_session, StdDuration::from_secs(60));
        assert_eq!(config.job_prune_uploads, StdDuration::from_secs(70));
        assert_eq!(config.job_prune_text, StdDuration::from_secs(80));
        assert_eq!(config.job_name_change_refill, StdDuration::from_secs(90));
        assert_eq!(
            config.job_lift_expired_punishments,
            StdDuration::from_secs(100),
        );
        assert_eq!(config.preprocess_timeout, StdDuration::from_millis(1_000));
        assert_eq!(config.render_timeout, StdDuration::from_millis(9_000));
        assert_eq!(
            config.rerender_skip,
            vec![(2, None), (5, Some(TimeDuration::milliseconds(250))),],
        );
        assert_eq!(config.message_layout, Layout::Wikijump);
        assert_eq!(config.default_page_layout, Layout::Wikidot);
        assert_eq!(config.blueprint_page_template, "_template");
        assert_eq!(config.blueprint_page_missing, "_404");
        assert_eq!(config.blueprint_page_private, "_public");
        assert_eq!(config.blueprint_page_banned, "_ban");
        assert_eq!(config.default_name_changes, 2);
        assert_eq!(config.maximum_name_changes, 5);
        assert_eq!(
            config.refill_name_change,
            Some(StdDuration::from_secs(7 * 24 * 60 * 60)),
        );
        assert_eq!(config.minimum_name_bytes, 4);
        assert_eq!(config.minimum_name_chars, 2);
        assert!(config.mock_mailcheck);
        assert_eq!(config.automation_email, "noreply@example.com");
        assert_eq!(config.notification_email, "notifications@example.com");
        assert_eq!(config.newsletter_email, "newsletter@example.com");
        assert_eq!(config.presigned_path_length, 16);
        assert_eq!(config.presigned_expiry_secs, 180);
        assert_eq!(config.maximum_blob_size, 512 * 1024);
        assert_eq!(config.maximum_avatar_size, 256 * 1024);
        assert_eq!(config.maximum_message_subject_bytes, 128);
        assert_eq!(config.maximum_message_body_bytes, 10_000);
        assert_eq!(config.maximum_message_recipients, 3);
    }

    #[test]
    fn database_sqlx_logging_defaults_true_and_accepts_false() {
        let toml = toml::to_string(&sample_config_file()).unwrap();

        let absent_toml = toml.replace("sqlx-logging = true\n", "");
        assert_ne!(toml, absent_toml);
        let absent_config: ConfigFile = toml::from_str(&absent_toml).unwrap();
        assert!(absent_config.database.sqlx_logging);

        let false_toml = toml.replace("sqlx-logging = true", "sqlx-logging = false");
        assert_ne!(toml, false_toml);
        let false_config: ConfigFile = toml::from_str(&false_toml).unwrap();
        assert!(!false_config.database.sqlx_logging);
    }

    #[test]
    fn ftml_render_cap_defaults_and_parses() {
        let toml = toml::to_string(&sample_config_file()).unwrap();

        let absent_toml = toml
            .replace("render-concurrency = 512\n", "")
            .replace("render-queue-timeout-ms = 30000\n", "");
        let absent_config: ConfigFile = toml::from_str(&absent_toml).unwrap();
        assert_eq!(absent_config.ftml.render_concurrency, 512);
        assert_eq!(absent_config.ftml.render_queue_timeout_ms, 30_000);

        let parsed_toml = toml
            .replace("render-concurrency = 512", "render-concurrency = 8")
            .replace(
                "render-queue-timeout-ms = 30000",
                "render-queue-timeout-ms = 10000",
            );
        let parsed_config: ConfigFile = toml::from_str(&parsed_toml).unwrap();
        let config = parsed_config.into_config(extra_config());
        assert_eq!(config.render_concurrency, 8);
        assert_eq!(
            config.render_queue_timeout,
            StdDuration::from_millis(10_000),
        );
    }

    #[test]
    fn database_pool_settings_default_and_parse() {
        let toml = toml::to_string(&sample_config_file()).unwrap();

        let absent_toml = toml
            .replace("max-connections = 100\n", "")
            .replace("statement-cache-capacity = 100\n", "")
            .replace("max-lifetime-secs = 0\n", "");
        let absent_config: ConfigFile = toml::from_str(&absent_toml).unwrap();
        assert_eq!(absent_config.database.max_connections, 100);
        assert_eq!(absent_config.database.statement_cache_capacity, 100);
        assert_eq!(absent_config.database.max_lifetime_secs, 0);

        let parsed_toml = toml
            .replace("max-connections = 100", "max-connections = 16")
            .replace(
                "statement-cache-capacity = 100",
                "statement-cache-capacity = 32",
            )
            .replace("max-lifetime-secs = 0", "max-lifetime-secs = 1800");
        let parsed_config: ConfigFile = toml::from_str(&parsed_toml).unwrap();
        let config = parsed_config.into_config(extra_config());
        assert_eq!(config.database_max_connections, 16);
        assert_eq!(config.database_statement_cache_capacity, 32);
        assert_eq!(
            config.database_max_lifetime,
            Some(StdDuration::from_secs(1800)),
        );
    }

    #[test]
    fn domain_https_port_defaults_to_standard_https_for_existing_configs() {
        let toml = toml::to_string(&sample_config_file()).unwrap();
        let without_https_port = toml.replace("https-port = 443\n", "");
        assert_ne!(toml, without_https_port);

        let config_file: ConfigFile = toml::from_str(&without_https_port).unwrap();
        assert_eq!(config_file.into_config(extra_config()).https_port, 443);
    }

    #[test]
    #[should_panic(expected = "set the port with https-port")]
    fn into_config_rejects_a_port_spelled_into_the_main_domain() {
        let mut config_file = sample_config_file();
        config_file.domain.main = str!("wikijump.localhost:18443");

        config_file.into_config(extra_config());
    }

    #[test]
    #[should_panic(expected = "set the port with https-port")]
    fn into_config_rejects_a_port_spelled_into_the_files_domain() {
        let mut config_file = sample_config_file();
        config_file.domain.files = str!("wjfiles.localhost:18443");

        config_file.into_config(extra_config());
    }

    #[test]
    fn into_config_preserves_custom_public_https_port() {
        let mut config_file = sample_config_file();
        config_file.domain.https_port = 18445;

        assert_eq!(config_file.into_config(extra_config()).https_port, 18445);
    }

    #[test]
    fn into_config_treats_empty_pid_file_and_zero_refill_as_none() {
        let mut config_file = sample_config_file();
        config_file.server.pid_file = Some(PathBuf::new());
        config_file.user.refill_name_change_days = 0;

        let config = config_file.into_config(extra_config());

        assert_eq!(config.pid_file, None);
        assert_eq!(config.refill_name_change, None);
    }

    #[test]
    #[should_panic(expected = "Session prune job period time too long")]
    fn into_config_rejects_rsmq_delay_over_limit() {
        let mut config_file = sample_config_file();
        config_file.job.prune_session_secs = 9_999_999;

        config_file.into_config(extra_config());
    }
}

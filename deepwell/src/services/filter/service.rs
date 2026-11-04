/*
 * services/filter/service.rs
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

use super::matcher::{FilterMatcher, FilterSummary};
use super::structs::{CreateFilter, FilterClass, FilterType};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::filter::{self, Entity as Filter, Model as FilterModel};
use crate::services::ServiceContext;
use crate::utils::now;
use paste::paste;
use regex::{Regex, RegexSet};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, ExprTrait, QueryFilter, Set,
};

#[derive(Debug)]
pub struct FilterService;

impl FilterService {
    pub async fn create(
        ctx: &ServiceContext<'_>,
        site_id: Option<i64>,
        CreateFilter {
            affects_user,
            affects_email,
            affects_page,
            affects_file,
            affects_forum,
            case_sensitive,
            mut regex,
            description,
        }: CreateFilter,
    ) -> Result<FilterModel> {
        let txn = ctx.transaction();

        info!("Creating filter with regex '{regex}' because '{description}'");

        let regex_2 = regex.clone();
        let make_error = || {
            Error::new(
                format!(
                    "failed to create filter with base regex pattern '{}': user {}, email {}, page {}, file {}, forum {}, case sensitive {}",
                    regex_2,
                    affects_user,
                    affects_email,
                    affects_page,
                    affects_file,
                    affects_forum,
                    case_sensitive,
                ),
                ErrorType::Filter,
            )
        };

        Self::check_conflicts(ctx, site_id, &regex, "create")
            .await
            .or_raise(make_error)?;

        if !case_sensitive {
            regex = str!(regex.trim_start_matches("(?i)"));
            regex.insert_str(0, "(?i)");
        }

        let _ = Regex::new(&regex).or_raise(|| {
            Error::new(
                format!("failed to create filter with regex pattern '{}'", regex),
                ErrorType::FilterRegexInvalid { regex: str!(regex) },
            )
        })?;

        let model = filter::ActiveModel {
            site_id: Set(site_id),
            affects_user: Set(affects_user),
            affects_email: Set(affects_email),
            affects_page: Set(affects_page),
            affects_file: Set(affects_file),
            affects_forum: Set(affects_forum),
            regex: Set(regex),
            description: Set(description),
            ..Default::default()
        };
        let filter = model.insert(txn).await.or_raise(make_error)?;
        Ok(filter)
    }

    pub async fn delete(ctx: &ServiceContext<'_>, filter_id: i64) -> Result<()> {
        info!("Deleting filter with ID {filter_id}");
        let txn = ctx.transaction();

        let make_error = || {
            Error::new(
                format!("failed to delete filter ID {}", filter_id),
                ErrorType::Filter,
            )
        };

        let filter = Self::get(ctx, filter_id).await.or_raise(make_error)?;

        if filter.deleted_at.is_some() {
            error!("Attempting to remove already-deleted filter");
            bail!(Error::new(
                format!("cannot delete filter ID {}, is already deleted", filter_id),
                ErrorType::FilterNotFound,
            ));
        }

        let model = filter::ActiveModel {
            filter_id: Set(filter_id),
            deleted_at: Set(Some(now())),
            ..Default::default()
        };
        model.update(txn).await.or_raise(make_error)?;
        Ok(())
    }

    pub async fn restore(
        ctx: &ServiceContext<'_>,
        filter_id: i64,
    ) -> Result<FilterModel> {
        let txn = ctx.transaction();

        info!("Undeleting filter with ID {filter_id}");

        let make_error = || {
            Error::new(
                format!("failed to restore (undelete) filter ID {}", filter_id),
                ErrorType::Filter,
            )
        };

        let filter = Self::get(ctx, filter_id).await?;
        if filter.deleted_at.is_none() {
            error!("Attempting to un-delete extant filter");
            bail!(Error::new(
                format!(
                    "cannot restore (undelete) filter ID {} that isn't deleted",
                    filter_id,
                ),
                ErrorType::FilterNotDeleted
            ));
        }

        Self::check_conflicts(ctx, filter.site_id, &filter.regex, "restore")
            .await
            .or_raise(make_error)?;

        let model = filter::ActiveModel {
            filter_id: Set(filter_id),
            deleted_at: Set(None),
            ..Default::default()
        };
        let filter = model.update(txn).await.or_raise(make_error)?;
        Ok(filter)
    }

    #[inline]
    pub async fn get(ctx: &ServiceContext<'_>, filter_id: i64) -> Result<FilterModel> {
        find_or_error!(Self::get_optional(ctx, filter_id), "filter", Filter)
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        filter_id: i64,
    ) -> Result<Option<FilterModel>> {
        let make_error = || {
            Error::new(
                format!("failed to get filter ID {}", filter_id),
                ErrorType::Filter,
            )
        };

        let txn = ctx.transaction();
        let filter = Filter::find_by_id(filter_id)
            .one(txn)
            .await
            .or_raise(make_error)?;

        Ok(filter)
    }

    pub async fn get_all(
        ctx: &ServiceContext<'_>,
        filter_class: FilterClass,
        filter_type: Option<FilterType>,
        deleted: Option<bool>,
    ) -> Result<Vec<FilterModel>> {
        let txn = ctx.transaction();

        let make_error = || {
            let mut message = format!("failed to get all {} ", filter_class.name());

            match deleted {
                Some(true) => message.push_str("deleted "),
                Some(false) => message.push_str("extant "),
                None => (),
            }

            message.push_str("filters ");

            if let Some(filter_type) = filter_type {
                str_write!(&mut message, "of type {:?} ", filter_type);
            }

            match filter_class {
                FilterClass::Platform => message.push_str("on the platform"),
                FilterClass::Site(site_id) => {
                    str_write!(&mut message, "on site ID {}", site_id)
                }
                FilterClass::PlatformAndSite(site_id) => {
                    str_write!(&mut message, "on the platform and on site ID {}", site_id)
                }
            }

            Error::new(message, ErrorType::Filter)
        };

        let filter_condition =
            filter_type.map(|filter_type| filter_type.into_column().eq(true));

        let deleted_condition = match deleted {
            Some(true) => Some(filter::Column::DeletedAt.is_not_null()),
            Some(false) => Some(filter::Column::DeletedAt.is_null()),
            None => None,
        };

        let filters = Filter::find()
            .filter(
                Condition::all()
                    .add(filter_class.to_condition())
                    .add_option(filter_condition)
                    .add_option(deleted_condition),
            )
            .all(txn)
            .await
            .or_raise(make_error)?;

        Ok(filters)
    }

    pub async fn get_matcher(
        ctx: &ServiceContext<'_>,
        filter_class: FilterClass,
        filter_type: FilterType,
    ) -> Result<FilterMatcher> {
        let make_error = || Error::new("failed to get filter matcher", ErrorType::Filter);

        let filters = Self::get_all(ctx, filter_class, Some(filter_type), Some(false))
            .await
            .or_raise(make_error)?;

        let mut regexes = Vec::new();
        let mut filter_data = Vec::new();

        for FilterModel {
            filter_id,
            regex,
            description,
            ..
        } in filters
        {
            filter_data.push(FilterSummary {
                filter_id,
                regex: str!(regex.as_str()),
                description,
            });
            regexes.push(regex);
        }

        let regex_set = RegexSet::new(regexes).or_raise(|| {
            Error::new(
                "invalid regular expression found in database",
                ErrorType::Filter,
            )
        })?;

        Ok(FilterMatcher::new(regex_set, filter_data))
    }

    async fn check_conflicts(
        ctx: &ServiceContext<'_>,
        site_id: Option<i64>,
        regex: &str,
        action: &str,
    ) -> Result<()> {
        let make_error = || {
            Error::new(
                format!(
                    "failed conflict check for filter '{}' for {:?}, cannot {}",
                    regex, site_id, action,
                ),
                ErrorType::Filter,
            )
        };

        let txn = ctx.transaction();
        let result = Filter::find()
            .filter(
                Condition::all()
                    .add(filter::Column::SiteId.eq(site_id))
                    .add(
                        filter::Column::Regex
                            .eq(regex)
                            .or(filter::Column::Regex.eq(format!("(?i){regex}"))),
                    )
                    .add(filter::Column::DeletedAt.is_null()),
            )
            .one(txn)
            .await
            .or_raise(make_error)?;

        match result {
            None => Ok(()),
            Some(_) => {
                error!(
                    "Filter '{}' for {:?} already exists, cannot {}",
                    regex, site_id, action,
                );
                bail!(Error::new(
                    format!(
                        "cannot {}, filter '{}' for {:?} already exists",
                        action, regex, site_id,
                    ),
                    ErrorType::FilterExists,
                ));
            }
        }
    }
}

/*
 * services/render/list_pages/substitution/date_selectors.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::parse_list_pages_comparison;
use crate::services::page_query::{
    ComparisonOperation, DateSelector, DateTimeResolution,
};

pub(in crate::services::render) fn parse_list_pages_date_selector(
    value: &str,
) -> Option<DateSelector> {
    let value = value.trim();
    let words = value.split_whitespace().collect::<Vec<_>>();
    if words.len() == 2 && words[0].eq_ignore_ascii_case("last") {
        return Some(DateSelector::FromPresent {
            start: subtract_wikidot_relative_time(
                time::OffsetDateTime::now_utc(),
                1,
                words[1],
            )?,
        });
    }
    if words.len() == 3
        && (words[0].eq_ignore_ascii_case("older")
            || words[0].eq_ignore_ascii_case("newer"))
        && words[1].eq_ignore_ascii_case("than")
    {
        let (amount, unit) = words[2]
            .parse()
            .map_or((1, words[2]), |amount| (amount, "day"));
        return Some(DateSelector::Span {
            timestamp: subtract_wikidot_relative_time(
                time::OffsetDateTime::now_utc(),
                amount,
                unit,
            )?,
            resolution: DateTimeResolution::Second,
            comparison: if words[0].eq_ignore_ascii_case("older") {
                ComparisonOperation::LessThan
            } else {
                ComparisonOperation::GreaterThan
            },
        });
    }
    if words.len() == 4
        && words[0].eq_ignore_ascii_case("older")
        && words[1].eq_ignore_ascii_case("than")
    {
        let amount = words[2].parse().ok()?;
        return Some(DateSelector::Span {
            timestamp: subtract_wikidot_relative_time(
                time::OffsetDateTime::now_utc(),
                amount,
                words[3],
            )?,
            resolution: DateTimeResolution::Second,
            comparison: ComparisonOperation::LessThan,
        });
    }
    if words.len() == 4
        && words[0].eq_ignore_ascii_case("newer")
        && words[1].eq_ignore_ascii_case("than")
    {
        let amount = words[2].parse().ok()?;
        return Some(DateSelector::Span {
            timestamp: subtract_wikidot_relative_time(
                time::OffsetDateTime::now_utc(),
                amount,
                words[3],
            )?,
            resolution: DateTimeResolution::Second,
            comparison: ComparisonOperation::GreaterThan,
        });
    }
    if words.len() == 3 && words[0].eq_ignore_ascii_case("last") {
        let amount = words[1].parse().ok()?;
        return Some(DateSelector::FromPresent {
            start: subtract_wikidot_relative_time(
                time::OffsetDateTime::now_utc(),
                amount,
                words[2],
            )?,
        });
    }

    let (comparison, date) = parse_list_pages_comparison(value);
    let parts = date.split('.').collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 2 {
        return None;
    }
    let year_text = parts[0].trim();
    if year_text.is_empty()
        || !year_text.bytes().all(|byte| byte.is_ascii_digit())
        || year_text == "0"
    {
        return None;
    }
    let year = year_text.parse::<i32>().ok()?;
    if year == 0 {
        return None;
    }
    let month_number = parts
        .get(1)
        .map_or(Some(1), |part| part.trim().parse::<u8>().ok())?;
    let month = time::Month::try_from(month_number).ok()?;
    let date = time::Date::from_calendar_date(year, month, 1).ok()?;
    let timestamp = date.with_time(time::Time::MIDNIGHT).assume_utc();
    let resolution = match parts.len() {
        1 => DateTimeResolution::Year,
        2 => DateTimeResolution::Month,
        _ => unreachable!(),
    };
    Some(DateSelector::Span {
        timestamp,
        resolution,
        comparison,
    })
}

fn subtract_wikidot_relative_time(
    timestamp: time::OffsetDateTime,
    amount: i64,
    unit: &str,
) -> Option<time::OffsetDateTime> {
    let unit = unit.trim_end_matches('s').to_ascii_lowercase();
    match unit.as_str() {
        "second" | "minute" | "hour" | "day" | "week" => {
            let seconds_per_unit = match unit.as_str() {
                "second" => 1,
                "minute" => 60,
                "hour" => 3_600,
                "day" => 86_400,
                "week" => 604_800,
                _ => unreachable!(),
            };
            let seconds = amount.checked_mul(seconds_per_unit)?;
            timestamp.checked_sub(time::Duration::seconds(seconds))
        }
        "month" | "year" => {
            let months = amount.checked_mul(if unit == "year" { 12 } else { 1 })?;
            let month_index = i64::from(timestamp.year())
                .checked_mul(12)?
                .checked_add(i64::from(u8::from(timestamp.month())) - 1)?
                .checked_sub(months)?;
            let year = i32::try_from(month_index.div_euclid(12)).ok()?;
            let month =
                time::Month::try_from((month_index.rem_euclid(12) + 1) as u8).ok()?;
            let day = timestamp.day().min(month.length(year));
            let date = time::Date::from_calendar_date(year, month, day).ok()?;
            Some(timestamp.replace_date(date))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(year: i32, month: time::Month, day: u8) -> time::OffsetDateTime {
        time::Date::from_calendar_date(year, month, day)
            .expect("test date should be valid")
            .with_time(time::Time::MIDNIGHT)
            .assume_utc()
    }

    #[test]
    fn relative_time_units_subtract_exactly() {
        let base = utc(2024, time::Month::March, 31);

        for (amount, unit, expected) in [
            (30, "seconds", base - time::Duration::seconds(30)),
            (2, "minutes", base - time::Duration::minutes(2)),
            (3, "hours", base - time::Duration::hours(3)),
            (2, "days", base - time::Duration::days(2)),
            (2, "weeks", base - time::Duration::weeks(2)),
        ] {
            assert_eq!(
                subtract_wikidot_relative_time(base, amount, unit),
                Some(expected),
                "{amount} {unit}",
            );
        }

        assert_eq!(
            subtract_wikidot_relative_time(base, 1, "month"),
            Some(utc(2024, time::Month::February, 29)),
        );
        assert_eq!(
            subtract_wikidot_relative_time(base, 1, "year"),
            Some(utc(2023, time::Month::March, 31)),
        );
        assert_eq!(
            subtract_wikidot_relative_time(base, 13, "months"),
            Some(utc(2023, time::Month::February, 28)),
        );

        assert_eq!(subtract_wikidot_relative_time(base, 1, "fortnight"), None,);
        assert_eq!(subtract_wikidot_relative_time(base, i64::MAX, "days"), None,);
    }
}

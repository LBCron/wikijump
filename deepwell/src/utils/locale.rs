/*
 * utils/locale.rs
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

use crate::error::prelude::*;
use unic_langid::LanguageIdentifier;

const WIKIDOT_JAPANESE_CORRECTIONS_LOCALE: &str = "ja-corrections";

pub const WIKIDOT_SITE_LANGUAGES: &[&str] = &[
    "en",
    "en-au-mate",
    "en-corrections",
    "en-pirate",
    "cn",
    "cn-tr",
    "da",
    "de",
    "es",
    "fr",
    "it",
    "ko",
    "pl",
    "pl-cyr",
    "ru",
    "sr",
    "ab",
    "af",
    "am",
    "ar",
    "au",
    "az",
    "be",
    "bg",
    "bk",
    "bn",
    "br",
    "bw",
    "ca",
    "cg",
    "co",
    "cs",
    "cu",
    "cy",
    "dd",
    "dn",
    "du",
    "el",
    "em",
    "eo",
    "et",
    "fa",
    "fi",
    "fy",
    "ga",
    "gf",
    "gl",
    "hb",
    "he",
    "hi",
    "hu",
    "hy",
    "id",
    "io",
    "is",
    "ja",
    "ja-corrections",
    "jc",
    "ka",
    "kb",
    "kf",
    "kk",
    "kn",
    "la",
    "lb",
    "lt",
    "mn",
    "mn-trad",
    "mr",
    "ms",
    "mt",
    "mx",
    "nb",
    "nl",
    "nr",
    "ns",
    "nt",
    "pg",
    "ph",
    "pt",
    "pt-br",
    "qa",
    "ql",
    "ro",
    "sh",
    "si",
    "sk",
    "ss",
    "st",
    "sv",
    "sw",
    "ta",
    "th",
    "tn",
    "tp",
    "tr",
    "ts",
    "tt",
    "tw",
    "uh",
    "uk",
    "vc",
    "ve",
    "vi",
    "vn",
    "xd",
    "xh",
    "za",
    "zh",
    "zh-joke",
    "zh-lan-br",
    "zh-new",
    "zh-note",
    "zh-sb",
    "zh-yue-hant-hk",
    "zu",
    "zy",
    "zy-cl",
    "zy-fq-cl",
    "zy-fq-cl-sp",
    "zy-tr",
];

pub fn locale_for_ftml(locale_str: &str) -> &str {
    match locale_str {
        "en-au-mate" | "en-corrections" | "en-pirate" => "en",
        "cn" | "cn-tr" | "co" | "hb" | "jc" | "tw" | "zh-joke" | "zh-lan-br"
        | "zh-new" | "zh-note" | "zh-sb" | "zh-yue-hant-hk" | "zy" | "zy-cl"
        | "zy-fq-cl" | "zy-fq-cl-sp" | "zy-tr" => "zh",
        "pl-cyr" => "pl",
        WIKIDOT_JAPANESE_CORRECTIONS_LOCALE => "ja",
        "au" => "en-AU",
        "mn-trad" => "mn",
        "ph" => "tl",
        "pt-br" => "pt-BR",
        "vn" => "vi",
        _ => locale_str,
    }
}

fn parse_locale_identifier(locale_str: &str) -> Option<LanguageIdentifier> {
    LanguageIdentifier::from_bytes(locale_for_ftml(locale_str).as_bytes()).ok()
}

pub fn validate_locale(locale_str: &str) -> Result<LanguageIdentifier> {
    parse_locale_identifier(locale_str).ok_or_raise(|| {
        Error::new(
            format!("failed to validate locale for '{locale_str}'"),
            ErrorType::LocaleInvalid {
                locale: str!(locale_str),
            },
        )
    })
}

pub fn validate_wikidot_site_language(locale_str: &str) -> Result<LanguageIdentifier> {
    if WIKIDOT_SITE_LANGUAGES.contains(&locale_str) {
        validate_locale(locale_str)
    } else {
        Err(Error::new(
            format!("'{locale_str}' is not available in Wikidot site settings"),
            ErrorType::LocaleInvalid {
                locale: str!(locale_str),
            },
        )
        .into())
    }
}

pub fn parse_locales<S: AsRef<str>>(
    locales_str: &[S],
) -> Result<Vec<LanguageIdentifier>> {
    let mut locales = Vec::with_capacity(locales_str.len());
    for locale_str in locales_str {
        let locale_str = locale_str.as_ref();
        let locale = parse_locale_identifier(locale_str).ok_or_raise(|| {
            Error::new(
                format!("failed to parse locale '{locale_str}'"),
                ErrorType::LocaleInvalid {
                    locale: str!(locale_str),
                },
            )
        })?;

        locales.push(locale);
    }

    Ok(locales)
}

#[test]
fn validate_locale_accepts_valid_locale() {
    let locale = validate_locale("en-US").unwrap();

    assert_eq!(locale.to_string(), "en-US");
}

#[test]
fn validate_locale_maps_wikidot_japanese_corrections_to_japanese() {
    let locale = validate_locale("ja-corrections").unwrap();

    assert_eq!(locale.to_string(), "ja");
}

#[test]
fn locale_for_ftml_preserves_standard_identifiers() {
    assert_eq!(locale_for_ftml("ja-corrections"), "ja");
    assert_eq!(locale_for_ftml("en-US"), "en-US");
}

#[test]
fn validate_locale_rejects_invalid_locale() {
    let error = validate_locale("not a locale").unwrap_err();

    assert!(error.to_string().contains("failed to validate locale"));
}

#[test]
fn parse_locales_accepts_empty_and_valid_locale_lists() {
    let empty: Vec<LanguageIdentifier> = parse_locales::<&str>(&[]).unwrap();
    assert!(empty.is_empty());

    let locales = parse_locales(&["en-US", "ja"]).unwrap();
    assert_eq!(
        locales.iter().map(ToString::to_string).collect::<Vec<_>>(),
        vec!["en-US", "ja"],
    );
}

#[test]
fn parse_locales_maps_wikidot_japanese_corrections_to_japanese() {
    let locales = parse_locales(&["ja-corrections", "en"]).unwrap();

    assert_eq!(
        locales.iter().map(ToString::to_string).collect::<Vec<_>>(),
        vec!["ja", "en"],
    );
}

#[test]
fn parse_locales_rejects_invalid_locale() {
    let error = parse_locales(&["en-US", "not a locale"]).unwrap_err();

    assert!(error.to_string().contains("failed to parse locale"));
}

#[test]
fn wikidot_site_language_allowlist_accepts_captured_values_only() {
    for locale in WIKIDOT_SITE_LANGUAGES {
        validate_wikidot_site_language(locale)
            .unwrap_or_else(|error| panic!("captured locale {locale} failed: {error}"));
    }
    assert!(validate_wikidot_site_language("en-US").is_err());
}

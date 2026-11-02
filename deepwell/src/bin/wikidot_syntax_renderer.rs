/*
 * wikidot_syntax_renderer.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use ftml::data::{PageInfo, ScoreValue};
use ftml::layout::Layout;
use ftml::render::Render;
use ftml::render::html::HtmlRender;
use ftml::settings::{WikitextMode, WikitextSettings};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::io::{self, BufRead, Write};

const INPUT_SCHEMA: &str = "wikijump_syntax_differential.syntax_case.v1";
const OUTPUT_SCHEMA: &str = "wikijump_syntax_differential.ftml_render_result.v1";

#[derive(Debug, Deserialize)]
struct SyntaxCase {
    schema: String,
    case_id: String,
    source: String,
    title: String,
    page_context: Option<PageContext>,
}

#[derive(Debug, Deserialize)]
struct PageContext {
    site: String,
    page: String,
}

#[derive(Debug, Serialize)]
struct Engine {
    name: &'static str,
    version: String,
    package_version: &'static str,
    git_commit: Option<&'static str>,
    layout: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Rendered,
    InputError,
}

#[derive(Debug, Serialize)]
struct RenderResult {
    schema: &'static str,
    case_id: Option<String>,
    status: Status,
    html: Option<String>,
    engine: Engine,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn engine() -> Engine {
    Engine {
        name: ftml::info::PKG_NAME,
        version: ftml::info::VERSION.as_str().to_owned(),
        package_version: ftml::info::PKG_VERSION,
        git_commit: ftml::info::GIT_COMMIT_HASH,
        layout: "wikidot",
    }
}

fn input_error(case_id: Option<String>, error: impl Into<String>) -> RenderResult {
    RenderResult {
        schema: OUTPUT_SCHEMA,
        case_id,
        status: Status::InputError,
        html: None,
        engine: engine(),
        error: Some(error.into()),
    }
}

fn page_info(title: String, context: Option<PageContext>) -> PageInfo<'static> {
    let context = context.unwrap_or_else(|| PageContext {
        site: "syntax-differential".to_owned(),
        page: String::new(),
    });
    PageInfo {
        page: Cow::Owned(context.page),
        category: None,
        site: Cow::Owned(context.site),
        title: Cow::Owned(title),
        alt_title: None,
        score: ScoreValue::Integer(0),
        tags: Vec::new(),
        language: Cow::Borrowed("en"),
    }
}

fn render_case(case: SyntaxCase) -> RenderResult {
    if case.schema != INPUT_SCHEMA {
        return input_error(
            Some(case.case_id),
            format!(
                "unsupported schema {:?}; expected {INPUT_SCHEMA:?}",
                case.schema
            ),
        );
    }
    let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
    let page_info = page_info(case.title, case.page_context);
    let mut source = case.source;
    ftml::preprocess_for_layout(&mut source, settings.layout);
    let tokens = ftml::tokenize(&source);
    let (tree, _) = ftml::parse(&tokens, &page_info, &settings).into();
    let html = HtmlRender.render(&tree, &page_info, &settings).body;
    RenderResult {
        schema: OUTPUT_SCHEMA,
        case_id: Some(case.case_id),
        status: Status::Rendered,
        html: Some(html),
        engine: engine(),
        error: None,
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let result = match line {
            Ok(line) => match serde_json::from_str::<SyntaxCase>(&line) {
                Ok(case) => render_case(case),
                Err(error) => input_error(None, error.to_string()),
            },
            Err(error) => input_error(None, error.to_string()),
        };
        serde_json::to_writer(&mut stdout, &result).map_err(io::Error::other)?;
        stdout.write_all(b"\n")?;
    }
    Ok(())
}

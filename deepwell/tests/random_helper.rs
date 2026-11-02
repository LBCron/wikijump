/*
 * tests/random_helper.rs
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

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::constants::SYSTEM_USER_ID;
use deepwell::license::License;
use deepwell::services::RequestContext;
use deepwell::services::category::CategoryService;
use deepwell::services::page::{CreatePage, DeletePage, PageService};
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::services::view::{
    GetPageView, GetPageViewOutput, PageRedirectKind, PageRoute, ViewService,
};
use deepwell::types::{Action, Permission, Reference, Resource, UserType};
use sea_orm::{ConnectionTrait, Statement, Value};
use std::collections::BTreeSet;
use uuid::Uuid;

fn helper_source(selector: &str) -> String {
    format!(
        "[[module ListPages {selector}]]\n[[include :snippets:redirect url=%%link%%]]\n[[/module]]\n",
    )
}

async fn create_page(
    runner: &TestRunner,
    site_id: i64,
    slug: &str,
    tags: Vec<&str>,
    wikitext: String,
) -> (i64, i64) {
    let created = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext,
            title: format!("Fixture {slug}"),
            alt_title: None,
            tags: tags.into_iter().map(str::to_owned).collect(),
            slug: slug.to_owned(),
            layout: Some(ftml::layout::Layout::Wikidot),
            revision_comments: String::from("create random helper fixture"),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture page should be created");
    (created.page_id, created.revision_id)
}

async fn helper_view(
    runner: &TestRunner,
    site_id: i64,
    session_token: &str,
    slug: &str,
    extra: &str,
) -> GetPageViewOutput {
    ViewService::page(
        runner.context(),
        GetPageView {
            site_id,
            session_token: Some(session_token.to_owned()),
            route: Some(PageRoute {
                slug: slug.to_owned(),
                extra: extra.to_owned(),
            }),
            locales: vec!["en".to_owned()],
        },
    )
    .await
    .expect("helper view should resolve")
}

fn redirect_target(view: GetPageViewOutput, slug: &str) -> Option<String> {
    match view {
        GetPageViewOutput::Found {
            redirect_page,
            redirect_kind,
            ..
        } => {
            if redirect_page.is_some() {
                assert_eq!(
                    redirect_kind,
                    Some(PageRedirectKind::RandomHelper),
                    "helper redirect for '{slug}' must carry the helper kind",
                );
            }
            redirect_page
        }
        _ => panic!("helper route '{slug}' must resolve to a page view"),
    }
}

async fn setup_fixture_site(runner: &mut TestRunner) -> (i64, String) {
    let nonce = Uuid::new_v4().as_simple().to_string();
    let site = SiteService::create(
        runner.context(),
        CreateSite {
            slug: format!("random-helper-{nonce}"),
            name: format!("Random helper {nonce}"),
            tagline: String::new(),
            description: String::from("random helper redirect fixture"),
            default_page: None,
            layout: None,
            license: License::CcBySa40,
            locale: String::from("en"),
            ip_address: common::IP_ADDRESS,
        },
        None,
    )
    .await
    .expect("fixture site should be created");
    let site_id = site.site_id;

    let viewer = UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Random helper viewer {nonce}"),
            email: format!("random-helper-viewer-{nonce}@email.com"),
            locales: vec![String::from("en")],
            password: String::from("random-helper-fixture-password"),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture viewer should be created");
    let viewer_role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: String::from("Random helper fixture viewer"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture viewer role should be created");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(viewer_role.role_id),
            new_permissions: vec![Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            }],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("viewer role should receive site-wide view permission");
    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            site_id,
            user_id: viewer.user_id,
            role_id: viewer_role.role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture viewer should receive the viewer role");

    let private_category_id =
        CategoryService::get_or_create(runner.context(), site_id, "priv")
            .await
            .expect("private category should be created")
            .category_id;
    let private_role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: String::from("Random helper private viewer"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("private viewer role should be created");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(private_role.role_id),
            new_permissions: vec![Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(private_category_id)),
                action: Action::View,
            }],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("role should receive category-scoped view permission");
    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            site_id,
            user_id: SYSTEM_USER_ID,
            role_id: private_role.role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture actor should receive the private viewer role");

    create_page(
        runner,
        site_id,
        "alpha-one",
        vec!["rt"],
        String::from("eligible one"),
    )
    .await;
    create_page(
        runner,
        site_id,
        "alpha-two",
        vec!["rt"],
        String::from("eligible two"),
    )
    .await;
    create_page(
        runner,
        site_id,
        "wrong-tag-page",
        vec!["other"],
        String::from("wrong tag"),
    )
    .await;
    create_page(
        runner,
        site_id,
        "priv:secret-page",
        vec!["rt", "onlypriv"],
        String::from("private"),
    )
    .await;
    create_page(
        runner,
        site_id,
        "unlisted:hidden-page",
        vec!["rt", "onlyun"],
        String::from("unlisted"),
    )
    .await;
    let (gone, gone_revision) = create_page(
        runner,
        site_id,
        "gone-page",
        vec!["rt", "onlygone"],
        String::from("deleted later"),
    )
    .await;
    PageService::delete(
        runner.context(),
        DeletePage {
            site_id,
            page: Reference::Id(gone),
            last_revision_id: gone_revision,
            revision_comments: String::from("delete random helper fixture"),
            user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture page should be deleted");

    create_page(
        runner,
        site_id,
        "random:helper-main",
        vec!["rt"],
        helper_source("category=\"* -unlisted\" order=\"random\" limit=\"1\" tag=\"rt\""),
    )
    .await;
    create_page(
        runner,
        site_id,
        "random:helper-onlypriv",
        vec![],
        helper_source("category=\"*\" order=\"random\" limit=\"1\" tag=\"onlypriv\""),
    )
    .await;
    create_page(
        runner,
        site_id,
        "random:helper-onlygone",
        vec![],
        helper_source("category=\"*\" order=\"random\" limit=\"1\" tag=\"onlygone\""),
    )
    .await;
    create_page(
        runner,
        site_id,
        "random:helper-empty",
        vec![],
        helper_source("category=\"*\" order=\"random\" limit=\"1\" tag=\"no-such-tag\""),
    )
    .await;
    create_page(
        runner,
        site_id,
        "random:helper-soleself",
        vec!["soleself"],
        helper_source("category=\"*\" order=\"random\" limit=\"1\" tag=\"soleself\""),
    )
    .await;

    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(viewer.user_id),
        site_id: Some(site_id),
        page_reference: None,
    });
    let session_token = SessionService::create(
        runner.context(),
        CreateSession {
            user_id: viewer.user_id,
            ip_address: common::IP_ADDRESS,
            user_agent: String::from("random helper fixture viewer"),
            restricted: false,
        },
    )
    .await
    .expect("fixture viewer session should be created");

    (site_id, session_token)
}

#[tokio::test]
async fn helper_redirects_stay_inside_the_eligible_set() {
    let mut runner = TestRunner::setup().await;
    let (site_id, session_token) = setup_fixture_site(&mut runner).await;

    let mut seen = BTreeSet::new();
    for _ in 0..40 {
        let target = redirect_target(
            helper_view(&runner, site_id, &session_token, "random:helper-main", "").await,
            "random:helper-main",
        )
        .expect("the helper route must redirect while eligible pages exist");
        assert!(
            target == "alpha-one" || target == "alpha-two",
            "helper must never select private, unlisted, wrong-tag, deleted, or holder pages, got '{target}'",
        );
        seen.insert(target);
    }
    assert_eq!(
        seen,
        BTreeSet::from(["alpha-one".to_owned(), "alpha-two".to_owned()]),
        "repeated selections must visit every eligible page, not one pinned row",
    );

    runner.teardown().await;
}

#[tokio::test]
async fn helper_redirect_fails_closed_without_eligible_targets() {
    let mut runner = TestRunner::setup().await;
    let (site_id, session_token) = setup_fixture_site(&mut runner).await;

    for slug in [
        "random:helper-onlypriv",
        "random:helper-onlygone",
        "random:helper-empty",
        "random:helper-soleself",
    ] {
        assert_eq!(
            redirect_target(
                helper_view(&runner, site_id, &session_token, slug, "").await,
                slug
            ),
            None,
            "helper '{slug}' must not redirect without an eligible target",
        );
    }

    runner.teardown().await;
}

#[tokio::test]
async fn helper_redirect_only_fires_on_the_bare_route() {
    let mut runner = TestRunner::setup().await;
    let (site_id, session_token) = setup_fixture_site(&mut runner).await;

    for extra in ["noredirect/true", "history"] {
        assert_eq!(
            redirect_target(
                helper_view(
                    &runner,
                    site_id,
                    &session_token,
                    "random:helper-main",
                    extra
                )
                .await,
                "random:helper-main",
            ),
            None,
            "helper with extra '{extra}' must render instead of redirecting",
        );
    }

    runner.teardown().await;
}

fn found_ids(view: GetPageViewOutput, slug: &str) -> (i64, i64) {
    match view {
        GetPageViewOutput::Found {
            page,
            page_revision,
            ..
        } => (page.page_id, page_revision.revision_id),
        _ => panic!("route '{slug}' must resolve to a page view"),
    }
}

async fn mark_imported(runner: &TestRunner, (page_id, revision_id): (i64, i64)) {
    let transaction = runner.context().transaction();
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE page SET from_wikidot = TRUE WHERE page_id = $1",
            [Value::from(page_id)],
        ))
        .await
        .expect("imported page provenance should be recorded");
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE page_revision SET from_wikidot = TRUE WHERE revision_id = $1",
            [Value::from(revision_id)],
        ))
        .await
        .expect("imported revision provenance should be recorded");
}

#[tokio::test]
async fn helper_redirects_when_the_page_is_imported_from_wikidot() {
    let mut runner = TestRunner::setup().await;
    let (site_id, session_token) = setup_fixture_site(&mut runner).await;

    let helper = found_ids(
        helper_view(&runner, site_id, &session_token, "random:helper-main", "").await,
        "random:helper-main",
    );
    mark_imported(&runner, helper).await;

    let mut seen = BTreeSet::new();
    for _ in 0..40 {
        let target = redirect_target(
            helper_view(&runner, site_id, &session_token, "random:helper-main", "").await,
            "random:helper-main",
        )
        .expect("an imported helper must redirect while eligible pages exist");
        assert!(
            target == "alpha-one" || target == "alpha-two",
            "imported helper must stay inside the eligible set, got '{target}'",
        );
        seen.insert(target);
    }
    assert_eq!(
        seen,
        BTreeSet::from(["alpha-one".to_owned(), "alpha-two".to_owned()]),
        "imported helper must visit every eligible page",
    );

    let plain = found_ids(
        helper_view(&runner, site_id, &session_token, "alpha-one", "").await,
        "alpha-one",
    );
    mark_imported(&runner, plain).await;
    assert_eq!(
        redirect_target(
            helper_view(&runner, site_id, &session_token, "alpha-one", "").await,
            "alpha-one",
        ),
        None,
        "an imported page without a redirect source must render",
    );

    runner.teardown().await;
}

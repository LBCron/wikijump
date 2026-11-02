/*
 * database/seeder/data.rs
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
use crate::types::{License, UserType};
use ftml::layout::Layout;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use time::Date;

#[derive(Debug)]
pub struct SeedData {
    pub users: Vec<User>,
    pub sites: Vec<Site>,
    pub pages: HashMap<String, Vec<Page>>,
    pub files: HashMap<String, HashMap<String, Vec<File>>>,
    pub filters: Vec<Filter>,
    pub roles: Vec<Role>,
}

impl SeedData {
    pub fn load(directory: &Path) -> Result<Self> {
        let make_error =
            || Error::new("failed to load seed data", ErrorType::DatabaseSeeder);

        let mut path: PathBuf = directory.join("filename");

        // Load user data
        let users: Vec<User> =
            Self::load_json(&mut path, "users").or_raise(make_error)?;

        // Load site data
        let sites: Vec<Site> =
            Self::load_json(&mut path, "sites").or_raise(make_error)?;

        // Load page data
        let mut site_pages: HashMap<String, Vec<Page>> =
            Self::load_json(&mut path, "pages").or_raise(make_error)?;

        for (site, pages) in &mut site_pages {
            // Verify that the site exists
            assert!(
                sites.iter().any(|s| &s.slug == site),
                "No site with slug {site}",
            );

            // Fetch wikitext from file
            for page in pages {
                page.wikitext = Self::load_wikitext(&mut path, &page.wikitext_filename)
                    .or_raise(make_error)?;
            }
        }

        // Load file data
        let files: HashMap<String, HashMap<String, Vec<File>>> =
            Self::load_json(&mut path, "files").or_raise(make_error)?;

        // Load filter data
        let filters: Vec<Filter> =
            Self::load_json(&mut path, "filters").or_raise(make_error)?;

        // Load roles template
        let roles: Vec<Role> =
            Self::load_json(&mut path, "roles").or_raise(make_error)?;

        // Build and return
        Ok(SeedData {
            users,
            sites,
            pages: site_pages,
            files,
            filters,
            roles,
        })
    }

    fn load_json<T>(path: &mut PathBuf, filename: &str) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let make_error = || Error::new("failed to load JSON", ErrorType::DatabaseSeeder);

        path.set_file_name(filename);
        path.set_extension("json");
        debug!("Loading JSON from {}", path.display());

        let mut file = fs::File::open(path).or_raise(make_error)?;
        let data = serde_json::from_reader(&mut file).or_raise(make_error)?;
        Ok(data)
    }

    fn load_wikitext(path: &mut PathBuf, filename: &Path) -> Result<String> {
        let make_error =
            || Error::new("failed to load wikitext", ErrorType::DatabaseSeeder);

        path.set_file_name(filename);
        path.set_extension("ftml");
        debug!("Loading wikitext from {}", path.display());

        let wikitext = fs::read_to_string(path).or_raise(make_error)?;
        Ok(wikitext)
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
pub struct User {
    pub id: i64,
    pub name: String,
    pub slug: String,
    pub email: String,

    #[serde(rename = "type")]
    pub user_type: UserType,
    pub password: Option<String>,
    pub locales: Vec<String>,
    pub real_name: Option<String>,
    pub gender: Option<String>,
    pub birthday: Option<Date>,
    pub location: Option<String>,
    pub biography: Option<String>,
    pub user_page: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
pub struct Site {
    pub slug: String,

    #[serde(default)]
    pub aliases: Vec<String>,

    #[serde(default)]
    pub domains: Vec<SiteDomain>,

    #[serde(default)]
    pub preferred_domain: Option<String>,
    pub name: String,
    pub tagline: String,
    pub description: String,

    #[serde(default)]
    pub default_page: Option<String>,
    pub layout: Option<Layout>,
    pub license: License,
    pub locale: String,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum SiteDomain {
    DomainOnly(String),
    WithRedirect {
        domain: String,

        #[serde(rename = "www-redirect", default = "default_true")]
        www_redirect: bool,
    },
}

impl SiteDomain {
    pub fn domain(&self) -> &str {
        match self {
            SiteDomain::DomainOnly(domain) => domain,
            SiteDomain::WithRedirect { domain, .. } => domain,
        }
    }

    pub fn into_fields(self) -> (String, bool) {
        match self {
            SiteDomain::DomainOnly(domain) => (domain, true),
            SiteDomain::WithRedirect {
                domain,
                www_redirect,
            } => (domain, www_redirect),
        }
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
pub struct Page {
    pub slug: String,
    pub title: String,

    #[serde(default)]
    pub alt_title: Option<String>,

    #[serde(default)]
    pub tags: Vec<String>,

    #[serde(default)]
    pub created_by: Option<i64>,

    #[serde(skip)]
    pub wikitext: String,

    #[serde(rename = "wikitext")]
    pub wikitext_filename: PathBuf,

    #[serde(default)]
    pub parents: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
pub struct Filter {
    pub regex: String,
    pub description: String,
    pub case_sensitive: bool,

    #[serde(rename = "site")]
    pub site_slug: Option<String>,

    #[serde(default)]
    pub user: bool,

    #[serde(default)]
    pub email: bool,

    #[serde(default)]
    pub page: bool,

    #[serde(default)]
    pub file: bool,

    #[serde(default)]
    pub forum: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
pub struct File {
    pub name: String,
    pub path: PathBuf,

    #[serde(default)]
    pub overwrite: Option<PathBuf>,

    #[serde(default)]
    pub deleted: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
pub struct Role {
    pub name: String,
    pub description: String,
    pub is_virtual: bool,
    pub parent_role: Option<String>,
    pub permissions: Vec<String>,
}

#[inline]
const fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::SeedData;
    use std::path::Path;

    #[test]
    fn default_template_contains_working_search_and_management_pages_and_renderable_join_guidance()
     {
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");
        let template_site = seed
            .sites
            .iter()
            .find(|site| site.slug == "template-en")
            .expect("default template site");
        assert_eq!(template_site.license, crate::types::License::Cc0);
        let pages = seed
            .pages
            .get("template-en")
            .expect("default template pages");

        let search = pages
            .iter()
            .find(|page| page.slug == "search:site")
            .expect("default search page");
        assert_eq!(
            search.wikitext.trim_end(),
            "[[module Search]]\n\n[!-- please do not remove or change this page if you want to keep the search function working --]"
        );

        let manage = pages
            .iter()
            .find(|page| page.slug == "admin:manage")
            .expect("default site manager page");
        assert_eq!(manage.wikitext.trim(), "[[module ManageSite]]");

        let list_all_pages = pages
            .iter()
            .find(|page| page.slug == "system:list-all-pages")
            .expect("default list-all-pages page");
        assert_eq!(list_all_pages.title, "List All Pages");
        // Frozen source: shared EN corpus capture run-20260816-100230,
        // entity 1c9408e8-ca66-4d9e-8913-122cbb9aca6b; payload SHA-256
        // e4e03500edf018fe7784750eaf8c78a3dbf408a0aa90bc55d0c6bb5fbfeab27a,
        // source file SHA-256 14da20ce7b6208b5552361e71a09d214c8b5823e00c4e603d797fcf1023549a5.
        assert_eq!(
            list_all_pages.wikitext,
            "[[module ListPages separate=\"@URL\" category=\"@URL|*\" order=\"@URL|title\" perPage=\"@URL|50\"]]\n%%title_linked%%\n[[/module]]"
        );
        for (site_slug, site_pages) in &seed.pages {
            if site_slug == "template-en" {
                continue;
            }
            assert!(
                !site_pages
                    .iter()
                    .any(|page| page.slug == "system:list-all-pages"),
                "the default-only inventory must not be seeded into {site_slug}",
            );
        }

        let join = pages
            .iter()
            .find(|page| page.slug == "system:join")
            .expect("default join page");
        assert!(!join.wikitext.contains("[[note]]"));
        assert!(!join.wikitext.contains("[[/note]]"));
        assert!(join.wikitext.contains("Site administrator"));
        assert!(join.wikitext.contains("[[[admin:manage|Site Manager]]]"));
        assert!(join.wikitext.contains("[[module MembershipApply]]"));
        assert!(join.wikitext.contains("[[module MembershipByPassword]]"));

        let start = pages
            .iter()
            .find(|page| page.slug == "start")
            .expect("default template homepage");
        assert!(
            start
                .wikitext
                .contains("effective license for this page is shown in its footer")
        );
        assert!(start.wikitext.contains("[[[admin:manage|Site Manager]]]"));
        assert!(!start.wikitext.contains("Creative Commons"));
    }

    fn find_module_open(rest: &str) -> Option<usize> {
        const NEEDLE: &[u8] = b"[[module";
        let bytes = rest.as_bytes();
        if bytes.len() < NEEDLE.len() {
            return None;
        }
        (0..=bytes.len() - NEEDLE.len())
            .find(|&i| bytes[i..i + NEEDLE.len()].eq_ignore_ascii_case(NEEDLE))
    }

    fn seeded_module_names(wikitext: &str) -> Vec<String> {
        let mut names = Vec::new();
        let mut rest = wikitext;
        while let Some(offset) = find_module_open(rest) {
            let mut after = &rest[offset + "[[module".len()..];
            // Only a whitespace boundary starts a module invocation.
            if !after.starts_with(|b: char| b.is_whitespace()) {
                rest = after;
                continue;
            }
            after = after.trim_start();
            let end = after
                .find(|b: char| !(b.is_ascii_alphanumeric() || b == '_'))
                .unwrap_or(after.len());
            if end > 0 {
                names.push(after[..end].to_ascii_lowercase());
            }
            rest = &after[end..];
        }
        names
    }

    #[test]
    fn www_platform_site_serves_new_site_system_page() {
        // Refs #2052: the canonical platform site must resolve /new-site as
        // the special system page whose source is [[module NewSite]], so
        // browsers receive the NewSite runtime state instead of missing-page
        // UI. Anonymous output is the retained Wikidot state; submission,
        // bootstrap, and redirect remain open lifecycle work tracked there.
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");
        let pages = seed.pages.get("www").expect("www platform pages");
        let new_site = pages
            .iter()
            .find(|page| page.slug == "new-site")
            .expect("www new-site system page");
        assert_eq!(new_site.wikitext.trim(), "[[module NewSite]]");
    }

    #[test]
    fn www_platform_pages_contain_only_owned_modules() {
        // Refs #2064: first-party platform pages must never ship module
        // syntax with no runtime owner. Owned here means a Deepwell runtime
        // expansion exists: PlatformActivity and PlatformSites render from
        // live instance state (platform_directory.rs), SearchAll renders the
        // frozen form/unavailable contract (search_feed.rs), and SearchUsers
        // renders through the account-module runtime (runtime_modules.rs).
        // Adding a module to these pages without an owner must fail here
        // instead of leaking raw [[module ...]] source to end users.
        const OWNED: &[&str] = &[
            "platformactivity",
            "platformsites",
            "searchall",
            "searchusers",
        ];
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");
        let pages = seed.pages.get("www").expect("www platform pages");
        for slug in ["platform:activity", "platform:sites", "platform:search"] {
            let page = pages
                .iter()
                .find(|page| page.slug == slug)
                .unwrap_or_else(|| panic!("www {slug} platform page"));
            let names = seeded_module_names(&page.wikitext);
            assert!(
                !names.is_empty(),
                "www {slug} must keep its advertised module content",
            );
            for name in names {
                assert!(
                    OWNED.contains(&name.as_str()),
                    "www {slug} ships module '{name}' with no runtime owner",
                );
            }
        }
    }

    #[test]
    fn scp_jp_seed_claims_only_its_local_development_domain() {
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");
        let site = seed
            .sites
            .iter()
            .find(|site| site.slug == "scp-jp")
            .expect("scp-jp seed site");
        let domains = site
            .domains
            .iter()
            .map(|domain| domain.domain())
            .collect::<Vec<_>>();

        assert_eq!(site.preferred_domain, None);
        assert_eq!(domains, ["scp-jp.localhost"]);
        assert!(!domains.contains(&"scp-jp.wikijump.dev"));
    }

    #[test]
    fn loads_reserved_scp_wiki_mirror_pages() {
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");
        let pages = seed.pages.get("scp-wiki").expect("scp-wiki pages");

        let scp_3922 = pages
            .iter()
            .find(|page| page.slug == "scp-3922")
            .expect("scp-3922 seed page");
        assert_eq!(scp_3922.title, "SCP-3922");
        // Full source tag set carried into the seed (Refs #2077).
        assert_eq!(
            scp_3922.tags,
            [
                "_cc",
                "_licensebox",
                "cinema",
                "electronic",
                "inscription",
                "media",
                "metafiction",
                "safe",
                "scp",
                "three-moons-initiative"
            ]
        );
        assert!(scp_3922.wikitext.contains("**Item #:** SCP-3922"));

        let scp_9506 = pages
            .iter()
            .find(|page| page.slug == "scp-9506")
            .expect("scp-9506 seed page");
        assert_eq!(scp_9506.title, "National Fog Safety Initiative");
        // Full source tag set carried into the seed (Refs #2077).
        assert_eq!(
            scp_9506.tags,
            [
                "airborne",
                "dystopian",
                "esoteric-class",
                "gaseous",
                "horror",
                "illustrated",
                "scp",
                "transfiguration",
                "uncontained",
                "_cc",
                "_cc4",
                "_licensebox"
            ]
        );
        assert!(scp_9506.wikitext.contains("National Fog Safety Initiative"));
        assert!(scp_9506.wikitext.contains("local--files/scp-9506/NFSI.png"));

        let theme_basalt = pages
            .iter()
            .find(|page| page.slug == "theme:basalt")
            .expect("theme:basalt seed page");
        assert_eq!(theme_basalt.tags, ["theme"]);

        let sidebar = pages
            .iter()
            .find(|page| page.slug == "nav:side")
            .expect("scp-wiki sidebar seed page");
        assert!(
            sidebar
                .wikitext
                .contains("local--files/nav:side/social-facebook.png")
        );
        assert!(
            sidebar
                .wikitext
                .contains("local--files/nav:side/icon-Discord-2023.png")
        );
        let sidebar_files = seed
            .files
            .get("scp-wiki")
            .and_then(|files| files.get("nav:side"))
            .expect("scp-wiki sidebar attachment seed");
        assert_eq!(sidebar_files.len(), 8);

        let component_betterfootnotes = pages
            .iter()
            .find(|page| page.slug == "component:betterfootnotes")
            .expect("component:betterfootnotes seed page");
        assert_eq!(component_betterfootnotes.tags, ["component"]);

        let page_index = |slug: &str| {
            pages
                .iter()
                .position(|page| page.slug == slug)
                .unwrap_or_else(|| panic!("missing seeded page {slug}"))
        };
        assert!(
            page_index("component:image-block-base")
                < page_index("component:image-block")
        );
        assert!(page_index("component:interwiki-style") < page_index("theme:basalt"));
        assert!(page_index("component:betterfootnotes") < page_index("theme:basalt"));
        assert!(page_index("component:acs-animation") < page_index("theme:basalt"));
        assert!(
            page_index("component:license-box-backend")
                < page_index("component:license-box")
        );
        assert!(
            page_index("component:license-box-end") < page_index("component:license-box")
        );
    }

    #[test]
    fn mirror_seed_prefers_source_pages_over_generic_seed_pages() {
        // Refs #2083: during mirror bootstrap a source-owned page from the
        // imported corpus takes precedence over a generic seed page with the
        // same slug. The scp-wiki mirror seed must therefore materialize the
        // source title, tags, and wikitext for every slug the source site
        // owns as a page, and must never reuse the generic seed file there.
        //
        // Source authority is the shared corpus (branch `en` == scp-wiki),
        // run-20261011-230158, status active for each slug below:
        // * system:join (entity ee8f6558-4ebc-471d-b293-cbc353250a59,
        //   payload sha256:2c466eb6, title "Join the Site", tags
        //   admin/policy, 15 KB custom membership guide with tabview);
        // * system:members (entity a51810aa-071c-4030-96db-f8c0a71c6606,
        //   payload sha256:5552baf0, title "Site Members", tags admin,
        //   custom "+ Acceptance" section with [[module WhoInvited]]);
        // * system:page-tags (entity 338ff32c-c525-46ff-acc7-f4a03c91df87,
        //   payload sha256:dfd444df, title "Page Tags", tags admin, 2.4 KB
        //   custom tag browser with TagCloud limit="2000").
        // system:recent-changes is source-owned too (entity
        // f9f2c958-e512-40d5-a9bc-5ccc753a53ce, payload sha256:3a601fe4),
        // but its source (`[[module SiteChanges]]`) is byte-equivalent to
        // the generic default, so sharing the generic seed file there is
        // source-consistent and intentionally retained.
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");

        let seed_page = |site: &str, slug: &str| {
            seed.pages
                .get(site)
                .unwrap_or_else(|| panic!("{site} seed pages"))
                .iter()
                .find(|page| page.slug == slug)
                .unwrap_or_else(|| panic!("{site} seed page {slug}"))
        };

        // Ownership table: (slug, source title, source tags, markers only
        // the source page carries, markers only the generic seed carries).
        // Every entry here is page-owned by the source site, so the mirror
        // seed must carry the source page, not the generic default.
        let source_owned = [
            (
                "system:join",
                "Join the Site",
                vec!["admin", "policy"],
                vec!["[[tabview]]", "Joining the Site", "Guide for Newcomers"],
                // NOTE: the source guide itself embeds [[module
                // MembershipApply]] inside its application tab, so only
                // the generic starter's instruction line and its
                // MembershipByPassword module discriminate here.
                vec!["Please customize this page", "MembershipByPassword"],
            ),
            (
                "system:members",
                "Site Members",
                vec!["admin"],
                vec!["+ Acceptance", "[[module WhoInvited]]"],
                vec!["+ Members:"],
            ),
            (
                "system:page-tags",
                "Page Tags",
                vec!["admin"],
                vec!["TagCloud limit=\"2000\"", "tag-list", "Tag Guide"],
                vec![],
            ),
        ];

        for (slug, expected_title, expected_tags, source_markers, generic_markers) in
            source_owned
        {
            let generic = seed_page("template-en", slug);
            let mirror = seed
                .pages
                .get("scp-wiki")
                .expect("scp-wiki pages")
                .iter()
                .find(|page| page.slug == slug)
                .unwrap_or_else(|| panic!("scp-wiki seed page {slug}"));

            // The mirror must not reuse the generic seed file for a
            // source-owned slug; it carries a mirror-specific source copy
            // (scp-*.ftml, mirroring the scp-topbar.ftml precedent).
            assert_ne!(
                mirror.wikitext_filename, generic.wikitext_filename,
                "mirror {slug} must not reuse the generic seed file",
            );
            assert!(
                mirror
                    .wikitext_filename
                    .to_string_lossy()
                    .starts_with("scp-"),
                "mirror {slug} must carry a mirror-specific source copy",
            );

            // Source title and tags win over the generic seed entry.
            assert_eq!(mirror.title, expected_title);
            let expected_tags: Vec<String> =
                expected_tags.into_iter().map(str::to_owned).collect();
            assert_eq!(mirror.tags, expected_tags);

            // Source content wins: source markers present, generic markers
            // absent.
            for marker in source_markers {
                assert!(
                    mirror.wikitext.contains(marker),
                    "mirror {slug} must carry source content ({marker})",
                );
            }
            for marker in generic_markers {
                assert!(
                    !mirror.wikitext.contains(marker),
                    "mirror {slug} must not fall back to generic seed content ({marker})",
                );
            }
            assert_ne!(
                mirror.wikitext, generic.wikitext,
                "mirror {slug} must differ from the generic seed page",
            );
        }

        // system:recent-changes documents the byte-equivalent exception: the
        // source page is `[[module SiteChanges]]`, so the shared generic
        // seed file already materializes the source content.
        let mirror_changes = seed_page("scp-wiki", "system:recent-changes");
        assert_eq!(mirror_changes.wikitext.trim(), "[[module SiteChanges]]");

        // Control: fresh native sites keep the generic defaults (#2066 owns
        // their presentation, not this precedence rule).
        for site in ["template-en", "www"] {
            let generic_join = seed_page(site, "system:join");
            assert_eq!(
                generic_join.wikitext_filename.to_string_lossy(),
                "join",
                "{site} must retain the generic join seed file",
            );
            assert!(
                generic_join.wikitext.contains("[[module MembershipApply]]"),
                "{site} must retain the generic join starter content",
            );
        }
    }

    #[test]
    fn mirror_seed_prefers_source_pages_for_scp_jp() {
        // Refs #2083: the scp-jp mirror seed must carry the source-owned
        // system pages the same way the scp-wiki seed does, so a fresh JP
        // mirror bootstrap includes them without a separate repair import.
        // Source authority is the shared corpus (branch `jp` == scp-jp),
        // run-xmlrpc-resume-jp-20260807-text-only-rate1, status active:
        // * system:join (title "SCP財団参加の手引き", tags jp/管理);
        // * system:members (title "サイトメンバー", tags jp/管理);
        // * system:page-tags (title "Page Tags", tags jp/管理).
        //
        // NOTE: this test pins the open JP-bootstrap gap and is expected
        // to fail until JP source seed content lands (the scp-jp seed
        // currently holds only `boundary-check`). Either mirror-specific
        // source copies (the scp-*.ftml precedent) or a checked-in
        // bootstrap import manifest closes it; do not weaken this test to
        // accept the generic seed there.
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");

        let source_owned = [
            (
                "system:join",
                "SCP財団参加の手引き",
                "**タイトル:** SCP財団参加の手引き",
            ),
            (
                "system:members",
                "サイトメンバー",
                "**タイトル:** サイトメンバー",
            ),
            ("system:page-tags", "Page Tags", "**タイトル:** Page Tags"),
        ];

        for (slug, expected_title, source_marker) in source_owned {
            let mirror = seed
                .pages
                .get("scp-jp")
                .expect("scp-jp pages")
                .iter()
                .find(|page| page.slug == slug)
                .unwrap_or_else(|| panic!("scp-jp seed page {slug}"));

            assert_eq!(mirror.title, expected_title);
            assert_eq!(mirror.tags, ["jp", "管理"]);
            assert!(
                mirror.wikitext.contains(source_marker),
                "scp-jp {slug} must carry the source page content",
            );
            assert!(
                !mirror.wikitext.contains("Please customize this page"),
                "scp-jp {slug} must not fall back to generic seed content",
            );
        }
    }

    #[test]
    fn editable_site_seeds_the_public_self_join_route() {
        let seeder_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("seeder");
        let seed = SeedData::load(&seeder_path).expect("seed data should load");
        let pages = seed
            .pages
            .get("scpaiueouiuiuiui")
            .expect("editable local site pages");
        let join = pages
            .iter()
            .find(|page| page.slug == "system:join")
            .expect("editable local site should expose its self-join route");

        assert_eq!(join.title, "Join this site");
        assert_eq!(join.wikitext.trim(), "[[module Join]]");

        let draft = pages
            .iter()
            .find(|page| page.slug == "corpus:scp-9506-draft")
            .expect("editable local site should expose the corpus draft fixture");
        assert_eq!(draft.tags, ["draft"]);
    }
}

import { Open43SettingsBrowserAdapter } from "./open43-settings-browser-adapter.mjs";
import {
  OPEN43_SETTINGS_ANALYTICS_CASE_IDS,
  OPEN43_SETTINGS_ADMIN_CASE_IDS,
  OPEN43_SETTINGS_BROWSER_CASE_IDS,
  OPEN43_SETTINGS_THEME_CASE_IDS,
  OPEN43_SETTINGS_TOOLBAR_CASE_IDS,
  verifyOpen43SettingsBrowserCase,
  verifyOpen43SettingsBrowserCleanup,
} from "./open43-settings-browser-candidate-contract.mjs";
import { Open43SettingsCandidateSession } from "./open43-settings-candidate-http.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { candidatePageOrigin } from "./standing-browser-parity-receipt.mjs";
import { sha256Value } from "./standing-browser-parity-util.mjs";

export {
  OPEN43_SETTINGS_ANALYTICS_CASE_IDS,
  OPEN43_SETTINGS_BROWSER_CASE_IDS,
  OPEN43_SETTINGS_THEME_CASE_IDS,
  OPEN43_SETTINGS_TOOLBAR_CASE_IDS,
} from "./open43-settings-browser-candidate-contract.mjs";

const SITE_SLUG = "scpaiueouiuiuiui";
const SITE_HOST = `${SITE_SLUG}.wikijump.localhost`;
const VIEWPORTS = Object.freeze([1280, 767, 479]);
const siteSettings = (site) => ({
  site_id: site.site_id,
  slug: site.slug,
  name: site.name,
  tagline: site.tagline,
  description: site.description,
  locale: site.locale,
  default_page: site.default_page,
  welcome_page: site.welcome_page,
  google_analytics_enabled: site.google_analytics_enabled,
  google_analytics_profile: site.google_analytics_profile,
  show_top_toolbar: site.show_top_toolbar,
  show_bottom_toolbar: site.show_bottom_toolbar,
});

const revisionBoundSiteSettings = (site) => ({
  ...siteSettings(site),
  settings_revision: site.settings_revision,
});

const categorySettings = (category) => ({
  category_id: category.category_id,
  slug: category.slug,
  theme_kind: category.theme_kind,
  theme_builtin_id: category.theme_builtin_id,
  theme_external_url: category.theme_external_url,
  theme_custom_css: category.theme_custom_css,
});

const generalValues = (site) => ({
  unixName: site.slug,
  name: site.name,
  subtitle: site.tagline,
  language: site.locale,
  description: site.description,
  default_page: site.default_page,
  welcome_page: site.welcome_page,
});

function temporal(pair, settled) {
  const capture = pair.capture;
  return {
    phase: settled ? capture.document.phase : capture.first_paint.document.phase,
    sequence: settled ? 2 : 1,
    input_url: capture.input_url,
    final_url: capture.final_url,
    navigation_status: capture.navigation_status,
    ...(settled ? { resource_completion: capture.document.resource_completion.status } : {}),
    artifact: settled ? capture.settled_viewport_screenshot : capture.first_paint.screenshot,
    counterpart_artifact_path: settled
      ? capture.first_paint.screenshot.path
      : capture.settled_viewport_screenshot.path,
    counterpart_artifact_sha256: settled
      ? capture.first_paint.screenshot.sha256
      : capture.settled_viewport_screenshot.sha256,
  };
}

function clientTransitionTemporal(pair, settled) {
  const capture = pair.client_transition_capture;
  if (capture === null || capture === undefined) throw new Error("client transition capture is missing");
  return {
    phase: settled ? "client_navigation_settled" : "client_navigation_immediate_observation",
    sequence: settled ? 2 : 1,
    input_url: capture.input_url,
    final_url: capture.final_url,
    navigation_status: capture.navigation_status,
    ...(settled ? { resource_completion: capture.document.resource_completion.status } : {}),
    artifact: settled ? capture.settled_viewport_screenshot : capture.first_paint.screenshot,
    counterpart_artifact_path: settled ? capture.first_paint.screenshot.path : capture.settled_viewport_screenshot.path,
    counterpart_artifact_sha256: settled ? capture.first_paint.screenshot.sha256 : capture.settled_viewport_screenshot.sha256,
  };
}

function themeFields(siteId, category, theme) {
  return {
    siteId,
    categoryId: category.category_id,
    expectedSettingsRevision: category.settings_revision,
    themeType: theme.theme_kind,
    builtinId: theme.theme_builtin_id ?? 1,
    externalUrl: theme.theme_external_url ?? "",
    customCss: theme.theme_custom_css ?? "",
  };
}

function siteFields(site, description = site.description) {
  return {
    siteId: site.site_id,
    expectedSettingsRevision: site.settings_revision,
    name: site.name,
    slug: site.slug,
    tagline: site.tagline,
    description,
    defaultPage: site.default_page,
    welcomePage: site.welcome_page,
    locale: site.locale,
    action: "edit",
  };
}

class Open43SettingsRun {
  #session;
  #browser;
  #resources;
  #fixedPlan;
  #group;
  #fixture;
  #verificationPlan = null;
  #siteId = null;
  #before = null;
  #staleSiteRevision = null;
  #actorSessions = null;
  #settingChanges = {};
  #settingsResource = null;

  constructor({ session, browser, resources, fixedPlan, group = "all" }) {
    this.#session = session;
    this.#browser = browser;
    this.#resources = resources;
    this.#fixedPlan = fixedPlan;
    this.#group = group;
    this.#fixture = session.fixtureIdentity;
  }

  async #rpc(method, params = {}, { actor = "administrator", page, cleanup = false } = {}) {
    return await this.#session.rpc(method, params, { actor, siteId: this.#siteId ?? undefined, page, cleanup });
  }

  async #site(cleanup = false) {
    const site = await this.#rpc("site_get", { site: SITE_SLUG }, { cleanup });
    if (site?.site_id !== this.#fixture.site_id || site.slug !== SITE_SLUG || !Number.isSafeInteger(site.settings_revision)) throw new Error("editable settings candidate site is missing or malformed");
    this.#siteId ??= site.site_id;
    if (site.site_id !== this.#siteId) throw new Error("editable settings candidate site identity drifted");
    return site;
  }

  async #category(role, cleanup = false) {
    const expected = this.#fixture[role];
    const category = await this.#rpc("category_get", { site: this.#siteId, category: expected.slug }, { cleanup });
    if (category?.category_id !== expected.category_id || category.slug !== expected.slug || !Number.isSafeInteger(category.settings_revision)) throw new Error(`${role} settings category is missing or malformed`);
    return category;
  }

  async #settings(cleanup = false) {
    const site = await this.#site(cleanup);
    const categories = await Promise.all([this.#category("default_category", cleanup), this.#category("transition_category", cleanup)]);
    return { site: siteSettings(site), categories: categories.map(categorySettings) };
  }

  async #action(name, fields, options = {}) {
    const result = await this.#session.action(name, fields, options);
    if (options.expectSuccess === true && result.http_status !== 200) throw new Error(`${name} public action returned ${result.http_status}`);
    return result;
  }

  async #page(slug, cleanup = false) {
    return await this.#rpc("page_get", { site_id: this.#siteId, page: slug, details: { wikitext: true, compiled: false } }, { page: slug, cleanup });
  }

  async #setup() {
    this.#actorSessions = await this.#session.verifyActorSessions();
    if (
      this.#actorSessions?.administrator_user_id !== this.#fixedPlan.administrator_user_id ||
      this.#actorSessions?.non_admin_user_id !== this.#fixedPlan.non_admin_user_id ||
      this.#actorSessions?.expired_session !== null ||
      Object.hasOwn(this.#actorSessions, "expired_user_id")
    ) throw new Error("public actor session identity does not match private input");
    const site = await this.#site();
    this.#staleSiteRevision = site.settings_revision;
    if (await this.#rpc("site_get", { site: this.#fixture.cross_site_sentinel_id }) !== null) throw new Error("cross-site sentinel unexpectedly resolves to an existing site");
    const category = await this.#category("default_category");
    const transitionCategory = await this.#category("transition_category");
    for (const { page_slug: slug, page_id: pageId, category_id: categoryId } of [this.#fixture.default_category, this.#fixture.transition_category]) {
      const page = await this.#page(slug);
      if (page?.page_id !== pageId || page.slug !== slug || page.page_category_id !== categoryId) throw new Error(`fixed category transition page ${slug} is missing or malformed`);
    }
    this.#before = await this.#settings();
    this.#settingsResource = this.#resources.register("settings", { site_id: site.site_id, category_ids: [category.category_id, transitionCategory.category_id], before_sha256: sha256Value(this.#before) });
    if (this.#group === "admin") {
      await this.#action("site", siteFields(site), { expectSuccess: true });
      return;
    }
    if (this.#group === "all" || this.#group === "analytics") {
      await this.#action("analytics", { siteId: site.site_id, expectedSettingsRevision: site.settings_revision, enabled: false, profile: "" }, { expectSuccess: true });
    }
    if (this.#group === "all" || this.#group === "toolbar") {
      const beforeToolbar = await this.#site();
      await this.#action("toolbar", { siteId: site.site_id, expectedSettingsRevision: beforeToolbar.settings_revision, top: false, bottom: beforeToolbar.show_bottom_toolbar }, { expectSuccess: true });
    }
    if (this.#group !== "all" && this.#group !== "theme") return;
    const beforeTheme = await this.#category("default_category");
    await this.#action("theme", themeFields(site.site_id, beforeTheme, { theme_kind: "custom", theme_builtin_id: null, theme_external_url: null, theme_custom_css: this.#fixedPlan.theme_css }), { expectSuccess: true });
    const afterTheme = await this.#category("default_category");
    this.#settingChanges.theme = { before_sha256: sha256Value(categorySettings(beforeTheme)), after_sha256: sha256Value(categorySettings(afterTheme)) };
    const beforeTransitionTheme = await this.#category("transition_category");
    await this.#action("theme", themeFields(site.site_id, beforeTransitionTheme, { theme_kind: "custom", theme_builtin_id: null, theme_external_url: null, theme_custom_css: this.#fixedPlan.transition_theme_css }), { expectSuccess: true });
    const afterTransitionTheme = await this.#category("transition_category");
    this.#settingChanges.transitionTheme = { before_sha256: sha256Value(categorySettings(beforeTransitionTheme)), after_sha256: sha256Value(categorySettings(afterTransitionTheme)) };
  }

  async #matrix() {
    const before = await this.#site();
    const beforeState = revisionBoundSiteSettings(before);
    const beforeHash = sha256Value(beforeState);
    const marker = this.#fixedPlan.general_description_marker;
    const expectedAdminAfter = { ...beforeState, description: marker, settings_revision: before.settings_revision + 1 };
    const cases = [
      ["anonymous", { actor: "anonymous" }, siteFields(before, marker)],
      ["non_admin", { actor: "non_admin" }, siteFields(before, marker)],
      ["cross_site", {}, { ...siteFields(before, marker), siteId: this.#fixture.cross_site_sentinel_id }],
      ["stale_revision", {}, { ...siteFields(before, marker), expectedSettingsRevision: this.#staleSiteRevision }],
      ["wrong_origin", { origin: "https://wrong-origin.invalid" }, siteFields(before, marker)],
      ["expired_session", { actor: "expired" }, siteFields(before, marker)],
      ["administrator", {}, siteFields(before, marker)],
    ];
    const outcomes = [];
    for (const [name, options, fields] of cases) {
      const result = await this.#action("site", fields, options);
      const next = await this.#site();
      const nextHash = sha256Value(revisionBoundSiteSettings(next));
      outcomes.push({ case: name, http_status: result.http_status, mutated: nextHash !== beforeHash, next_read_sha256: nextHash, site_id: next.site_id, settings_revision: next.settings_revision });
    }
    return { outcomes, site_id: before.site_id, before_revision: before.settings_revision, admin_after_revision: before.settings_revision + 1, before_sha256: beforeHash, expected_admin_after_sha256: sha256Value(expectedAdminAfter) };
  }

  async #executeGroup() {
    const pageUrl = new URL(`/${encodeURIComponent(this.#fixture.default_category.page_slug)}`, this.#session.pageOrigin).href;
    const transitionUrl = new URL(`/${encodeURIComponent(this.#fixture.transition_category.page_slug)}`, this.#session.pageOrigin).href;
    this.#verificationPlan = { ...this.#fixedPlan, group: this.#group, default_page_url: pageUrl, transition_page_url: transitionUrl };
    if (this.#group === "admin") {
      const denied = await Promise.all([
        this.#browser.deniedAdmin("anonymous"),
        this.#browser.deniedAdmin("non_admin"),
      ]);
      const matrix = await this.#matrix();
      const adminUrl = new URL("/_admin", this.#session.pageOrigin).href;
      const adminInitial = await this.#browser.capturePagePair({ url: adminUrl, label: "S1046_ADMIN", index: 0, actor: "administrator" });
      const adminInitialSite = await this.#site();
      const adminInitialValuesSha256 = sha256Value(generalValues(adminInitialSite));
      const adminSettledValuesSha256 = sha256Value({ ...generalValues(adminInitialSite), description: this.#fixedPlan.general_ui_description_marker });
      let staleValuesSha256 = null;
      let stalePublicRevision = null;
      const generalLifecycle = await this.#browser.exerciseGeneralAdmin({
        description: this.#fixedPlan.general_ui_description_marker,
        onLoaded: async () => {
          const site = await this.#site();
          await this.#action("site", siteFields(site), { expectSuccess: true });
        },
        onStaleObserved: async () => {
          const site = await this.#site();
          staleValuesSha256 = sha256Value(generalValues(site));
          stalePublicRevision = site.settings_revision;
        },
      });
      const adminSettledSite = await this.#site();
      const adminSettled = await this.#browser.capturePagePair({ url: adminUrl, label: "S1046_ADMIN", index: 1, actor: "administrator" });
      this.#verificationPlan = { ...this.#verificationPlan, admin_url: adminUrl, admin_initial_values_sha256: adminInitialValuesSha256, admin_settled_values_sha256: adminSettledValuesSha256, admin_initial_revision: adminInitialSite.settings_revision, admin_settled_revision: adminInitialSite.settings_revision + 3, general_description_sha256: sha256Value(this.#fixedPlan.general_ui_description_marker), matrix_site_id: matrix.site_id, matrix_before_revision: matrix.before_revision, matrix_admin_after_revision: matrix.admin_after_revision, matrix_before_sha256: matrix.before_sha256, matrix_admin_after_sha256: matrix.expected_admin_after_sha256 };
      const { success_dom_values: successDomValues, ...generalLifecycleReceipt } = generalLifecycle;
      return [
        { case_id: "S1046_ADMIN_INITIAL", observations: { temporal: temporal(adminInitial, false), admin: { route: "/_admin", status: adminInitial.capture.navigation_status, controls: adminInitial.initial.admin.controls, values_sha256: sha256Value(adminInitial.initial.admin.general_values) }, denied } },
        { case_id: "S1046_ADMIN_SETTLED", observations: { temporal: temporal(adminSettled, true), lifecycle: { ...generalLifecycleReceipt, stale_mutated: staleValuesSha256 !== adminInitialValuesSha256, stale_public_revision: stalePublicRevision, success_public_values_sha256: sha256Value(generalValues(adminSettledSite)), success_public_revision: adminSettledSite.settings_revision, success_dom_values_sha256: sha256Value(successDomValues), settled_values_sha256: sha256Value(adminSettled.settled.admin.general_values), reload_values_sha256: sha256Value(adminSettled.reload.admin.general_values), client_navigation_values_sha256: sha256Value(adminSettled.client.admin.general_values), client_navigation_preserved_document: adminSettled.client_navigation_preserved_document, client_resource_completion: adminSettled.client_resource_completion, reload_url: adminSettled.reload_url, console_errors: [...new Set([...(generalLifecycleReceipt.console_errors ?? []), ...adminSettled.console_errors])].sort() } } },
        { case_id: "S1046_PUBLIC_PERMISSION_CSRF_REVISION_MATRIX", observations: { actor_sessions: this.#actorSessions, outcomes: matrix.outcomes } },
      ];
    }
    const groupTemporal = (pair, settled) => ({
      phase: settled ? pair.capture.document.phase : pair.capture.first_paint.document.phase,
      sequence: settled ? 2 : 1,
      input_url: pair.capture.input_url,
      final_url: pair.capture.final_url,
      navigation_status: pair.capture.navigation_status,
      ...(settled ? { resource_completion: pair.capture.document.resource_completion.status } : {}),
      artifact: settled ? pair.capture.settled_viewport_screenshot : pair.capture.first_paint.screenshot,
      counterpart_artifact_path: settled ? pair.capture.first_paint.screenshot.path : pair.capture.settled_viewport_screenshot.path,
      counterpart_artifact_sha256: settled ? pair.capture.first_paint.screenshot.sha256 : pair.capture.settled_viewport_screenshot.sha256,
    });
    const failedRequestIdentity = (pair) => sha256Value({
      failures: pair.capture.failures,
      request_gate_aborts: pair.capture.request_gate_aborts ?? [],
      client_failures: pair.client_transition_capture?.failures ?? [],
      client_request_gate_aborts: pair.client_transition_capture?.request_gate_aborts ?? [],
    });
    if (this.#group === "analytics") {
      const disabled = await this.#browser.capturePagePair({ url: pageUrl, label: "S754_ANALYTICS", index: 0 });
      const lifecycle = await this.#browser.exerciseAnalyticsAdmin({
        profile: this.#fixedPlan.analytics_profile,
        onLoaded: async () => {
          const site = await this.#site();
          await this.#action("analytics", { siteId: site.site_id, expectedSettingsRevision: site.settings_revision, enabled: true, profile: this.#fixedPlan.analytics_stale_profile }, { expectSuccess: true });
        },
      });
      const enabled = await this.#browser.capturePagePair({ url: pageUrl, label: "S754_ANALYTICS", index: 1 });
      const analyticsState = (pair, enabledState) => {
        const { nonce, ...analytics } = pair.initial.analytics;
        return {
          enabled: enabledState,
          ...analytics,
          remote_request_count: pair.remote_analytics_request_count,
          initial_navigation_csp_header_sha256: pair.initial_navigation_csp_header_sha256,
          failed_request_identity_sha256: failedRequestIdentity(pair),
          ...(enabledState ? { csp_nonce_sha256: sha256Value(nonce), csp_nonce_matches_initial_navigation_header: pair.csp_nonce_matches_initial_navigation_header } : {}),
        };
      };
      return [
        { case_id: "S754_ANALYTICS_INITIAL", observations: { disabled_temporal: groupTemporal(disabled, false), enabled_temporal: groupTemporal(enabled, false), disabled: analyticsState(disabled, false), enabled: analyticsState(enabled, true) } },
        { case_id: "S754_ANALYTICS_SETTLED", observations: { temporal: groupTemporal(enabled, true), admin_lifecycle: lifecycle, analytics: { profile: enabled.settled.analytics.profile, queue: enabled.settled.analytics.queue, reload_queue: enabled.reload.analytics.queue, reload_url: enabled.reload_url, client_navigation_queue: enabled.client.analytics.queue, client_navigation_preserved_document: enabled.client_navigation_preserved_document, client_resource_completion: enabled.client_resource_completion, remote_request_count: enabled.remote_analytics_request_count, initial_navigation_csp_header_sha256: enabled.initial_navigation_csp_header_sha256, csp_nonce_matches_initial_navigation_header: enabled.csp_nonce_matches_initial_navigation_header, console_errors: enabled.console_errors, failed_request_identity_sha256: failedRequestIdentity(enabled) } } },
      ];
    }
    if (this.#group === "toolbar") {
      const disabledToolbar = [];
      for (const [offset, width] of VIEWPORTS.slice(1).entries()) disabledToolbar.push(await this.#browser.capturePagePair({ url: pageUrl, label: "S757_TOOLBAR", index: offset + 1, viewport: { width, height: 900 } }));
      const toolbarTransition = await this.#browser.capturePagePair({
        url: pageUrl, label: "S757_TOOLBAR", index: 0, viewport: { width: VIEWPORTS[0], height: 900 }, navigationFromUrl: transitionUrl,
        beforeClientNavigation: async () => {
          const before = await this.#site();
          await this.#action("toolbar", { siteId: this.#siteId, expectedSettingsRevision: before.settings_revision, top: true, bottom: before.show_bottom_toolbar }, { expectSuccess: true });
          const after = await this.#site();
          this.#settingChanges.toolbar = { before_sha256: sha256Value(siteSettings(before)), after_sha256: sha256Value(siteSettings(after)) };
        },
      });
      disabledToolbar.unshift(toolbarTransition);
      const toolbar = [];
      for (const [offset, width] of VIEWPORTS.entries()) toolbar.push(await this.#browser.capturePagePair({ url: pageUrl, label: "S757_TOOLBAR", index: offset + 3, viewport: { width, height: 900 } }));
      const toolbarRows = (pairs, settled, enabled) => pairs.map((pair, index) => {
        const observed = settled ? pair.settled.toolbar : pair.initial.toolbar;
        return { viewport: { width: VIEWPORTS[index], height: 900 }, ...observed, stale_previous_setting_present: enabled ? observed.top_toolbar_count === 0 : observed.top_toolbar_count > 0, failed_request_identity_sha256: failedRequestIdentity(pair), reload_url: pair.reload_url, temporal: temporal(pair, settled) };
      });
      const toolbarSettingTransition = { before_top_toolbar_count: toolbarTransition.navigation_source.toolbar.top_toolbar_count, client_immediate_top_toolbar_count: toolbarTransition.client_initial.toolbar.top_toolbar_count, client_settled_top_toolbar_count: toolbarTransition.client.toolbar.top_toolbar_count, client_immediate_stale_previous_setting_present: toolbarTransition.client_initial.toolbar.top_toolbar_count !== 1, client_settled_stale_previous_setting_present: toolbarTransition.client.toolbar.top_toolbar_count !== 1, navigation_from_url: toolbarTransition.navigation_from_url, navigation_to_url: pageUrl, client_navigation_preserved_document: toolbarTransition.client_navigation_preserved_document, client_resource_completion: toolbarTransition.client_resource_completion, failed_request_identity_sha256: failedRequestIdentity(toolbarTransition), initial_temporal: clientTransitionTemporal(toolbarTransition, false), settled_temporal: clientTransitionTemporal(toolbarTransition, true) };
      return [
        { case_id: "S757_TOOLBAR_INITIAL", observations: { disabled_captures: toolbarRows(disabledToolbar, false, false), captures: toolbarRows(toolbar, false, true) } },
        { case_id: "S757_TOOLBAR_SETTLED", observations: { disabled_captures: toolbarRows(disabledToolbar, true, false), captures: toolbarRows(toolbar, true, true), setting_transition: toolbarSettingTransition, setting_change: this.#settingChanges.toolbar, interactions: { ...toolbarTransition.toolbar_interactions, client_navigation_preserved_document: toolbarTransition.client_navigation_preserved_document, client_resource_completion: toolbarTransition.client_resource_completion } } },
      ];
    }
    const defaultTheme = await this.#browser.capturePagePair({ url: pageUrl, label: "S755_THEME", index: 0 });
    const transitionTheme = await this.#browser.capturePagePair({ url: transitionUrl, label: "S755_THEME", index: 1, navigationFromUrl: pageUrl });
    const themeState = (observed, expectedMarker, transition, pair, capture) => ({
      expected_marker: expectedMarker,
      computed_marker: observed.marker,
      stylesheet_order: observed.stylesheet_order,
      ...(transition
        ? { stale_previous_theme_present: observed.site_theme_count !== 1 || observed.site_theme_css !== this.#fixedPlan.transition_theme_css || observed.marker === this.#fixedPlan.theme_marker }
        : { stale_theme_present: observed.site_theme_count !== 1 || observed.site_theme_css !== this.#fixedPlan.theme_css }),
      body_font_family: observed.body_font_family,
      body_background_color: observed.body_background_color,
      body_color: observed.body_color,
      initial_navigation_csp_header_sha256: pair.initial_navigation_csp_header_sha256,
      capture_failures: capture.failures,
      request_gate_aborts: capture.request_gate_aborts ?? [],
      failed_request_identity_sha256: sha256Value({ failures: capture.failures, request_gate_aborts: capture.request_gate_aborts ?? [] }),
    });
    const categoryState = (observed, pair) => ({
      ...themeState(observed, this.#fixedPlan.transition_theme_marker, true, pair, pair.client_transition_capture),
      navigation_source_marker: pair.navigation_source?.theme.marker ?? null,
      navigation_from_url: pair.navigation_from_url,
    });
    return [
      { case_id: "S755_THEME_INITIAL", observations: { default_temporal: groupTemporal(defaultTheme, false), transition_temporal: groupTemporal(transitionTheme, false), category_transition_temporal: clientTransitionTemporal(transitionTheme, false), default_theme: themeState(defaultTheme.initial.theme, this.#fixedPlan.theme_marker, false, defaultTheme, defaultTheme.capture), transition_theme: themeState(transitionTheme.initial.theme, this.#fixedPlan.transition_theme_marker, true, transitionTheme, transitionTheme.capture), category_transition_theme: categoryState(transitionTheme.client_initial.theme, transitionTheme) } },
      { case_id: "S755_THEME_SETTLED", observations: { default_temporal: groupTemporal(defaultTheme, true), transition_temporal: groupTemporal(transitionTheme, true), category_transition_temporal: clientTransitionTemporal(transitionTheme, true), default_theme: { ...themeState(defaultTheme.settled.theme, this.#fixedPlan.theme_marker, false, defaultTheme, defaultTheme.capture), reload_url: defaultTheme.reload_url }, transition_theme: { ...themeState(transitionTheme.settled.theme, this.#fixedPlan.transition_theme_marker, true, transitionTheme, transitionTheme.capture), reload_url: transitionTheme.reload_url }, category_transition_theme: categoryState(transitionTheme.client.theme, transitionTheme), setting_changes: { default: this.#settingChanges.theme, transition: this.#settingChanges.transitionTheme } } },
    ];
  }

  async execute() {
    await this.#setup();
    if (this.#group !== "all") return await this.#executeGroup();
    const denied = await Promise.all([
      this.#browser.deniedAdmin("anonymous"),
      this.#browser.deniedAdmin("non_admin"),
    ]);
    const matrix = await this.#matrix();
    const pageUrl = new URL(`/${encodeURIComponent(this.#fixture.default_category.page_slug)}`, this.#session.pageOrigin).href;
    const transitionUrl = new URL(`/${encodeURIComponent(this.#fixture.transition_category.page_slug)}`, this.#session.pageOrigin).href;
    const analyticsDisabled = await this.#browser.capturePagePair({ url: pageUrl, label: "S754_ANALYTICS", index: 0 });
    const analyticsLifecycle = await this.#browser.exerciseAnalyticsAdmin({
      profile: this.#fixedPlan.analytics_profile,
      onLoaded: async () => {
        const site = await this.#site();
        await this.#action("analytics", { siteId: site.site_id, expectedSettingsRevision: site.settings_revision, enabled: true, profile: this.#fixedPlan.analytics_stale_profile }, { expectSuccess: true });
      },
    });
    const analyticsEnabled = await this.#browser.capturePagePair({ url: pageUrl, label: "S754_ANALYTICS", index: 1 });
    const defaultTheme = await this.#browser.capturePagePair({ url: pageUrl, label: "S755_THEME", index: 2 });
    const transitionTheme = await this.#browser.capturePagePair({ url: transitionUrl, label: "S755_THEME", index: 3, navigationFromUrl: pageUrl });
    const disabledToolbar = [];
    for (const [offset, width] of VIEWPORTS.slice(1).entries()) disabledToolbar.push(await this.#browser.capturePagePair({ url: pageUrl, label: "S757_TOOLBAR", index: offset + 5, viewport: { width, height: 900 } }));
    const toolbarTransition = await this.#browser.capturePagePair({
      url: pageUrl, label: "S757_TOOLBAR", index: 4, viewport: { width: VIEWPORTS[0], height: 900 }, navigationFromUrl: transitionUrl,
      beforeClientNavigation: async () => {
        const before = await this.#site();
        await this.#action("toolbar", { siteId: this.#siteId, expectedSettingsRevision: before.settings_revision, top: true, bottom: before.show_bottom_toolbar }, { expectSuccess: true });
        const after = await this.#site();
        this.#settingChanges.toolbar = { before_sha256: sha256Value(siteSettings(before)), after_sha256: sha256Value(siteSettings(after)) };
      },
    });
    disabledToolbar.unshift(toolbarTransition);
    const toolbar = [];
    for (const [offset, width] of VIEWPORTS.entries()) toolbar.push(await this.#browser.capturePagePair({ url: pageUrl, label: "S757_TOOLBAR", index: offset + 7, viewport: { width, height: 900 } }));
    const adminUrl = new URL("/_admin", this.#session.pageOrigin).href;
      const adminInitial = await this.#browser.capturePagePair({ url: adminUrl, label: "S1046_ADMIN", index: 10, actor: "administrator" });
    const adminInitialSite = await this.#site();
    const adminInitialValuesSha256 = sha256Value(generalValues(adminInitialSite));
    const adminSettledValuesSha256 = sha256Value({ ...generalValues(adminInitialSite), description: this.#fixedPlan.general_ui_description_marker });
    let staleValuesSha256 = null;
    let stalePublicRevision = null;
    const generalLifecycle = await this.#browser.exerciseGeneralAdmin({
      description: this.#fixedPlan.general_ui_description_marker,
      onLoaded: async () => {
        const site = await this.#site();
        await this.#action("analytics", { siteId: site.site_id, expectedSettingsRevision: site.settings_revision, enabled: site.google_analytics_enabled, profile: site.google_analytics_profile ?? "" }, { expectSuccess: true });
      },
      onStaleObserved: async () => {
        const site = await this.#site();
        staleValuesSha256 = sha256Value(generalValues(site));
        stalePublicRevision = site.settings_revision;
      },
    });
    const adminSettledSite = await this.#site();
    const adminSettledPublicValuesSha256 = sha256Value(generalValues(adminSettledSite));
      const adminSettled = await this.#browser.capturePagePair({ url: adminUrl, label: "S1046_ADMIN", index: 11, actor: "administrator" });
    this.#verificationPlan = { ...this.#fixedPlan, default_page_url: pageUrl, transition_page_url: transitionUrl, admin_url: adminUrl, admin_initial_values_sha256: adminInitialValuesSha256, admin_settled_values_sha256: adminSettledValuesSha256, admin_initial_revision: adminInitialSite.settings_revision, admin_settled_revision: adminInitialSite.settings_revision + 3, general_description_sha256: sha256Value(this.#fixedPlan.general_ui_description_marker), matrix_site_id: matrix.site_id, matrix_before_revision: matrix.before_revision, matrix_admin_after_revision: matrix.admin_after_revision, matrix_before_sha256: matrix.before_sha256, matrix_admin_after_sha256: matrix.expected_admin_after_sha256 };
    const analyticsState = (pair, enabled) => {
      const { nonce, ...analytics } = pair.initial.analytics;
      return { enabled, ...analytics, remote_request_count: pair.remote_analytics_request_count, initial_navigation_csp_header_sha256: pair.initial_navigation_csp_header_sha256, ...(enabled ? { csp_nonce_sha256: sha256Value(nonce), csp_nonce_matches_initial_navigation_header: pair.csp_nonce_matches_initial_navigation_header } : {}) };
    };
    const toolbarRows = (pairs, settled, enabled) => pairs.map((pair, index) => {
      const observed = settled ? pair.settled.toolbar : pair.initial.toolbar;
      return { viewport: { width: VIEWPORTS[index], height: 900 }, ...observed, stale_previous_setting_present: enabled ? observed.top_toolbar_count === 0 : observed.top_toolbar_count > 0, reload_url: pair.reload_url, temporal: temporal(pair, settled) };
    });
    const toolbarSettingTransition = { before_top_toolbar_count: toolbarTransition.navigation_source.toolbar.top_toolbar_count, client_immediate_top_toolbar_count: toolbarTransition.client_initial.toolbar.top_toolbar_count, client_settled_top_toolbar_count: toolbarTransition.client.toolbar.top_toolbar_count, client_immediate_stale_previous_setting_present: toolbarTransition.client_initial.toolbar.top_toolbar_count !== 1, client_settled_stale_previous_setting_present: toolbarTransition.client.toolbar.top_toolbar_count !== 1, navigation_from_url: toolbarTransition.navigation_from_url, navigation_to_url: pageUrl, client_navigation_preserved_document: toolbarTransition.client_navigation_preserved_document, client_resource_completion: toolbarTransition.client_resource_completion, initial_temporal: clientTransitionTemporal(toolbarTransition, false), settled_temporal: clientTransitionTemporal(toolbarTransition, true) };
    const defaultInitialTheme = defaultTheme.initial.theme;
    const defaultSettledTheme = defaultTheme.settled.theme;
    const transitionInitialTheme = transitionTheme.initial.theme;
    const transitionSettledTheme = transitionTheme.settled.theme;
    const categoryTransitionInitialTheme = transitionTheme.client_initial.theme;
    const categoryTransitionSettledTheme = transitionTheme.client.theme;
    const defaultThemeState = (observed) => ({ expected_marker: this.#fixedPlan.theme_marker, computed_marker: observed.marker, stylesheet_order: observed.stylesheet_order, stale_theme_present: observed.site_theme_count !== 1 || observed.site_theme_css !== this.#fixedPlan.theme_css });
    const transitionThemeState = (observed) => ({ expected_marker: this.#fixedPlan.transition_theme_marker, computed_marker: observed.marker, stylesheet_order: observed.stylesheet_order, stale_previous_theme_present: observed.site_theme_count !== 1 || observed.site_theme_css !== this.#fixedPlan.transition_theme_css || observed.marker === this.#fixedPlan.theme_marker });
    const categoryTransitionThemeState = (observed) => ({ ...transitionThemeState(observed), navigation_source_marker: transitionTheme.navigation_source?.theme.marker ?? null, navigation_from_url: transitionTheme.navigation_from_url });
    const { success_dom_values: successDomValues, ...generalLifecycleReceipt } = generalLifecycle;
    return [
      { case_id: "S754_ANALYTICS_INITIAL", observations: { disabled_temporal: temporal(analyticsDisabled, false), enabled_temporal: temporal(analyticsEnabled, false), disabled: analyticsState(analyticsDisabled, false), enabled: analyticsState(analyticsEnabled, true) } },
      { case_id: "S754_ANALYTICS_SETTLED", observations: { temporal: temporal(analyticsEnabled, true), admin_lifecycle: analyticsLifecycle, analytics: { profile: analyticsEnabled.settled.analytics.profile, queue: analyticsEnabled.settled.analytics.queue, reload_queue: analyticsEnabled.reload.analytics.queue, reload_url: analyticsEnabled.reload_url, client_navigation_queue: analyticsEnabled.client.analytics.queue, client_navigation_preserved_document: analyticsEnabled.client_navigation_preserved_document, client_resource_completion: analyticsEnabled.client_resource_completion, remote_request_count: analyticsEnabled.remote_analytics_request_count, initial_navigation_csp_header_sha256: analyticsEnabled.initial_navigation_csp_header_sha256, csp_nonce_matches_initial_navigation_header: analyticsEnabled.csp_nonce_matches_initial_navigation_header, console_errors: analyticsEnabled.console_errors } } },
      { case_id: "S755_THEME_INITIAL", observations: { default_temporal: temporal(defaultTheme, false), transition_temporal: temporal(transitionTheme, false), category_transition_temporal: clientTransitionTemporal(transitionTheme, false), default_theme: { ...defaultThemeState(defaultInitialTheme), body_font_family: defaultInitialTheme.body_font_family, body_background_color: defaultInitialTheme.body_background_color, body_color: defaultInitialTheme.body_color, initial_navigation_csp_header_sha256: defaultTheme.initial_navigation_csp_header_sha256, capture_failures: defaultTheme.capture.failures }, transition_theme: { ...transitionThemeState(transitionInitialTheme), body_font_family: transitionInitialTheme.body_font_family, body_background_color: transitionInitialTheme.body_background_color, body_color: transitionInitialTheme.body_color, initial_navigation_csp_header_sha256: transitionTheme.initial_navigation_csp_header_sha256, capture_failures: transitionTheme.capture.failures }, category_transition_theme: { ...categoryTransitionThemeState(categoryTransitionInitialTheme), body_font_family: categoryTransitionInitialTheme.body_font_family, body_background_color: categoryTransitionInitialTheme.body_background_color, body_color: categoryTransitionInitialTheme.body_color, capture_failures: transitionTheme.client_transition_capture.failures } } },
      { case_id: "S755_THEME_SETTLED", observations: { default_temporal: temporal(defaultTheme, true), transition_temporal: temporal(transitionTheme, true), category_transition_temporal: clientTransitionTemporal(transitionTheme, true), default_theme: { ...defaultThemeState(defaultSettledTheme), body_font_family: defaultSettledTheme.body_font_family, body_background_color: defaultSettledTheme.body_background_color, body_color: defaultSettledTheme.body_color, reload_url: defaultTheme.reload_url, initial_navigation_csp_header_sha256: defaultTheme.initial_navigation_csp_header_sha256, capture_failures: defaultTheme.capture.failures }, transition_theme: { ...transitionThemeState(transitionSettledTheme), body_font_family: transitionSettledTheme.body_font_family, body_background_color: transitionSettledTheme.body_background_color, body_color: transitionSettledTheme.body_color, reload_url: transitionTheme.reload_url, initial_navigation_csp_header_sha256: transitionTheme.initial_navigation_csp_header_sha256, capture_failures: transitionTheme.capture.failures }, category_transition_theme: { ...categoryTransitionThemeState(categoryTransitionSettledTheme), body_font_family: categoryTransitionSettledTheme.body_font_family, body_background_color: categoryTransitionSettledTheme.body_background_color, body_color: categoryTransitionSettledTheme.body_color, capture_failures: transitionTheme.client_transition_capture.failures }, setting_changes: { default: this.#settingChanges.theme, transition: this.#settingChanges.transitionTheme } } },
      { case_id: "S757_TOOLBAR_INITIAL", observations: { disabled_captures: toolbarRows(disabledToolbar, false, false), captures: toolbarRows(toolbar, false, true) } },
      { case_id: "S757_TOOLBAR_SETTLED", observations: { disabled_captures: toolbarRows(disabledToolbar, true, false), captures: toolbarRows(toolbar, true, true), setting_transition: toolbarSettingTransition, setting_change: this.#settingChanges.toolbar, interactions: { ...toolbarTransition.toolbar_interactions, client_navigation_preserved_document: toolbarTransition.client_navigation_preserved_document, client_resource_completion: toolbarTransition.client_resource_completion } } },
      { case_id: "S1046_ADMIN_INITIAL", observations: { temporal: temporal(adminInitial, false), admin: { route: "/_admin", status: adminInitial.capture.navigation_status, controls: adminInitial.initial.admin.controls, values_sha256: sha256Value(adminInitial.initial.admin.general_values) }, denied } },
      { case_id: "S1046_ADMIN_SETTLED", observations: { temporal: temporal(adminSettled, true), lifecycle: { ...generalLifecycleReceipt, stale_mutated: staleValuesSha256 !== adminInitialValuesSha256, stale_public_revision: stalePublicRevision, success_public_values_sha256: adminSettledPublicValuesSha256, success_public_revision: adminSettledSite.settings_revision, success_dom_values_sha256: sha256Value(successDomValues), settled_values_sha256: sha256Value(adminSettled.settled.admin.general_values), reload_values_sha256: sha256Value(adminSettled.reload.admin.general_values), client_navigation_values_sha256: sha256Value(adminSettled.client.admin.general_values), client_navigation_preserved_document: adminSettled.client_navigation_preserved_document, client_resource_completion: adminSettled.client_resource_completion, reload_url: adminSettled.reload_url, console_errors: [...new Set([...(generalLifecycleReceipt.console_errors ?? []), ...adminSettled.console_errors])].sort() } } },
      { case_id: "S1046_PUBLIC_PERMISSION_CSRF_REVISION_MATRIX", observations: { actor_sessions: this.#actorSessions, outcomes: matrix.outcomes } },
    ];
  }

  async cleanup() {
    const failures = [];
    if (this.#before !== null) {
      const defaultBefore = this.#before.categories.find(({ slug }) => slug === this.#fixture.default_category.slug);
      const transitionBefore = this.#before.categories.find(({ slug }) => slug === this.#fixture.transition_category.slug);
      const restores = [];
      if (this.#group === "all" || this.#group === "admin") restores.push(
        async () => { const site = await this.#site(true); await this.#action("site", siteFields({ ...site, ...this.#before.site }), { cleanup: true, expectSuccess: true }); },
      );
      if (this.#group === "all" || this.#group === "theme") restores.push(
        async () => { const category = await this.#category("default_category", true); await this.#action("theme", themeFields(this.#siteId, category, defaultBefore), { cleanup: true, expectSuccess: true }); },
        async () => { const category = await this.#category("transition_category", true); await this.#action("theme", themeFields(this.#siteId, category, transitionBefore), { cleanup: true, expectSuccess: true }); },
      );
      if (this.#group === "all" || this.#group === "toolbar") restores.push(
        async () => { const site = await this.#site(true); await this.#action("toolbar", { siteId: this.#siteId, expectedSettingsRevision: site.settings_revision, top: this.#before.site.show_top_toolbar, bottom: this.#before.site.show_bottom_toolbar }, { cleanup: true, expectSuccess: true }); },
      );
      if (this.#group === "all" || this.#group === "analytics") restores.push(
        async () => { const site = await this.#site(true); await this.#action("analytics", { siteId: this.#siteId, expectedSettingsRevision: site.settings_revision, enabled: this.#before.site.google_analytics_enabled, profile: this.#before.site.google_analytics_profile ?? "" }, { cleanup: true, expectSuccess: true }); },
      );
      for (const restore of restores) await restore().catch((error) => failures.push(error));
    }
    let after = null;
    try { if (this.#before !== null) after = await this.#settings(true); } catch (error) { failures.push(error); }
    if (this.#settingsResource !== null && sha256Value(after) === sha256Value(this.#before)) this.#resources.release(this.#settingsResource, { before_sha256: sha256Value(this.#before), after_sha256: sha256Value(after) });
    if (failures.length > 0) throw new AggregateError(failures, "settings public cleanup failed");
    return { before: this.#before, after };
  }

  verifyCase(caseId, observations) {
    if (this.#verificationPlan === null) throw new Error("settings cases were not executed");
    return verifyOpen43SettingsBrowserCase(caseId, observations, this.#verificationPlan);
  }
}

const SOURCE_FILES = Object.freeze([...new Set([
  ...STANDING_BROWSER_EXECUTION_MODULES,
  "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
  "install/local/wikidot-verification/src/candidate-case-command.mjs",
  "install/local/wikidot-verification/src/candidate-case-http.mjs",
  "install/local/wikidot-verification/src/candidate-case-runner.mjs",
  "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
  "install/local/wikidot-verification/src/open43-settings-browser-adapter.mjs",
  "install/local/wikidot-verification/src/open43-settings-browser-candidate-case-set.mjs",
  "install/local/wikidot-verification/src/open43-settings-browser-candidate-contract.mjs",
  "install/local/wikidot-verification/src/open43-settings-candidate-http.mjs",
  "install/local/wikidot-verification/src/deepwell-rpc-auth.mjs",
  "install/local/wikidot-verification/package.json",
  "install/local/wikidot-verification/pnpm-lock.yaml",
])]);

export function createOpen43SettingsGroupCandidateCaseSet({
  group = "all",
  sessionFactory = (options) => new Open43SettingsCandidateSession(options),
  browserAdapterFactory = (options) => new Open43SettingsBrowserAdapter(options),
} = {}) {
  const caseIds = group === "analytics"
    ? OPEN43_SETTINGS_ANALYTICS_CASE_IDS
    : group === "theme"
      ? OPEN43_SETTINGS_THEME_CASE_IDS
      : group === "toolbar"
        ? OPEN43_SETTINGS_TOOLBAR_CASE_IDS
        : group === "admin"
          ? OPEN43_SETTINGS_ADMIN_CASE_IDS
          : group === "all"
            ? OPEN43_SETTINGS_BROWSER_CASE_IDS
            : null;
  if (caseIds === null) throw new Error(`unknown Open43 settings candidate group: ${group}`);
  const id = group === "all" ? "open43-settings-browser" : `open43-settings-${group}`;
  return Object.freeze({
    id,
    caseIds,
    prepareRun({ runId, candidateIdentity, privateInput, signal, resources, candidateBrowserContexts }) {
      if (candidateIdentity.candidate.endpoint.host !== SITE_HOST || candidateIdentity.candidate.endpoint.port === 443 || candidateIdentity.candidate.port_443_published !== false) throw new Error(`Open43 settings cases require exact non-standing ${SITE_HOST}`);
      const session = sessionFactory({ candidateIdentity, privateInput, signal });
      if (session.pageOrigin !== candidatePageOrigin(candidateIdentity)) throw new Error("settings session did not bind the sealed editable candidate origin");
      const privateInputIdentity = session.privateInputIdentity;
      const suffix = runId.slice("candidate-run-".length);
      const fixedPlan = Object.freeze({
        analytics_profile: "UA-754-1",
        analytics_stale_profile: "UA-754-2",
        theme_marker: `open43-${suffix}`,
        transition_theme_marker: `open43-corpus-${suffix}`,
        theme_body_font_family: "Arial, sans-serif",
        theme_body_background_color: "rgb(17, 34, 51)",
        theme_body_color: "rgb(238, 238, 238)",
        transition_body_background_color: "rgb(68, 85, 102)",
        theme_css: `:root { --open43-theme-marker: open43-${suffix}; } body { font-family: Arial, sans-serif; background-color: rgb(17, 34, 51); color: rgb(238, 238, 238); }`,
        transition_theme_css: `:root { --open43-theme-marker: open43-corpus-${suffix}; } body { font-family: Arial, sans-serif; background-color: rgb(68, 85, 102); color: rgb(238, 238, 238); }`,
        default_category_slug: session.fixtureIdentity.default_category.slug,
        transition_category_slug: session.fixtureIdentity.transition_category.slug,
        toolbar_top: true,
        revision_conflict_code: 4000,
        revision_conflict_message_sha256: sha256Value("The request is in some way malformed or incorrect"),
        general_ui_description_marker: `Open43 settings UI candidate ${suffix}`,
        general_description_marker: `Open43 settings candidate ${suffix}`,
        administrator_user_id: privateInputIdentity.administrator_user_id,
        non_admin_user_id: privateInputIdentity.non_admin_user_id,
      });
      const browser = browserAdapterFactory({ browserContexts: candidateBrowserContexts, pageOrigin: session.pageOrigin, storageState: (actor) => session.storageState(actor) });
      const execution = new Open43SettingsRun({ session, browser, resources, fixedPlan, group });
      return Object.freeze({
        sourceFiles: SOURCE_FILES,
        runtimeBindings: session.requiredServiceBindings,
        privateInputIdentity,
        browserCredentialPolicy: group === "theme" || group === "toolbar" ? "none" : { mode: "private-actor-storage-states", storage_state_count: group === "all" || group === "admin" ? 2 : 1, private_input_identity_sha256: sha256Value(privateInputIdentity) },
        plan: { schema: "wikijump.open43_settings_browser_candidate_plan.v1", group, site_slug: SITE_SLUG, page_origin: session.pageOrigin, case_ids: caseIds, fixture_identity_sha256: privateInputIdentity.fixture_identity_sha256, analytics_profile: fixedPlan.analytics_profile, theme_marker: fixedPlan.theme_marker, toolbar_top: true, matrix_order: ["anonymous", "non_admin", "cross_site", "stale_revision", "wrong_origin", "expired_session", "administrator"] },
        execute: () => execution.execute(),
        cleanup: () => execution.cleanup(),
        verifyCase: (caseId, observations) => execution.verifyCase(caseId, observations),
        verifyCleanup: verifyOpen43SettingsBrowserCleanup,
      });
    },
  });
}

export function createOpen43SettingsBrowserCandidateCaseSet(options = {}) {
  return createOpen43SettingsGroupCandidateCaseSet({ ...options, group: "all" });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {themeTestExecutionPlan} from '../src/theme-test-execution-plan.mjs';
import {materializeThemeSessionInputs} from '../src/theme-test-session-inputs.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma9-extra-black-canonical.json'),'utf8'));
const record=materialized=>{const base={schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,site_id:17,site_slug:materialized.scenario.branch_profile.site_slug,observed:{}};return {...base,receipt_sha256:crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex')}};

test('ready Sigma-9 plan materializes exact session-server and check bytes',()=>{
  const materialized=materializeThemeTestScenario(root,config);
  const plan=themeTestExecutionPlan(root,config,{siteState:record(materialized)});
  const inputs=materializeThemeSessionInputs(root,plan);
  assert.equal(inputs.server.candidateUrl,`${materialized.scenario.runtime.origin}/run-owned%3Atheme-lab-canonical-corpus-v1`);
  assert.match(inputs.server.sidebarHtml,/side-block/u);
  assert.match(inputs.server.interwikiHtml,/scpnet-interwiki-wrapper/u);
  assert.match(inputs.server.navigationHtml,/top-bar/u);
  assert.equal(inputs.server.baselineCss,fs.readFileSync(path.join(root,'fixtures/scp-jp-sigma9-offline.css'),'utf8'));
  assert.equal(inputs.check.css,fs.readFileSync(path.join(root,'ports/extra-black-highlighter-theme/candidate.css'),'utf8'));
  assert.equal(inputs.check.siteId,17);
  assert.equal(inputs.check.wikitext,null);
  assert.equal(inputs.check.baseCss,'');
  assert.equal(inputs.check.savedCandidate,true);
  assert.equal(inputs.server.scenarioEvidence.scenario_sha256,materialized.scenario_sha256);
  assert.equal(inputs.server.scenarioEvidence.session_profile,'anonymous');
  assert.equal(inputs.server.scenarioEvidence.site_id,17);
  assert.equal(inputs.server.scenarioEvidence.theme_css_sha256,materialized.scenario.theme.css_sha256);
  assert.match(inputs.server.scenarioEvidence.execution_evidence_sha256,/^[0-9a-f]{64}$/u);
  const authenticated=materializeThemeSessionInputs(root,plan,{sessionProfile:'authenticated'});
  assert.equal(authenticated.server.scenarioEvidence.session_profile,'authenticated');
});

test('non-ready plan cannot materialize runnable session inputs',()=>{
  const plan=themeTestExecutionPlan(root,config);
  assert.throws(()=>materializeThemeSessionInputs(root,plan),/not ready/u);
});

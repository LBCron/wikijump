import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {themeTestExecutionPlan} from '../src/theme-test-execution-plan.mjs';
import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {renderThemeShellProfile} from '../src/theme-shell-render.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const load=name=>JSON.parse(fs.readFileSync(path.join(root,'scenarios',name),'utf8'));

const liveSiteState=(materialized,siteId=17)=>{const base={schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,site_id:siteId,site_slug:'scpaiueouiuiuiui',observed:{}};return {...base,receipt_sha256:crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex')}};

test('JP Sigma-9 canonical scenario requires live site-state verification before session injection',()=>{
  const config=load('jp-sigma9-extra-black-canonical.json'),materialized=materializeThemeTestScenario(root,config);
  const plan=themeTestExecutionPlan(root,load('jp-sigma9-extra-black-canonical.json'));
  assert.equal(plan.shell_requires_rendering,false);
  assert.equal(plan.session_server_ready,false);
  assert.deepEqual(plan.blockers,['live branch/site-state must be verified before scenario execution']);
  const ready=themeTestExecutionPlan(root,config,{siteState:liveSiteState(materialized)});
  assert.equal(ready.session_server_ready,true);
  assert.deepEqual(ready.blockers,[]);
  assert.equal(ready.candidate_url,'https://scpaiueouiuiuiui.wikijump.localhost:3398/run-owned%3Atheme-lab-canonical-corpus-v1');
  assert.equal(ready.session_server_inputs.shell_injection.sidebarHtml.path,'fixtures/scp-jp-sidebar.html');
});

test('JP Sigma-10 canonical scenario fails closed until its Wikidot-source shell is rendered',()=>{
  const plan=themeTestExecutionPlan(root,load('jp-sigma10-extra-black-canonical.json'));
  assert.equal(plan.shell_requires_rendering,true);
  assert.equal(plan.session_server_ready,false);
  assert.deepEqual(plan.blockers,['Wikidot-source shell must be rendered by the bound runtime before HTML injection','live branch/site-state must be verified before scenario execution']);
});

test('JP Sigma-10 canonical scenario becomes session-server ready only with its exact bound rendered shell',async()=>{
  const config=load('jp-sigma10-extra-black-canonical.json');
  const materialized=materializeThemeTestScenario(root,config);
  const rendered=await renderThemeShellProfile({root,materialized,siteId:17,previewClient:{preview:async({title})=>({body:`<div>${title}</div>`,styles:[]})}});
  const plan=themeTestExecutionPlan(root,config,{renderedShell:rendered,siteState:liveSiteState(materialized)});
  assert.equal(plan.session_server_ready,true);
  assert.deepEqual(plan.blockers,[]);
  assert.match(plan.session_server_inputs.shell_injection.sidebarHtml,/Theme Lab shell navigation_side/u);
  assert.throws(()=>themeTestExecutionPlan(root,config,{renderedShell:rendered,siteState:liveSiteState(materialized,18)}),/different sites/u);
  const styled=await renderThemeShellProfile({root,materialized,siteId:17,previewClient:{preview:async({title})=>({body:`<div>${title}</div>`,styles:['.unexpected{display:none}']})}});
  assert.throws(()=>themeTestExecutionPlan(root,config,{renderedShell:styled}),/unsupported shell styles/u);
});

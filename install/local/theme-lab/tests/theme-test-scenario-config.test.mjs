import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {CANONICAL_INTERACTION_STATES,CANONICAL_SEMANTIC_PROBES} from '../src/theme-canonical-execution.mjs';

test('scenario config binds exact shell, site-state, baseline, theme and corpus bytes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'theme-scenario-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const site={schema:'theme_lab_site_state.v1',branch_profile:'scp-jp',locale:'ja',site_slug:'scp-jp',existing_pages:['existing'],missing_pages:['missing'],page_tags:['theme'],session_profiles:['anonymous']};
  const manifest={schema:'theme_lab_canonical_corpus.v1',id:'canonical',source:'corpus.txt',site_state_requirements:{existing_pages:['existing'],missing_pages:['missing'],page_tags:['theme'],session_profiles:['anonymous']},semantic_probes:[...CANONICAL_SEMANTIC_PROBES]};
  const states={schema:'theme_lab_canonical_corpus_states.v1',corpus:'canonical',viewports:['desktop','laptop','tablet','mobile','narrow-mobile'],session_profiles:['anonymous'],interaction_states:[...CANONICAL_INTERACTION_STATES]};
  const measurement={schema:'theme_lab_measurement_contract.v1',id:'measurement',viewports:[{id:'desktop',width:1440,height:1000},{id:'laptop',width:1024,height:900},{id:'tablet',width:768,height:1024},{id:'mobile',width:390,height:844},{id:'narrow-mobile',width:320,height:800}],browser_engines:['chromium','firefox','webkit'],browser_version_policy:'exact-runtime-version',session_profiles:['anonymous'],network_policy:'block-external-after-local-materialization'};
  fs.mkdirSync(path.join(root,'assets'));
  fs.writeFileSync(path.join(root,'assets/header-logo.png'),'legacy image');
  for(const [file,bytes] of Object.entries({'header.html':'header','sidebar.html':'sidebar','site.json':JSON.stringify(site),'base.css':'baseline','credit.txt':'credit component','theme.css':'header{background:url("./assets/header-logo.png")}','theme-base.css':'theme base','theme.txt':'source','corpus.txt':'corpus','manifest.json':JSON.stringify(manifest),'states.json':JSON.stringify(states),'measurement.json':JSON.stringify(measurement)}))fs.writeFileSync(path.join(root,file),bytes);
  const config={schema:'theme_lab_test_scenario_config.v1',runtime:{platform:'wikijump',implementation:'local',implementation_sha256:'0'.repeat(64),origin:'https://example.test'},branch_profile:{id:'scp-jp',locale:'ja',site_slug:'scp-jp',site_state:'site.json'},shell_profile:{id:'scp-jp-sigma9-shell',format:'rendered-html',files:{header:'header.html',sidebar:'sidebar.html'}},baseline:{id:'sigma9',css:'base.css',components:{credit:'credit.txt'}},theme:{id:'test-theme',css:'theme.css',base_css:'theme-base.css',source:'theme.txt'},corpus:{id:'canonical',manifest:'manifest.json',source:'corpus.txt',states:'states.json'},measurement:{id:'measurement',contract:'measurement.json'}};
  const first=materializeThemeTestScenario(root,config);
  fs.writeFileSync(path.join(root,'site.json'),JSON.stringify({...site,existing_pages:['existing','extra-existing']}));
  const second=materializeThemeTestScenario(root,config);
  assert.notEqual(first.scenario_sha256,second.scenario_sha256);
  assert.equal(first.scenario.branch_profile.id,'scp-jp');
  assert.match(first.scenario.theme.base_css_sha256,/^[0-9a-f]{64}$/u);
  assert.deepEqual(Object.keys(first.bindings.shell),['header','sidebar']);
  assert.equal(first.bindings.theme_asset_dir.path,'assets');
  assert.equal(first.bindings.theme_asset_dependencies.asset_dependencies[0]?.name,'header-logo.png');
});

test('scenario config rejects an artifact path escaping the Theme Lab root',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'theme-scenario-contained-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const outside=path.join(os.tmpdir(),`theme-scenario-outside-${process.pid}.txt`);fs.writeFileSync(outside,'outside');t.after(()=>fs.rmSync(outside,{force:true}));
  fs.writeFileSync(path.join(root,'header'),'header');
  fs.writeFileSync(path.join(root,'site'),JSON.stringify({schema:'theme_lab_site_state.v1',branch_profile:'scp-jp',locale:'ja',site_slug:'scp-jp',existing_pages:[],missing_pages:[],page_tags:[],session_profiles:[]}));
  fs.writeFileSync(path.join(root,'base'),'base');fs.writeFileSync(path.join(root,'component'),'component');fs.writeFileSync(path.join(root,'css'),'css');fs.writeFileSync(path.join(root,'source'),'source');fs.writeFileSync(path.join(root,'corpus'),'corpus');fs.writeFileSync(path.join(root,'measurement'),'measurement');
  fs.writeFileSync(path.join(root,'manifest'),JSON.stringify({schema:'theme_lab_canonical_corpus.v1',id:'corpus',source:'corpus',site_state_requirements:{},semantic_probes:[...CANONICAL_SEMANTIC_PROBES]}));
  fs.writeFileSync(path.join(root,'states'),JSON.stringify({schema:'theme_lab_canonical_corpus_states.v1',corpus:'corpus',viewports:['desktop','laptop','tablet','mobile','narrow-mobile'],session_profiles:[],interaction_states:[...CANONICAL_INTERACTION_STATES]}));
  fs.writeFileSync(path.join(root,'measurement'),JSON.stringify({schema:'theme_lab_measurement_contract.v1',id:'measurement',viewports:[{id:'desktop',width:1440,height:1000},{id:'laptop',width:1024,height:900},{id:'tablet',width:768,height:1024},{id:'mobile',width:390,height:844},{id:'narrow-mobile',width:320,height:800}],browser_engines:['chromium','firefox','webkit'],browser_version_policy:'exact-runtime-version',session_profiles:[],network_policy:'block-external-after-local-materialization'}));
  const config={schema:'theme_lab_test_scenario_config.v1',runtime:{platform:'wikijump',implementation:'local',implementation_sha256:'0'.repeat(64),origin:'https://example.test'},branch_profile:{id:'scp-jp',locale:'ja',site_slug:'scp-jp',site_state:'site'},shell_profile:{id:'scp-jp-sigma9-shell',format:'rendered-html',files:{header:'header'}},baseline:{id:'sigma9',css:'base',components:{credit:'component'}},theme:{id:'theme',css:'css',source:'source'},corpus:{id:'corpus',manifest:'manifest',source:'corpus',states:'states'},measurement:{id:'measurement',contract:'measurement'}};
  config.shell_profile.files.header=outside;
  assert.throws(()=>materializeThemeTestScenario(root,config),/escapes root/u);
});

test('scenario config fails when branch database state cannot satisfy corpus semantics',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'theme-scenario-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [file,bytes] of Object.entries({header:'header',base:'base',component:'component',css:'css',source:'source',corpus:'corpus'}))fs.writeFileSync(path.join(root,file),bytes);
  fs.writeFileSync(path.join(root,'site'),JSON.stringify({schema:'theme_lab_site_state.v1',branch_profile:'scp-jp',locale:'ja',site_slug:'scp-jp',existing_pages:[],missing_pages:['missing'],page_tags:['theme'],session_profiles:['anonymous']}));
  fs.writeFileSync(path.join(root,'manifest'),JSON.stringify({schema:'theme_lab_canonical_corpus.v1',id:'corpus',source:'corpus',site_state_requirements:{existing_pages:['required-existing'],missing_pages:['missing'],page_tags:['theme'],session_profiles:['anonymous']},semantic_probes:[...CANONICAL_SEMANTIC_PROBES]}));
  fs.writeFileSync(path.join(root,'states'),JSON.stringify({schema:'theme_lab_canonical_corpus_states.v1',corpus:'corpus',viewports:['desktop','laptop','tablet','mobile','narrow-mobile'],session_profiles:['anonymous'],interaction_states:[...CANONICAL_INTERACTION_STATES]}));
  fs.writeFileSync(path.join(root,'measurement'),JSON.stringify({schema:'theme_lab_measurement_contract.v1',id:'measurement',viewports:[{id:'desktop',width:1440,height:1000},{id:'laptop',width:1024,height:900},{id:'tablet',width:768,height:1024},{id:'mobile',width:390,height:844},{id:'narrow-mobile',width:320,height:800}],browser_engines:['chromium','firefox','webkit'],browser_version_policy:'exact-runtime-version',session_profiles:['anonymous'],network_policy:'block-external-after-local-materialization'}));
  const config={schema:'theme_lab_test_scenario_config.v1',runtime:{platform:'wikijump',implementation:'local',implementation_sha256:'0'.repeat(64),origin:'https://example.test'},branch_profile:{id:'scp-jp',locale:'ja',site_slug:'scp-jp',site_state:'site'},shell_profile:{id:'scp-jp-sigma9-shell',format:'rendered-html',files:{header:'header'}},baseline:{id:'sigma9',css:'base',components:{credit:'component'}},theme:{id:'theme',css:'css',source:'source'},corpus:{id:'corpus',manifest:'manifest',source:'corpus',states:'states'},measurement:{id:'measurement',contract:'measurement'}};
  assert.throws(()=>materializeThemeTestScenario(root,config),/does not satisfy corpus existing_pages/u);
});

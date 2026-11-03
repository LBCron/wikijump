import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {themeScenarioConfigForPackage} from '../src/theme-scenario-factory.mjs';
import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('package scenario factory changes only the theme axis of a generation template',()=>{
  const config=themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'bedrock'});
  assert.equal(config.theme.id,'bedrock');
  assert.equal(config.theme.css,'ports/bedrock/candidate.css');
  assert.equal(config.theme.source,'ports/bedrock/candidate.wikidot.source.txt');
  assert.equal(config.theme.base_css,undefined);
  const materialized=materializeThemeTestScenario(root,config);
  assert.equal(materialized.scenario.theme.id,'bedrock');
  assert.equal(materialized.scenario.theme.base_css_sha256,null);
});

test('package scenario factory binds declared candidate-base CSS without changing generation identity',()=>{
  const sigma9=themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'site'});
  const sigma10=themeScenarioConfigForPackage(root,{generation:'sigma10',packageName:'site'});
  assert.equal(sigma9.theme.base_css,'ports/site/candidate-base.css');
  assert.equal(sigma10.theme.base_css,'ports/site/candidate-base.css');
  const left=materializeThemeTestScenario(root,sigma9),right=materializeThemeTestScenario(root,sigma10);
  assert.equal(left.scenario.theme.base_css_sha256,right.scenario.theme.base_css_sha256);
  assert.notEqual(left.scenario.baseline.id,right.scenario.baseline.id);
  assert.notEqual(left.scenario.shell_profile.id,right.scenario.shell_profile.id);
});

test('package scenario factory fails closed on unknown packages and generations',()=>{
  assert.throws(()=>themeScenarioConfigForPackage(root,{generation:'sigma11',packageName:'bedrock'}),/unsupported canonical scenario generation/u);
  assert.throws(()=>themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'not-a-real-theme'}),/not-a-real-theme/u);
});


test('package scenario factory binds an explicit task-owned run contract origin',()=>{
  const contractRoot=path.join(root,'ports/current-acceptance');fs.mkdirSync(contractRoot,{recursive:true});
  const contractPath=path.join(contractRoot,`run-contract-scenario-factory-${process.pid}-sigma9.json`);
  assert.equal(fs.existsSync(contractPath),false);
  try{
    const contract=JSON.parse(fs.readFileSync(path.join(root,'ports/current-acceptance/run-contract.json'),'utf8'));
    contract.target_site={...contract.target_site,origin:'https://scpaiueouiuiuiui.wikijump.localhost:3396',slug:'scpaiueouiuiuiui',locale:'ja'};
    contract.baseline_theme={...contract.baseline_theme,name:'Sigma-9'};
    fs.writeFileSync(contractPath,JSON.stringify(contract));
    const relative=path.relative(root,contractPath).split(path.sep).join('/');
    const config=themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'bedrock',runContract:relative});
    const materialized=materializeThemeTestScenario(root,config);
    assert.equal(config.runtime.origin,'https://scpaiueouiuiuiui.wikijump.localhost:3396');
    assert.equal(materialized.scenario.runtime.origin,'https://scpaiueouiuiuiui.wikijump.localhost:3396');
    const wrongSite={...contract,target_site:{...contract.target_site,slug:'scp-jp'}};
    fs.writeFileSync(contractPath,JSON.stringify(wrongSite));
    assert.throws(()=>themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'bedrock',runContract:relative}),/does not match the scenario branch profile/u);
    const wrongBaseline={...contract,baseline_theme:{...contract.baseline_theme,name:'Sigma-10'}};
    fs.writeFileSync(contractPath,JSON.stringify(wrongBaseline));
    assert.throws(()=>themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'bedrock',runContract:relative}),/baseline does not match sigma9/u);
    const badOrigin={...contract,target_site:{...contract.target_site,origin:'https://example.com:3396'}};
    fs.writeFileSync(contractPath,JSON.stringify(badOrigin));
    assert.throws(()=>themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'bedrock',runContract:relative}),/origin must be the HTTPS local Wikijump site/u);
  }finally{fs.rmSync(contractPath,{force:true})}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scenario=path.join(root,'scenarios/jp-sigma9-extra-black-canonical.json');

test('scenario plan CLI consumes an exact live site-state record and emits saved-page session inputs',()=>{
  const config=JSON.parse(fs.readFileSync(scenario,'utf8'));
  const materialized=materializeThemeTestScenario(root,config);
  const base={schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,site_id:17,site_slug:'scpaiueouiuiuiui',declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,observed:{}};
  const record={...base,receipt_sha256:crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex')};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'theme-scenario-cli-'));
  try{
    const receiptPath=path.join(dir,'site.json');fs.writeFileSync(receiptPath,JSON.stringify(record));
    const output=JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/theme-scenario-plan.mjs'),'--file',scenario,'--site-state',receiptPath],{encoding:'utf8'}));
    assert.equal(output.session_server_ready,true);
    assert.equal(output.candidate_url,`${materialized.scenario.runtime.origin}/run-owned%3Atheme-lab-canonical-corpus-v1`);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

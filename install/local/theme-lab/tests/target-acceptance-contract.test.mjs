import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {RECORDED_TARGET_PAGE_RUNTIME_SHA256,TARGET_ACCEPTANCE_CONTRACT,TARGET_ACCEPTANCE_CONTRACT_FUNCTIONS,TARGET_ACCEPTANCE_CONTRACT_SHA256,targetAcceptanceContractSha256} from '../src/target-acceptance-contract.mjs';
import {isAdmittedTargetAcceptanceContract} from '../src/target-acceptance-instruments.mjs';

const lab=fileURLToPath(new URL('../',import.meta.url));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(lab,file))).digest('hex');

test('target acceptance contract binds every static fixture consumed by full acceptance',()=>{
  assert.equal(TARGET_ACCEPTANCE_CONTRACT.static_inputs.runtime_surface_parity_sha256,sha('fixtures/runtime-surface-parity.json'));
  assert.equal(TARGET_ACCEPTANCE_CONTRACT.static_inputs.surface_contract_fixture_sha256,sha('ports/interactive-visual-fixture/fixture.wikidot.txt'));
  assert.equal(TARGET_ACCEPTANCE_CONTRACT.static_inputs.torture_fixture_sha256,sha('fixtures/theme-torture.wikidot.txt'));
  assert.match(TARGET_ACCEPTANCE_CONTRACT.program_module_closure_sha256,/^[0-9a-f]{64}$/u);
  assert.match(TARGET_ACCEPTANCE_CONTRACT_SHA256,/^[0-9a-f]{64}$/u);
});

test('the instrument digest substitutes the recorded runtime value',()=>{
  // Runtime independence: the live runtime surface is recorded on verdicts
  // (target_page_runtime_sha256), never inside the instrument identity, so
  // perturbing it cannot move the digest.
  const runtimeMoved={...TARGET_ACCEPTANCE_CONTRACT,static_inputs:{...TARGET_ACCEPTANCE_CONTRACT.static_inputs,target_page_runtime_sha256:'a'.repeat(64)}};
  assert.equal(targetAcceptanceContractSha256(runtimeMoved),TARGET_ACCEPTANCE_CONTRACT_SHA256);
  assert.equal(targetAcceptanceContractSha256(),TARGET_ACCEPTANCE_CONTRACT_SHA256);
  assert.match(RECORDED_TARGET_PAGE_RUNTIME_SHA256,/^[0-9a-f]{64}$/u);
});

test('the instrument digest moves with any other contract field or the function list',()=>{
  const toleranceMoved={...TARGET_ACCEPTANCE_CONTRACT,viewport_overflow:{...TARGET_ACCEPTANCE_CONTRACT.viewport_overflow,tolerance_px:TARGET_ACCEPTANCE_CONTRACT.viewport_overflow.tolerance_px+1}};
  assert.notEqual(targetAcceptanceContractSha256(toleranceMoved),TARGET_ACCEPTANCE_CONTRACT_SHA256);
  const fixtureMoved={...TARGET_ACCEPTANCE_CONTRACT,static_inputs:{...TARGET_ACCEPTANCE_CONTRACT.static_inputs,torture_fixture_sha256:'b'.repeat(64)}};
  assert.notEqual(targetAcceptanceContractSha256(fixtureMoved),TARGET_ACCEPTANCE_CONTRACT_SHA256);
  assert.notEqual(targetAcceptanceContractSha256(TARGET_ACCEPTANCE_CONTRACT,TARGET_ACCEPTANCE_CONTRACT_FUNCTIONS.slice(1)),TARGET_ACCEPTANCE_CONTRACT_SHA256);
  assert.notEqual(targetAcceptanceContractSha256(TARGET_ACCEPTANCE_CONTRACT,[...TARGET_ACCEPTANCE_CONTRACT_FUNCTIONS,()=>0]),TARGET_ACCEPTANCE_CONTRACT_SHA256);
});

test('the live instrument digest is admitted in the registry',()=>{
  assert.equal(isAdmittedTargetAcceptanceContract(TARGET_ACCEPTANCE_CONTRACT_SHA256),true);
});

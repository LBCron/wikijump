import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {faithfulDesignExemptionsState,loadFaithfulDesignExemptions,matchFullCheckWaivers,matchFaithfulDesignContainment,verifyFaithfulDesignWaivers,finalizeVisualAcceptance,surfaceOverflowSourcesChainSha256,surfaceFindingCanonicalSha256,FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA} from '../src/finalize-visual-acceptance.mjs';
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from '../src/target-acceptance-contract.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const readPackageFile=name=>fs.readFileSync(new URL(`../ports/cosmonaut/${name}`,import.meta.url),'utf8');
const ledgerEntry=()=>loadFaithfulDesignExemptions().entries.find(entry=>entry.id==='G2-47-cosmonaut-hovertip');
const findingFromSpec=spec=>({severity:'error',kind:spec.kind,viewport:spec.viewport,overflow_px:spec.overflow_px,document_overflow_px:spec.document_overflow_px,viewport_escape_px:spec.viewport_escape_px,baseline_overflow_px:spec.baseline_overflow_px,baseline_document_overflow_px:spec.baseline_document_overflow_px,baseline_viewport_escape_px:spec.baseline_viewport_escape_px,overflow_sources:spec.selectors.map(selector=>({selector}))});
const syntheticResult=entry=>({target_acceptance_contract_sha256:entry.target_acceptance_contract_sha256,candidate_css_sha256:entry.candidate_css_sha256,candidate_source_sha256:entry.candidate_source_sha256,full_check_input_bindings:{sha256:entry.full_check_input_bindings_sha256},target_acceptance:{status:'fail',findings:entry.findings.map(findingFromSpec)}});

test('the committed ledger carries the authorized G2-47 cosmonaut entry first',()=>{
 const document=loadFaithfulDesignExemptions();
 assert.equal(document.schema,FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA);
 assert.equal(document.entries.length,109);
 assert.deepEqual(document.entries.map(entry=>entry.id),['G2-47-cosmonaut-hovertip','OD-T3-a-ouroborous-surface-history','OD-T3-a-scp-offices-surface-history','OD-T1-space-02afa837c959-S9','OD-T1-scp-offices-theme-37839c0b0cf8-S9','OD-T1-scp-offices-theme-d4b81ae7315e-S9','OD-T1-scp-offices-theme-7a6b757cf218-S9','OD-T1-scp-offices-theme-d87a27fbbba4-S9','OD-T1-scp-offices-theme-a7f32326b13d-S9','OD-T1-scp-offices-theme-3ac22b1b626c-S9','OD-T1-scp-offices-theme-a474425e1fe7-S9','OD-T1-scp-offices-theme-a3a2df2a042f-S9','OD-T1-scp-offices-theme-db875d2f9004-S9','OD-T1-ouroborous-theme-91b93f1a719e-S9','OD-T1-ouroborous-theme-33b406d117b9-S9','OD-T1-ouroborous-theme-d9f39b4bcef1-S9','OD-T1-ouroborous-theme-9087cb4759f7-S9','OD-T1-ouroborous-theme-255a1834391c-S9','OD-T1-ouroborous-theme-2fa21d25fe52-S9','OD-T1-ouroborous-theme-89c01e014b36-S9','OD-T1-ouroborous-theme-91554d89fa9f-S9','OD-T1-ouroborous-theme-17bbe719543e-S9','OD-T1-classic-494ca1fdb724-S10','OD-T1-classic-4cf168bcf5e0-S10','OD-T1-classic-6da12d88a68c-S10','OD-T1-classic-b15ba66865ce-S10','OD-T1-classic-73dbb05e66de-S10','OD-T1-classic-696d8bca53ee-S10','OD-T1-classic-1c61f33b3e55-S10','OD-T1-classic-2fd60e09fd6a-S10','OD-T1-classic-de9f133be45e-S10','OD-T1-classic-83b5d4419cb0-S10','OD-T1-classic-10ed32fd1ad8-S10','OD-T1-classic-15092a4aed88-S10','OD-T1-classic-273ed028526f-S10','OD-T1-classic-9fa853965702-S10','OD-T1-classic-1f45e217b060-S10','OD-T1-classic-a75bda189cad-S10','OD-T1-classic-18f4bca8866b-S10','OD-T1-classic-720b12392c42-S10','OD-T1-classic-945b321f98d8-S10','OD-T1-classic-7c40dcfafa8f-S10','OD-T1-classic-e98fba2fa404-S10','OD-T1-classic-69a956d1be37-S10','OD-T1-classic-5902c454ffde-S10','OD-T1-classic-8a510db2ef1b-S10','OD-T1-classic-11696895ba7f-S10','OD-T1-classic-2f8bb6ec7734-S10','OD-T1-classic-cb0f6cc3c615-S10','OD-T1-classic-317be888905f-S10','OD-T1-flopstyle-dark-30241dabbe11-S10','OD-T1-flopstyle-dark-20fded74da98-S10','OD-T1-flopstyle-dark-8196d9c49726-S10','OD-T1-flopstyle-dark-374ce90e9fbf-S10','OD-T1-flopstyle-dark-fff3e5c60a02-S10','OD-T1-flopstyle-dark-b58a163d82c3-S10','OD-T1-flopstyle-dark-af66b38e4553-S10','OD-T1-ouroborous-theme-91b93f1a719e-S10','OD-T1-ouroborous-theme-33b406d117b9-S10','OD-T1-ouroborous-theme-d9f39b4bcef1-S10','OD-T1-ouroborous-theme-9087cb4759f7-S10','OD-T1-ouroborous-theme-255a1834391c-S10','OD-T1-ouroborous-theme-2fa21d25fe52-S10','OD-T1-ouroborous-theme-89c01e014b36-S10','OD-T1-ouroborous-theme-91554d89fa9f-S10','OD-T1-ouroborous-theme-17bbe719543e-S10','OD-T1-penumbra-c6a5595f56af-S10','OD-T1-penumbra-cf8ac0887787-S10','OD-T1-penumbra-3b54e7db75db-S10','OD-T1-penumbra-0712cb8c4c0c-S10','OD-T1-penumbra-b176de419098-S10','OD-T1-penumbra-1213edb2665a-S10','OD-T1-penumbra-686a82af25a4-S10','OD-T1-penumbra-f043c868a587-S10','OD-T1-penumbra-6a4752ea5c0b-S10','OD-T1-penumbra-c484da95e8df-S10','OD-T1-penumbra-bf61886d2eea-S10','OD-T1-penumbra-bd6dda8cfdea-S10','OD-T1-penumbra-75ba37e2f09c-S10','OD-T1-penumbra-97cbc12838e7-S10','OD-T1-penumbra-a6aa1c3b63bf-S10','OD-T1-penumbra-adfaba29675d-S10','OD-T1-penumbra-a776a9f39380-S10','OD-T1-penumbra-d19a34dde3b9-S10','OD-T1-penumbra-948a687bcc5a-S10','OD-T1-penumbra-ae3d807df4b2-S10','OD-T1-penumbra-fafd7bb6f9bc-S10','OD-T1-penumbra-1fe46e843745-S10','OD-T1-penumbra-f7c7de8dab0a-S10','OD-T1-penumbra-a54107b0fa35-S10','OD-T1-penumbra-995a6d8c0c48-S10','OD-T1-penumbra-d3cd6a4af259-S10','OD-T1-penumbra-7631ab1c7547-S10','OD-T1-penumbra-5b4e8a30c9a5-S10','OD-T1-scp-offices-theme-37839c0b0cf8-S10','OD-T1-scp-offices-theme-d4b81ae7315e-S10','OD-T1-scp-offices-theme-7a6b757cf218-S10','OD-T1-scp-offices-theme-d87a27fbbba4-S10','OD-T1-scp-offices-theme-a7f32326b13d-S10','OD-T1-scp-offices-theme-3ac22b1b626c-S10','OD-T1-scp-offices-theme-a474425e1fe7-S10','OD-T1-scp-offices-theme-a3a2df2a042f-S10','OD-T1-scp-offices-theme-db875d2f9004-S10','OD-T1-space-02afa837c959-S10','OD-T1-classic-1ed279319fce-S10','OD-T1-penumbra-2a44b2f5d47d-S10','OD-T1-flopstyle-dark-694bc4d38fb8-S10','OD-T1-classic-bafb85e5f175-S10','OD-T1-penumbra-545d241220a4-S10']);
 const entry=document.entries[0];
 assert.equal(entry.id,'G2-47-cosmonaut-hovertip');
 assert.equal(entry.decision,'G2-47');
 assert.equal(entry.package,'cosmonaut');
 assert.equal(entry.instrument,'full_check_target');
 // The committed ledger's full_check_target entries rebind to the
 // #3381 successor instrument (the rebind the #3381 design anticipates
 // for an instrument change); the registry admits it alongside the
 // closure anchor (src/target-acceptance-instruments.mjs).
 assert.equal(entry.target_acceptance_contract_sha256,'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb');
 assert.equal(entry.candidate_css_sha256,sha(readPackageFile('candidate.css')));
 assert.equal(entry.candidate_source_sha256,sha(readPackageFile('candidate.wikidot.source.txt')));
 const bytes=fs.readFileSync(new URL('../ports/current-acceptance/faithful-design-exemptions.json',import.meta.url));
 assert.equal(faithfulDesignExemptionsState().sha256,sha(bytes));
});

test('full-check waivers match exactly and any drift re-fails the finding',()=>{
 const entry=ledgerEntry();const document=loadFaithfulDesignExemptions();
 assert.equal(matchFullCheckWaivers(document,syntheticResult(entry)).length,5);
 const perturbedPx=syntheticResult(entry);perturbedPx.target_acceptance.findings[0].overflow_px=401;
 assert.equal(matchFullCheckWaivers(document,perturbedPx).length,4);
 const perturbedSelectors=syntheticResult(entry);perturbedSelectors.target_acceptance.findings[1].overflow_sources.pop();
 assert.equal(matchFullCheckWaivers(document,perturbedSelectors).length,4);
 const wrongCandidate=syntheticResult(entry);wrongCandidate.candidate_css_sha256='0'.repeat(64);
 assert.equal(matchFullCheckWaivers(document,wrongCandidate).length,0);
 assert.equal(matchFullCheckWaivers({schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[]},syntheticResult(entry)).length,0);
 assert.equal(matchFullCheckWaivers(null,syntheticResult(entry)).length,0);
});

async function cosmonautFinalize(t,{perturbFindingPx=false,perturbViewportRow=false}={}){
 const entry=ledgerEntry();
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'theme-lab-ledger-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const candidate=path.join(dir,'candidate.png'),reference=path.join(dir,'reference.png');
 await fsp.writeFile(candidate,'candidate');await fsp.writeFile(reference,'reference');
 const inputs={css:readPackageFile('candidate.css'),source:readPackageFile('candidate.wikidot.source.txt'),preview:readPackageFile('candidate.wikidot.txt')};
 const viewports=['desktop','laptop','tablet','mobile','narrow-mobile'];
 const findings=entry.findings.map(findingFromSpec);
 if(perturbFindingPx)findings[2].overflow_px=401;
 const result={target_acceptance_contract_sha256:TARGET_ACCEPTANCE_CONTRACT_SHA256,next_actions:[],candidate_css_sha256:entry.candidate_css_sha256,candidate_source_sha256:entry.candidate_source_sha256,candidate_preview_sha256:sha(inputs.preview),candidate_base_css_sha256:null,full_check_input_bindings:{sha256:entry.full_check_input_bindings_sha256},verification_scope:{mode:'full',deferred:[]},port_decision:{verdict:'pass'},target_acceptance:{status:'fail',visual_status:'inconclusive',issue_count:27,style_change_count:40,torture_changed_component_count:11,findings:[...findings,{severity:'warn',kind:'local_style_delta'}]},overall_acceptance:{status:'fail',port_verdict:'pass',target_status:'fail'},verdict:'fail',viewport_status:Object.fromEntries(entry.findings.map(spec=>[spec.viewport,{status:'fail',viewport_escape_px:spec.viewport_escape_px+(perturbViewportRow&&spec.viewport==='desktop'?1:0),document_overflow_px:spec.document_overflow_px}])),font_diagnostics:{status:'measured',fonts:[{glyph_count:1}]},torture:'pass',visual:{viewports:Object.fromEntries(viewports.map(id=>[id,{candidate_path:candidate,reference_path:reference,comparison_status:'fail',normalized_rmse:.4}]))}};
 const review={schema:'theme_lab_visual_acceptance.v1',candidate_css_sha256:entry.candidate_css_sha256,candidate_source_sha256:entry.candidate_source_sha256,candidate_preview_sha256:sha(inputs.preview),viewports:Object.fromEntries(viewports.map(id=>[id,{status:'pass',candidate_screenshot_sha256:sha('candidate'),reference_screenshot_sha256:sha('reference'),reviewed_at:new Date().toISOString(),reviewer:'test reviewer',note:'Parked hovertip state reviewed against the G2-47 record.'}]))};
 return finalizeVisualAcceptance({result,review,...inputs,fullCheckInputBindings:{sha256:entry.full_check_input_bindings_sha256}});
}

test('finalize completes a target failing only through waived findings and reports the waiver',async t=>{
 const accepted=await cosmonautFinalize(t);
 assert.equal(accepted.overall_acceptance.status,'warn');
 assert.equal(accepted.target_acceptance.status,'warn');
 const marked=accepted.target_acceptance.findings.filter(finding=>finding.exemption);
 assert.equal(marked.length,5);
 assert.ok(marked.every(finding=>finding.exemption.entry_id==='G2-47-cosmonaut-hovertip'&&finding.exemption.decision==='G2-47'));
 assert.equal(accepted.target_acceptance.findings.at(-1).exemption,undefined);
 for(const viewport of ['desktop','laptop','tablet','mobile','narrow-mobile']){
  assert.equal(accepted.viewport_status[viewport].status,'pass');
  assert.deepEqual(accepted.viewport_status[viewport].exemption_entry_ids,['G2-47-cosmonaut-hovertip']);
  assert.equal(accepted.viewport_status[viewport].viewport_escape_px,400);
 }
 assert.equal(accepted.faithful_design_exemptions.schema,FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA);
 assert.equal(accepted.faithful_design_exemptions.ledger_sha256,faithfulDesignExemptionsState().sha256);
 assert.equal(accepted.faithful_design_exemptions.waivers.length,5);
 assert.equal(accepted.faithful_design_exemptions.waivers[0].measured.overflow_px,400);
 assert.equal(accepted.faithful_design_exemptions.waivers[0].target_status_original,'fail');
 assert.deepEqual(verifyFaithfulDesignWaivers(accepted,'cosmonaut'),[]);
});

test('finalize still refuses when one finding or viewport row drifts from the ledger',async t=>{
 await assert.rejects(cosmonautFinalize(t,{perturbFindingPx:true}),/unresolved nonvisual work/);
 await assert.rejects(cosmonautFinalize(t,{perturbViewportRow:true}),/cannot override failed target checks/);
});

test('completion waiver verification rejects tampered or foreign waiver blocks',async t=>{
 const accepted=await cosmonautFinalize(t);
 const missing=structuredClone(accepted);missing.faithful_design_exemptions.waivers.pop();
 assert.ok(verifyFaithfulDesignWaivers(missing,'cosmonaut').length>0);
 const stale=structuredClone(accepted);stale.faithful_design_exemptions.ledger_sha256='0'.repeat(64);
 assert.ok(verifyFaithfulDesignWaivers(stale,'cosmonaut').length>0);
 assert.ok(verifyFaithfulDesignWaivers(accepted,'basalt').length>0);
 assert.deepEqual(verifyFaithfulDesignWaivers({target_acceptance:{findings:[]}},'cosmonaut'),[]);
 const unmarked=structuredClone(accepted);delete unmarked.faithful_design_exemptions;
 assert.ok(verifyFaithfulDesignWaivers(unmarked,'cosmonaut').length>0);
});

test('containment exemptions match exactly, including the certified-remedy-conflict class',()=>{
 const key=JSON.stringify(['ouroborous-theme','chromium','mobile','page.history','settled']);
 const document={schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[
  {id:'OD-T1-ouroborous-history',decision:'OD-T1',package:'ouroborous-theme',instrument:'semantic_document_containment',match:{observation_key:key,candidate_overflow_px:52,baseline_overflow_px:0,dependencies_sha256:'a'.repeat(64)}},
  {id:'OD-T2-hansarp-history-fallback',decision:'certified-remedy-conflict',package:'hansarp',instrument:'semantic_document_containment',match:{observation_key:JSON.stringify(['hansarp','chromium','narrow-mobile','page.history','settled']),candidate_overflow_px:5,baseline_overflow_px:0,dependencies_sha256:'b'.repeat(64)}}]};
 const tuple={theme:'ouroborous-theme',observationKey:key,candidateOverflowPx:52,baselineOverflowPx:0,dependenciesSha256:'a'.repeat(64)};
 assert.equal(matchFaithfulDesignContainment(document,tuple)?.id,'OD-T1-ouroborous-history');
 assert.equal(matchFaithfulDesignContainment(document,{...tuple,candidateOverflowPx:53}),null);
 assert.equal(matchFaithfulDesignContainment(document,{...tuple,baselineOverflowPx:1}),null);
 assert.equal(matchFaithfulDesignContainment(document,{...tuple,dependenciesSha256:'c'.repeat(64)}),null);
 assert.equal(matchFaithfulDesignContainment(document,{...tuple,theme:'space'}),null);
 const fallback=matchFaithfulDesignContainment(document,{theme:'hansarp',observationKey:JSON.stringify(['hansarp','chromium','narrow-mobile','page.history','settled']),candidateOverflowPx:5,baselineOverflowPx:0,dependenciesSha256:'b'.repeat(64)});
 assert.equal(fallback?.decision,'certified-remedy-conflict');
});

// --- OD-T3-a surface_new_viewport_overflow variant ---
// The chains below are the exact ordered overflow_sources arrays recorded in
// the TL-02 full-check raw results (runtime tree, tl02-*-full/raw-result.json).
const OUROBOROUS_CHAIN=[{"selector": "table.form", "tag": "table", "class_name": "form", "inside_page_content": false, "ancestors": ["#history-form-1", "#action-area", "#main-content", "#content-wrap", "#container"], "rect": {"left": 15.5, "right": 457.5, "width": 442}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "442px", "min_width": "0px", "max_width": "100%", "position": "static", "overflow_x": "visible"}}, {"selector": "tbody", "tag": "tbody", "class_name": "", "inside_page_content": false, "ancestors": ["table.form", "#history-form-1", "#action-area", "#main-content", "#content-wrap"], "rect": {"left": 15.5, "right": 457.5, "width": 442}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "442px", "min_width": "0px", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "tr", "tag": "tr", "class_name": "", "inside_page_content": false, "ancestors": ["tbody", "table.form", "#history-form-1", "#action-area", "#main-content"], "rect": {"left": 321.5, "right": 457.5, "width": 136}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "136px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 353.3, "right": 457.5, "width": 104.2}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "99px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 353.3, "right": 457.5, "width": 104.2}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "104.188px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}];
const SCP_OFFICES_CHAIN=[{"selector": "table.form", "tag": "table", "class_name": "form", "inside_page_content": false, "ancestors": ["#history-form-1", "#action-area", "#main-content", "#content-wrap", "#container"], "rect": {"left": 15.5, "right": 475.5, "width": 460}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "460px", "min_width": "0px", "max_width": "100%", "position": "static", "overflow_x": "visible"}}, {"selector": "tbody", "tag": "tbody", "class_name": "", "inside_page_content": false, "ancestors": ["table.form", "#history-form-1", "#action-area", "#main-content", "#content-wrap"], "rect": {"left": 15.5, "right": 475.5, "width": 460}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "460px", "min_width": "0px", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "tr", "tag": "tr", "class_name": "", "inside_page_content": false, "ancestors": ["tbody", "table.form", "#history-form-1", "#action-area", "#main-content"], "rect": {"left": 339.5, "right": 475.5, "width": 136}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "136px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 356.3, "right": 475.5, "width": 119.2}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "114px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 356.3, "right": 475.5, "width": 119.2}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "119.188px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}];
const surfaceEntry=id=>loadFaithfulDesignExemptions().entries.find(entry=>entry.id===id);
const readThemeFile=(pkg,name)=>fs.readFileSync(new URL(`../ports/${pkg}/${name}`,import.meta.url),'utf8');
// The whole TL-02 finding objects, verbatim: the finding canonical hash
// binds every key of these objects, not only the overflow chain.
const SURFACE_FINDINGS={'OD-T3-a-ouroborous-surface-history':{"severity": "error", "kind": "surface_new_viewport_overflow", "surface": "page.history", "state": "history-list", "viewport": "mobile", "before_px": 0, "after_px": 67, "overflow_sources": [{"selector": "table.form", "tag": "table", "class_name": "form", "inside_page_content": false, "ancestors": ["#history-form-1", "#action-area", "#main-content", "#content-wrap", "#container"], "rect": {"left": 15.5, "right": 457.5, "width": 442}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "442px", "min_width": "0px", "max_width": "100%", "position": "static", "overflow_x": "visible"}}, {"selector": "tbody", "tag": "tbody", "class_name": "", "inside_page_content": false, "ancestors": ["table.form", "#history-form-1", "#action-area", "#main-content", "#content-wrap"], "rect": {"left": 15.5, "right": 457.5, "width": 442}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "442px", "min_width": "0px", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "tr", "tag": "tr", "class_name": "", "inside_page_content": false, "ancestors": ["tbody", "table.form", "#history-form-1", "#action-area", "#main-content"], "rect": {"left": 321.5, "right": 457.5, "width": 136}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "136px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 353.3, "right": 457.5, "width": 104.2}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "99px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 353.3, "right": 457.5, "width": 104.2}, "overflow_px": 67.5, "off_left_px": 0, "off_right_px": 67.5, "computed": {"width": "104.188px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}], "parity_review": {"status": "INSUFFICIENT_EVIDENCE", "surface_ids": ["content.article", "content.table", "page.history", "page.normal", "shell.container"], "may_treat_differences_as_port_requirements": false, "port_conclusion_eligible": false, "blocks_port_conclusion": false, "quarantined": true, "conclusion_resolution": "LOCAL_TARGET_ACCEPTANCE_ONLY", "decision_authority": "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY", "reason": "The finding remains in SCP-JP local target acceptance; it cannot establish Wikidot parity or a parity-based port requirement."}},'OD-T3-a-scp-offices-surface-history':{"severity": "error", "kind": "surface_new_viewport_overflow", "surface": "page.history", "state": "history-list", "viewport": "mobile", "before_px": 0, "after_px": 85, "overflow_sources": [{"selector": "table.form", "tag": "table", "class_name": "form", "inside_page_content": false, "ancestors": ["#history-form-1", "#action-area", "#main-content", "#content-wrap", "#container"], "rect": {"left": 15.5, "right": 475.5, "width": 460}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "460px", "min_width": "0px", "max_width": "100%", "position": "static", "overflow_x": "visible"}}, {"selector": "tbody", "tag": "tbody", "class_name": "", "inside_page_content": false, "ancestors": ["table.form", "#history-form-1", "#action-area", "#main-content", "#content-wrap"], "rect": {"left": 15.5, "right": 475.5, "width": 460}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "460px", "min_width": "0px", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "tr", "tag": "tr", "class_name": "", "inside_page_content": false, "ancestors": ["tbody", "table.form", "#history-form-1", "#action-area", "#main-content"], "rect": {"left": 339.5, "right": 475.5, "width": 136}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "136px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 356.3, "right": 475.5, "width": 119.2}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "114px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}, {"selector": "td", "tag": "td", "class_name": "", "inside_page_content": false, "ancestors": ["tr", "tbody", "table.form", "#history-form-1", "#action-area"], "rect": {"left": 356.3, "right": 475.5, "width": 119.2}, "overflow_px": 85.5, "off_left_px": 0, "off_right_px": 85.5, "computed": {"width": "119.188px", "min_width": "auto", "max_width": "none", "position": "static", "overflow_x": "visible"}}], "parity_review": {"status": "INSUFFICIENT_EVIDENCE", "surface_ids": ["content.article", "content.table", "page.history", "page.normal", "shell.container"], "may_treat_differences_as_port_requirements": false, "port_conclusion_eligible": false, "blocks_port_conclusion": false, "quarantined": true, "conclusion_resolution": "LOCAL_TARGET_ACCEPTANCE_ONLY", "decision_authority": "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY", "reason": "The finding remains in SCP-JP local target acceptance; it cannot establish Wikidot parity or a parity-based port requirement."}}};
const surfaceFinding=(entry)=>structuredClone(SURFACE_FINDINGS[entry.id]);
const surfaceResult=(entry,chain)=>({target_acceptance_contract_sha256:entry.target_acceptance_contract_sha256,candidate_css_sha256:entry.candidate_css_sha256,candidate_source_sha256:entry.candidate_source_sha256,candidate_preview_sha256:entry.candidate_preview_sha256,candidate_base_css_sha256:entry.candidate_base_css_sha256,full_check_input_bindings:{sha256:entry.full_check_input_bindings_sha256},target_acceptance:{status:'fail',findings:[surfaceFinding(entry,chain)]}});

test('OD-T3-a entries carry the exact TL-02 bindings and claim no reference parity',()=>{
 const expected={
  'OD-T3-a-ouroborous-surface-history':{package:'ouroborous-theme',css:'0102ff1156947176ae4bca48829e758982331d11c45df6b7b8f8ef5d453d402e',source:'ec5eadaa0d7f13636259c8209ad6f5ab2f20c52a882ed92a59ebcd2f7469299d',preview:'cf7f337ed0cc7b6d651bf58887aa7c58259f9ad646b32df459b4d28de697c5a8',inputs:'b3f6af7b052294a6407700f0dba6c6f22799c83aef32dfc44e979a1caf32b54b',raw:'613b2671d98a91b23c550615fefb668717a50847531b8dcb0a9dedc93a00b32f',chain:'0817205ccec880ca137054307fb690c5e3569c1637cde31d49b2fe544d5a3b5e',findingHash:'5427e20788c79fba400b23d79f972b80f2d2cf5043bef1327389b37e1242cc76',after:67,width:442,chainRows:OUROBOROUS_CHAIN},
  'OD-T3-a-scp-offices-surface-history':{package:'scp-offices-theme',css:'f3d5d0cec11e9092bed5913399d302ed8a19dea98a4e43ee71845afe4e803545',source:'1fb480f19fd71c9d78ba365e5d88d5668ce46b722546f514b795a83b74eb82c8',preview:'c1232435af36eeeee5d2d5c5b548832f7b8d7f5e66b5485af3d7eba0b80f4213',inputs:'abc7e2553b8a7b02e22390f399a385051f22c0a134910d28292d6de782dcf872',raw:'dc19675e426ea3e0f8142699ec5165642fb4be8a3596a9a57500c087e0575759',chain:'2691dc99dc39092d6d96b4964908970e005b0401c65731ae34d207e28c5fc10b',findingHash:'6ef09bb339b7610f6607301c1ae24ec4880138ff86bfe81d74e56a98f686028c',after:85,width:460,chainRows:SCP_OFFICES_CHAIN}};
 for(const [id,want] of Object.entries(expected)){
  const entry=surfaceEntry(id);
  assert.ok(entry,id);
  assert.equal(entry.decision,'OD-T3-a');
  assert.equal(entry.package,want.package);
  assert.equal(entry.instrument,'full_check_target');
  assert.equal(entry.candidate_css_sha256,want.css);
  assert.equal(entry.candidate_source_sha256,want.source);
  assert.equal(entry.candidate_preview_sha256,want.preview);
  assert.equal(entry.candidate_base_css_sha256,null);
  assert.equal(entry.full_check_input_bindings_sha256,want.inputs);
  assert.equal(entry.full_check_raw_result_sha256,want.raw);
  assert.equal(entry.target_acceptance_contract_sha256,'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb'); // #3381 successor instrument, as rebound
  assert.equal(sha(readThemeFile(want.package,'candidate.css')),want.css);
  assert.equal(sha(readThemeFile(want.package,'candidate.wikidot.source.txt')),want.source);
  assert.equal(sha(readThemeFile(want.package,'candidate.wikidot.txt')),want.preview);
  const spec=entry.findings[0];
  assert.equal(entry.findings.length,1);
  assert.deepEqual({kind:spec.kind,surface:spec.surface,state:spec.state,viewport:spec.viewport,before_px:spec.before_px,after_px:spec.after_px},{kind:'surface_new_viewport_overflow',surface:'page.history',state:'history-list',viewport:'mobile',before_px:0,after_px:want.after});
  assert.equal(spec.overflow_sources_chain_sha256,want.chain);
  assert.equal(spec.overflow_sources_first.width,want.width);
  assert.equal(surfaceOverflowSourcesChainSha256(want.chainRows),want.chain);
  assert.equal(spec.finding_canonical_sha256,want.findingHash);
  assert.notEqual(spec.finding_canonical_sha256,spec.overflow_sources_chain_sha256);
  assert.equal(surfaceFindingCanonicalSha256(SURFACE_FINDINGS[id]),want.findingHash);
  // Basis is Q1-4 provenance only: the reference does not overflow.
  assert.match(entry.basis,/Q1-4 provenance only/);
  assert.match(entry.basis,/does NOT overflow/);
  assert.match(entry.basis,/does not claim parity with the reference/);
 }
});

test('OD-T3-a waivers match only the exact recorded surface findings',()=>{
 const document=loadFaithfulDesignExemptions();
 const ouroborous=surfaceEntry('OD-T3-a-ouroborous-surface-history');
 const offices=surfaceEntry('OD-T3-a-scp-offices-surface-history');
 const ouroborousResult=surfaceResult(ouroborous,OUROBOROUS_CHAIN);
 const officesResult=surfaceResult(offices,SCP_OFFICES_CHAIN);
 assert.deepEqual(matchFullCheckWaivers(document,ouroborousResult,{fullCheckRawResultSha256:ouroborous.full_check_raw_result_sha256}).map(w=>w.entry.id),['OD-T3-a-ouroborous-surface-history']);
 assert.deepEqual(matchFullCheckWaivers(document,officesResult,{fullCheckRawResultSha256:offices.full_check_raw_result_sha256}).map(w=>w.entry.id),['OD-T3-a-scp-offices-surface-history']);
 assert.equal(matchFullCheckWaivers(document,ouroborousResult).length,1);
 // Cross-package: neither entry waives the other package's finding.
 assert.equal(matchFullCheckWaivers({schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[offices]},ouroborousResult).length,0);
 assert.equal(matchFullCheckWaivers({schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[ouroborous]},officesResult).length,0);
});

test('OD-T3-a variant never matches any drifted kind, surface, state, viewport, package, chain, px or binding',()=>{
 const entry=surfaceEntry('OD-T3-a-ouroborous-surface-history');
 const options={fullCheckRawResultSha256:entry.full_check_raw_result_sha256};
 const noMatch=(label,mutate)=>{
  const document={schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[structuredClone(entry)]};
  const result=surfaceResult(entry,OUROBOROUS_CHAIN);
  mutate(result,document);
  assert.equal(matchFullCheckWaivers(document,result,options).length,0,label);
 };
 noMatch('other kind',result=>{result.target_acceptance.findings[0].kind='viewport_overflow';});
 noMatch('other surface kind',result=>{result.target_acceptance.findings[0].kind='surface_navigation_viewport_escape';});
 noMatch('other surface',result=>{result.target_acceptance.findings[0].surface='page.normal';});
 noMatch('other state',result=>{result.target_acceptance.findings[0].state='normal';});
 noMatch('same table at narrow-mobile',result=>{result.target_acceptance.findings[0].viewport='narrow-mobile';});
 noMatch('other viewport',result=>{result.target_acceptance.findings[0].viewport='desktop';});
 noMatch('hansarp package',(_result,document)=>{document.entries[0].package='hansarp';});
 noMatch('any other package',(_result,document)=>{document.entries[0].package='basalt';});
 noMatch('reordered source chain',result=>{const rows=result.target_acceptance.findings[0].overflow_sources;[rows[1],rows[2]]=[rows[2],rows[1]];});
 noMatch('different source chain measurement',result=>{result.target_acceptance.findings[0].overflow_sources[2].rect.width=137;});
 noMatch('first source inside page content',result=>{result.target_acceptance.findings[0].overflow_sources[0].inside_page_content=true;});
 noMatch('first source ancestors swapped',result=>{result.target_acceptance.findings[0].overflow_sources[0].ancestors[0]='#action-area';});
 noMatch('truncated source chain',result=>{result.target_acceptance.findings[0].overflow_sources.pop();});
 noMatch('after_px difference',result=>{result.target_acceptance.findings[0].after_px=68;});
 noMatch('no tolerance for fractional px',result=>{result.target_acceptance.findings[0].after_px=67.5;});
 noMatch('non-zero before_px',result=>{result.target_acceptance.findings[0].before_px=1;});
 noMatch('warn severity is not waived',result=>{result.target_acceptance.findings[0].severity='warn';});
 noMatch('candidate css drift',result=>{result.candidate_css_sha256='0'.repeat(64);});
 noMatch('candidate source drift',result=>{result.candidate_source_sha256='0'.repeat(64);});
 noMatch('candidate preview drift',result=>{result.candidate_preview_sha256='0'.repeat(64);});
 noMatch('candidate base drift',result=>{result.candidate_base_css_sha256='0'.repeat(64);});
 noMatch('input bindings drift',result=>{result.full_check_input_bindings.sha256='0'.repeat(64);});
 noMatch('contract drift',result=>{result.target_acceptance_contract_sha256='0'.repeat(64);});
 noMatch('spec px drift',(_result,document)=>{document.entries[0].findings[0].after_px=68;});
 noMatch('spec chain hash drift',(_result,document)=>{document.entries[0].findings[0].overflow_sources_chain_sha256='0'.repeat(64);});
 noMatch('spec finding canonical hash drift',(_result,document)=>{document.entries[0].findings[0].finding_canonical_sha256='0'.repeat(64);});
 noMatch('finding field outside the chain changes the whole-finding binding',result=>{result.target_acceptance.findings[0].parity_review.reason='drifted';});
 const wrongRaw=surfaceResult(entry,OUROBOROUS_CHAIN);
 assert.equal(matchFullCheckWaivers({schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[entry]},wrongRaw,{fullCheckRawResultSha256:'0'.repeat(64)}).length,0,'raw result drift');
});

async function ouroborousFinalize(t){
 const entry=surfaceEntry('OD-T3-a-ouroborous-surface-history');
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'theme-lab-odt3a-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 const candidate=path.join(dir,'candidate.png'),reference=path.join(dir,'reference.png');
 await fsp.writeFile(candidate,'candidate');await fsp.writeFile(reference,'reference');
 const inputs={css:readThemeFile('ouroborous-theme','candidate.css'),source:readThemeFile('ouroborous-theme','candidate.wikidot.source.txt'),preview:readThemeFile('ouroborous-theme','candidate.wikidot.txt')};
 const viewports=['desktop','laptop','tablet','mobile','narrow-mobile'];
 const result={target_acceptance_contract_sha256:TARGET_ACCEPTANCE_CONTRACT_SHA256,next_actions:[],candidate_css_sha256:entry.candidate_css_sha256,candidate_source_sha256:entry.candidate_source_sha256,candidate_preview_sha256:sha(inputs.preview),candidate_base_css_sha256:null,full_check_input_bindings:{sha256:entry.full_check_input_bindings_sha256},verification_scope:{mode:'full',deferred:[]},port_decision:{verdict:'pass'},target_acceptance:{status:'fail',visual_status:'inconclusive',issue_count:0,style_change_count:0,torture_changed_component_count:0,findings:[surfaceFinding(entry,OUROBOROUS_CHAIN)]},overall_acceptance:{status:'fail',port_verdict:'pass',target_status:'fail'},verdict:'fail',viewport_status:Object.fromEntries(viewports.map(id=>[id,{status:'pass',viewport_escape_px:0,document_overflow_px:0}])),font_diagnostics:{status:'measured',fonts:[{glyph_count:1}]},torture:'pass',visual:{viewports:Object.fromEntries(viewports.map(id=>[id,{candidate_path:candidate,reference_path:reference,comparison_status:'fail',normalized_rmse:.4}]))}};
 const review={schema:'theme_lab_visual_acceptance.v1',candidate_css_sha256:entry.candidate_css_sha256,candidate_source_sha256:entry.candidate_source_sha256,candidate_preview_sha256:sha(inputs.preview),viewports:Object.fromEntries(viewports.map(id=>[id,{status:'pass',candidate_screenshot_sha256:sha('candidate'),reference_screenshot_sha256:sha('reference'),reviewed_at:new Date().toISOString(),reviewer:'test reviewer',note:'History surface reviewed against the OD-T3-a record.'}]))};
 return finalizeVisualAcceptance({result,review,...inputs,fullCheckInputBindings:{sha256:entry.full_check_input_bindings_sha256}});
}

test('finalize waives the OD-T3-a finding to warn, never pass, and completion re-verifies it',async t=>{
 const entry=surfaceEntry('OD-T3-a-ouroborous-surface-history');
 const accepted=await ouroborousFinalize(t);
 assert.equal(accepted.target_acceptance.status,'warn');
 assert.equal(accepted.overall_acceptance.status,'warn');
 const marked=accepted.target_acceptance.findings.filter(finding=>finding.exemption);
 assert.equal(marked.length,1);
 assert.equal(marked[0].exemption.entry_id,'OD-T3-a-ouroborous-surface-history');
 assert.equal(marked[0].exemption.decision,'OD-T3-a');
 assert.equal(accepted.viewport_status.mobile.status,'pass');
 assert.deepEqual(accepted.viewport_status.mobile.exemption_entry_ids,['OD-T3-a-ouroborous-surface-history']);
 assert.equal(accepted.viewport_status.mobile.viewport_escape_px,0);
 assert.equal(accepted.viewport_status.desktop.exemption_entry_ids,undefined);
 assert.equal(accepted.faithful_design_exemptions.waivers.length,1);
 const waiver=accepted.faithful_design_exemptions.waivers[0];
 assert.deepEqual(waiver.measured,{before_px:0,after_px:67});
 assert.equal(waiver.surface,'page.history');
 assert.equal(waiver.state,'history-list');
 assert.equal(waiver.full_check_raw_result_sha256,entry.full_check_raw_result_sha256);
 assert.equal(waiver.overflow_sources_chain_sha256,entry.findings[0].overflow_sources_chain_sha256);
 assert.equal(waiver.finding_canonical_sha256,entry.findings[0].finding_canonical_sha256);
 assert.deepEqual(verifyFaithfulDesignWaivers(accepted,'ouroborous-theme'),[]);
 const unbound=structuredClone(accepted);delete unbound.faithful_design_exemptions.waivers[0].full_check_raw_result_sha256;
 assert.ok(verifyFaithfulDesignWaivers(unbound,'ouroborous-theme').length>0);
 const drifted=structuredClone(accepted);drifted.target_acceptance.findings[0].surface='page.normal';
 assert.ok(verifyFaithfulDesignWaivers(drifted,'ouroborous-theme').length>0);
 assert.ok(verifyFaithfulDesignWaivers(accepted,'scp-offices-theme').length>0);
});

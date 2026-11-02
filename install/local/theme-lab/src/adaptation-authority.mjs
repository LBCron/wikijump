import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {extractSCPJPAdaptationBlocks} from './port-maintenance.mjs';
import {closedDrawerBounds} from './viewport-bounds.mjs';
import {candidatePageTags,materializeDefaultCss} from './runtime-theme-css.mjs';
import {validateFrozenHistoryResponse} from './frozen-history-replay.mjs';
import {validateFrozenPagePreview} from './frozen-page-preview-replay.mjs';
import {evidenceRoots,resolveEvidenceFile} from './evidence-roots.mjs';
import {resolveExistingContainedFile,resolveExistingPackageDirectory,resolveExistingPackageFile} from './package-path.mjs';
import {adaptationInputNames} from './theme-package.mjs';
import {AB_RECEIPT_SCHEMA,CERTIFIED_AUTHORITIES,nestedArtifactBindings} from './authority-evidence-closure.mjs';

export function verifyGeneratedLineAuthority(receipt) {
  const captures = receipt.rows?.filter(row => row.state === 'header-line-layout') ?? [];
  if (!captures.length) return;
  if (!receipt.archived_sources?.some(source => source.path === 'measurement-generated-text-lines.mjs')) throw new Error('generated line producer is unbound');
  for (const capture of captures) {
    const probes = capture.measurement?.generated_text_lines;
    if (!Array.isArray(probes) || !probes.length) throw new Error('generated line authority lacks geometry');
    let overlapCount = 0;
    for (const probe of probes) {
      if (!probe.text || !/::(?:before|after)$/u.test(probe.selector ?? '') || !Array.isArray(probe.lines) || !probe.lines.length) throw new Error('generated line authority has missing text');
      for (const line of probe.lines) {
        if (![line.left,line.right,line.top,line.bottom,line.width,line.height].every(Number.isFinite) || line.width <= 0 || line.height <= 0 || Math.abs(line.right-line.left-line.width)>0.01 || Math.abs(line.bottom-line.top-line.height)>0.01) throw new Error('invalid generated line geometry');
      }
      const overlaps = [];
      for (let i=0;i<probe.lines.length;i++) for (let j=i+1;j<probe.lines.length;j++) {
        const width=Math.min(probe.lines[i].right,probe.lines[j].right)-Math.max(probe.lines[i].left,probe.lines[j].left);
        const height=Math.min(probe.lines[i].bottom,probe.lines[j].bottom)-Math.max(probe.lines[i].top,probe.lines[j].top);
        if (width>1 && height>1) overlaps.push({i,j,width,height});
      }
      if (JSON.stringify(overlaps)!==JSON.stringify(probe.overlaps)) throw new Error('generated line intersections differ from geometry');
      overlapCount += overlaps.length;
    }
    if (capture.pass && overlapCount) throw new Error('overlapping generated lines cannot pass');
  }
}

export function verifyNavigationRowAuthority(receipt){
  for(const capture of receipt.rows?.filter(row=>row.state==='navigation-row-layout')??[]){
    const rows=capture.measurement?.navigation_row_layout;
    if(!Array.isArray(rows)||!rows.length)throw new Error('navigation row authority lacks visible text');
    let contained=true;
    for(const row of rows){
      if(!row.label||!row.ink?.length||![row.bar?.top,row.bar?.bottom,row.bar?.left,row.bar?.right].every(Number.isFinite))throw new Error('navigation row authority lacks geometry');
      for(const ink of row.ink){
        if(![ink.top,ink.bottom,ink.left,ink.right].every(Number.isFinite)||ink.right<=ink.left||ink.bottom<=ink.top)throw new Error('navigation row authority has invalid text geometry');
        contained&&=ink.top>=row.bar.top-1&&ink.bottom<=row.bar.bottom+1&&ink.left>=row.bar.left-1&&ink.right<=row.bar.right+1;
      }
    }
    if(capture.pass&&!contained)throw new Error('navigation text outside its bar cannot pass');
  }
}

export function verifyNativeCreditFoldAuthority(receipt) {
  const captures=receipt.rows?.filter(row=>row.state?.startsWith('credit-fold-'))??[];
  if(!captures.length)return;
  if(!receipt.archived_sources?.some(source=>source.path==='measurement-sigma10-credit-actions.mjs'))throw new Error('native credit control producer is unbound');
  for(const capture of captures){
    if(!['credit-fold-view','credit-fold-otherwise','credit-fold-return'].includes(capture.state))throw new Error('invalid native credit control state');
    const fold=capture.measurement?.credit_fold;
    if(capture.variant==='without'&&capture.pass===false&&typeof capture.interaction_error==='string'&&capture.interaction_error.length>0){
      if(!fold||typeof fold.initial_hash!=='string'||fold.hash!==fold.initial_hash)throw new Error('failed native credit action lacks unchanged navigation identity');
      continue;
    }

    if(!fold||typeof fold.initial_hash!=='string'||fold.hash!==fold.initial_hash||!fold.outer_unfolded||fold.inner_unfolded!==(capture.state==='credit-fold-otherwise')||fold.view_visibility!=='visible'||fold.otherwise_visibility!==(capture.state==='credit-fold-otherwise'?'visible':'hidden'))throw new Error('native credit authority lacks the settled control state');
    if(!capture.measurement.rows?.length||capture.measurement.rows.some(row=>![row.rect?.width,row.rect?.height].every(value=>Number.isFinite(value)&&value>0)||row.style?.visibility!=='visible'||row.style?.display==='none'))throw new Error('native credit authority has missing or hidden geometry');
  }
}

export function verifyFrozenPagePreviewAuthority(receipt,directory,root){
  const binding=receipt.frozen_page_preview;
  if(!binding)return;
  const read=(key,hashKey)=>{
    const file=resolveExistingContainedFile(root,binding[key]??'','native preview artifact',directory);
    const bytes=fs.readFileSync(file);
    if(digest(bytes)!==binding[hashKey])throw new Error('corrupt native preview authority artifact');
    return bytes;
  };
  validateFrozenPagePreview({receiptBytes:read('receipt','receipt_sha256'),responseBytes:read('response','response_sha256')},receipt.url);
  if(!receipt.archived_sources?.some(source=>source.path==='measurement-frozen-page-preview-replay.mjs'))throw new Error('native preview producer is unbound');
  for(const dependency of binding.dependencies??[]){
    if(!/^[a-f0-9]{64}$/u.test(dependency.sha256)||digest(fs.readFileSync(path.join(root,'authority-evidence/replay/objects',dependency.sha256.slice(0,2),dependency.sha256)))!==dependency.sha256)throw new Error('corrupt native preview script');
  }
  for(const capture of receipt.rows){
    if(!['article-table','second-tab-selected'].includes(capture.state)||!capture.measurement?.rows?.length||capture.measurement.rows.some(row=>![row.rect?.width,row.rect?.height].every(value=>Number.isFinite(value)&&value>0)||row.style?.visibility!=='visible'||row.style?.display==='none'))throw new Error('native preview authority has missing or hidden geometry');
  }
}

export function verifyFrozenHistoryAuthority(receipt, directory, root) {
  const replay=receipt.frozen_history_replay;
  if (!replay) {
    if(receipt.rows?.some(capture=>capture.state==='history-list'))throw new Error('native history authority lacks bound replay');
    return;
  }
  const modules=['history/PageHistoryModule','history/PageRevisionListModule'];
  if(replay.bindings?.length!==2||receipt.rows.some(capture=>capture.state!=='history-list'))throw new Error('invalid native history authority scope');
  const entries=replay.bindings.map((binding,index)=>{
    const read=(key,hashKey)=>{
      const file=resolveExistingContainedFile(root,binding[key]??'','native history artifact',directory);
      const bytes=fs.readFileSync(file);
      if(digest(bytes)!==binding[hashKey])throw new Error('corrupt native history authority artifact');
      return bytes;
    };
    if(binding.module!==modules[index])throw new Error('invalid native history module ordering');
    const entry=validateFrozenHistoryResponse({receiptBytes:read('receipt','receipt_sha256'),responseBytes:read('response','response_sha256'),requestId:binding.request_id},receipt.url,modules[index]);
    if(entry.pageId!==binding.page_id)throw new Error('native history page binding differs');
    return entry;
  });
  if(entries[0].pageId!==entries[1].pageId)throw new Error('native history responses belong to different pages');
  if(!receipt.archived_sources?.some(source=>source.path==='measurement-frozen-history-replay.mjs'))throw new Error('native history replay producer is unbound');
  for(const capture of receipt.rows){
    const table=capture.measurement?.scroll_overflow_sources?.find(element=>element.class_name==='page-history');
    const list=capture.measurement?.rows?.find(element=>element.selector==='#revision-list');
    if(!list||![list.rect?.width,list.rect?.height].every(value=>Number.isFinite(value)&&value>0)||list.style?.visibility!=='visible'||list.style?.display==='none'||table&&(!Number.isFinite(table.rect.height)||table.rect.height<=0))throw new Error('native history authority has hidden geometry');
  }
}

export const PUBLISHABLE_AUTHORITIES = new Set([
  'SOURCE_THEME', 'SOURCE_AND_TARGET_CERTIFIED', 'TARGET_WIKIDOT_CERTIFIED', 'RUNTIME_INDEPENDENT',
]);
export const ADAPTATION_AUTHORITIES = new Set([...PUBLISHABLE_AUTHORITIES, 'NONPUBLISHABLE_QUARANTINE', 'REMOVE']);
export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ports = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ports');

// Independently certified corrections retain their own module/provenance boundary.
export function composeAuthoritySource(base, css) {
  const trimmed = css.trim();
  if (!trimmed) return base.trimEnd() + '\n';
  const blocks = trimmed.split('/* THEME_LAB_AUTHORITY_BLOCK_BOUNDARY */').map(block => block.trim());
  if (blocks.some(block => !block)) throw new Error('empty authority block');
  return base.trimEnd() + '\n' + blocks.map(block => `\n[[module CSS]]\n${block}\n[[/module]]\n`).join('');
}

export function validateAuthority(row) {
  if (!ADAPTATION_AUTHORITIES.has(row.authority)) throw new Error(`missing/unsupported adaptation authority: ${row.marker}`);
  if (PUBLISHABLE_AUTHORITIES.has(row.authority)) {
    if (!row.evidence?.length) throw new Error(`publishable adaptation lacks evidence: ${row.marker}`);
    for (const evidence of row.evidence) {
      if (!evidence.path || !/^[a-f0-9]{64}$/u.test(evidence.sha256 ?? '')) throw new Error(`unbound authority evidence: ${row.marker}`);
      if (/LOCAL_TARGET_ACCEPTANCE_ONLY|SYNTHETIC/iu.test(evidence.decision_authority ?? '')) throw new Error(`local/synthetic observation cannot authorize adaptation: ${row.marker}`);
    }
  }
  return row;
}

// `root` is the ports root. When it is the default checkout root, authority
// evidence missing (or hash-mismatching) locally may be served from the shared
// evidence cache; the root that resolves a receipt is the only root its nested
// artifacts are validated against. An explicit `root` never falls back unless
// `sharedRoot` is also given.
export function verifyEvidence(rows, root = ports, {sharedRoot} = {}) {
  const roots = evidenceRoots(root, ports, sharedRoot);
  for (const row of rows) {
    validateAuthority(row);
    if (!PUBLISHABLE_AUTHORITIES.has(row.authority)) continue;
    const requiredStates=row.scope?.states??(row.scope?.state?[row.scope.state]:[]);
    const observedStates=new Set();
    for (const evidence of row.evidence) {
      const {file, root: evidenceRoot, bytes} = resolveEvidenceFile(roots,evidence.path,'authority evidence',evidence.sha256);
      if (CERTIFIED_AUTHORITIES.has(row.authority)) {
        const root = evidenceRoot;
        const receipt = JSON.parse(bytes.toString('utf8'));
        if (receipt.schema !== AB_RECEIPT_SCHEMA || receipt.public_writes !== 0 || !receipt.url || !receipt.observed_at || !receipt.snapshot?.entry) throw new Error(`invalid Wikidot A/B authority receipt: ${evidence.path}`);
        verifyFrozenHistoryAuthority(receipt,path.dirname(file),root);
        verifyFrozenPagePreviewAuthority(receipt,path.dirname(file),root);
        verifyGeneratedLineAuthority(receipt);
        verifyNativeCreditFoldAuthority(receipt);
        verifyNavigationRowAuthority(receipt);
        const after = receipt.rows.filter(r=>r.variant==='with');
        if(!/^https:\/\/[a-z0-9-]+\.wikidot\.com\//u.test(receipt.url) || receipt.site!==new URL(receipt.url).hostname || receipt.external_browser_requests!==0) throw new Error(`invalid public read-only Wikidot identity: ${evidence.path}`);
        if(row.scope?.target_url && receipt.url!==row.scope.target_url) throw new Error(`wrong target authority: ${evidence.path}`);
        if(row.scope?.viewports?.some(width=>!after.some(r=>r.width===width))) throw new Error(`incomplete authority viewport coverage: ${evidence.path}`);
        for(const capture of after)observedStates.add(capture.state);
        if(requiredStates.length && after.some(r=>!requiredStates.includes(r.state))) throw new Error(`wrong authority state coverage: ${evidence.path}`);
        if(!receipt.rows.some(r=>r.variant==='without' && !r.pass)) throw new Error(`target adaptation has no demonstrated A/B need: ${evidence.path}`);
        if (!after.length || after.some(r=>!r.pass || r.bounds.some(b=>!b.pass))) throw new Error(`failed target geometry authority: ${evidence.path}`);
        if (row.published_css_sha256 && after.some(r=>r.css_sha256!==row.published_css_sha256)) throw new Error(`authority capture has stale candidate CSS: ${evidence.path}`);
        if (row.published_base_css_sha256 && receipt.rows.some(r=>r.base_css_sha256!==row.published_base_css_sha256)) throw new Error(`authority capture has stale candidate base CSS: ${evidence.path}`);
        for(const capture of after) if(capture.state==='sidebar-closed') {
          if(receipt.measurement_contract!=='existing-drawer-wholly-off-canvas.v1' || capture.measurement.rows.length!==1 || capture.measurement.rows[0].selector!=='#side-bar' || !closedDrawerBounds(capture.measurement.rows[0].rect,capture.measurement.viewport_width).pass) throw new Error(`invalid closed drawer authority: ${evidence.path}`);
        }
        const receiptPath=path.relative(fs.realpathSync(root),file).split(path.sep).join('/');
        for(const {relative_path,sha256} of nestedArtifactBindings(receipt,receiptPath)) {
          const artifact=resolveExistingContainedFile(root,relative_path,'authority artifact');
          if(digest(fs.readFileSync(artifact))!==sha256) throw new Error(`corrupt authority artifact: ${relative_path}`);
        }
      }
    }
    if(CERTIFIED_AUTHORITIES.has(row.authority) && requiredStates.some(state=>!observedStates.has(state))) throw new Error(`incomplete authority state coverage: ${row.marker}`);
  }
}

export function authorityInventory(name, root = ports) {
  const ledger = JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,'adaptation-authority.json','adaptation authority ledger'), 'utf8'));
  const pkg = ledger.packages[name];
  if (!pkg) throw new Error(`package lacks adaptation authority inventory: ${name}`);
  return pkg;
}

export function assertPublishablePackage(name, {checkOutputs = false, portsRoot = ports, verifyAuthorityEvidence = true, sharedEvidenceRoot} = {}) {
  const pkg = authorityInventory(name,portsRoot), dir = resolveExistingPackageDirectory(portsRoot,name,`${name}: package directory`);
  const {sourceInputName, publicationSourceNames} = adaptationInputNames(dir);
  if(verifyAuthorityEvidence)verifyEvidence(pkg.blocks,portsRoot,{sharedRoot:sharedEvidenceRoot});
  for(const block of pkg.blocks) if(block.diagnostic_file && digest(fs.readFileSync(resolveExistingPackageFile(dir,block.diagnostic_file,`${name}: diagnostic file`)))!==block.diagnostic_file_sha256) throw new Error(`${name}: historical diagnostic evidence changed: ${block.marker}`);
  for (const [file, sha] of Object.entries(pkg.inputs)) {
    if (digest(fs.readFileSync(resolveExistingPackageFile(dir,file,`${name}: adaptation input`))) !== sha) throw new Error(`${name}: unreviewed adaptation input ${file}`);
  }
  if(pkg.inputs['runtime-css-materialization.json']) {
    const receipt=JSON.parse(fs.readFileSync(resolveExistingPackageFile(dir,'runtime-css-materialization.json',`${name}: materialization receipt`)));
    const sourceFile=receipt.source_file;
    if(sourceFile!=='maintenance/authority-base.wikidot.txt')throw new Error(`${name}: unbound publication materialization source`);
    const source=fs.readFileSync(resolveExistingPackageFile(dir,sourceFile,`${name}: source file`),'utf8');
    if(receipt.source_page_tags){
      const manifest=JSON.parse(fs.readFileSync(resolveExistingPackageFile(dir,'manifest.json',`${name}: materialization manifest`)));
      if(JSON.stringify(receipt.source_page_tags)!==JSON.stringify(candidatePageTags(manifest,source)))throw new Error(`${name}: unbound materialization source page tags`);
    }
    const {css,modules}=materializeDefaultCss(source,{sourcePageTags:receipt.source_page_tags??[]});
    const expected=modules.map(row=>({index:row.index,css_sha256:digest(row.css)}));
    if(receipt.schema!=='theme_lab_published_runtime_css_materialization.v1' || receipt.public_writes!==0 || receipt.external_requests!==0 ||
       JSON.stringify(receipt.runtime_active_tags)!=='[]' || receipt.source_sha256!==pkg.inputs[sourceFile] || receipt.source_sha256!==digest(source) ||
       JSON.stringify(receipt.modules)!==JSON.stringify(expected) || receipt.input_sha256!==digest(css) || receipt.input_sha256!==pkg.inputs['candidate-input.css']) {
      throw new Error(`${name}: publication CSS does not match its active default source modules`);
    }
  }
  const sourceDisposition=pkg.blocks.find(row=>row.origin==='preserved-source');
  if(!sourceDisposition || sourceDisposition.sha256!==pkg.inputs[sourceInputName]) throw new Error(`${name}: source input lacks matching authority disposition`);
  const sourceFile = pkg.source_file;
  const manifestFile=resolveExistingPackageFile(dir,'manifest.json',`${name}: manifest`);
  if(fs.existsSync(manifestFile)) {
    const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    if(manifest.flattened_css_transforms) {
      const transforms=JSON.parse(fs.readFileSync(resolveExistingPackageFile(dir,manifest.flattened_css_transforms,`${name}: flattened CSS transforms`),'utf8'));
      for(const transform of transforms.transforms ?? []) {
        const disposition=pkg.blocks.find(row=>row.origin==='flattened-css-transform' && row.sha256===digest(JSON.stringify(transform)));
        if(!disposition || !PUBLISHABLE_AUTHORITIES.has(disposition.authority)) throw new Error(`${name}: unauthorized flattened CSS transform: ${transform.id}`);
      }
    }
  }
  const source = fs.readFileSync(resolveExistingPackageFile(dir,sourceFile,`${name}: source file`),'utf8');
  if (pkg.inputs['maintenance/authority-base.wikidot.txt']) {
    const base=fs.readFileSync(resolveExistingPackageFile(dir,'maintenance/authority-base.wikidot.txt',`${name}: authority base`),'utf8');
    const css=fs.readFileSync(resolveExistingPackageFile(dir,'authority-overrides.css',`${name}: authority overrides`),'utf8').trim();
    const expected=composeAuthoritySource(base,css);
    if(source!==expected) throw new Error(`${name}: candidate source is not the authority-bound composition`);
  }
  const publicationSources=[source];
  if(checkOutputs)for(const extra of publicationSourceNames)publicationSources.push(fs.readFileSync(resolveExistingPackageFile(dir,extra,`${name}: publishable theme`),'utf8'));
  for (const block of publicationSources.flatMap(extractSCPJPAdaptationBlocks)) {
    const disposition = pkg.blocks.find(r=>r.sha256===block.sha256 && r.marker===block.marker);
    if (!disposition || !PUBLISHABLE_AUTHORITIES.has(disposition.authority)) throw new Error(`${name}: unauthorized publishable adaptation: ${block.marker}`);
  }
  for (const file of ['candidate-input.css', 'authority-overrides.css'].filter(f=>pkg.inputs[f])) {
    const css=fs.readFileSync(resolveExistingPackageFile(dir,file,`${name}: adaptation input`),'utf8');
    if (/SCP-JP interaction adaptation: reveal Sigma|Theme Lab evidenced viewport|Campaign JP|SCP-JP navigation adaptation: constrain submenu/u.test(css)) throw new Error(`${name}: historical/synthetic CSS in publishable input ${file}`);
  }
  if (checkOutputs) {
    if(!pkg.outputs?.['candidate.css'] || !pkg.outputs?.[pkg.source_file]) throw new Error(`${name}: unbound publication outputs`);
    for (const [file, sha] of Object.entries(pkg.outputs)) {
      if (digest(fs.readFileSync(resolveExistingPackageFile(dir,file,`${name}: adaptation input`))) !== sha) throw new Error(`${name}: stale derived candidate ${file}`);
    }
    for(const block of pkg.blocks) if(block.published_css_sha256 && block.published_css_sha256!==pkg.outputs['candidate.css']) throw new Error(`${name}: retained adaptation proof does not match current published CSS`);
    for(const block of pkg.blocks) if(block.authority.includes('CERTIFIED') && (pkg.outputs['candidate-base.css']??null)!==(block.published_base_css_sha256??null)) throw new Error(`${name}: retained adaptation proof does not match current base CSS`);
    const receipt=JSON.parse(fs.readFileSync(resolveExistingPackageFile(dir,'receipt.json',`${name}: receipt`),'utf8'));
    if(receipt.candidate_source_sha256!==pkg.outputs[pkg.source_file] || receipt.candidate_css_sha256!==pkg.outputs['candidate.css']) throw new Error(`${name}: stale current candidate receipt`);
    if(receipt.final_verdict!==receipt.overall_acceptance?.status) throw new Error(`${name}: ambiguous receipt final acceptance`);
  }
  return {theme:name,audited:pkg.blocks.length,publishable:pkg.blocks.filter(r=>PUBLISHABLE_AUTHORITIES.has(r.authority)).length,without_authority:0};
}

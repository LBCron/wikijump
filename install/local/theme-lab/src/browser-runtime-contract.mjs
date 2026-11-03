import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATIC_IMPORT=/\b(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu;
const RUNTIME_EXTENSIONS=['.js','.ts','.svelte','.mjs','.json','.css','.scss'];
const PAGE_ROUTE='framerail/src/routes/[slug]/[...extra]';

const paneRoot=surface=>({
  'page.history':'HistoryPane.svelte',
  'page.files':'FilePane.svelte',
  'page.backlinks':'BacklinksPane.svelte',
  'page.parent':'ParentPane.svelte',
  'page.edit':'EditorPane.svelte',
  'page.rename':'MovePane.svelte',
  'page.delete':'DeletePane.svelte',
  'page.tags':'TagsPane.svelte',
}[surface]??null);

export function runtimeFilesForObservation(surface, viewport) {
  const files = [
    'framerail/src/app.html',
    'framerail/src/hooks.server.ts',
    'framerail/src/routes/+layout.server.ts',
    `${PAGE_ROUTE}/+page.svelte`,
    `${PAGE_ROUTE}/+page.server.ts`,
    ...(surface === 'dialog.generic'
    ? ['framerail/src/lib/popup/error.svelte', 'framerail/src/routes/[slug]/[...extra]/PageView.svelte', 'framerail/src/lib/wikidot/wikidot-locale.ts']
    : surface.startsWith('page.history')
      ? ['framerail/src/routes/[slug]/[...extra]/HistoryPane.svelte', 'framerail/src/lib/wikidot-history-contract.js']
      : surface.startsWith('page.files') ? ['framerail/src/routes/[slug]/[...extra]/FileList.svelte']
        : surface.startsWith('nav.') || surface.startsWith('shell.')
          ? ['framerail/src/lib/sigma-esque/wikidot.svelte', 'framerail/src/routes/+layout.svelte']
          : ['framerail/src/routes/[slug]/[...extra]/PageView.svelte'])
  ];
  // Normal-page identity measures the header/login shell as well as article
  // content. Changes to that shell cannot reuse an older normal screenshot.
  if (surface === 'page.normal') files.push('framerail/src/lib/sigma-esque/wikidot.svelte', 'framerail/src/routes/+layout.svelte', 'framerail/src/lib/wikidot/wikidot-tabviews.ts');
  // Page states retain the saved page's tag row alongside their action pane.
  // Its wrapper participates in CSS layout (including History document width),
  // even though PageView imports the renderer from a separate component.
  if (surface.startsWith('page.')) files.push('framerail/src/routes/[slug]/[...extra]/WikidotFoundPageTags.svelte', 'framerail/src/lib/wikidot/wikidot-page-tags.ts');
  if (viewport === 'mobile' || viewport === 'narrow-mobile') files.push('framerail/src/lib/sigma-esque/wikidot.svelte');
  if (surface === 'shell.search' && viewport !== 'mobile' && viewport !== 'narrow-mobile') files.push('framerail/src/lib/wikidot/wikidot-search.js');
  const pane=paneRoot(surface);if(pane)files.push(`${PAGE_ROUTE}/${pane}`);
  return [...new Set(files)];
}

function resolveRuntimeImport(root,from,specifier){
  const framerail=path.join(root,'framerail');
  let raw;
  if(specifier.startsWith('$lib/'))raw=path.join(framerail,'src/lib',specifier.slice(5));
  else if(specifier.startsWith('.'))raw=path.resolve(path.dirname(from),specifier);
  else return null;
  const extension=path.extname(raw);
  const candidates=extension?[raw]:[raw,...RUNTIME_EXTENSIONS.map(ext=>raw+ext),...RUNTIME_EXTENSIONS.map(ext=>path.join(raw,'index'+ext))];
  if(extension==='.js')candidates.push(raw.slice(0,-3)+'.ts');
  for(const candidate of candidates){
    if(!fs.existsSync(candidate))continue;
    const stat=fs.lstatSync(candidate);
    if(stat.isSymbolicLink())throw new Error(`runtime dependency cannot be a symlink: ${path.relative(root,candidate)}`);
    if(!stat.isFile())continue;
    const actual=fs.realpathSync(candidate);
    if(!actual.startsWith(framerail+path.sep))throw new Error(`runtime dependency escapes Framerail: ${path.relative(root,candidate)}`);
    return actual;
  }
  return null;
}

export function runtimeDependencyFilesForObservation(repoRoot,surface,viewport){
  const root=fs.realpathSync(repoRoot);
  const pending=runtimeFilesForObservation(surface,viewport).map(file=>path.join(root,file));
  const seen=new Set(),files=[];
  while(pending.length){
    const candidate=pending.pop();
    const relative=path.relative(root,candidate).replaceAll(path.sep,'/');
    if(seen.has(relative))continue;
    const stat=fs.lstatSync(candidate);
    if(stat.isSymbolicLink())throw new Error(`runtime surface contract input cannot be a symlink: ${relative}`);
    const actual=fs.realpathSync(candidate);
    if(!actual.startsWith(root+path.sep)||!fs.statSync(actual).isFile())throw new Error(`runtime surface contract input escapes repository: ${relative}`);
    seen.add(relative);files.push(relative);
    const text=fs.readFileSync(actual,'utf8');
    STATIC_IMPORT.lastIndex=0;
    for(const match of text.matchAll(STATIC_IMPORT)){
      const dependency=resolveRuntimeImport(root,actual,match[1]);
      if(dependency)pending.push(dependency);
    }
  }
  return files.sort();
}

export function runtimeSurfaceContractSha(repoRoot, surface, viewport) {
  const root=fs.realpathSync(repoRoot);
  const hash = crypto.createHash('sha256');
  for (const file of runtimeDependencyFilesForObservation(root,surface,viewport)) {
    hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(root,file)));
  }
  return hash.digest('hex');
}

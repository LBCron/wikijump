import fs from 'node:fs';
// An entry waives one document-containment finding only while its recorded
// measurements and candidate hashes still match exactly. Any drift re-fails it.
export const FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA='theme_lab_faithful_design_exemptions.v1';
const FAITHFUL_DESIGN_EXEMPTIONS_URL=new URL('../ports/current-acceptance/faithful-design-exemptions.json',import.meta.url);
let faithfulDesignExemptionsCache=null;
export function faithfulDesignExemptionsState(){
 let stat=null;try{stat=fs.statSync(FAITHFUL_DESIGN_EXEMPTIONS_URL)}catch{}
 if(!stat)return {document:null};
 const cacheKey=`${stat.mtimeMs}:${stat.size}`;
 if(faithfulDesignExemptionsCache?.key===cacheKey)return faithfulDesignExemptionsCache.state;
 const bytes=fs.readFileSync(FAITHFUL_DESIGN_EXEMPTIONS_URL);
 const document=JSON.parse(bytes.toString('utf8'));
 if(document?.schema!==FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA||!Array.isArray(document.entries))throw new Error('Faithful-design exemption ledger is malformed');
 const state={document};
 faithfulDesignExemptionsCache={key:cacheKey,state};
 return state;
}
export function loadFaithfulDesignExemptions(){return faithfulDesignExemptionsState().document??{schema:FAITHFUL_DESIGN_EXEMPTIONS_SCHEMA,entries:[]};}
export function canonicalJson(value){
 if(value===null||['number','boolean','string'].includes(typeof value))return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(row=>canonicalJson(row)??'null').join(',')}]`;
 if(typeof value==='object'){
  const parts=[];
  for(const key of Object.keys(value).sort()){
   const encoded=canonicalJson(value[key]);
   if(encoded!==undefined)parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
 }
 return undefined;
}
export function matchFaithfulDesignContainment(document,{theme,observationKey: key,candidateOverflowPx,baselineOverflowPx,dependenciesSha256}){
 return (document?.entries??[]).find(entry=>entry?.instrument==='semantic_document_containment'&&entry.package===theme&&
  entry.match?.observation_key===key&&entry.match?.candidate_overflow_px===candidateOverflowPx&&
  entry.match?.baseline_overflow_px===baselineOverflowPx&&entry.match?.dependencies_sha256===dependenciesSha256)??null;
}

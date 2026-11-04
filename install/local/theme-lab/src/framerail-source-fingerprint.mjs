import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

async function filesBelow(entry){
 const stat=await fs.lstat(entry);
 if(stat.isSymbolicLink())throw new Error(`Framerail fingerprint input cannot be a symlink: ${entry}`);
 if(stat.isFile())return[entry];
 if(!stat.isDirectory())throw new Error(`Framerail fingerprint input is not a regular file or directory: ${entry}`);
 const output=[];
 for(const item of await fs.readdir(entry,{withFileTypes:true})){
  if(['node_modules','.svelte-kit','build'].includes(item.name))continue;
  const child=path.join(entry,item.name);
  if(item.isSymbolicLink())throw new Error(`Framerail fingerprint input cannot be a symlink: ${child}`);
  if(item.isDirectory())output.push(...await filesBelow(child));
  else if(item.isFile())output.push(child);
 }
 return output;
}

export async function framerailSourceFingerprint(repoRoot){
 const framerailDir=path.join(repoRoot,'framerail');
 const inputs=[
  path.join(framerailDir,'src'),
  path.join(framerailDir,'static'),
  path.join(framerailDir,'package.json'),
  path.join(framerailDir,'server.ts'),
  path.join(framerailDir,'svelte.config.js'),
 path.join(framerailDir,'sveltekit-options.ts'),
  path.join(framerailDir,'tsconfig.json'),
  path.join(framerailDir,'vite.config.ts'),
  path.join(repoRoot,'pnpm-lock.yaml'),
 ];
 const files=[];
 for(const entry of inputs){try{files.push(...await filesBelow(entry))}catch(error){if(error.code!=='ENOENT')throw error}}
 files.sort();
 const hash=crypto.createHash('sha256');
 for(const file of files){hash.update(path.relative(repoRoot,file));hash.update('\0');hash.update(await fs.readFile(file));hash.update('\0')}
 return hash.digest('hex');
}

function filesBelowSync(entry){
 const stat=fsSync.lstatSync(entry);
 if(stat.isSymbolicLink())throw new Error(`Framerail fingerprint input cannot be a symlink: ${entry}`);
 if(stat.isFile())return[entry];
 if(!stat.isDirectory())throw new Error(`Framerail fingerprint input is not a regular file or directory: ${entry}`);
 const output=[];
 for(const item of fsSync.readdirSync(entry,{withFileTypes:true})){
  if(['node_modules','.svelte-kit','build'].includes(item.name))continue;
  const child=path.join(entry,item.name);
  if(item.isSymbolicLink())throw new Error(`Framerail fingerprint input cannot be a symlink: ${child}`);
  if(item.isDirectory())output.push(...filesBelowSync(child));
  else if(item.isFile())output.push(child);
 }
 return output;
}

export function framerailSourceFingerprintSync(repoRoot){
 const framerailDir=path.join(repoRoot,'framerail');
 const inputs=[
  path.join(framerailDir,'src'),path.join(framerailDir,'static'),path.join(framerailDir,'package.json'),
  path.join(framerailDir,'server.ts'),path.join(framerailDir,'svelte.config.js'),path.join(framerailDir,'sveltekit-options.ts'),path.join(framerailDir,'tsconfig.json'),
  path.join(framerailDir,'vite.config.ts'),path.join(repoRoot,'pnpm-lock.yaml'),
 ];
 const files=[];
 for(const entry of inputs){try{files.push(...filesBelowSync(entry))}catch(error){if(error.code!=='ENOENT')throw error}}
 files.sort();
 const hash=crypto.createHash('sha256');
 for(const file of files){hash.update(path.relative(repoRoot,file));hash.update('\0');hash.update(fsSync.readFileSync(file));hash.update('\0')}
 return hash.digest('hex');
}

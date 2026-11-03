import fs from 'node:fs';
import path from 'node:path';

import {currentPackageBaseCss} from './candidate-base-contract.mjs';
import {candidateSourceName} from './theme-package.mjs';
import {resolveExistingContainedFile,resolveExistingPackageDirectory,resolveExistingPackageFile} from './package-path.mjs';
import {DEFAULT_SIGMA10_RUN_CONTRACT,DEFAULT_SIGMA9_RUN_CONTRACT,resolveRunContractOption} from './current-run-contract-option.mjs';

const templateByGeneration={
  sigma9:'scenarios/jp-sigma9-extra-black-canonical.json',
  sigma10:'scenarios/jp-sigma10-extra-black-canonical.json',
};

export function themeScenarioConfigForPackage(root,{generation,packageName,runContract=null}){
  const templatePath=templateByGeneration[generation];
  if(!templatePath)throw new Error(`unsupported canonical scenario generation: ${generation}`);
  if(!/^[a-z0-9-]+$/u.test(packageName??''))throw new Error(`invalid maintained package name: ${packageName}`);
  const directory=resolveExistingPackageDirectory(path.join(root,'ports'),packageName,`${packageName}: package directory`);
  resolveExistingPackageFile(directory,'candidate.css',`${packageName}: candidate CSS`);
  const sourceFile=candidateSourceName(directory);
  resolveExistingPackageFile(directory,sourceFile,`${packageName}: candidate source`);
  const config=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,templatePath,'Canonical scenario generation template'),'utf8'));
  // Only a task-owned contract rebinds the runtime origin; the shared default
  // keeps the template origin so its scenario identity is unchanged.
  const explicitContractPath=runContract===null?null:resolveRunContractOption(root,runContract,{generation});
  const defaultContractPath=generation==='sigma10'?DEFAULT_SIGMA10_RUN_CONTRACT:DEFAULT_SIGMA9_RUN_CONTRACT;
  if(explicitContractPath!==null&&explicitContractPath!==defaultContractPath){
    const contractPath=explicitContractPath;
    const contract=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,contractPath,'Canonical scenario run contract'),'utf8'));
    const expectedBaseline=generation==='sigma10'?'Sigma-10':'Sigma-9';
    if(contract.baseline_theme?.name!==expectedBaseline)throw new Error(`task run contract baseline does not match ${generation}`);
    if(contract.target_site?.slug!==config.branch_profile.site_slug||contract.target_site?.locale!==config.branch_profile.locale)throw new Error('task run contract target site does not match the scenario branch profile');
    let origin;
    try{origin=new URL(contract.target_site.origin)}catch{throw new Error('task run contract target origin is invalid')}
    if(origin.protocol!=='https:'||origin.hostname!=='scpaiueouiuiuiui.wikijump.localhost'||!origin.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('task run contract origin must be the HTTPS local Wikijump site with an explicit port');
    config.runtime.origin=origin.origin;
  }
  const base=currentPackageBaseCss(directory,packageName);
  config.theme={
    id:packageName,
    css:`ports/${packageName}/candidate.css`,
    source:`ports/${packageName}/${sourceFile}`,
    ...(base?{base_css:`ports/${packageName}/candidate-base.css`}:{}),
  };
  return config;
}

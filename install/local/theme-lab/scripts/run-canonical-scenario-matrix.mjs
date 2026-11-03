#!/usr/bin/env node
import {loadThemeLabAuthenticatedStorage} from '../src/authenticated-storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {runThemeScenarioMatrix} from '../src/theme-test-matrix.mjs';
import {themeScenarioConfigForPackage} from '../src/theme-scenario-factory.mjs';
import {runContractArgument,sigma10RunContractArgument} from '../src/current-run-contract-option.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);const value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null};
for(const key of ['--package','--generation','--site-state','--authenticated-storage','--output'])if(!value(key))throw new Error(`Missing ${key}`);
const packageName=value('--package'),generation=value('--generation');
// Each generation names its own task-owned contract: --sigma10-run-contract for
// Sigma-10. The other option is refused rather than silently ignored.
if(generation==='sigma10'&&runContractArgument(args)!==null)throw new Error('Sigma-10 canonical matrices take --sigma10-run-contract, not --run-contract');
const runContract=generation==='sigma10'?sigma10RunContractArgument(args):runContractArgument(args);
const config=themeScenarioConfigForPackage(root,{generation,packageName,runContract});
const siteState=JSON.parse(fs.readFileSync(path.resolve(value('--site-state')),'utf8'));
const {storage:authenticatedStorage}=await loadThemeLabAuthenticatedStorage(value('--authenticated-storage'));
const renderedShell=value('--rendered-shell')?JSON.parse(fs.readFileSync(path.resolve(value('--rendered-shell')),'utf8')):null;
const browserRoot=value('--browser-root')?path.resolve(value('--browser-root')):path.resolve(root,'../../../framerail');
const result=await runThemeScenarioMatrix({root,config,siteState,renderedShell,browserRoot,pathPrefix:`/tmp/theme-lab-canonical-${packageName}-${generation}`,sessionStorageStates:{anonymous:null,authenticated:authenticatedStorage}});
fs.writeFileSync(path.resolve(value('--output')),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({package:packageName,generation,scenario_sha256:result.scenario_sha256,})+'\n');

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {themeTestExecutionPlan} from '../src/theme-test-execution-plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const index=process.argv.indexOf('--file');
if(index<0||!process.argv[index+1])throw new Error('usage: theme-scenario-plan.mjs --file <scenario-config.json>');
const config=JSON.parse(fs.readFileSync(path.resolve(process.argv[index+1]),'utf8'));
const optionalJson=name=>{const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?JSON.parse(fs.readFileSync(path.resolve(process.argv[i+1]),'utf8')):null};
const renderedShell=optionalJson('--rendered-shell');
const siteState=optionalJson('--site-state');
process.stdout.write(JSON.stringify(themeTestExecutionPlan(root,config,{renderedShell,siteState}),null,2)+'\n');

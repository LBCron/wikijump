import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const task = "wikijump-theme-lab-basalt-current-20261022";
const url = `http://${task}-deepwell-1:2747/jsonrpc`;
const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../ports/interactive-visual-fixture/provision-fixture.mjs",
);
const primary = "run-owned:theme-lab-visual-acceptance-20260924";

// Stateful in-memory Deepwell: a fresh backend holds no fixture pages.
const mockSource = `
import fs from 'node:fs';
const pages=new Map();let next=3000000100;const log=[];
globalThis.fetch=async(_url,options)=>{
  const {method,params}=JSON.parse(options.body);log.push(method+(params?.slug?':'+params.slug:''));
  const ok=result=>({ok:true,json:async()=>({result})});
  const fail=message=>({ok:true,json:async()=>({error:{code:1,message}})});
  const view=page=>{
    if(page.revisions.length===0)return null;
    const last=page.revisions.at(-1);
    return {page_id:page.page_id,revision_id:last.revision_id,revision_number:page.revisions.length-1,wikitext:last.wikitext,tags:last.tags};
  };
  const addRevision=(page,wikitext,tags)=>page.revisions.push({revision_id:next++,wikitext,tags});
  switch(method){
    case 'site_get':return ok({site_id:6000003,slug:'scpaiueouiuiuiui'});
    case 'login':return ok({needs_mfa:false,session_token:'t'});
    case 'session_get':return ok({user_id:-1});
    case 'page_get':{const page=pages.get(params.page)??[...pages.values()].find(p=>p.page_id===params.page);
      if(!page)return ok(null);
      if(page.revisions.length===0)return fail('Page revision does not exist');
      return ok(view(page));}
    case 'page_create':{if(pages.has(params.slug))return fail('exists');
      const page={page_id:next++,slug:params.slug,revisions:[]};pages.set(params.slug,page);addRevision(page,params.wikitext,params.tags);
      return ok({page_id:page.page_id,revision_id:page.revisions[0].revision_id});}
    case 'page_edit_lock_acquire':return ok({grant:{lock_id:77,['lock_secret']:'mock-secret'}});
    case 'page_edit_lock_release':return ok({});
    case 'page_edit':{const page=[...pages.values()].find(p=>p.page_id===params.page);
      if(!page)return fail('missing');if(params.lease?.lock_id!==77)return fail('edit lease required');addRevision(page,params.wikitext,params.tags);return ok({});}
    case 'import_wikidot_page':{pages.set(params.slug,{page_id:params.page_id,slug:params.slug,revisions:[]});return ok({});}
    case 'import_wikidot_page_revision':{const page=pages.get(params.slug);addRevision(page,params.wikitext,params.tags);return ok({});}
    default:return fail('unexpected method '+method);
  }
};
process.on('exit',()=>fs.writeFileSync(process.env.MOCK_LOG,JSON.stringify(log)));
`;

test("fixture provisioning bootstraps the primary page on a fresh task backend", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "theme-lab-bootstrap-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const mock = path.join(scratch, "mock-fetch.mjs");
  const logPath = path.join(scratch, "log.json");
  fs.writeFileSync(mock, mockSource);
  const result = spawnSync(process.execPath, ["--import", mock, script], {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      MOCK_LOG: logPath,
      THEME_LAB_BACKEND_PROJECT: task,
      DEEPWELL_RPC_URL: url,
      DEEPWELL_RPC_TOKEN: "a".repeat(64),
      WIKIDOT_VERIFY_ADMIN_EMAIL: "fake@localhost",
      WIKIDOT_VERIFY_ADMIN_PASS: "test-only",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const slugs = output.pages.map((page) => page.slug);
  assert.ok(slugs.includes(primary), "primary fixture is provisioned");
  assert.ok(slugs.includes("run-owned:theme-lab-visual-acceptance-imported-20260924"));
  const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
  assert.ok(log.includes(`page_create:${primary}`), "primary created through page_create");
  assert.ok(!log.includes(`import_wikidot_page:${primary}`));
  assert.equal(log[0], "site_get", "identity check precedes every write");
});

test("a fixture page that is neither bootstrap-creatable nor present still fails closed", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.match(
    source,
    /if\(!spec\.slug\.startsWith\('nav:'\)&&spec\.slug!==primarySlug&&spec\.slug!=='run-owned:theme-lab-visual-backlink-20260924'\)throw new Error\(`Run-owned local fixture page is missing/u,
  );
});

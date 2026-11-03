// Builds the sibling mobile/narrow-mobile search record by offline replay of the cached frozen Basalt snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.env.THEME_LAB_ROOT;            // runtime Theme Lab tree (same src as the target captures)
const evid = process.env.EVIDENCE_DIR;              // fix worktree evidence dir, e.g. .../evidence/search-controls-20261022
const cacheDir = process.env.REF_CACHE_DIR;
const programSrc = process.env.PROGRAM_SRC;
const {createSession} = await import(path.join(root, 'src/session-server.mjs'));
const {ReferenceCache} = await import(path.join(root, 'src/reference-cache.mjs'));
const {loadChromium} = await import(path.join(root, 'src/browser-lab.mjs'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const shaFile = p => sha(fs.readFileSync(p));
const url = 'https://scp-wiki.wikidot.com/theme:basalt';
const cache = new ReferenceCache({cacheDir, fetchImpl: () => { throw new Error('OFFLINE SOURCE PROBE: acquisition forbidden'); }});
const chromium = loadChromium();
const browser = await chromium.launch({headless: true});
const session = createSession({browser, referenceAssets: cache});
const viewports = [['mobile', {width: 390, height: 844}], ['narrow-mobile', {width: 320, height: 800}]];
const measurements = [];
const shots = {};
let m0 = null;
try {
  for (const [viewport, size] of viewports) {
    const loaded = await session.loadReference({url, offline: true});
    const p = session.pages.reference;
    await p.setViewportSize(size);
    await p.waitForTimeout(250);
    const readQuery = () => p.locator('#search-top-box-input').evaluate(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return {display: s.display, visibility: s.visibility, width: r.width, height: r.height, value: e.value}; });
    const query = await readQuery();
    await p.locator('#search-top-box-form input[type=submit]').focus();
    const afterFocus = await readQuery();
    const button = await p.locator('#search-top-box-form input[type=submit]').evaluate(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return {display: s.display, visibility: s.visibility, width: r.width, height: r.height}; });
    const handler = await p.evaluate(() => ({
      search: typeof WIKIDOT?.page?.listeners?.search === 'function' ? WIKIDOT.page.listeners.search.toString() : null,
      events: typeof YAHOO?.util?.Event?.getListeners === 'function' ? YAHOO.util.Event.getListeners(document.querySelector('#search-top-box-form'), 'submit')?.map(e => ({type: e.type, fn: e.fn?.toString()})) : null}));
    let navigation = null;
    const intercept = async route => { if (route.request().isNavigationRequest()) { navigation = new URL(route.request().url()).pathname; return route.abort('blockedbyclient'); } return route.continue(); };
    await p.route('**/search:site/**', intercept);
    let actionError = null;
    try { if (await p.locator('#search-top-box-form input[type=submit]').isVisible()) await p.locator('#search-top-box-form input[type=submit]').click({timeout: 1500, noWaitAfter: true}); } catch (error) { actionError = error.message.split('\n')[0]; }
    await p.waitForTimeout(150);
    await p.unroute('**/search:site/**', intercept).catch(() => {});
    const m = await cache.load();
    m0 = m;
    measurements.push({theme: 'basalt', url, viewport, viewport_size: size, source_sha256: 'df4b78d344536f5b7c363ac86b2ddc6f3c31b3647693f473169550e03fca17c5', loaded: {offline: true, root_url: url, entry: loaded.entry}, query, after_focus: afterFocus, button, handler, navigation, action_error: actionError, original_html_sha256: m.urls[url].digest});
    shots[viewport] = await p.locator('#top-bar').first().screenshot({type: 'png'}).catch(() => null);
  }
  const snapshot = m0.snapshots[url];
  const rootDigest = snapshot.entry.replace('/o/', '');
  const htmlDigest = m0.urls[url].digest;
  const copyObject = digest => {
    const src = path.join(cacheDir, 'objects', digest.slice(0, 2), digest);
    const dst = path.join(evid, 'objects', digest.slice(0, 2), digest);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.copyFileSync(src, dst);
    if (shaFile(dst) !== digest) throw new Error('object sha mismatch ' + digest);
    return {path: path.relative(path.join(root, '..', '..', '..', '..', '..'), dst).replace(/^.*?install\/local\/theme-lab\//, ''), sha256: digest};
  };
  const artifactRel = d => `evidence/search-controls-20261022/objects/${d.slice(0, 2)}/${d}`;
  const htmlArt = copyObject(htmlDigest), rootArt = copyObject(rootDigest);
  htmlArt.path = artifactRel(htmlDigest); rootArt.path = artifactRel(rootDigest);
  const progDst = path.join(evid, 'probe-frozen-search-mobile-narrow-20261022.mjs');
  fs.copyFileSync(programSrc, progDst);
  const pngs = [];
  for (const [vp, buf] of Object.entries(shots)) {
    if (!buf) continue;
    const rel = `evidence/search-controls-20261022/artifacts/${vp}-header-search.png`;
    const dst = path.join(evid, 'artifacts', `${vp}-header-search.png`);
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.writeFileSync(dst, buf);
    pngs.push({path: rel, sha256: sha(buf)});
  }
  const record = {
    schema: 'theme_lab_wikidot_search_control.v1',
    theme: 'basalt',
    source_url: url,
    source_sha256: 'df4b78d344536f5b7c363ac86b2ddc6f3c31b3647693f473169550e03fca17c5',
    observed_at: new Date().toISOString(),
    public_writes: 0,
    external_requests_sent: 0,
    offline: true,
    browser_version: browser.version(),
    browser_sha256: shaFile(chromium.executablePath()),
    original_html_sha256: htmlDigest,
    replay_entry: snapshot.entry,
    snapshot_sha256: sha(JSON.stringify(snapshot)),
    snapshot_source: 'reference cache manifest (anonymous Wikidot acquisition retained 2026-09-23; acquisition forbidden in this replay)',
    artifacts: [htmlArt, rootArt, ...pngs],
    scope: 'Mobile (390x844) and narrow-mobile (320x800) hidden header query and native visible-button search navigation of the frozen Basalt source. Sibling of evidence/search-controls-20261001 (desktop, laptop, tablet); not an edit of it.',
    source_measurements: measurements,
    measurement_programs: [{path: 'evidence/search-controls-20261022/probe-frozen-search-mobile-narrow-20261022.mjs', sha256: shaFile(progDst)}],
  };
  fs.writeFileSync(path.join(evid, 'basalt.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({record_sha256: shaFile(path.join(evid, 'basalt.json')), browser: record.browser_version, navigation: measurements.map(x => [x.viewport, x.navigation, x.after_focus.display, x.action_error])}));
} finally {
  for (const pg of Object.values(session.pages)) await pg?.context().close().catch(() => {});
  for (const r of session.replays.values()) await r.close().catch(() => {});
  await browser.close();
}

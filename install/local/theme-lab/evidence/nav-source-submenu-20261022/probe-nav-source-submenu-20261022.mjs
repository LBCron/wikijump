// Offline replay of the cached frozen Basalt snapshot: measures the open top-navigation submenu (the target's own expand helpers) at tablet/mobile/narrow-mobile.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.env.THEME_LAB_ROOT, evid = process.env.EVIDENCE_DIR, cacheDir = process.env.REF_CACHE_DIR, programSrc = process.env.PROGRAM_SRC;
const {createSession} = await import(path.join(root, 'src/session-server.mjs'));
const {ReferenceCache} = await import(path.join(root, 'src/reference-cache.mjs'));
const {loadChromium} = await import(path.join(root, 'src/browser-lab.mjs'));
const nav = await import(path.join(root, 'src/navigation-interaction.mjs'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const shaFile = p => sha(fs.readFileSync(p));
const url = 'https://scp-wiki.wikidot.com/theme:basalt';
const cache = new ReferenceCache({cacheDir, fetchImpl: () => { throw new Error('OFFLINE SOURCE PROBE: acquisition forbidden'); }});
const chromium = loadChromium();
const browser = await chromium.launch({headless: true});
const session = createSession({browser, referenceAssets: cache});
const cases = [
  {viewport: 'tablet', size: {width: 768, height: 1024}, action: 'expandTabletTopNavigation'},
  {viewport: 'mobile', size: {width: 390, height: 844}, action: 'expandMobileTopSubmenu'},
  {viewport: 'narrow-mobile', size: {width: 320, height: 800}, action: 'expandMobileTopSubmenu'},
];
const measurements = [], pngs = [];
let m0 = null;
try {
  for (const c of cases) {
    const loaded = await session.loadReference({url, offline: true});
    const p = session.pages.reference;
    await p.setViewportSize(c.size);
    await p.waitForTimeout(300);
    let actionError = null;
    try { await nav[c.action](p); } catch (error) { actionError = error.message.split('\n')[0]; }
    await p.waitForTimeout(600);
    const data = await p.evaluate(() => {
      const vis = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0 && r.height > 0; };
      const rect = el => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
      const links = [...document.querySelectorAll('#top-bar ul li ul li a, .mobile-top-bar ul li ul li a, .top-bar ul li ul li a')].filter(vis).map(a => {
        const s = getComputedStyle(a), ul = a.parentElement.parentElement, uls = getComputedStyle(ul);
        return {text: a.textContent.trim(), background: s.backgroundColor, backdrop: s.backdropFilter, opacity: s.opacity, color: s.color, ul_background: uls.backgroundColor, ul_backdrop: uls.backdropFilter, uiOpacityVar: s.getPropertyValue('--basalt-UI-opacity').trim(), rect: rect(a)};
      });
      const titles = [...document.querySelectorAll('#page-title, #page-content h1, h1')].filter(vis).slice(0, 2).map(h => ({tag: h.tagName, text: h.textContent.trim().slice(0, 60), color: getComputedStyle(h).color, rect: rect(h)}));
      const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      const overlapping = links.map(l => ({text: l.text, area_over_title: titles.reduce((acc, t) => acc + overlap(l.rect, t.rect), 0)})).filter(x => x.area_over_title > 0);
      return {links, titles, overlapping, expandedLists: [...document.querySelectorAll('#top-bar ul li ul, .mobile-top-bar ul li ul, .top-bar ul li ul')].filter(vis).length};
    });
    const shot = await p.screenshot({type: 'png'});
    const rel = `evidence/nav-source-submenu-20261022/artifacts/${c.viewport}-expanded.png`;
    fs.mkdirSync(path.join(evid, 'artifacts'), {recursive: true});
    fs.writeFileSync(path.join(evid, 'artifacts', `${c.viewport}-expanded.png`), shot);
    pngs.push({path: rel, sha256: sha(shot), viewport: c.viewport});
    m0 = await cache.load();
    const backgrounds = [...new Set(data.links.map(l => l.background))];
    const backdrops = [...new Set(data.links.map(l => l.backdrop))];
    measurements.push({viewport: c.viewport, viewport_size: c.size, action: c.action, action_error: actionError, visible_submenu_links: data.links.length, expanded_lists: data.expandedLists, backgrounds, backdrops, ul_backgrounds: [...new Set(data.links.map(l => l.ul_background))], uiOpacityVars: [...new Set(data.links.map(l => l.uiOpacityVar))], links: data.links.slice(0, 18), title_candidates: data.titles, links_overlapping_title: data.overlapping.length, overlapping: data.overlapping.slice(0, 18), screenshot_png: rel, screenshot_sha256: sha(shot)});
  }
  const snapshot = m0.snapshots[url];
  const htmlDigest = m0.urls[url].digest, rootDigest = snapshot.entry.replace('/o/', '');
  const objs = [htmlDigest, rootDigest].map(d => {
    const src = path.join(cacheDir, 'objects', d.slice(0, 2), d), dst = path.join(evid, 'objects', d.slice(0, 2), d);
    fs.mkdirSync(path.dirname(dst), {recursive: true}); fs.copyFileSync(src, dst);
    if (shaFile(dst) !== d) throw new Error('object sha mismatch ' + d);
    return {path: `evidence/nav-source-submenu-20261022/objects/${d.slice(0, 2)}/${d}`, sha256: d};
  });
  const progDst = path.join(evid, 'probe-nav-source-submenu-20261022.mjs');
  fs.copyFileSync(programSrc, progDst);
  const record = {
    schema: 'theme_lab_source_navigation_submenu.v1', theme: 'basalt', source_url: url,
    source_sha256: 'df4b78d344536f5b7c363ac86b2ddc6f3c31b3647693f473169550e03fca17c5',
    observed_at: new Date().toISOString(), public_writes: 0, external_requests_sent: 0, offline: true,
    browser_version: browser.version(), browser_sha256: shaFile(chromium.executablePath()),
    original_html_sha256: htmlDigest, replay_entry: snapshot.entry, snapshot_sha256: sha(JSON.stringify(snapshot)),
    snapshot_source: 'reference cache manifest (anonymous Wikidot acquisition retained 2026-09-23; acquisition forbidden in this replay)',
    artifacts: [...objs, ...pngs.map(x => ({path: x.path, sha256: x.sha256}))],
    scope: 'Open top-navigation submenu of the frozen Basalt source at tablet (768x1024), mobile (390x844) and narrow-mobile (320x800), opened with the target capture helpers. Measures link background/alpha, backdrop filter and title/heading overlap.',
    measurement_programs: [{path: 'evidence/nav-source-submenu-20261022/probe-nav-source-submenu-20261022.mjs', sha256: shaFile(progDst)}],
    source_measurements: measurements,
  };
  fs.writeFileSync(path.join(evid, 'basalt.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({record_sha256: shaFile(path.join(evid, 'basalt.json')), rows: measurements.map(x => ({v: x.viewport, err: x.action_error, links: x.visible_submenu_links, bg: x.backgrounds, backdrop: x.backdrops, overlap: x.links_overlapping_title}))}));
} finally {
  for (const pg of Object.values(session.pages)) await pg?.context().close().catch(() => {});
  for (const r of session.replays.values()) await r.close().catch(() => {});
  await browser.close();
}

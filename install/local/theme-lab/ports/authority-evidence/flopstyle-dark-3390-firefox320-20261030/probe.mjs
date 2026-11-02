// flopstyle-dark Firefox top-bar endpoint probe (ALLOC-35 Q3 supplementary record).
// Page setup is the phase-A / design-harness shell setup verbatim (m123-parity.mjs
// lineage): runtime origin page run-owned:sigma10-main, nav fixtures injected,
// runtime sigma link disabled, acceptance styles = runtime-asset-replay.css +
// sigma10-offline.css + the candidate CSS under test. The only adaptation from
// the phase-A probe is that the candidate CSS is read from the worktree at run
// time (so the same script measures before/after candidates unchanged) and an
// extra topBarMaxRight field (max right edge over the measured top-bar
// elements) is recorded alongside the raw scrollWidth.
import fs from 'node:fs';

const WT = '/home/roku/.local/state/wikijump/agents/worktrees/wt-3390';
const TL = `${WT}/install/local/theme-lab`;
const FRAMERAIL = `${WT}/framerail`;

const { loadBrowser } = await import(`${TL}/src/browser-lab.mjs`);

const ORIGIN = 'https://scpaiueouiuiuiui.wikijump.localhost:3413';
const email = process.env.WIKIDOT_VERIFY_ADMIN_EMAIL;
const password = process.env.WIKIDOT_VERIFY_ADMIN_PASS;
if (!email || !password) throw new Error('admin creds missing from env');

const candidatePath = process.argv[2];
const outPath = process.argv[3];
if (!candidatePath || !outPath) throw new Error('usage: probe320.mjs <candidate.css> <out.json>');

const supportCss = fs.readFileSync(`${TL}/ports/interactive-visual-fixture/runtime-asset-replay.css`, 'utf8');
const baselineCss = fs.readFileSync(`${TL}/sigma10-migration/sigma10-offline.css`, 'utf8');
const candidateCss = fs.readFileSync(candidatePath, 'utf8');
const headerHtml = fs.readFileSync(`${TL}/fixtures/scp-jp-header.html`, 'utf8');
const sidebarHtml = fs.readFileSync(`${TL}/fixtures/scp-jp-sidebar.html`, 'utf8');
const interwikiHtml = fs.readFileSync(`${TL}/fixtures/scp-jp-interwiki.html`, 'utf8');

function measureFn() {
  const r2 = (n) => Math.round(n * 100) / 100;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r2(r.x), y: r2(r.y), width: r2(r.width), height: r2(r.height), right: r2(r.right) }; };
  const list = document.querySelector('#top-bar .mobile-top-bar > ul');
  if (!list) return null;
  const items = [...list.querySelectorAll(':scope > li')];
  const grab = (li) => {
    if (!li) return null;
    const sub = li.querySelector(':scope > ul');
    const scs = sub ? getComputedStyle(sub) : null;
    return {
      li: rect(li),
      li_text: (li.querySelector(':scope > a')?.textContent ?? '').trim(),
      submenu: rect(sub),
      submenu_style: scs ? { position: scs.position, left: scs.left, right: scs.right, display: scs.display, visibility: scs.visibility, opacity: scs.opacity } : null,
    };
  };
  const last = grab(items[items.length - 1]);
  const nthLast2 = grab(items[items.length - 2]);
  const rights = [rect(list)?.right, last?.submenu?.right, nthLast2?.submenu?.right].filter((v) => typeof v === 'number');
  return {
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    topBarMaxRight: rights.length ? Math.max(...rights) : null,
    barList: rect(list),
    itemCount: items.length,
    last,
    nthLast2,
  };
}

async function setupShellPage(page) {
  await page.goto(`${ORIGIN}/run-owned%3Asigma10-main`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    for (const selector of ['#history-button', '#page-options-bottom', '#search-top-box-form input[type="submit"]', '#side-bar .collapsible-block-link']) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const symbol = Object.getOwnPropertySymbols(element).find((s) => s.description === 'events');
      if (symbol && typeof element[symbol]?.click === 'function') return true;
    }
    return false;
  }, null, { timeout: 12000 }).catch(() => {});
  await page.evaluate(async () => {
    const fetchFixture = async (slug) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(`/${encodeURIComponent(slug)}`, { cache: 'no-store' });
        if (response.ok) return response;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
      throw new Error(`fixture fetch failed: ${slug}`);
    };
    const payloads = [];
    for (const [slug, selector] of [['run-owned:sigma10-nav-top', '#top-bar'], ['run-owned:sigma10-nav-side', '#side-bar']]) {
      const response = await fetchFixture(slug);
      const html = new DOMParser().parseFromString(await response.text(), 'text/html');
      const source = html.querySelector('#page-content');
      if (!source) throw new Error(`fixture lacks #page-content: ${slug}`);
      payloads.push([selector, source.innerHTML]);
    }
    const apply = () => { for (const [selector, html] of payloads) { const t = document.querySelector(selector); if (t && t.innerHTML !== html) t.innerHTML = html; } };
    apply();
    await new Promise((r) => setTimeout(r, 700));
    apply();
  });
  await page.locator('#header').evaluate((e, html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    for (const tag of ['h1', 'h2']) {
      const src = t.content.querySelector(tag);
      const dst = e.querySelector(tag);
      if (src && dst) dst.replaceWith(src.cloneNode(true));
    }
  }, headerHtml);
  await page.locator('#side-bar').evaluate((e, html) => { e.innerHTML = html; }, sidebarHtml);
  await page.locator('#side-bar').evaluate((e, html) => {
    e.querySelectorAll('.scpnet-interwiki-wrapper').forEach((n) => n.remove());
    e.insertAdjacentHTML('beforeend', html);
  }, interwikiHtml);
  await page.locator('link[rel="stylesheet"][href="/wikidot/styles/sigma-fe5388a32e12.css"]').evaluate((link) => { link.disabled = true; link.media = 'not all'; }).catch(() => {});
  const nonce = await page.locator('script[nonce],style[nonce]').first().getAttribute('nonce').catch(() => null);
  await page.evaluate(({ css, nonce }) => {
    const style = document.createElement('style');
    style.setAttribute('data-theme-lab-acceptance-styles', '');
    if (nonce) style.nonce = nonce;
    style.textContent = css;
    document.head.append(style);
  }, { css: [supportCss, baselineCss, candidateCss].join('\n'), nonce });
  await page.waitForTimeout(600);
}

async function auth(browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  await ctx.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === ORIGIN) { await route.continue(); return; }
    await route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/-/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('.auth-name-or-email').fill(email);
  await page.locator('.auth-password').fill(password);
  await page.locator('#login button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#login'), null, { timeout: 15000 });
  const storage = await ctx.storageState();
  await ctx.close();
  return storage;
}

async function measureStates(page) {
  const out = {};
  out.settled = await page.evaluate(measureFn);
  const rootSel = '#top-bar .mobile-top-bar';
  const hover = async (label, sel) => {
    await page.locator(sel).hover({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(450);
    out[label] = await page.evaluate(measureFn);
    await page.mouse.move(2, 300).catch(() => {});
    await page.waitForTimeout(250);
  };
  await hover('hoverLast', `${rootSel} > ul > li:last-child > a`);
  await hover('hoverNth', `${rootSel} > ul > li:nth-last-child(2) > a`);
  return out;
}

const browserType = loadBrowser('firefox', FRAMERAIL);
const browser = await browserType.launch({ headless: true, executablePath: browserType.executablePath() });
const results = { browserVersion: browser.version() };
try {
  const storage = await auth(browser);
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, ignoreHTTPSErrors: true, storageState: storage });
    await context.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === ORIGIN) { await route.continue(); return; }
      await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    await setupShellPage(page);
    results[String(width)] = await measureStates(page);
    await context.close();
    console.log(`width ${width} done`);
  }
} finally {
  await browser.close();
}
fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
console.log(`wrote ${outPath}`);

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const EXPECTED = {
  sideBlockBorderTopWidth: "1px",
  sideBlockBorderTopStyle: "solid",
  sideBlockBorderTopColor: "rgb(102, 0, 0)",
  sideBlockBorderTopLeftRadius: "10px",
  sideBlockBackgroundColor: "rgb(255, 255, 255)",
  headingColor: "rgb(102, 0, 0)",
  linkColor: "rgb(187, 0, 17)",
};

export function usage() {
  return `Usage: check-sigma10-interwiki-style.mjs [options]

Live check that the scp-jp-sigma10 site's interwiki frame is actually styled
by the site theme. The interwiki content is a separate iframe document, so
this drives a real Chromium against the live site: it reads the served
styleFrame declaration, enters the real interwiki frame, and compares the
computed styles of the frame's .side-block, .heading and menu links with
the #interwiki rules of the JP Sigma-10 theme served at
/component:theme/code/1 on the site. It also fails on any Content Security
Policy refusal reported while loading.

This is a live check: it needs the stafflab site reachable and a Playwright
installation (default ~/node_modules). It is not part of the offline test
suite and CI does not run it; record its output as evidence instead.

Options:
  --base-url URL       Site origin (default https://scp-jp-sigma10.localhost:28443)
  --page PATH          Page path to load (default /)
  --browser-root DIR   Directory whose node_modules holds playwright
                       (default ~/node_modules)
  --output FILE        Write the JSON report to FILE as well as stdout
  --screenshot FILE    Write a screenshot of the interwiki wrapper region
  --timeout-ms N       Navigation timeout (default 45000)
  --help               Show this text

Exit codes: 0 = styled as expected, 1 = check failed, 2 = harness error.
`;
}

function parseArgs(argv) {
  const args = {
    baseUrl: "https://scp-jp-sigma10.localhost:28443",
    page: "/",
    browserRoot: path.join(homedir(), "node_modules"),
    output: null,
    screenshot: null,
    timeoutMs: 45000,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${flag}`);
      return argv[i];
    };
    if (flag === "--base-url") args.baseUrl = next();
    else if (flag === "--page") args.page = next();
    else if (flag === "--browser-root") args.browserRoot = next();
    else if (flag === "--output") args.output = next();
    else if (flag === "--screenshot") args.screenshot = next();
    else if (flag === "--timeout-ms") args.timeoutMs = Number(next());
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function requirePlaywright(browserRoot) {
  const rootPackage = path.join(browserRoot, "package.json");
  const anchor = existsSync(rootPackage)
    ? rootPackage
    : path.join(browserRoot, "__anchor__.js");
  const requireFromRoot = createRequire(anchor);
  try {
    return requireFromRoot("playwright");
  } catch (error) {
    throw new Error(`could not load playwright from ${browserRoot}: ${error.message}`);
  }
}

export async function checkSigma10InterwikiStyle(args) {
  const { chromium } = requirePlaywright(args.browserRoot);
  const browser = await chromium.launch({ headless: true });
  const report = {
    tool: "check-sigma10-interwiki-style",
    base_url: args.baseUrl,
    page: args.page,
    checked_at: new Date().toISOString(),
    assertions: [],
    evidence: {},
  };
  const assert = (name, ok, actual) => {
    report.assertions.push({ name, ok: Boolean(ok), actual });
    return ok;
  };
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    const cspViolations = [];
    page.on("console", (message) => {
      const text = message.text();
      if (/content security policy/i.test(text) && /refused/i.test(text)) {
        cspViolations.push(text.slice(0, 300));
      }
    });
    page.on("pageerror", (error) => {
      const text = String(error);
      if (/content security policy/i.test(text)) cspViolations.push(text.slice(0, 300));
    });
    const url = new URL(args.page, args.baseUrl).href;
    await page.goto(url, { waitUntil: "load", timeout: args.timeoutMs });
    await page.waitForTimeout(2500);

    const styleFrameSrc = await page.evaluate(() => {
      const frame = [...document.querySelectorAll("iframe")].find((element) =>
        (element.getAttribute("src") ?? "").includes("styleFrame.html"),
      );
      return frame ? frame.src : null;
    });
    report.evidence.styleframe_src = styleFrameSrc;
    assert("styleframe-present", styleFrameSrc !== null, styleFrameSrc);
    let themeParam = null;
    let priorityParam = null;
    if (styleFrameSrc) {
      const parsed = new URL(styleFrameSrc);
      themeParam = parsed.searchParams.get("theme");
      priorityParam = parsed.searchParams.get("priority");
    }
    report.evidence.styleframe_theme = themeParam;
    report.evidence.styleframe_priority = priorityParam;
    assert("styleframe-theme-nonempty", Boolean(themeParam), themeParam);

    const frame = page
      .frames()
      .find((candidate) => candidate.url().includes("interwikiFrame.html"));
    assert("interwiki-frame-present", Boolean(frame), frame?.url() ?? null);
    if (frame) {
      await frame.waitForLoadState("load").catch(() => {});
      await frame.waitForTimeout(1500);
      const inside = await frame.evaluate(() => {
        const customStyles = [
          ...document.head.querySelectorAll("link.custom-style, style.custom-style"),
        ].map((element) => ({
          tag: element.tagName,
          priority: element.getAttribute("data-priority"),
          href: element.tagName === "LINK" ? element.href : null,
          sheet_loaded: element.tagName === "STYLE" ? true : Boolean(element.sheet),
        }));
        const sideBlock = document.querySelector(".side-block");
        const heading = document.querySelector(".side-block .heading");
        const link = document.querySelector(".side-block .menu-item a");
        const computed = (element) => (element ? getComputedStyle(element) : null);
        const side = computed(sideBlock);
        const head = computed(heading);
        const anchor = computed(link);
        return {
          custom_styles: customStyles,
          side_block: side
            ? {
                border_top_width: side.borderTopWidth,
                border_top_style: side.borderTopStyle,
                border_top_color: side.borderTopColor,
                border_top_left_radius: side.borderTopLeftRadius,
                background_color: side.backgroundColor,
              }
            : null,
          heading_color: head ? head.color : null,
          link_color: anchor ? anchor.color : null,
        };
      });
      report.evidence.frame_url = frame.url();
      report.evidence.custom_styles = inside.custom_styles;
      report.evidence.side_block = inside.side_block;
      report.evidence.heading_color = inside.heading_color;
      report.evidence.link_color = inside.link_color;
      const priorityZero = inside.custom_styles.find(
        (style) => style.priority === (priorityParam ?? "0"),
      );
      assert(
        "priority-style-applied-in-frame",
        Boolean(priorityZero) && priorityZero.sheet_loaded,
        priorityZero ?? null,
      );
      assert(
        "sideblock-border-matches-theme",
        inside.side_block?.border_top_width === EXPECTED.sideBlockBorderTopWidth &&
          inside.side_block?.border_top_style === EXPECTED.sideBlockBorderTopStyle &&
          inside.side_block?.border_top_color === EXPECTED.sideBlockBorderTopColor,
        inside.side_block,
      );
      assert(
        "sideblock-surface-matches-theme",
        inside.side_block?.border_top_left_radius ===
          EXPECTED.sideBlockBorderTopLeftRadius &&
          inside.side_block?.background_color === EXPECTED.sideBlockBackgroundColor,
        inside.side_block,
      );
      assert(
        "heading-color-matches-theme",
        inside.heading_color === EXPECTED.headingColor,
        inside.heading_color,
      );
      assert(
        "link-color-matches-theme",
        inside.link_color === EXPECTED.linkColor,
        inside.link_color,
      );
    }
    report.evidence.csp_violations = cspViolations;
    assert("no-csp-refusal", cspViolations.length === 0, cspViolations);

    if (args.screenshot) {
      const wrapper = page.locator(".scpnet-interwiki-wrapper").first();
      if ((await wrapper.count()) > 0) {
        await wrapper.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        const box = await wrapper.boundingBox();
        if (box) {
          await mkdir(path.dirname(path.resolve(args.screenshot)), { recursive: true });
          await page.screenshot({
            path: args.screenshot,
            clip: {
              x: Math.max(0, box.x - 10),
              y: Math.max(0, box.y - 10),
              width: box.width + 20,
              height: box.height + 20,
            },
          });
        }
      }
    }
  } finally {
    await browser.close();
  }
  report.ok = report.assertions.every((entry) => entry.ok);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  let report;
  try {
    report = await checkSigma10InterwikiStyle(args);
  } catch (error) {
    process.stderr.write(`harness error: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (args.output) {
    await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
    await writeFile(args.output, text);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

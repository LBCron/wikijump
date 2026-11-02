import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function usage() {
  return `Usage: node ${path.basename(process.argv[1])} [--html PATH] [--chrome BIN] [--port PORT] [--timeout MS]\n`;
}

function parseArgs(argv) {
  const options = {
    html: "/tmp/listpages-2652-proof.html",
    chrome: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
    port: 19311,
    timeout: 20000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--html") options.html = argv[(index += 1)];
    else if (arg === "--chrome") options.chrome = argv[(index += 1)];
    else if (arg === "--port") options.port = Number(argv[(index += 1)]);
    else if (arg === "--timeout") options.timeout = Number(argv[(index += 1)]);
    else {
      process.stderr.write(`unknown argument: ${arg}\n${usage()}`);
      process.exit(2);
    }
  }
  return options;
}

function httpJson(method, port, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: endpoint, method },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body || "null"));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function waitForEndpoint(port, deadline) {
  for (;;) {
    try {
      await httpJson("GET", port, "/json/version");
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("devtools endpoint did not appear");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

let cdpId = 0;
function cdp(socket, method, params = {}, deadline = Number.POSITIVE_INFINITY) {
  return new Promise((resolve, reject) => {
    const id = (cdpId += 1);
    const timer = setTimeout(
      () => {
        socket.removeEventListener("message", onMessage);
        reject(new Error(`CDP ${method} timed out`));
      },
      Math.max(0, deadline - Date.now()),
    );
    timer.unref?.();
    const onMessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const PROBE = `(() => ({
  iframes: document.querySelectorAll("iframe").length,
  listPagesBoxes: document.querySelectorAll(".list-pages-box").length,
  htmlBlocks: document.querySelectorAll(".html-block-iframe").length,
  scripts: document.querySelectorAll("script").length,
  canary: ("__listpages2652canary" in window) ? String(window.__listpages2652canary) : null,
  title: document.title,
}))()`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const htmlPath = path.resolve(options.html);
  if (!fs.existsSync(htmlPath)) {
    process.stderr.write(`missing html artifact: ${htmlPath}\n`);
    process.exit(2);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "listpages-proof-chrome-"));
  const chrome = spawn(
    options.chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${options.port}`,
      "--remote-allow-origins=*",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + options.timeout;
  try {
    await waitForEndpoint(options.port, deadline);
    const fileUrl = pathToFileURL(htmlPath).href;
    await httpJson("PUT", options.port, `/json/new?${encodeURIComponent(fileUrl)}`);
    const targets = await httpJson("GET", options.port, "/json/list");
    const page = targets.find((target) => target.type === "page" && target.url === fileUrl);
    if (!page) throw new Error("proof page target did not open");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("debugger socket did not open")), 10000);
      timer.unref?.();
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener("error", reject, { once: true });
    });
    try {
      await cdp(socket, "Page.enable", {}, deadline);
      await cdp(socket, "Page.navigate", { url: fileUrl }, deadline);
      for (;;) {
        const state = await cdp(
          socket,
          "Runtime.evaluate",
          {
            expression: "document.readyState",
            returnByValue: true,
          },
          deadline,
        );
        if (state.result.value === "complete") break;
        if (Date.now() > deadline) throw new Error("proof page did not finish loading");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const evaluation = await cdp(
        socket,
        "Runtime.evaluate",
        {
          expression: PROBE,
          returnByValue: true,
        },
        deadline,
      );
      const verdict = evaluation.result.value;
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
      const violations = [
        verdict.iframes !== 0 && `${verdict.iframes} iframe(s)`,
        verdict.listPagesBoxes !== 0 && `${verdict.listPagesBoxes} list-pages-box(es)`,
        verdict.htmlBlocks !== 0 && `${verdict.htmlBlocks} html-block(s)`,
        verdict.scripts !== 0 && `${verdict.scripts} script element(s)`,
        verdict.canary !== null && `canary executed: ${verdict.canary}`,
      ].filter(Boolean);
      if (violations.length > 0) {
        process.stderr.write(`BROWSER PROOF FAILED: ${violations.join("; ")}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write("BROWSER PROOF PASSED: inert proof HTML\n");
      }
      socket.close();
    } finally {
      try {
        socket.close();
      } catch {
      }
    }
  } finally {
    chrome.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

await main();

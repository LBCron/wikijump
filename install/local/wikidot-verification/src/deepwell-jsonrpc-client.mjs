import {deepwellRpcAuthorization} from "./deepwell-rpc-auth.mjs";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const IP_ADDRESS = "127.0.0.1";

export function validateLocalDeepwellRpcUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !new Set(["127.0.0.1", "localhost"]).has(url.hostname) || url.pathname !== "/jsonrpc" || url.username || url.password || url.search || url.hash) {
    throw new Error("Deepwell RPC URL must be an uncredentialed loopback HTTP /jsonrpc endpoint");
  }
  return url.href;
}

export class DeepwellJsonRpcClient {
  #authorization;

  constructor({rpcUrl = "http://127.0.0.1:2747/jsonrpc", rpcToken, timeoutMs = DEFAULT_RPC_TIMEOUT_MS, fetchImpl = globalThis.fetch} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Deepwell RPC timeout must be a positive integer");
    if (typeof fetchImpl !== "function") throw new Error("Deepwell RPC fetch implementation is required");
    this.rpcUrl = validateLocalDeepwellRpcUrl(rpcUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.#authorization = deepwellRpcAuthorization(rpcToken);
    this.nextId = 1;
  }

  async call(method, params = {}, context = {}) {
    const headers = {authorization: this.#authorization, "content-type": "application/json"};
    if (context.sessionToken) headers["X-Deepwell-Session-Token"] = context.sessionToken;
    if (context.siteId) headers["X-Deepwell-Site-Id"] = String(context.siteId);
    if (context.page) headers["X-Deepwell-Page"] = context.page;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.rpcUrl, {method: "POST", redirect: "error", headers, body: JSON.stringify({jsonrpc: "2.0", id: this.nextId++, method, params}), signal: controller.signal});
    } catch (error) {
      if (error.name === "AbortError") throw new Error(`Deepwell RPC ${method} timed out after ${this.timeoutMs}ms`);
      throw new Error(`Deepwell RPC ${method} transport failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Deepwell RPC ${method} returned invalid JSON with HTTP ${response.status}`);
    }
    if (!response.ok || body.error) throw new Error(`Deepwell RPC ${method} failed with HTTP ${response.status}: ${body.error?.message ?? "unknown error"}`);
    return body.result;
  }
}

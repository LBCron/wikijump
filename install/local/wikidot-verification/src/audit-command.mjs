import {spawn} from "node:child_process";
import {open} from "node:fs/promises";

async function awaitProcessGroup(pid) {
  const exists = () => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  for (const termination of [null, "SIGTERM", "SIGKILL"]) {
    if (!exists()) return;
    if (termination) process.kill(-pid, termination);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!exists()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("test process group did not terminate; cleanup cannot proceed");
}

export async function runAuditCommand(name, args, {
  cwd = process.cwd(), env = process.env, capture = false, signal,
  logPath, allowFailure = false, timeoutMs, processGroup = false,
} = {}) {
  signal?.throwIfAborted();
  const log = logPath ? await open(logPath, "wx", 0o600) : null;
  try {
    return await new Promise((resolve, reject) => {
      const started = performance.now();
      const child = spawn(name, args, {
        cwd, env, detached: processGroup,
        stdio: log ? ["ignore", log.fd, log.fd] : capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let stdout = "", stderr = "", timedOut = false;
      const escalation = [];
      const killGroup = (name) => {
        try { process.kill(-child.pid, name); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      const stop = () => {
        try {
          if (processGroup) process.kill(-child.pid, "SIGINT");
          else child.kill("SIGINT");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        // Node owners never restore source themselves. The parent restores it
        // after this group terminates, so an ignored SIGINT must remain bounded.
        // cargo-mutants is deliberately not a process group here: its own
        // supervisor must finish restoring source before it exits.
        if (processGroup && escalation.length === 0) {
          escalation.push(setTimeout(() => killGroup("SIGTERM"), 1000));
          escalation.push(setTimeout(() => killGroup("SIGKILL"), 2000));
        }
      };
      signal?.addEventListener("abort", stop, {once: true});
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        for (const timer of escalation) clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      };
      child.once("error", (error) => { finish(); reject(error); });
      child.once("close", async (code, childSignal) => {
        finish();
        if (processGroup) {
          try { await awaitProcessGroup(child.pid); }
          catch (error) { reject(error); return; }
        }
        const result = {code, signal: childSignal, stdout, stderr, timedOut, elapsed_ms: performance.now() - started};
        if (signal?.aborted) return reject(signal.reason);
        if (!allowFailure && (code !== 0 || timedOut)) {
          return reject(new Error(`${name} failed with ${childSignal ? `signal ${childSignal}` : `status ${code}`}${capture && stderr ? `: ${stderr.trim()}` : ""}`));
        }
        resolve(result);
      });
      if (signal?.aborted) stop();
    });
  } finally {
    await log?.close();
  }
}

export async function withAuditSignals(callback) {
  const controller = new AbortController();
  const abort = (name) => controller.abort(new Error(`audit interrupted by ${name}`));
  const interrupt = () => abort("SIGINT");
  const terminate = () => abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await callback(controller.signal);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

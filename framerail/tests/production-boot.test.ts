import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { fileURLToPath } from "node:url"

const framerailRoot = fileURLToPath(new URL("..", import.meta.url))
const hasBuild = existsSync(new URL("../build/handler.js", import.meta.url))

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

test(
  "production build boots via server.ts and answers HTTP",
  { skip: hasBuild ? false : "run `pnpm build` first", timeout: 30_000 },
  async () => {
    const port = await freePort()
    const child = spawn(process.execPath, ["server.ts"], {
      cwd: framerailRoot,
      env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (chunk) => (output += chunk))
    child.stderr.on("data", (chunk) => (output += chunk))
    const exited = new Promise((resolve) => child.once("exit", resolve))

    try {
      const listening = new Promise((resolve) => {
        const check = () => output.includes("Listening on") && resolve(true)
        child.stdout.on("data", check)
        check()
      })
      const started = await Promise.race([listening, exited.then(() => false)])
      assert.ok(started, `server.ts exited before listening:\n${output}`)

      const response = await fetch(`http://127.0.0.1:${port}/`)
      assert.equal(typeof response.status, "number")
      await response.arrayBuffer()
      assert.equal(child.exitCode, null, `server.ts exited after request:\n${output}`)
    } finally {
      child.kill("SIGTERM")
      await exited
    }
  }
)

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

function mainCheckout(root) {
  try {
    const commonDir = execFileSync("/usr/bin/git", ["--no-replace-objects", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
    return path.dirname(commonDir)
  } catch {
    return root
  }
}

export function siblingCheckout(name, environmentVariable, root = REPOSITORY_ROOT) {
  const override = process.env[environmentVariable]
  if (override) return override
  const direct = path.resolve(root, "..", name)
  if (existsSync(direct)) return direct
  return path.resolve(mainCheckout(root), "..", name)
}

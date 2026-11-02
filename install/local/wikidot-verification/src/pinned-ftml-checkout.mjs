import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HEX40 = /^[0-9a-f]{40}$/u;
const GIT_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
});

function gitOutput(args) {
  return execFileSync("/usr/bin/git", args, {
    encoding: "utf8",
    env: GIT_ENVIRONMENT,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function cargoFtmlGitStores() {
  const cargoGit = path.join(homedir(), ".cargo", "git");
  const stores = [];
  const dbRoot = path.join(cargoGit, "db");
  for (const entry of readdirSync(dbRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("ftml-")) {
      stores.push({ kind: "bare", root: path.join(dbRoot, entry.name) });
    }
  }
  const checkoutsRoot = path.join(cargoGit, "checkouts");
  for (const repository of readdirSync(checkoutsRoot, { withFileTypes: true })) {
    if (!repository.isDirectory() || !repository.name.startsWith("ftml-")) continue;
    const repositoryRoot = path.join(checkoutsRoot, repository.name);
    for (const checkout of readdirSync(repositoryRoot, { withFileTypes: true })) {
      if (checkout.isDirectory()) {
        stores.push({ kind: "checkout", root: path.join(repositoryRoot, checkout.name) });
      }
    }
  }
  return stores;
}

function gitArgs(store, ...args) {
  return store.kind === "bare"
    ? ["--git-dir", store.root, ...args]
    : ["-C", store.root, ...args];
}

function resolveFtmlStore(revision, tree) {
  const explicit = process.env.WIKIJUMP_FTML_CHECKOUT;
  const candidates = explicit
    ? [{ kind: "checkout", root: explicit }]
    : cargoFtmlGitStores();
  for (const store of candidates) {
    if (!path.isAbsolute(store.root)) continue;
    try {
      const observed = gitOutput(
        gitArgs(store, "rev-parse", `${revision}^{commit}`, `${revision}^{tree}`),
      ).split(/\s+/u);
      if (observed[0] === revision && observed[1] === tree) return store;
    } catch {
    }
  }
  throw new Error("local Cargo FTML object store does not contain the pinned revision and tree");
}

export function pinnedFtmlBytes({ revision, tree, sourcePath }) {
  if (!HEX40.test(revision) || !HEX40.test(tree)) {
    throw new Error("pinned FTML revision and tree must be full Git object IDs");
  }
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length === 0 ||
    /[\0\r\n]/u.test(sourcePath) ||
    path.isAbsolute(sourcePath) ||
    sourcePath.split("/").includes("..")
  ) {
    throw new Error("pinned FTML source path must be repository-relative");
  }
  const store = resolveFtmlStore(revision, tree);
  return execFileSync("/usr/bin/git", gitArgs(store, "cat-file", "blob", `${revision}:${sourcePath}`), {
    env: GIT_ENVIRONMENT,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

import "$lib/vite-env.d.ts"

import defaults from "$lib/defaults"
import process from "process"

import { info } from "$lib/server/deepwell"
import { translate } from "$lib/server/deepwell/translate"

import type { PreloadDataAsync } from "$lib/server/deepwell/views"
import type { TranslateKeys } from "$lib/types"

export async function loadInfo(preloadData: PreloadDataAsync) {
  const parentData = await preloadData()
  const locales = parentData.locales

  const response = await info()

  const translateKeys: TranslateKeys = {
    ...defaults.translateKeys,
    "about-info": {},
    "about-info.backend": {},
    "about-info.frontend": {},
    "about-info.package-name": {},
    "about-info.package-description": {},
    "about-info.package-license": {},
    "about-info.package-repository": {},
    "about-info.package-version": {},
    "about-info.rustc-version": {},
    "about-info.cargo-version": {},
    "about-info.built-at": {},
    "about-info.git-commit": {},
    "about-info.ftml-commit": {},
    "about-info.blurb": {},
    "about-info.blog": {},
    "about-info.node-version": {},
    "about-info.pnpm-version": {}
  }

  const viewData = {
    backend: {
      package: {
        name: response.package.name,
        description: response.package.description,
        license: response.package.license,
        repository: response.package.repository,
        version: response.package.version
      },
      compile_info: {
        rustc_version: response.compile_info.rustc_version,
        cargo_version: response.compile_info.cargo_version,
        built_at: response.compile_info.built_at,
        git_commit: response.compile_info.git_commit,
        ftml_commit: response.compile_info.ftml_commit
      }
    },
    frontend: {
      name: serverInfo.frontendName,
      description: serverInfo.frontendDescription,
      repository: serverInfo.frontendRepository,
      version: serverInfo.frontendVersion,
      license: serverInfo.frontendLicense,
      node: process.versions.node,
      pnpm: serverInfo.pnpmVersion,
      git_commit: serverInfo.frontendGitCommit
    },
    // The Wikijump project blog (WJ-1279). The historical
    // blog.wikijump.org subdomain no longer resolves; the project
    // site itself is the blog.
    blog_url: "https://www.wikijump.org"
  }

  const internationalization = await translate(locales, translateKeys)

  return { ...viewData, internationalization }
}

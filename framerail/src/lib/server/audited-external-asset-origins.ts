export interface AuditedExternalAssetOrigin {
  origin: string
  styles: boolean
  fonts: boolean
  evidence: string
}

export const AUDITED_EXTERNAL_ASSET_ORIGINS: readonly AuditedExternalAssetOrigin[] =
  Object.freeze([
    {
      origin: "https://*.wdfiles.com",
      styles: true,
      fonts: true,
      evidence:
        "Wikidot's own file host. Serves imported `local--files` stylesheet and font attachments, e.g. `component:theme`'s `font-bauhaus.css` in the retained shared-corpus copies of `component:classified-decoration-base`."
    },
    {
      origin: "https://cdn.scpwiki.com",
      styles: true,
      fonts: true,
      evidence:
        "SCP Wiki CDN, cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/basalt/manifest.json`)."
    },
    {
      origin: "https://cdn.jsdelivr.net",
      styles: true,
      fonts: true,
      evidence:
        "jsDelivr CDN, cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/cosmonaut/manifest.json`)."
    },
    {
      origin: "https://d3g0gp89917ko0.cloudfront.net",
      styles: true,
      fonts: true,
      evidence:
        "Legacy SCP Wiki CloudFront distribution, cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/site/manifest.json`)."
    },
    {
      origin: "https://fonts.bunny.net",
      styles: true,
      fonts: true,
      evidence:
        "Bunny Fonts, cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/al-slop/manifest.json`)."
    },
    {
      origin: "https://fonts.googleapis.com",
      styles: true,
      fonts: false,
      evidence:
        "Google Fonts stylesheet host. Still loading with HTTP 200 on both origins for `component:classified-decoration-base`'s `Noto Serif KR` import (the #2213 control), and cited by the Theme Lab port manifests (e.g. `install/local/theme-lab/ports/foxtrot/manifest.json`)."
    },
    {
      origin: "https://fonts.gstatic.com",
      styles: false,
      fonts: true,
      evidence:
        "Google Fonts font-file host for the stylesheets that Google Fonts serves."
    },
    {
      origin: "https://maxcdn.bootstrapcdn.com",
      styles: true,
      fonts: true,
      evidence:
        "Legacy Bootstrap CDN, cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/site/manifest.json`)."
    },
    {
      origin: "https://use.typekit.net",
      styles: true,
      fonts: true,
      evidence:
        "Adobe Fonts (Typekit) kit stylesheets and font files, cited by the retained Theme Lab port manifests (`install/local/theme-lab/ports/aesthetic-theme/manifest.json`, `install/local/theme-lab/ports/ouroborous-theme/manifest.json`) and observed loading on live Wikidot in `install/local/wikidot-verification/artifacts/theme-sweep-external-origins-20261019.json`."
    },
    {
      origin: "https://p.typekit.net",
      styles: true,
      fonts: false,
      evidence:
        "Typekit's kit stylesheets begin with `@import url(https://p.typekit.net/p.css?...)`, a near-empty stylesheet, so a kit that is allowed must be able to complete that import (retained observation in `install/local/wikidot-verification/artifacts/theme-sweep-external-origins-20261019.json`)."
    },
    {
      origin: "https://nu-scptheme.github.io",
      styles: true,
      fonts: true,
      evidence:
        "Nu SCP Theme GitHub Pages host for the Black Highlighter component, cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/hansarp/manifest.json`)."
    },
    {
      origin: "https://rsms.me",
      styles: true,
      fonts: true,
      evidence:
        "Rasmus Andersson's font host (Inter), cited by the retained Theme Lab port manifests (e.g. `install/local/theme-lab/ports/foxtrot/manifest.json`)."
    },
    {
      origin: "https://scp-wiki-cdn.nyc3.cdn.digitaloceanspaces.com",
      styles: true,
      fonts: true,
      evidence:
        "SCP Wiki DigitalOcean Spaces CDN, cited by the retained Theme Lab port assets (e.g. `install/local/theme-lab/ports/basalt/assets.json`)."
    },
    {
      origin: "https://scp-jp.github.io",
      styles: true,
      fonts: true,
      evidence:
        "SCP-JP community GitHub Pages host. Serves the production scp-jp theme stylesheet (sigma-9.min.css), the JP credit-module stylesheet that imported scp-jp articles @import, and the Bauhaus font CSS recorded as a dependency of the frozen Sigma-9 baseline (install/local/theme-lab/fixtures/scp-jp-sigma9-offline.json); retained sweep in install/local/wikidot-verification/artifacts/scp-jp-external-origins-20261025.json (issue #2759)."
    },
    {
      origin: "https://cdnjs.cloudflare.com",
      styles: true,
      fonts: true,
      evidence:
        "cdnjs CDN. Imported Wikidot credit modules reference the cc-icons stylesheet (https://cdnjs.cloudflare.com/ajax/libs/cc-icons/1.2.1/css/cc-icons.min.css, 4,231 bytes, sha256 cea128bf70e5dcd2d9c9d3ded35080f775cf564ea59d1a0380375f4748526722), whose @font-face loads the icon fonts from the same origin (../fonts/cc-icons.woff, 84,416 bytes, sha256 1a9b14799594702e4d0350164623d9e71261d70042ed4b3979808b08ba6e38b6); blocked by style-src on the staff-lab mirror while live Wikidot serves it; retained sweep in install/local/wikidot-verification/artifacts/cdnjs-cc-icons-external-origin-20261025.json (issue #2765)."
    },
    {
      origin: "https://indestructibletype-fonthosting.github.io",
      styles: true,
      fonts: true,
      evidence:
        "Indestructible Type's font-hosting GitHub Pages site. Both retained shared-corpus copies of `component:classified-decoration-base` `@import` `https://indestructibletype-fonthosting.github.io/renner.css` (EN capture b498634ff254edb806041276dbd088d8c9ed415d7fac1f05ff3dada1c21501d9, JP capture d0230d2f49ab3776d8d503367e06ba5d168a5fadcca7c8036af2331b5a5112e5), and current Wikidot loads both that stylesheet and its WOFF2 with HTTP 200 while Wikijump's `style-src` blocked them (issue #2213)."
    }
  ])

export const auditedExternalAssetOrigins = (directive: "styles" | "fonts"): string[] =>
  AUDITED_EXTERNAL_ASSET_ORIGINS.filter((entry) => entry[directive]).map(
    (entry) => entry.origin
  )

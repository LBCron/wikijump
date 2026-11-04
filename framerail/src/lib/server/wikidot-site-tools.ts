const WANTED_PAGES_PER_PAGE = 50

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

export const renderWikidotSiteTools = () => `
<div class="site-tools-box">
  <div class="page-options-bottom">
    <ul class="nav nav-pills">
      <li><a id="st-wanted-pages-button" href="javascript:;">Wanted pages</a></li>
      <li><a id="st-orphaned-pages-button" href="javascript:;">Orphaned pages</a></li>
      <li><a id="st-draft-pages-button" href="javascript:;">Draft pages</a></li>
    </ul>
  </div>
</div>`

export const renderWikidotListDrafts = (
  drafts: { slug: string; title: string }[] = []
) => {
  if (drafts.length === 0) {
    return `<div class="list-drafts-box">
            </div>`
  }

  let body = `<div class="list-drafts-box">
`
  for (const draft of drafts) {
    body += `            <div class="list-drafts-item">
                <p><a href="/${escapeHtml(draft.slug)}">${escapeHtml(draft.title)}</a></p>
            </div>
`
  }
  return `${body}            </div>`
}

export const renderWikidotOrphanedPages = (pages: { slug: string; title: string }[]) => {
  let body = "\n<h1>List of orphaned pages</h1>\n\n"
  for (const page of pages) {
    body += `\t\t\t<a href="/${escapeHtml(page.slug)}">${escapeHtml(page.title)}</a> <span style="color: #999">(${escapeHtml(page.slug)})</span>\n\t\t<br/>\n`
  }
  return `${body}\t\n`
}

const renderPager = (pageCount: number) => {
  let body = `<div class="pager"><span class="pager-no">page 1 of ${pageCount}</span><span class="current">1</span>`
  for (let page = 2; page <= pageCount; page += 1) {
    body += `<span class="target"><a href="javascript:;">${page}</a></span>`
  }
  body += '<span class="target"><a href="javascript:;">next &raquo;</a></span></div>'
  return body
}

export const renderWikidotWantedPages = (
  targets: { slug: string; sources: { slug: string; title: string }[] }[]
) => {
  const pageCount = Math.max(1, Math.ceil(targets.length / WANTED_PAGES_PER_PAGE))
  const pager = pageCount > 1 ? renderPager(pageCount) : ""
  let rows = ""
  for (const target of targets.slice(0, WANTED_PAGES_PER_PAGE)) {
    const sources = target.sources
      .map(
        (source) =>
          `<a href="/${escapeHtml(source.slug)}">${escapeHtml(source.title)}</a><br/>`
      )
      .join("")
    rows += `<tr><td>${sources}</td><td><a href="/${escapeHtml(target.slug)}" class="newpage">${escapeHtml(target.slug)}</a></td></tr>`
  }
  return `
<div class="wanted-pages-module">
  ${pager}
  <table class="form grid" style="margin: 1em auto;">
    <tr><th>Linked from</th><th>Linked to (wanted page name)</th></tr>
    ${rows}
  </table>
  ${pager}
</div>`
}

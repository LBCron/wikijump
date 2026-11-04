const renderedHeadingSelector =
  "h1[id^='toc'], h2[id^='toc'], h3[id^='toc'], h4[id^='toc'], h5[id^='toc'], h6[id^='toc']"
const editControlsByPage = new WeakMap<HTMLElement, HTMLAnchorElement[]>()

export type WikidotEditSection = {
  index: number
  level: number
  start: number
  end: number
}

/**
 * Match source-owned headings to the direct rendered Wikidot heading
 * sequence.
 */
export const findWikidotEditSections = (
  source: string,
  pageContent: {
    children: ArrayLike<Element>
    querySelectorAll: (selector: string) => ArrayLike<Element>
  }
): WikidotEditSection[] => {
  const descendantHeadings = Array.from(
    pageContent.querySelectorAll(renderedHeadingSelector)
  )
  const directHeadings = Array.from(pageContent.children).filter(
    (element) => /^H[1-6]$/.test(element.tagName) && /^toc\d+$/.test(element.id)
  )

  if (
    directHeadings.length === 0 ||
    descendantHeadings.length !== directHeadings.length
  ) {
    return []
  }

  const sourceHeadings = Array.from(
    source.matchAll(/^(\+{1,6})[ \t]+[^\r\n]+/gm),
    (match) => ({ level: match[1].length, start: match.index })
  )
  if (sourceHeadings.length !== directHeadings.length) return []

  for (const [index, heading] of directHeadings.entries()) {
    if (
      heading.id !== `toc${index}` ||
      heading.tagName !== `H${sourceHeadings[index].level}` ||
      descendantHeadings[index] !== heading
    ) {
      return []
    }
  }

  const nextPeerStarts: number[] = Array(sourceHeadings.length)
  const nextPeerByLevel = Array(7).fill(source.length)
  for (let index = sourceHeadings.length - 1; index >= 0; index--) {
    const heading = sourceHeadings[index]
    let nextPeerStart = source.length
    for (let level = 1; level <= heading.level; level++) {
      nextPeerStart = Math.min(nextPeerStart, nextPeerByLevel[level])
    }
    nextPeerStarts[index] = nextPeerStart
    nextPeerByLevel[heading.level] = heading.start
  }

  return sourceHeadings.map((heading, index) => {
    return {
      index,
      level: heading.level,
      start: heading.start,
      end: nextPeerStarts[index]
    }
  })
}

/**
 * Insert or remove Wikidot's direct-child section edit controls. Returns
 * whether controls are visible after the toggle.
 */
export const toggleWikidotEditSections = (
  pageContent: HTMLElement,
  source: string,
  edit: (section: WikidotEditSection) => void
): boolean => {
  const existing = editControlsByPage.get(pageContent)
  if (existing) {
    for (const control of existing) control.remove()
    editControlsByPage.delete(pageContent)
    return false
  }

  const sections = findWikidotEditSections(source, pageContent)
  const directHeadings = Array.from(pageContent.children).filter(
    (element) => /^H[1-6]$/.test(element.tagName) && /^toc\d+$/.test(element.id)
  )
  const controls: HTMLAnchorElement[] = []
  for (const section of sections) {
    const heading = directHeadings[section.index]
    const control = pageContent.ownerDocument.createElement("a")
    control.className = "edit-section-button"
    // eslint-disable-next-line no-script-url -- Wikidot's observed control contract uses this exact inert href.
    control.href = "javascript:;"
    control.id = `edit-section-b-${section.index}`
    control.textContent = "edit"
    control.addEventListener("click", (event) => {
      event.preventDefault()
      edit(section)
    })
    heading.before(control)
    controls.push(control)
  }
  if (sections.length > 0) {
    editControlsByPage.set(pageContent, controls)
  }
  return sections.length > 0
}

export const buildWikidotSectionEditSource = (
  source: string,
  section: WikidotEditSection,
  replacement: string
): string => source.slice(0, section.start) + replacement + source.slice(section.end)

/**
 * Build the existing edit action payload without allowing section editing
 * to change page metadata.
 */
export const buildWikidotSectionEditSubmission = (
  form: Record<string, unknown>,
  revision: {
    siteId: number
    pageId: number | undefined
    revisionId: number | undefined
    title: string
    altTitle: string
    tags: string
    source: string
  },
  section: WikidotEditSection,
  replacement: string
) => ({
  ...form,
  siteId: revision.siteId,
  pageId: revision.pageId,
  lastRevisionId: revision.revisionId,
  title: revision.title,
  altTitle: revision.altTitle,
  tags: revision.tags,
  wikitext: buildWikidotSectionEditSource(revision.source, section, replacement)
})

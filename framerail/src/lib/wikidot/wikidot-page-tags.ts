const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return character
    }
  })

export const buildWikidotPageTagsHtml = (
  tags: readonly string[],
  hrefForTag: (tag: string) => string = (tag) => `/system:page-tags/tag/${tag}#pages`
): string =>
  tags
    .map((tag) => `<a href="${escapeHtml(hrefForTag(tag))}">${escapeHtml(tag)}</a>`)
    .join("")

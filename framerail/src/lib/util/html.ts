let domParser: DOMParser
try {
  domParser = new DOMParser()
} catch {
}

export function toFragment(html: string) {
  const parsed = domParser.parseFromString(html, "text/html")
  const fragment = document.createDocumentFragment()
  fragment.append(...Array.from(parsed.body.children))
  return fragment
}

export function unsafeHtml(strings: TemplateStringsArray, ...subs: (string | string[])[]) {
  const src = strings.raw.reduce((prev, cur, idx) => {
    let sub = subs[idx - 1]
    if (Array.isArray(sub)) sub = sub.join("")
    return prev + sub + cur
  })
  return toFragment(src)
}

export function unsafeCss(strings: TemplateStringsArray, ...subs: (string | string[])[]) {
  const src = strings.raw.reduce((prev, cur, idx) => {
    let sub = subs[idx - 1]
    if (Array.isArray(sub)) sub = sub.join("")
    return prev + sub + cur
  })
  const style = document.createElement("style")
  style.textContent = src
  return style
}

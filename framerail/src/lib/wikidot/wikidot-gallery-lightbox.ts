type GalleryLightboxState = {
  index: number
  anchors: HTMLAnchorElement[]
  overlay: HTMLDivElement
  lightbox: HTMLDivElement
  image: HTMLImageElement
  imageBox: HTMLDivElement
  loading: HTMLDivElement
  nav: HTMLDivElement
  previous: HTMLAnchorElement
  next: HTMLAnchorElement
  dataBox: HTMLDivElement
  caption: HTMLSpanElement
  currentNumber: HTMLSpanElement
  loadSequence: number
}

const element = <K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  id: string
): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag)
  value.id = id
  return value
}

const galleryAnchors = (anchor: HTMLAnchorElement): HTMLAnchorElement[] => {
  const gallery = anchor.closest(".gallery-box")
  if (!gallery) return []
  return Array.from(gallery.querySelectorAll("a.with-lb")).filter(
    (candidate) => candidate instanceof HTMLAnchorElement
  )
}

const documentHeight = (document: Document) =>
  Math.max(
    document.body?.scrollHeight ?? 0,
    document.documentElement?.scrollHeight ?? 0,
    document.body?.offsetHeight ?? 0,
    document.documentElement?.offsetHeight ?? 0
  )

const galleryViewerFlags = (wikitext: string | null | undefined): boolean[] => {
  if (typeof wikitext !== "string" || wikitext === "") return []
  const flags: boolean[] = []
  const opening = /^[\t ]*\[\[gallery(?:[\t ]+([^\]\r\n]*))?\]\][\t ]*$/gimu
  for (const match of wikitext.matchAll(opening)) {
    const argumentsText = match[1] ?? ""
    const viewerValues = [
      ...argumentsText.matchAll(/\bviewer[\t ]*=[\t ]*"([^"]*)"/giu)
    ].map((entry) => entry[1].toLowerCase())
    const viewer = viewerValues.at(-1)
    flags.push(viewer === undefined || viewer === "yes" || viewer === "true")
  }
  return flags
}

const galleryRequirementIndex = (gallery: Element): number | null => {
  const match = /^gallery-box-(\d+)$/u.exec(gallery.id)
  if (!match) return null
  const index = Number(match[1]) - 1
  return Number.isSafeInteger(index) && index >= 0 ? index : null
}

export const wikidotGalleryLightbox = (
  root: HTMLElement,
  initialWikitext: string | null | undefined
) => {
  const document = root.ownerDocument
  const window = document.defaultView
  if (!window) return {}
  let viewerFlags = galleryViewerFlags(initialWikitext)

  let state: GalleryLightboxState | null = null

  const close = () => {
    if (!state) return
    state.loadSequence += 1
    state.overlay.remove()
    state.lightbox.remove()
    state = null
  }

  const preload = (href: string | undefined) => {
    if (!href) return
    const image = new window.Image()
    image.src = href
  }

  const showIndex = (index: number) => {
    if (!state || index < 0 || index >= state.anchors.length) return
    state.index = index
    const sequence = ++state.loadSequence
    const anchor = state.anchors[index]

    state.loading.style.display = "block"
    state.image.style.display = "none"
    state.nav.style.display = "none"
    state.previous.style.display = "none"
    state.next.style.display = "none"
    state.dataBox.style.display = "none"
    state.currentNumber.style.display = "none"

    const loader = new window.Image()
    loader.addEventListener("load", () => {
      if (sequence !== state?.loadSequence) return
      const active = state as GalleryLightboxState
      const width = loader.naturalWidth || loader.width
      const height = loader.naturalHeight || loader.height
      active.image.src = anchor.href
      active.image.alt = anchor.querySelector("img")?.getAttribute("alt") ?? ""
      active.imageBox.style.width = `${width + 20}px`
      active.imageBox.style.height = `${height + 20}px`
      active.dataBox.style.width = `${width}px`
      active.loading.style.display = "none"
      active.image.style.display = "block"
      active.nav.style.display = "block"
      active.previous.style.display = index > 0 ? "block" : "none"
      active.next.style.display = index + 1 < active.anchors.length ? "block" : "none"
      active.caption.textContent = anchor.title || ""
      if (active.anchors.length > 1) {
        active.currentNumber.textContent = `image ${index + 1} of ${active.anchors.length}`
        active.currentNumber.style.display = "block"
      }
      active.dataBox.style.display = "block"

      preload(active.anchors[index - 1]?.href)
      preload(active.anchors[index + 1]?.href)
    })
    loader.src = anchor.href
  }

  const open = (anchor: HTMLAnchorElement) => {
    const anchors = galleryAnchors(anchor)
    const index = anchors.indexOf(anchor)
    if (index < 0 || anchors.length === 0) return
    close()

    const overlay = element(document, "div", "jquery-overlay")
    overlay.style.display = "block"
    overlay.style.backgroundColor = "#000"
    overlay.style.opacity = "0.8"
    overlay.style.height = `${documentHeight(document)}px`

    const lightbox = element(document, "div", "jquery-lightbox")
    lightbox.style.display = "block"
    lightbox.style.top = `${window.scrollY + 10}px`

    const imageBox = element(document, "div", "lightbox-container-image-box")
    const imageContainer = element(document, "div", "lightbox-container-image")
    const image = element(document, "img", "lightbox-image")
    image.style.display = "none"

    const loading = element(document, "div", "lightbox-loading")
    const loadingLink = element(document, "a", "lightbox-loading-link")
    loadingLink.href = "#"
    loading.append(loadingLink)

    const nav = element(document, "div", "lightbox-nav")
    nav.style.display = "none"
    const previous = element(document, "a", "lightbox-nav-btnPrev")
    previous.href = "#"
    previous.setAttribute("aria-label", "previous image")
    const next = element(document, "a", "lightbox-nav-btnNext")
    next.href = "#"
    next.setAttribute("aria-label", "next image")
    nav.append(previous, next)
    imageContainer.append(image, loading, nav)
    imageBox.append(imageContainer)

    const dataBox = element(document, "div", "lightbox-container-image-data-box")
    dataBox.style.display = "none"
    const data = element(document, "div", "lightbox-container-image-data")
    const details = element(document, "div", "lightbox-image-details")
    const caption = element(document, "span", "lightbox-image-details-caption")
    const currentNumber = element(
      document,
      "span",
      "lightbox-image-details-currentNumber"
    )
    const secureNavigation = element(document, "div", "lightbox-secNav")
    const closeButton = element(document, "a", "lightbox-secNav-btnClose")
    closeButton.href = "#"
    closeButton.setAttribute("aria-label", "close image viewer")
    details.append(caption, currentNumber)
    secureNavigation.append(closeButton)
    data.append(details, secureNavigation)
    dataBox.append(data)
    lightbox.append(imageBox, dataBox)
    document.body.append(overlay, lightbox)

    state = {
      index,
      anchors,
      overlay,
      lightbox,
      image,
      imageBox,
      loading,
      nav,
      previous,
      next,
      dataBox,
      caption,
      currentNumber,
      loadSequence: 0
    }

    const navigation = (delta: number) => (event: Event) => {
      event.preventDefault()
      if (state) showIndex(state.index + delta)
    }
    previous.addEventListener("click", navigation(-1))
    next.addEventListener("click", navigation(1))
    closeButton.addEventListener("click", (event) => {
      event.preventDefault()
      close()
    })
    loadingLink.addEventListener("click", (event) => {
      event.preventDefault()
      close()
    })
    overlay.addEventListener("click", close)
    showIndex(index)
  }

  const click = (event: MouseEvent) => {
    const target =
      event.target instanceof Element ? event.target.closest("a.with-lb") : null
    if (!(target instanceof HTMLAnchorElement) || !root.contains(target)) return
    const gallery = target.closest(".gallery-box")
    if (!(gallery instanceof HTMLElement)) return
    const requirementIndex = galleryRequirementIndex(gallery)
    if (requirementIndex === null || viewerFlags[requirementIndex] !== true) return
    event.preventDefault()
    event.stopPropagation()
    open(target)
  }

  const keydown = (event: KeyboardEvent) => {
    if (!state) return
    const key = event.key.toLowerCase()
    if (["escape", "c", "x"].includes(key)) {
      close()
      return
    }
    if (["arrowleft", "p"].includes(key) && state.index > 0) {
      showIndex(state.index - 1)
      return
    }
    if (["arrowright", "n"].includes(key) && state.index + 1 < state.anchors.length) {
      showIndex(state.index + 1)
    }
  }

  root.addEventListener("click", click)
  document.addEventListener("keydown", keydown)
  return {
    update(wikitext: string | null | undefined) {
      viewerFlags = galleryViewerFlags(wikitext)
      close()
    },
    destroy() {
      root.removeEventListener("click", click)
      document.removeEventListener("keydown", keydown)
      close()
    }
  }
}

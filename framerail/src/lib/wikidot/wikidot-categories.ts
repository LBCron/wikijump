export type CategoriesPageListResponse = {
  status?: string
  body?: string
  categoryId?: number
}

export type WikiCategoriesModule = {
  listeners: {
    toggleListPages?: (event: Event | undefined, categoryId: number) => false
  }
  callbacks: { listPages?: (data: CategoriesPageListResponse) => void }
}

export type WikidotCategoriesRoot = Window &
  typeof globalThis & {
    WIKIDOT?: {
      modules?: { WikiCategoriesModule?: WikiCategoriesModule }
    }
  }

const CATEGORIES_PAGE_LIST_MODULE = "list/WikiCategoriesPageListModule"
const CATEGORY_TOGGLER_ID = /^category-pages-toggler-(\d+)$/u
const delegatedRoots = new WeakSet<WikidotCategoriesRoot>()

const ensureWikidotNamespace = (root: WikidotCategoriesRoot): WikiCategoriesModule => {
  const wikidot = (root.WIKIDOT ??= {})
  const modules = (wikidot.modules ??= {})
  return (modules.WikiCategoriesModule ??= { listeners: {}, callbacks: {} })
}

const categoryElements = (root: WikidotCategoriesRoot, categoryId: number) => ({
  list: root.document?.getElementById(`category-pages-${categoryId}`) ?? null,
  toggler: root.document?.getElementById(`category-pages-toggler-${categoryId}`) ?? null
})

export const installWikidotCategories = (
  root: WikidotCategoriesRoot = globalThis as WikidotCategoriesRoot
) => {
  const module = ensureWikidotNamespace(root)
  module.listeners ??= {}
  module.callbacks ??= {}

  module.callbacks.listPages = (data) => {
    const categoryId = Number(data?.categoryId)
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || data?.status !== "ok") {
      return
    }
    const { list } = categoryElements(root, categoryId)
    if (list) list.innerHTML = data.body ?? ""
  }

  module.listeners.toggleListPages = (event, categoryId) => {
    event?.preventDefault()
    event?.stopPropagation()
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return false

    const { list, toggler } = categoryElements(root, categoryId)
    if (!list || !toggler) return false

    if (list.style.display === "block") {
      list.style.display = "none"
      toggler.textContent = "+ list pages"
      return false
    }

    if (list.innerHTML === "") {
      list.style.display = "block"
      list.innerHTML = '<div class="wait-block">loading page list...</div>'
      const body = new URLSearchParams({
        moduleName: CATEGORIES_PAGE_LIST_MODULE,
        category_id: String(categoryId)
      })
      void root
        .fetch("/ajax-module-connector.php", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          credentials: "same-origin"
        })
        .then((response) => response.json())
        .then((data) => module.callbacks.listPages?.(data))
        .catch(() => {})
    } else {
      list.style.display = "block"
    }
    toggler.textContent = "- hide pages"
    return false
  }

  if (
    !delegatedRoots.has(root) &&
    typeof root.document?.addEventListener === "function"
  ) {
    root.document.addEventListener(
      "click",
      (event) => {
        const target = event.target as {
          closest?: (selector: string) => {
            id?: string
            getAttribute?: (name: string) => string | null
          } | null
        } | null
        const toggler = target?.closest?.('a[id^="category-pages-toggler-"]')
        const match = CATEGORY_TOGGLER_ID.exec(toggler?.id ?? "")
        if (!match) return

        const categoryId = Number(match[1])
        if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return

        const expectedOnclick = `WIKIDOT.modules.WikiCategoriesModule.listeners.toggleListPages(event, ${categoryId})`
        if (toggler?.getAttribute?.("onclick") !== expectedOnclick) return

        module.listeners.toggleListPages?.(event, categoryId)
      },
      true
    )
    delegatedRoots.add(root)
  }

  return module
}

import { addElement } from "./custom-elements"

export class WjTabsElement extends HTMLElement {
  static tag = "wj-tabs"

  private controller: AbortController | null = null

  connectedCallback() {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    const signal = controller.signal

    this.addEventListener("click", (event) => this.whenClicked(event), { signal })
    this.addEventListener("keydown", (event) => this.whenKeydown(event), { signal })

    const buttons = this.tabButtons()
    if (
      buttons.length > 0 &&
      !buttons.some((button) => button.getAttribute("aria-selected") === "true")
    ) {
      this.selectTab(buttons[0], false)
    }
  }

  disconnectedCallback() {
    this.controller?.abort()
    this.controller = null
  }

  private tabButtons(): HTMLElement[] {
    return Array.from(
      this.querySelectorAll<HTMLElement>(
        ":scope > .wj-tabs-button-list > .wj-tabs-button"
      )
    )
  }

  private tabPanels(): HTMLElement[] {
    return Array.from(
      this.querySelectorAll<HTMLElement>(":scope > .wj-tabs-panel-list > .wj-tabs-panel")
    )
  }

  private selectTab(selected: HTMLElement, focus: boolean) {
    const buttons = this.tabButtons()
    const panels = this.tabPanels()

    for (const [index, button] of buttons.entries()) {
      const isSelected = button === selected
      button.setAttribute("aria-selected", String(isSelected))
      button.setAttribute("tabindex", isSelected ? "0" : "-1")

      const controls = button.getAttribute("aria-controls")
      const panel = panels.find((candidate) => candidate.id === controls) ?? panels[index]
      if (panel) panel.hidden = !isSelected
    }

    if (focus) selected.focus()
  }

  private eventTabButton(event: Event): HTMLElement | null {
    if (!(event.target instanceof Element)) return null
    const button = event.target.closest<HTMLElement>(".wj-tabs-button")
    if (button?.closest("wj-tabs") !== this) return null
    return this.tabButtons().includes(button) ? button : null
  }

  private whenClicked(event: MouseEvent) {
    const button = this.eventTabButton(event)
    if (button) this.selectTab(button, false)
  }

  private whenKeydown(event: KeyboardEvent) {
    const button = this.eventTabButton(event)
    if (!button) return

    if (event.key === "Enter" || event.key === " ") {
      this.selectTab(button, false)
      event.preventDefault()
      return
    }

    const buttons = this.tabButtons()
    const index = buttons.indexOf(button)
    let next: number

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % buttons.length
        break
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + buttons.length) % buttons.length
        break
      case "Home":
        next = 0
        break
      case "End":
        next = buttons.length - 1
        break
      default:
        return
    }

    this.selectTab(buttons[next], true)
    event.preventDefault()
  }
}

export function installWjTabs() {
  addElement(WjTabsElement)
}

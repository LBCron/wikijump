<script lang="ts">
  import type { Placement } from "@popperjs/core"
  import { getFoci, keyHandle, onHover } from "$lib/dom"
  import { popover } from "./scripts/popper"
  import { guard } from "./scripts/use-guard"
  import type { Snippet } from "svelte"

  let {
    hoverable = false,
    open = false,
    placement = "bottom",
    button,
    children,
    ...others
  }: {
    hoverable?: boolean

    open?: boolean

    placement?: Placement

    button?: Snippet
    children?: Snippet<[boolean]>
    [key: string]: unknown
  } = $props()

  let details: HTMLElement
  let summary = $state<HTMLElement>()
  let menu: HTMLElement

  function checkClose(evt: PointerEvent) {
    if (!open) return
    if (!evt.target) return
    if (evt.target === details) return
    if (details.contains(evt.target as Node)) return
    closeMenu()
  }

  function toggleMenu() {
    open = !open
  }

  function openMenu() {
    open = true
  }

  function closeMenu() {
    open = false
  }

  function selectFirstActive() {
    if (!menu.contains(document.activeElement)) {
      getFoci(menu, true)[0]?.focus()
    }
  }
</script>

<svelte:body on:pointerdown={checkClose} />

<details
  bind:this={details}
  class="details-menu"
  {open}
  {...others}
  use:guard={{
    when: hoverable,
    use: [onHover, { alsoOnFocus: true, on: openMenu, off: closeMenu }]
  }}
  use:keyHandle={[{ key: "Escape", do: closeMenu }]}
>
  <summary
    bind:this={summary}
    class="details-menu-summary"
    use:keyHandle={[
      { key: "click", preventDefault: true, do: toggleMenu },
      { key: "Enter", preventDefault: true, do: openMenu },
      { key: "ArrowDown", preventDefault: true, do: selectFirstActive }
    ]}
  >
    {@render button?.()}
  </summary>

  <div
    bind:this={menu}
    class="details-menu-popover"
    use:popover={{ when: open, placement, target: summary }}
  >
    {@render children?.(open)}
  </div>
</details>

<style global lang="scss">
  @use "../css/abstracts/variables" as *;

  @keyframes reveal {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .details-menu {
    position: relative;
    display: inline-block;
    list-style: none;
  }

  .details-menu-summary {
    list-style: none;
  }

  .details-menu-popover {
    position: absolute;
    z-index: $z-popover;
  }

  .details-menu[open] > .details-menu-popover {
    animation: reveal 0.125s 1 0s backwards ease-out;
  }
</style>

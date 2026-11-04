<!--
  @component Generic dialog component.
  Doesn't handle inserting itself into a "correct" place in the DOM.
-->
<script lang="ts">
  import { scrollElement } from "$lib/dom/scrolling"
  import { createEventDispatcher, onMount, type Component, type Snippet } from "svelte"

  let dialog:
    | HTMLDialogElement
    | (HTMLElement & { showModal: () => void; close: () => void; show: () => void })

  let dispatch = createEventDispatcher()

  let {
    component = null,
    detail = {},
    open = $bindable(false),
    lazy = true,
    children,
    ...rest
  }: {
    component?: Component | null

    detail?: Record<string, unknown>

    open?: boolean

    lazy?: boolean

    children?: Snippet
    [key: string]: unknown
  } = $props()

  const closeDialog = () => void (open = false)

  let state = $state(open)
  let previousFocus: HTMLElement | null = null

  function preventPageScrolling(evt: WheelEvent) {
    if (!dialog || !evt.target) evt.preventDefault()
    const target = evt.target as HTMLElement
    if (target === dialog || dialog.contains(target)) {
      const scroll = scrollElement(evt.target as HTMLElement)
      if (target !== scroll && !dialog.contains(scroll)) evt.preventDefault()
    } else {
      evt.preventDefault()
    }
  }

  function cleanup() {
    document.removeEventListener("wheel", preventPageScrolling)
    if (previousFocus) {
      previousFocus.focus()
      previousFocus = null
    }
  }

  function show() {
    previousFocus = document.activeElement as HTMLElement
    dialog.showModal()
    document.addEventListener("wheel", preventPageScrolling, { passive: false })
    dispatch("open")
  }

  function close() {
    dialog.close()
    cleanup()
  }

  $effect(() => {
    if (dialog && state !== open) {
      if (open && !state) show()
      else if (!open && state) close()
      state = open
      dispatch("change", state)
    }
  })

  onMount(() => {
    if (open) show()
    dialog.addEventListener("cancel", () => cleanup())
    return cleanup
  })
</script>

<dialog bind:this={dialog} oncancel={() => {}} onclose={() => {}} {...rest}>
  {#if !lazy || open}
    {#if component}
      <component {closeDialog} {detail}></component>
    {/if}
    {@render children?.()}
  {/if}
</dialog>

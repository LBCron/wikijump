<!--
  @component Iconify powered inline icon.
-->
<script lang="ts">
  import { iconLoaded, getIcon, loadIcons, type IconifyIcon } from "iconify-icon"
  let {
    i,
    size = "1em",
    margin = "0 0",
    ...others
  }: {
    i: string
    size?: string
    margin?: string
    [key: string]: unknown
  } = $props()

  let icon = $state<Required<IconifyIcon> | null | undefined>(null)
  let viewBox = $derived(
    icon
      ? `${icon.left ?? 0} ${icon.top ?? 0} ${icon.width ?? 0} ${icon.height ?? 0}`
      : "0 0 0 0"
  )

  $effect(() => {
    if (i) {
      if (iconLoaded(i)) {
        icon = getIcon(i)
      } else {
        loadIcons([i], () => {
          icon = getIcon(i)
        })
      }
    }
  })
</script>

<svg
  style:width={size}
  style:height={size}
  style:margin
  aria-hidden="true"
  focusable="false"
  {viewBox}
  xmlns="http://www.w3.org/2000/svg"
  {...others}
>
  {@html icon?.body ?? ""}
</svg>

<style global lang="scss">
  svg {
    vertical-align: middle;
    transform: rotate(360deg);
  }
</style>

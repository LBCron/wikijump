<!--
  @component Icon that uses Wikijump's `ui.svg` spritesheet.
-->
<script lang="ts">
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

  let viewBox = $state("")

  $effect(() => {
    switch (i) {
      case "wj-karma":
        viewBox = "0 0 64 114"
        break
      default:
        viewBox = "0 0 24 24"
        break
    }
  })
</script>

<svg
  style:margin
  class="wj-ui-sprite sprite-{i}"
  {viewBox}
  width={size}
  {...others}
  aria-hidden="true"
>
  <use href="#{i}" />
</svg>

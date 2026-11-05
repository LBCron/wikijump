<script lang="ts">
  import { goto } from "$app/navigation"
  import { resolve } from "$app/paths"

  interface Props {
    redirectPage?: string
  }

  let { redirectPage = "/" }: Props = $props()

  $effect(() => {
    goto(resolve(redirectPage), {
      replaceState: true
    })
  })
</script>

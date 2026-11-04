<script lang="ts">
  import { page } from "$app/state"
  import Redirect from "$lib/redirect.svelte"
  const redirectPage = `/${page.params.fallback
    .split("/")
    .filter((v) => v.length)
    .join("/")}`
</script>

<Redirect {redirectPage} />

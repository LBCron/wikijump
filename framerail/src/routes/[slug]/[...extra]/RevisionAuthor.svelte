<script lang="ts">
  import type { Nullable, UserInfo } from "$lib/types"

  interface Props {
    author: Nullable<UserInfo>
  }

  let { author }: Props = $props()
</script>

{#if author}
  <span class="printuser">
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- absolute profile URL from user data -->
    <a href={author["user-profile-url"]}>{author["user-name"]}</a>
  </span>
{/if}

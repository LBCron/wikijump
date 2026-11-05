<script lang="ts">
  import { deserialize } from "$app/forms"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { getPageLayoutContext } from "$lib/layout/page-layout-context"
  import { Layout } from "$lib/types"
  import { resolve } from "$app/paths"
  let children = $state<Record<string, any>[]>([])
  let { data } = $props()
  const pageLayoutContext = getPageLayoutContext()
  let wikidot = $derived(pageLayoutContext.current === Layout.WIKIDOT)

  async function fetchChildren() {
    const res = await fetch(`?/childrenGet`, {
      method: "POST",
      body: JSON.stringify({
        pageId: data.page?.page_id,
        slug: data.page?.slug
      })
    }).then((res) => res.text())

    const result = deserialize<
      { res: Record<string, any>[] },
      { message: string; code: string; data: Record<string, unknown> }
    >(res)

    if (result.type === "failure" && result.data?.message) {
      errorPopupState.current = {
        state: true,
        message: result.data.message,
        data: result.data.data
      }
    } else if (result.type === "success" && result.data?.res) {
      children = result.data?.res
    }
  }

  $effect(() => {
    fetchChildren()
  })
</script>

{#if wikidot}
  <h1 class="page-children-header">
    {data.internationalization?.["wiki-page-children"]}
  </h1>
{:else}
  <h2 class="page-children-header">
    {data.internationalization?.["wiki-page-children"]}
  </h2>
{/if}
{#if children.length}
  <ul id="page-children" class="page-children">
    {#each children as child (child.slug)}
      <li class="page-child">
        <a href={resolve(`${child.slug}`)}>{child.title || child.slug}</a>
      </li>
    {/each}
  </ul>
{:else}
  <div class="page-children-message">
    {data.internationalization?.["wiki-page-children.no-children"]}
  </div>
{/if}

<style lang="scss">
  .page-children {
    display: flex;
    flex-direction: column;
    gap: 15px;
    align-items: stretch;
    justify-content: stretch;
    width: 100%;
    padding: 0 0 2em;
  }
</style>

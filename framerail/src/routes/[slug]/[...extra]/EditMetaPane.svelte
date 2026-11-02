<script lang="ts">
  import { deserialize } from "$app/forms"
  import { onMount } from "svelte"

  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { PagePane } from "$lib/types"
  import type { PageMetaTagView } from "$lib/server/deepwell/views"
  import {
    deleteWikidotMetaTag,
    loadWikidotEditMetaRows,
    saveWikidotMetaTag
  } from "$lib/wikidot/wikidot-edit-meta"
  import {
    editPermissionDeniedDialog,
    editPermissionDeniedMessage
  } from "$lib/wikidot/wikidot-locale"
  import type { PageProps } from "./$types"

  let { pagePaneState = $bindable(), data }: PageProps & { pagePaneState: PagePane } =
    $props()
  let rows = $state<PageMetaTagView[] | null>(null)
  let adding = $state(false)
  let metaName = $state("")
  let metaContent = $state("")
  let error = $state("")
  let busy = $state(false)
  // The meta-tag form is an edit-permission write surface like Append and
  // Parent. The pane stays empty until the live permission answer arrives,
  // so an anonymous actor receives the recorded Wikidot Permission error
  // window (issue #2336) without any writable form ever mounting.
  let permissionState = $state<"checking" | "allowed" | "denied">("checking")

  async function reloadPane() {
    if (!data.page) return
    rows = await loadWikidotEditMetaRows(fetch, data.page.page_id)
  }

  async function runMutation(mutation: () => Promise<unknown>) {
    busy = true
    error = ""
    try {
      await mutation()
      adding = false
      metaName = ""
      metaContent = ""
      await reloadPane()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Edit Meta request failed."
    } finally {
      busy = false
    }
  }

  function cancelAdding() {
    adding = false
    metaName = ""
    metaContent = ""
    error = ""
  }

  function save(allPages: boolean) {
    if (!data.page || metaName.length === 0) return
    return runMutation(() =>
      saveWikidotMetaTag(fetch, {
        pageId: data.page!.page_id,
        name: metaName,
        content: metaContent,
        allPages
      })
    )
  }

  function remove(row: PageMetaTagView) {
    if (!data.page) return
    return runMutation(() =>
      deleteWikidotMetaTag(fetch, {
        pageId: data.page!.page_id,
        name: row.name,
        allPages: row.all_pages
      })
    )
  }

  onMount(() => {
    let active = true

    const checkEditPermission = async () => {
      try {
        const response = await fetch("?/editPermission", {
          method: "POST",
          body: ""
        }).then((res) => res.text())
        const result = deserialize<
          { res: { can_edit: boolean } },
          { message: string; code: string; data: Record<string, unknown> }
        >(response)

        if (!active) return
        if (result.type === "success" && result.data?.res?.can_edit === true) {
          permissionState = "allowed"
          await reloadPane().catch((cause) => {
            error = cause instanceof Error ? cause.message : "Edit Meta request failed."
            rows = []
          })
          return
        }

        permissionState = "denied"
        if (result.type === "failure" && result.data?.message) {
          errorPopupState.current = {
            state: true,
            message: result.data.message,
            data: result.data
          }
        } else {
          const deniedDialog = editPermissionDeniedDialog(data.site.locale)
          errorPopupState.current = deniedDialog
            ? { state: true, ...deniedDialog, data: null }
            : {
                state: true,
                message: editPermissionDeniedMessage(data.site.locale),
                data: null
              }
        }
        pagePaneState = PagePane.None
      } catch {
        if (!active) return
        permissionState = "denied"
        const deniedDialog = editPermissionDeniedDialog(data.site.locale)
        errorPopupState.current = deniedDialog
          ? { state: true, ...deniedDialog, data: null }
          : {
              state: true,
              message: editPermissionDeniedMessage(data.site.locale),
              data: null
            }
        pagePaneState = PagePane.None
      }
    }

    void checkEditPermission()
    return () => {
      active = false
    }
  })
</script>

{#if permissionState === "checking"}
  <p role="status">Checking edit permission…</p>
{:else if permissionState === "allowed"}
  <h1>Meta tags for the page</h1>
  <p>
    Using the interface below you can edit special HTML &lt;meta&gt; tags for the page.
  </p>
  <h2>Current meta tags:</h2>

  {#if rows === null}
    <p class="pane-loading" aria-live="polite">Loading…</p>
  {:else}
    <div style:padding-left="3em">
      {#each rows as row (`${row.all_pages}:${row.name}`)}
        <div>
          <button
            class="edit-meta-remove"
            disabled={busy}
            onclick={() => remove(row)}
            type="button">remove</button
          >
          &lt;meta name="{row.name}" content="{row.content}"/&gt;{#if row.all_pages}
            (all pages)
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if adding}
    <div id="edit-meta-newtag">
      <h2>Add a new meta tag</h2>
      <form id="edit-meta-newtag-form" onsubmit={(event) => event.preventDefault()}>
        <!--
          The legacy Wikidot form is a single-row table whose minimum content
          width (~756px) overflows narrow phone viewports and widens the whole
          document. The pane keeps the same literal meta syntax, field names,
          and submit/cancel contract, but reflows so every field and control
          stays bounded inside the pane at 320px.
        -->
        <div class="edit-meta-syntax-row">
          <span class="edit-meta-syntax">&lt;meta&nbsp;&nbsp;&nbsp;name="</span>
          <input
            class="edit-meta-input edit-meta-name-input"
            aria-label={data.internationalization?.["wiki-page-meta-tag-name"]}
            name="metaName"
            size="20"
            type="text"
            bind:value={metaName}
          />
          <span class="edit-meta-syntax">"&nbsp;&nbsp;&nbsp;content="</span>
          <input
            class="edit-meta-input edit-meta-content-input"
            aria-label={data.internationalization?.["wiki-page-meta-tag-content"]}
            name="metaContent"
            size="30"
            type="text"
            bind:value={metaContent}
          />
          <span class="edit-meta-syntax">" /&gt;</span>
        </div>
        <div class="edit-meta-newtag-actions">
          <button
            class="btn btn-danger btn-small btn-sm"
            disabled={busy}
            onclick={cancelAdding}
            type="button">Cancel</button
          >
          <!-- svelte-ignore a11y_invalid_attribute -->
          <a
            class="button btn btn-primary btn-small btn-sm"
            href="javascript:;"
            onclick={(event) => {
              event.preventDefault()
              void save(true)
            }}>Add to All Pages</a
          >
          <!-- svelte-ignore a11y_invalid_attribute -->
          <a
            class="button btn btn-primary btn-small btn-sm"
            href="javascript:;"
            onclick={(event) => {
              event.preventDefault()
              void save(false)
            }}>Add to This Page</a
          >
        </div>
      </form>
    </div>
  {:else}
    <p id="edit-meta-addbutton">
      <button class="btn btn-primary" onclick={() => (adding = true)} type="button"
        >Add a new meta tag</button
      >
    </p>
  {/if}

  <p>
    Adding a meta tag with the name already used will effectively replace the existing
    entry. <br /><br /> Meta entries added to a page override global meta information added
    to all pages.
  </p>
{/if}

<style lang="scss">
  #edit-meta-newtag-form {
    max-width: 100%;

    .edit-meta-syntax-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0 0.25em;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      margin: 0 auto;
    }

    .edit-meta-syntax {
      overflow-wrap: anywhere;
    }

    .edit-meta-input {
      box-sizing: border-box;
      min-width: 0;
      max-width: 100%;
    }

    .edit-meta-name-input {
      flex: 0 1 10em;
    }

    .edit-meta-content-input {
      flex: 1 1 14em;
    }

    .edit-meta-newtag-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5em;
      align-items: center;
      justify-content: center;
      padding: 1em;
      text-align: center;
    }
  }

  .edit-meta-remove {
    margin-right: 2em;
  }
</style>

<script lang="ts">
  import { invalidateAll } from "$app/navigation"
  import { deserialize } from "$app/forms"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { PagePane } from "$lib/types"
  import { classifyEditLeaseSaveError } from "$lib/wikidot/wikidot-edit-lease.js"
  import { onDestroy, onMount, untrack } from "svelte"

  import EditLeaseDialog from "./EditLeaseDialog.svelte"
  import { createPageEditLeaseSession, startEditLeaseTimers } from "./edit-lease-client"

  import type { EditLeaseConflict } from "$lib/wikidot/wikidot-edit-lease.js"
  import type { PageProps } from "./$types"

  type LeaseSaveFields = {
    lockId: number
    lockSecret: string
    mode: string
    sectionIndex?: number
    lastRevisionId: number
  }

  let { pagePaneState = $bindable(), data }: PageProps & { pagePaneState: PagePane } =
    $props()

  let appendedWikitext = $state("")
  const appendLabel = $derived.by(() => {
    const translated = data.internationalization?.["wiki-page-append-content"]
    return translated && translated !== "wiki-page-append-content"
      ? translated
      : "Wikitext to append"
  })

  const leaseRequired = untrack(
    () => typeof data.page?.page_id === "number" && data.page.page_id > 0
  )
  const leaseSession = createPageEditLeaseSession()
  let leaseSnapshot = $state<{
    status: string
    conflicts: EditLeaseConflict[]
    seconds: number
    superseded: boolean
    fields: LeaseSaveFields | undefined
  }>({
    status: "idle",
    conflicts: [],
    seconds: 0,
    superseded: false,
    fields: undefined
  })
  let leaseDialog = $state<"page_changed" | "other_locks" | null>(null)
  let stopLeaseTimers: (() => void) | undefined

  const syncLease = () => {
    leaseSnapshot = {
      status: leaseSession.status,
      conflicts: leaseSession.conflictRows(),
      seconds: leaseSession.secondsRemaining(),
      superseded: leaseSession.status === "superseded",
      fields: leaseSession.saveFields()
    }
  }

  const closePane = async () => {
    await leaseSession.close()
    pagePaneState = PagePane.None
  }

  const forceLease = async () => {
    await leaseSession.forceOpen()
    syncLease()
  }

  const reacquireLease = async () => {
    leaseDialog = null
    await leaseSession.reopen()
    syncLease()
  }

  const reloadEditor = async () => {
    leaseDialog = null
    await leaseSession.close()
    window.location.reload()
  }

  const copyAppendedText = () => {
    void navigator.clipboard?.writeText(appendedWikitext)
  }

  onMount(() => {
    if (!leaseRequired) return
    stopLeaseTimers = startEditLeaseTimers(leaseSession, syncLease)
    void (async () => {
      try {
        const opening = leaseSession.open("append", undefined)
        syncLease()
        await opening
      } catch (error) {
        errorPopupState.current = {
          state: true,
          message:
            error instanceof Error ? error.message : "The edit lock request failed.",
          data: null
        }
        pagePaneState = PagePane.None
        return
      }
      syncLease()
    })()
  })

  onDestroy(() => {
    stopLeaseTimers?.()
    void leaseSession.close()
  })

  const submitAppend = async (event: SubmitEvent) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget as HTMLFormElement)
    const text = await fetch("?/edit", { method: "POST", body: formData }).then((res) =>
      res.text()
    )
    const result = deserialize<
      { res: { revision_id: number } },
      { message: string; code?: number; data: Record<string, unknown> }
    >(text)
    if (result.type === "success" && result.data) {
      if (leaseRequired) {
        leaseSession.noteSaveSucceeded(result.data.res)
        syncLease()
      }
      pagePaneState = PagePane.None
      await invalidateAll()
      return
    }
    if (result.type === "failure" && result.data) {
      const kind = leaseRequired ? classifyEditLeaseSaveError(result.data.code) : null
      if (kind) {
        leaseSession.noteSaveRejected(kind)
        leaseDialog = kind
        syncLease()
        return
      }
      errorPopupState.current = {
        state: true,
        message: result.data.message,
        data: result.data.data
      }
    }
  }
</script>

<h1 class="page-append-header">{data.wikidot_page_actions?.append ?? "Append"}</h1>

{#if leaseRequired && leaseSnapshot.status === "acquiring"}
  <p role="status">Acquiring the page edit lock&hellip;</p>
{:else if leaseRequired && leaseSnapshot.status === "conflict"}
  <p role="alert">This page is being edited by another user.</p>
{:else}
  {#if leaseSnapshot.superseded}
    <p class="edit-lease-superseded" role="alert">
      Your edit lock was taken by another user. Saving will be rejected until you take the
      lock back.
      <button class="btn" onclick={reacquireLease} type="button">
        Take the lock back
      </button>
    </p>
  {/if}

  <form
    id="page-append"
    class="page-append-form"
    action="?/edit"
    method="POST"
    onsubmit={submitAppend}
  >
    <input name="siteId" type="hidden" value={data.site.site_id} />
    <input name="pageId" type="hidden" value={data.page?.page_id} />
    <input
      name="lastRevisionId"
      type="hidden"
      value={leaseSnapshot.fields
        ? leaseSnapshot.fields.lastRevisionId
        : data.page_revision?.revision_id}
    />
    <input name="title" type="hidden" value={data.page_revision?.title ?? ""} />
    <input name="altTitle" type="hidden" value={data.page_revision?.alt_title ?? ""} />
    <input name="tags" type="hidden" value={data.page_revision?.tags?.join(" ") ?? ""} />
    <input name="comments" type="hidden" value="" />
    <input
      name="wikitext"
      type="hidden"
      value={leaseSnapshot.fields
        ? appendedWikitext
        : `${data.wikitext}${appendedWikitext}`}
    />
    {#if leaseSnapshot.fields}
      <input name="lockId" type="hidden" value={leaseSnapshot.fields.lockId} />
      <input name="lockSecret" type="hidden" value={leaseSnapshot.fields.lockSecret} />
      <input name="leaseMode" type="hidden" value={leaseSnapshot.fields.mode} />
      {#if leaseSnapshot.fields.sectionIndex !== undefined}
        <input
          name="sectionIndex"
          type="hidden"
          value={leaseSnapshot.fields.sectionIndex}
        />
      {/if}
    {/if}
    <label class="page-append-label" for="page-append-input">
      {appendLabel}
    </label>
    <textarea id="page-append-input" name="append" bind:value={appendedWikitext}
    ></textarea>
    <div class="buttons">
      <input
        class="btn btn-danger"
        onclick={closePane}
        type="button"
        value={data.internationalization?.cancel}
      />
      <input
        class="btn btn-primary"
        type="submit"
        value={data.internationalization?.save}
      />
    </div>
  </form>
{/if}

{#if leaseRequired && leaseSnapshot.status === "conflict"}
  <EditLeaseDialog
    conflicts={leaseSnapshot.conflicts}
    kind="conflict"
    onCancel={closePane}
    onForce={forceLease}
  />
{/if}

{#if leaseDialog}
  <EditLeaseDialog
    kind={leaseDialog}
    onClose={() => (leaseDialog = null)}
    onCopyText={copyAppendedText}
    onLeave={closePane}
    onReacquire={reacquireLease}
    onReload={reloadEditor}
    onViewPage={closePane}
  />
{/if}

<style lang="scss">
  .page-append-form {
    padding-bottom: 2em;
  }

  #page-append-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 12em;
  }

  .page-append-label {
    display: block;
    margin-bottom: 0.4em;
  }
</style>

<script lang="ts">
  import { goto } from "$app/navigation"
  import { deserialize } from "$app/forms"
  import { resolve } from "$app/paths"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { buildWikidotSectionEditSubmission } from "$lib/wikidot/wikidot-edit-sections"
  import { classifyEditLeaseSaveError } from "$lib/wikidot/wikidot-edit-lease.js"
  import {
    editPermissionDeniedDialog,
    editPermissionDeniedMessage
  } from "$lib/wikidot/wikidot-locale"
  import { superForm } from "sveltekit-superforms"
  import { onDestroy, onMount, untrack } from "svelte"

  import EditLeaseDialog from "./EditLeaseDialog.svelte"
  import { createPageEditLeaseSession, startEditLeaseTimers } from "./edit-lease-client"

  import type { EditLeaseConflict } from "$lib/wikidot/wikidot-edit-lease.js"
  import type { PageProps } from "./$types"

  type EditSection = {
    index: number
    level: number
    start: number
    end: number
  }

  let {
    data,
    params,
    section,
    close
  }: PageProps & { section: EditSection; close: () => void } = $props()
  const originalSource = untrack(() => data.wikitext)
  const selectedSection = untrack(() => section)
  let permissionState = $state<"checking" | "allowed" | "denied">("checking")

  const leaseSession = createPageEditLeaseSession()
  let leaseSnapshot = $state<{
    status: string
    conflicts: EditLeaseConflict[]
    seconds: number
    superseded: boolean
  }>({ status: "idle", conflicts: [], seconds: 0, superseded: false })
  let leaseDialog = $state<"page_changed" | "other_locks" | null>(null)
  let stopLeaseTimers: (() => void) | undefined

  const syncLease = () => {
    leaseSnapshot = {
      status: leaseSession.status,
      conflicts: leaseSession.conflictRows(),
      seconds: leaseSession.secondsRemaining(),
      superseded: leaseSession.status === "superseded"
    }
  }

  const cancelSection = async () => {
    await leaseSession.close()
    close()
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

  const viewCurrentPage = () => {
    leaseDialog = null
    close()
  }

  const reloadEditor = async () => {
    leaseDialog = null
    await leaseSession.close()
    window.location.reload()
  }

  const copySectionText = () => {
    void navigator.clipboard?.writeText($form.wikitext)
  }

  onMount(() => {
    let active = true
    stopLeaseTimers = startEditLeaseTimers(leaseSession, syncLease)

    const startLease = async () => {
      try {
        const opening = leaseSession.open("section", selectedSection.index)
        syncLease()
        await opening
      } catch (error) {
        if (!active) return
        errorPopupState.current = {
          state: true,
          message:
            error instanceof Error ? error.message : "The edit lock request failed.",
          data: null
        }
        close()
        return
      }
      if (active) syncLease()
    }

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
          void startLease()
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
        close()
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
        close()
      }
    }

    void checkEditPermission()
    return () => {
      active = false
    }
  })

  onDestroy(() => {
    stopLeaseTimers?.()
    void leaseSession.close()
  })

  const { form, enhance } = superForm(
    untrack(() => data.forms.pageEditForm),
    {
      dataType: "json",
      onSubmit: ({ jsonData }) => {
        const fields = leaseSession.saveFields()
        if (fields) {
          jsonData({
            ...$form,
            siteId: data.site.site_id,
            pageId: data.page?.page_id,
            lastRevisionId: fields.lastRevisionId,
            wikitext: $form.wikitext,
            lockId: fields.lockId,
            ["lockSecret"]: fields.lockSecret,
            leaseMode: fields.mode,
            sectionIndex: fields.sectionIndex ?? null
          })
          return
        }
        jsonData(
          buildWikidotSectionEditSubmission(
            $form,
            {
              siteId: data.site.site_id,
              pageId: data.page?.page_id,
              revisionId: data.page_revision?.revision_id,
              title: data.page_revision?.title ?? "",
              altTitle: data.page_revision?.alt_title ?? "",
              tags: data.page_revision?.tags?.join(" ") ?? "",
              source: originalSource
            },
            selectedSection,
            $form.wikitext
          )
        )
      },
      onResult: async ({ result, cancel }) => {
        if (result.type === "success" && result.data) {
          cancel()
          leaseSession.noteSaveSucceeded(result.data.res)
          syncLease()
          goto(resolve(`/${params.slug}`, {}), { noScroll: true })
        }
        if (result.type === "failure" && result.data) {
          const kind = classifyEditLeaseSaveError((result.data as { code?: number }).code)
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
    }
  )

  $form.title = untrack(() => data.page_revision?.title ?? "")
  $form.altTitle = untrack(() => data.page_revision?.alt_title ?? "")
  $form.tags = untrack(() => data.page_revision?.tags?.join(" ") ?? "")
  $form.comments = untrack(() => data.page_revision?.comments ?? "")
  $form.wikitext = originalSource.slice(selectedSection.start, selectedSection.end)
</script>

<div id="edit-section-content">
  <h1 class="page-edit-header">Edit Section</h1>
  {#if permissionState === "checking"}
    <p role="status">Checking edit permission…</p>
  {:else if permissionState === "allowed" && leaseSnapshot.status === "acquiring"}
    <p role="status">Acquiring the page edit lock&hellip;</p>
  {:else if permissionState === "allowed" && leaseSnapshot.status === "conflict"}
    <p role="alert">This page is being edited by another user.</p>
  {:else if permissionState === "allowed"}
    {#if leaseSnapshot.superseded}
      <p class="edit-lease-superseded" role="alert">
        Your edit lock was taken by another user. Saving will be rejected until you take
        the lock back.
        <button class="btn" onclick={reacquireLease} type="button">
          Take the lock back
        </button>
      </p>
    {/if}
    <form id="editor" class="editor" action="?/edit" method="POST" use:enhance>
      <textarea name="wikitext" class="editor-wikitext" bind:value={$form.wikitext}
      ></textarea>
      <textarea
        name="comments"
        class="editor-comments"
        placeholder={data.internationalization?.["wiki-page-revision-comments"]}
      ></textarea>
      <div class="buttons alignleft">
        <input
          name="cancel"
          class="btn btn-danger"
          onclick={cancelSection}
          type="button"
          value={data.internationalization?.cancel}
        />
        <input
          name="save"
          class="btn btn-primary"
          type="submit"
          value={data.internationalization?.save}
        />
      </div>
    </form>
  {/if}
</div>

{#if leaseSnapshot.status === "conflict"}
  <EditLeaseDialog
    conflicts={leaseSnapshot.conflicts}
    kind="conflict"
    onCancel={cancelSection}
    onForce={forceLease}
  />
{/if}

{#if leaseDialog}
  <EditLeaseDialog
    kind={leaseDialog}
    onClose={() => (leaseDialog = null)}
    onCopyText={copySectionText}
    onLeave={cancelSection}
    onReacquire={reacquireLease}
    onReload={reloadEditor}
    onViewPage={viewCurrentPage}
  />
{/if}

<style lang="scss">
  .editor {
    display: flex;
    flex-direction: column;
    gap: 15px;
    align-items: stretch;
  }

  .editor-wikitext {
    height: 40vh;
  }
</style>

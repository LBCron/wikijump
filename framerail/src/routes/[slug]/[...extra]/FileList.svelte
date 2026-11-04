<script lang="ts">
  import { tick } from "svelte"

  import { errorPopupState } from "$lib/layout/stores.svelte"
  import type { PageFile } from "$lib/server/deepwell/page-file"
  import {
    isMirrorFileInventoryReadOnly,
    sortFilesWikidot,
    wikidotFileSize,
    wikidotFileTotals,
    wikidotFileTypeDescription,
    wikidotRenameDeniedPopup,
    wikidotUploadDeniedPopup
  } from "$lib/wikidot-file-contract"
  import WikidotFileInfoModal from "./WikidotFileInfoModal.svelte"
  import type { SvelteMap } from "svelte/reactivity"
  import type { PageProps } from "./$types"
  import type { FileAction } from "./file-pane-state"

  let {
    data,
    fileMap,
    fileListError,
    fileListLoaded,
    activeFileAction = $bindable(),
    fileEditId = $bindable(),
    wikidot,
    getFileList,
    deleteFile,
    openFileHistory
  }: {
    data: PageProps["data"]
    fileMap: SvelteMap<number, PageFile>
    fileListError: string | null
    fileListLoaded: boolean
    activeFileAction: FileAction | null
    fileEditId: number
    wikidot: boolean
    getFileList: (deleted?: boolean) => Promise<void>
    deleteFile: (fileId: number, lastRevisionId: number) => Promise<void>
    openFileHistory: (fileId: number) => void
  } = $props()

  let optionsFileId = $state<number | undefined>(undefined)
  let infoFile = $state<PageFile | undefined>(undefined)
  let wikidotFiles = $derived(sortFilesWikidot([...fileMap.values()]))
  let fileTotals = $derived(wikidotFileTotals([...fileMap.values()]))

  const toggleFileOptions = (fileId: number) => {
    optionsFileId = optionsFileId === fileId ? undefined : fileId
  }

  let pendingDelete = $state<Pick<PageFile, "file_id" | "revision_id" | "name"> | null>(
    null
  )
  let deleteDialog = $state<HTMLDialogElement>()
  let cancelDeleteButton = $state<HTMLButtonElement>()
  let deleteTrigger: HTMLElement | null = null

  const localized = (
    key: keyof NonNullable<PageProps["data"]["internationalization"]>,
    fallback: string
  ) => {
    const value = data.internationalization?.[key]
    return value && value !== key ? value : fallback
  }

  function openFileAction(fileId: number, action: FileAction) {
    fileEditId = fileId
    activeFileAction = action
  }

  function openUpload() {
    if (isMirrorFileInventoryReadOnly(data.page, data.site)) {
      errorPopupState.current = {
        state: true,
        title: localized("wiki-page-file-mirror-readonly.title", "PERMISSION ERROR"),
        leadIn: localized("wiki-page-file-mirror-readonly.lead-in", "Please note:"),
        message: localized(
          "wiki-page-file-mirror-readonly.message",
          "Files on this imported page are read-only."
        ),
        extraMessage: localized(
          "wiki-page-file-mirror-readonly.extra-message",
          "Mirror pages show the source inventory. Ask a site administrator to update their files through the Wikidot import."
        ),
        actionLink: null,
        data: null
      }
      return
    }

    if (wikidot && !data.user_session) {
      errorPopupState.current = wikidotUploadDeniedPopup()
      return
    }

    activeFileAction = "upload"
  }

  function openFileRename(fileId: number) {
    if (wikidot && !data.user_session) {
      errorPopupState.current = wikidotRenameDeniedPopup()
      return
    }

    openFileAction(fileId, "edit")
  }

  function requestDelete(event: MouseEvent, file: PageFile) {
    deleteTrigger = event.currentTarget as HTMLElement
    pendingDelete = {
      file_id: file.file_id,
      revision_id: file.revision_id,
      name: file.name
    }
  }

  async function cancelDelete() {
    const trigger = deleteTrigger
    deleteTrigger = null
    if (deleteDialog?.open) deleteDialog.close()
    pendingDelete = null
    await tick()
    if (trigger?.isConnected) trigger.focus()
  }

  function handleDialogCancel(event: Event) {
    event.preventDefault()
    void cancelDelete()
  }

  function confirmDelete() {
    const target = pendingDelete
    if (!target) return
    deleteTrigger = null
    if (deleteDialog?.open) deleteDialog.close()
    pendingDelete = null
    void deleteFile(target.file_id, target.revision_id)
  }

  $effect(() => {
    if (pendingDelete && deleteDialog && !deleteDialog.open) {
      deleteDialog.showModal()
      cancelDeleteButton?.focus()
    }
  })
</script>

{#if wikidot}
  <div class="buttons">
    <input
      class="btn btn-default"
      onclick={() => void getFileList(true)}
      type="button"
      value={data.internationalization?.restore}
    />
  </div>
{:else}
  <div class="action-row file-action">
    <button
      class="action-button upload-file clickable"
      onclick={openUpload}
      type="button"
    >
      {data.internationalization?.upload}
    </button>
    <button
      class="action-button deleted-file clickable"
      onclick={() => void getFileList(true)}
      type="button"
    >
      {data.internationalization?.restore}
    </button>
  </div>
{/if}

{#if fileListError}
  <!--
    Source Wikidot leaves `#action-area` hidden and empty when the attachment
    list request fails (verified for the initial HTTP 503 case, issue #2273).
    It shows no result area, no error dialog, no toast and no retry control,
    so this layout must reproduce that absence rather than invent a recovery
    affordance. The failure stays observable internally through console error
    logging; only the false "No files for this page." reading is removed.
  -->
{:else if fileMap.size > 0}
  {#if wikidot}
    <h1>{localized("wiki-page-file-list.title", "Files")}</h1>
    <p>
      {localized("wiki-page-file-list.total-files", "Total files:")}
      {fileTotals.count}
      <br />
      {localized("wiki-page-file-list.total-size", "Total size:")}
      {wikidotFileSize(fileTotals.bytes)}
    </p>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="file-list-scroll"
    role="region"
    aria-label={data.internationalization?.["wiki-page-file"] ?? "Files"}
    tabindex="0"
  >
    {#if wikidot}
      <table class="table table-striped table-hover page-files">
        <thead>
          <tr>
            <th>{localized("wiki-page-file-list.header-name", "File name")}</th>
            <th>{localized("wiki-page-file-list.header-type", "File type")}</th>
            <th>{localized("wiki-page-file-list.header-size", "Size")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each wikidotFiles as file (file.file_id)}
            {@const fileUrl = `//${data.site_file_domain}/-/file/${data.page?.slug}/${file.name}`}
            <tr id="file-row-{file.file_id}">
              <td>
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- protocol-relative file-domain URL, not a route -->
                <a href={fileUrl}>
                  {file.name}
                </a>
              </td>
              <td>
                <span title={file.mime}>{wikidotFileTypeDescription(file.mime)}</span>
              </td>
              <td>
                {wikidotFileSize(file.size)}
              </td>
              <td>
                <!-- svelte-ignore a11y_invalid_attribute -->
                <a
                  class="btn btn-info btn-sm btn-small"
                  href="javascript:;"
                  onclick={() => (infoFile = file)}
                >
                  {localized("wiki-page-file-list.info", "Info")}
                </a>
                <!-- svelte-ignore a11y_invalid_attribute -->
                <a
                  class="btn btn-primary btn-sm btn-small"
                  href="javascript:;"
                  onclick={() => toggleFileOptions(file.file_id)}
                >
                  {localized("wiki-page-file-list.options", "Options")}
                </a>
              </td>
            </tr>
            {#if optionsFileId === file.file_id}
              <tr id="file-options-row-{file.file_id}" class="highlight">
                <td colspan="4">
                  <button
                    type="button"
                    class="btn btn-default btn-sm btn-small"
                    onclick={() => openFileRename(file.file_id)}
                  >
                    {localized("wiki-page-file-list.rename", "Rename")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-default btn-sm btn-small"
                    onclick={() => openFileAction(file.file_id, "move")}
                  >
                    {localized("wiki-page-file-list.move", "Move")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-danger btn-sm btn-small"
                    onclick={(event) => requestDelete(event, file)}
                  >
                    {localized("wiki-page-file-list.delete", "Delete")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-default btn-sm btn-small"
                    onclick={() => openFileHistory(file.file_id)}
                  >
                    {localized("wiki-page-file-list.history", "History")}
                  </button>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="file-list populated">
        <div class="file-list-header">
          <div class="file-attribute file-name">
            {data.internationalization?.["wiki-page-file.name"]}
          </div>
          <div class="file-attribute created-at">
            {data.internationalization?.["wiki-page-file.created-at"]}
          </div>
          <div class="file-attribute updated-at">
            {data.internationalization?.["wiki-page-file.updated-at"]}
          </div>
          <div class="file-attribute mime">
            {data.internationalization?.["wiki-page-file.mime"]}
          </div>
          <div class="file-attribute size">
            {data.internationalization?.["wiki-page-file.size"]}
          </div>
          <div class="file-attribute action"></div>
        </div>
        {#each [...fileMap].sort((a, b) => b[0] - a[0]) as [id, file] (id)}
          <div class="file-row" data-id={id}>
            <div class="file-attribute file-name">
              <a
                href={`//${data.site_file_domain}/-/file/${data.page?.slug}/${file.name}`}
                rel="external"
              >
                {file.name}
              </a>
            </div>
            <div class="file-attribute created-at">
              {new Date(file.file_created_at).toLocaleString()}
            </div>
            <div class="file-attribute updated-at">
              {file.file_updated_at
                ? new Date(file.file_updated_at).toLocaleString()
                : "-"}
            </div>
            {#if !wikidot}
              <div class="file-attribute mime">
                {file.mime}
              </div>
            {/if}
            <div class="file-attribute size">
              {file.size}
            </div>
            <div class="file-attribute action">
              {#if wikidot}
                {#if file.revision_type === "delete"}
                  <!-- svelte-ignore a11y_invalid_attribute -->
                  <a
                    class="btn btn-primary btn-sm btn-small"
                    href="javascript:;"
                    onclick={() => openFileAction(file.file_id, "restore")}
                  >
                    {data.internationalization?.restore}
                  </a>
                {:else}
                  <!-- svelte-ignore a11y_invalid_attribute -->
                  <a
                    class="btn btn-primary btn-sm btn-small"
                    href="javascript:;"
                    onclick={() => openFileHistory(file.file_id)}
                  >
                    {data.internationalization?.history}
                  </a>
                  <!-- svelte-ignore a11y_invalid_attribute -->
                  <a
                    class="btn btn-primary btn-sm btn-small"
                    href="javascript:;"
                    onclick={() => openFileAction(file.file_id, "move")}
                  >
                    {data.internationalization?.move}
                  </a>
                  <!-- svelte-ignore a11y_invalid_attribute -->
                  <a
                    class="btn btn-primary btn-sm btn-small"
                    href="javascript:;"
                    onclick={() => openFileRename(file.file_id)}
                  >
                    {data.internationalization?.edit}
                  </a>
                  <!-- svelte-ignore a11y_invalid_attribute -->
                  <a
                    class="btn btn-primary btn-sm btn-small delete-file"
                    href="javascript:;"
                    onclick={(event) => requestDelete(event, file)}
                  >
                    {data.internationalization?.delete}
                  </a>
                {/if}
              {:else if file.revision_type === "delete"}
                <button
                  class="action-button restore-file clickable"
                  onclick={() => openFileAction(file.file_id, "restore")}
                  type="button"
                >
                  {data.internationalization?.restore}
                </button>
              {:else}
                <button
                  class="action-button file-history clickable"
                  onclick={() => openFileHistory(file.file_id)}
                  type="button"
                >
                  {data.internationalization?.history}
                </button>
                <button
                  class="action-button move-file clickable"
                  onclick={() => openFileAction(file.file_id, "move")}
                  type="button"
                >
                  {data.internationalization?.move}
                </button>
                <button
                  class="action-button edit-file clickable"
                  onclick={() => openFileAction(file.file_id, "edit")}
                  type="button"
                >
                  {data.internationalization?.edit}
                </button>
                <button
                  class="action-button delete-file clickable"
                  onclick={(event) => requestDelete(event, file)}
                  type="button"
                >
                  {data.internationalization?.delete}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {#if wikidot}
    <div style:margin-top="1em" style:text-align="center" style:font-size="120%">
      <!-- svelte-ignore a11y_invalid_attribute -->
      <a
        href="javascript:;"
        id="show-upload-button"
        class="btn btn-large btn-lg btn-primary"
        onclick={openUpload}
      >
        {localized("wiki-page-file-list.upload", "Upload a file from your computer")}
      </a>
    </div>
    {#if infoFile}
      <WikidotFileInfoModal
        file={infoFile}
        siteId={data.site.site_id}
        pageId={data.page.page_id}
        fileUrl={`//${data.site_file_domain}/-/file/${data.page?.slug}/${infoFile.name}`}
        internationalization={data.internationalization}
        onClose={() => (infoFile = undefined)}
      />
    {/if}
  {/if}
  {#if pendingDelete}
    <dialog
      bind:this={deleteDialog}
      class="file-delete-confirmation"
      aria-labelledby="file-delete-confirmation-title"
      aria-describedby="file-delete-confirmation-details"
      oncancel={handleDialogCancel}
    >
      <h2 id="file-delete-confirmation-title">
        {localized("wiki-page-file-delete.confirmation", "Delete this file?")}
      </h2>
      <p id="file-delete-confirmation-details">
        {localized("wiki-page-file-delete.filename", "File")}: {pendingDelete.name}<br />
        {localized("wiki-page-file-delete.page", "Page")}: {data.page?.slug}
      </p>
      <div class="file-delete-actions">
        <button
          bind:this={cancelDeleteButton}
          class="file-delete-cancel"
          onclick={() => void cancelDelete()}
          type="button"
        >
          {localized("cancel", "Cancel")}
        </button>
        <button class="file-delete-confirm" onclick={confirmDelete} type="button">
          {localized("wiki-page-file-delete.confirm", "Confirm delete")}
        </button>
      </div>
    </dialog>
  {/if}
{:else if fileListLoaded}
  {#if wikidot}
    <h1>{localized("wiki-page-file-list.title", "Files")}</h1>
  {/if}
  <div class="file-list-scroll">
    <div class="file-list">
      <div class="file-list-message">
        {localized("wiki-page-file-no-files", "No files for this page.")}
      </div>
    </div>
  </div>
  {#if wikidot}
    <div style:margin-top="1em" style:text-align="center" style:font-size="120%">
      <!-- svelte-ignore a11y_invalid_attribute -->
      <a
        href="javascript:;"
        id="show-upload-button"
        class="btn btn-large btn-lg btn-primary"
        onclick={openUpload}
      >
        {localized("wiki-page-file-list.upload", "Upload a file from your computer")}
      </a>
    </div>
  {/if}
{/if}

<style lang="scss">
  .file-list-scroll {
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }

  .file-delete-confirmation {
    max-width: min(32rem, calc(100vw - 2rem));
    padding: 1.25rem;
    border: 1px solid currentColor;
    border-radius: 0.5rem;
  }

  .file-delete-confirmation::backdrop {
    background: rgb(0 0 0 / 0.55);
  }

  .file-delete-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .file-list {
    display: table;
    width: 100%;
    padding: 0 0 2em;

    &.populated {
      width: max(100%, 68rem);
    }

    .file-list-header,
    .file-row {
      display: grid;
      grid-template-columns:
        minmax(16rem, 2fr) minmax(9rem, 1fr) minmax(9rem, 1fr)
        minmax(10rem, 1.2fr) minmax(5rem, 0.6fr) minmax(14rem, 1.4fr);

      .file-attribute {
        min-width: 0;
      }
    }

    .file-attribute.file-name a {
      word-break: break-word;
      overflow-wrap: anywhere;
    }
  }
</style>

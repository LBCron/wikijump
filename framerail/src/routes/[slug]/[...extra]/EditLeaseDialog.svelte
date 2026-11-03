<script lang="ts">
  import { getPageLayoutContext } from "$lib/layout/page-layout-context"
  import { Layout } from "$lib/types"

  import type { EditLeaseConflict } from "$lib/wikidot/wikidot-edit-lease.js"

  export type EditLeaseDialogKind = "conflict" | "page_changed" | "other_locks"

  let {
    kind,
    conflicts = [],
    onForce,
    onCancel,
    onViewPage,
    onReload,
    onCopyText,
    onReacquire,
    onLeave,
    onClose
  }: {
    kind: EditLeaseDialogKind
    conflicts?: EditLeaseConflict[]
    onForce?: () => void
    onCancel?: () => void
    onViewPage?: () => void
    onReload?: () => void
    onCopyText?: () => void
    onReacquire?: () => void
    onLeave?: () => void
    onClose?: () => void
  } = $props()

  const pageLayoutContext = getPageLayoutContext()

  const formatRemaining = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return `${minutes}:${String(rest).padStart(2, "0")}`
  }

  const modeLabel = (conflict: EditLeaseConflict): string =>
    conflict.mode === "section"
      ? `section ${conflict.sectionIndex ?? ""}`.trim()
      : conflict.mode
</script>

{#snippet body()}
  {#if kind === "conflict"}
    <h1 id="edit-lease-dialog-title">The page is being edited</h1>
    <p>
      It seems that the page is currently being edited by another user. The details
      follow:
    </p>
    <ul class="edit-lease-conflicts">
      {#each conflicts as conflict (conflict.userId + conflict.mode)}
        <li>
          User {conflict.userId} &mdash; lock mode: {modeLabel(conflict)} &mdash; time remaining:
          {formatRemaining(conflict.secondsRemaining)}
        </li>
      {/each}
    </ul>
    <p>
      You can wait for the lock to expire, or force the edit and take the lock over. The
      other editor will then no longer be able to save.
    </p>
  {:else if kind === "page_changed"}
    <h1 id="edit-lease-dialog-title">The page has changed</h1>
    <p>
      The page was changed after you started editing, so your save was rejected. Your text
      has not been merged with the current version.
    </p>
    <p>
      You can view the current page, reload the editor with the current text (losing your
      changes), or copy your text before leaving.
    </p>
  {:else}
    <h1 id="edit-lease-dialog-title">Your edit lock was taken</h1>
    <p>
      Another editor took over the page edit lock, so your save was rejected. You can take
      the lock back, which restarts your editing session against the current version, or
      leave the editor.
    </p>
  {/if}
{/snippet}

{#snippet buttons()}
  {#if kind === "conflict"}
    <button class="btn btn-primary" onclick={onForce} type="button"> Edit anyway </button>
    <button class="btn btn-danger" onclick={onCancel} type="button">Cancel</button>
  {:else if kind === "page_changed"}
    <button class="btn btn-primary" onclick={onViewPage} type="button">
      View current page
    </button>
    <button class="btn" onclick={onReload} type="button">Reload editor</button>
    {#if onCopyText}
      <button class="btn" onclick={onCopyText} type="button">Copy my text</button>
    {/if}
    <button class="btn btn-danger" onclick={onClose} type="button">Close</button>
  {:else}
    <button class="btn btn-primary" onclick={onReacquire} type="button">
      Take the lock back
    </button>
    <button class="btn" onclick={onLeave} type="button">Leave editor</button>
    <button class="btn btn-danger" onclick={onClose} type="button">Close</button>
  {/if}
{/snippet}

{#if pageLayoutContext.current === Layout.WIKIDOT}
  <div id="odialog-shader" class="odialog-shader"></div>
  <div id="odialog-container" style:display="block" class="odialog-container">
    <div id="owindow-1" class="owindow edit-lease-dialog">
      <div class="title modal-header">Page edit lock</div>
      <div class="content modal-body">
        {@render body()}
      </div>
      <div class="button-bar modal-footer">
        {@render buttons()}
      </div>
    </div>
  </div>
{:else}
  <div class="modal-container" role="presentation">
    <div
      class="modal edit-lease-dialog"
      aria-describedby="edit-lease-dialog-title"
      role="dialog"
    >
      <div class="modal-message">
        {@render body()}
      </div>
      <div class="button-bar">
        {@render buttons()}
      </div>
    </div>
  </div>
{/if}

<style lang="scss">
  .edit-lease-conflicts {
    text-align: left;
  }

  .modal-container {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 100;
    width: 100%;
    height: 100%;
    text-align: center;
    background-color: #57575788;
  }

  .modal-container > .modal {
    display: inline-block;
    width: 30%;
    padding: 10px;
    margin: 40vh auto;
    color: var(--text);
    text-align: center;
    background-color: var(--background);
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .modal-container > .modal h1 {
    margin-top: 0;
    font-size: 1.2em;
  }
</style>

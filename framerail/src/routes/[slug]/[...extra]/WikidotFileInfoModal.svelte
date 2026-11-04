<script lang="ts">
  import { deserialize } from "$app/forms"
  import { onMount } from "svelte"
  import WikidotRevisionAuthor from "./WikidotRevisionAuthor.svelte"
  import {
    wikidotBareMimeType,
    wikidotFileSize,
    wikidotFileTypeDescription,
    wikidotFileUploadDate
  } from "$lib/wikidot-file-contract"
  import type { FileRevisionModel, Optional } from "$lib/types"
  import type { PageFile } from "$lib/server/deepwell/page-file"

  const SVELTEKIT_ACTION_HEADERS = {
    accept: "application/json",
    "content-type": "text/plain;charset=UTF-8",
    "x-sveltekit-action": "true"
  }

  interface Props {
    file: PageFile
    siteId: number
    pageId: number
    fileUrl: string
    internationalization?: Record<string, string>
    onClose: () => void
  }

  let { file, siteId, pageId, fileUrl, internationalization, onClose }: Props = $props()

  const text = (key: string, fallback: string) => internationalization?.[key] ?? fallback

  let earliest = $state<Optional<FileRevisionModel>>(undefined)
  let historyFailed = $state(false)

  const fileUploadDate = wikidotFileUploadDate

  onMount(async () => {
    const res = await fetch("?/fileHistory", {
      method: "POST",
      headers: SVELTEKIT_ACTION_HEADERS,
      body: JSON.stringify({ siteId, pageId, fileId: file.file_id })
    }).then((res) => res.text())
    const result = deserialize<
      { res: FileRevisionModel[] },
      { message: string; code: string; data: Record<string, unknown> }
    >(res)
    if (result.type === "success" && result.data?.res?.length) {
      earliest = [...result.data.res].sort(
        (a, b) => a.revision_number - b.revision_number
      )[0]
    } else {
      historyFailed = true
    }
  })

  const escKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose()
  }
</script>

<svelte:window onkeydown={escKeydown} />

<div
  id="odialog-shader"
  class="odialog-shader"
  onclick={onClose}
  onkeydown={escKeydown}
  role="presentation"
></div>
<div
  id="odialog-container"
  style:display="block"
  class="odialog-container"
  onclick={onClose}
  onkeydown={escKeydown}
  role="presentation"
>
  <div
    id="owindow-1"
    class="owindow"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
    role="dialog"
    aria-modal="true"
    aria-label={text("wiki-page-file-info.title", "File Information")}
    tabindex="-1"
  >
    <h1>{text("wiki-page-file-info.title", "File Information")}</h1>
    <table>
      <tbody>
        <tr>
          <td>{text("wiki-page-file-info.name", "File name:")}</td>
          <td><strong>{file.name}</strong></td>
        </tr>
        <tr>
          <td>{text("wiki-page-file-info.url", "Full file URL:")}</td>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- full file URL on the file domain, not a route -->
          <td><a href={fileUrl}>{fileUrl}</a></td>
        </tr>
        <tr>
          <td>{text("wiki-page-file-info.size", "File size:")}</td>
          <td>{wikidotFileSize(file.size)} ({file.size} Bytes)</td>
        </tr>
        <tr>
          <td>{text("wiki-page-file-info.mime", "MIME type:")}</td>
          <td>{wikidotBareMimeType(file.mime)}</td>
        </tr>
        <tr>
          <td>{text("wiki-page-file-info.content-type", "Content type:")}</td>
          <td><span title={file.mime}>{wikidotFileTypeDescription(file.mime)}</span></td>
        </tr>
        {#if earliest}
          {@const uploaded = fileUploadDate(earliest.created_at)}
          <tr>
            <td>{text("wiki-page-file-info.uploaded-by", "Uploaded by:")}</td>
            <td
              ><WikidotRevisionAuthor
                author={earliest.author}
                userId={earliest.user_id}
              /></td
            >
          </tr>
          <tr>
            <td>{text("wiki-page-file-info.upload-date", "Upload date:")}</td>
            <td><span class={uploaded.className}>{uploaded.text}</span></td>
          </tr>
        {:else if historyFailed}
          <tr>
            <td>{text("wiki-page-file-info.uploaded-by", "Uploaded by:")}</td>
            <td>{text("wiki-page-file-info.unavailable", "Unavailable")}</td>
          </tr>
        {/if}
      </tbody>
    </table>
    <div class="buttons">
      <input
        type="button"
        class="btn btn-default"
        value={text("wiki-page-file-info.close", "Close")}
        onclick={onClose}
      />
    </div>
  </div>
</div>

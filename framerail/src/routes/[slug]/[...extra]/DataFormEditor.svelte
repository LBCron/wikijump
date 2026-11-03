<script lang="ts">
  import { goto } from "$app/navigation"
  import { resolve } from "$app/paths"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { pageMutationDestinationSlug } from "$lib/page-mutation-destination"
  import {
    buildWikidotDataFormPagepathLevels,
    buildWikidotDataFormState,
    getWikidotDataFormFieldPresentation,
    serializeWikidotDataFormSource,
    wikidotDataFormFieldNames,
    wikidotDataFormPagepathSelectorClass
  } from "$lib/wikidot/wikidot-data-form.js"
  import WikidotDataFormMatchWorker from "$lib/wikidot/wikidot-data-form-match.worker.ts?worker"
  import { superForm } from "sveltekit-superforms"
  import { onDestroy, onMount, tick, untrack } from "svelte"
  import { SvelteMap } from "svelte/reactivity"
  import { mountWikidotDatePicker } from "$lib/wikidot/wikidot-date-picker.js"

  import type {
    DataFormDefinition,
    DataFormPagepathNode
  } from "$lib/server/deepwell/views"
  import type { buildPageForms } from "$lib/server/load/page/page-forms"

  type PageEditForm = Awaited<ReturnType<typeof buildPageForms>>["pageEditForm"]

  type LeaseSaveFields = {
    lockId: number
    lockSecret: string
    mode: string
    sectionIndex?: number | null
    lastRevisionId: number
  }

  type LeaseSaveFailure = {
    code?: number
    message?: string
    data?: unknown
  }

  let {
    definition,
    editForm,
    initialValues,
    initialSource,
    initialTitle,
    initialAltTitle = "",
    initialTags = "",
    initialComments = "",
    initialParent = "",
    pagepaths = {},
    siteId,
    pageId,
    lastRevisionId,
    slug,
    creating,
    leaseSaveFields,
    onLeaseSaveSuccess,
    onLeaseSaveFailure
  }: {
    definition: DataFormDefinition
    editForm: PageEditForm
    initialValues: Record<string, string>
    initialSource: string
    initialTitle: string
    initialAltTitle?: string
    initialTags?: string
    initialComments?: string
    initialParent?: string
    pagepaths?: Record<string, DataFormPagepathNode[]>
    siteId: number
    pageId?: number
    lastRevisionId?: number
    slug: string
    creating: boolean
    leaseSaveFields?: () => LeaseSaveFields | undefined
    onLeaseSaveSuccess?: (res: unknown) => void
    onLeaseSaveFailure?: (failure: LeaseSaveFailure) => boolean
  } = $props()

  let values = $state<Record<string, string>>(
    untrack(() => buildWikidotDataFormState(definition, initialValues))
  )
  let dateDisplayValues = $state<Record<string, string>>(
    untrack(() =>
      Object.fromEntries(
        definition.fields
          .filter((field) => field.field_type === "date")
          .map((field) => [field.name, initialValues[field.name] ?? ""])
      )
    )
  )
  let pagepathNodes = $state<Record<string, DataFormPagepathNode[]>>(
    untrack(() => structuredClone(pagepaths))
  )
  const writeSupported = $derived(
    !definition.fields.some((field) => field.field_type === "file")
  )
  let pagepathCreateNew = $state<
    Record<string, { parent: string; value: string } | undefined>
  >({})
  const validationErrors = new SvelteMap<string, string>()
  const category = $derived(
    slug.includes(":") ? slug.slice(0, slug.indexOf(":")) : "_default"
  )
  const headingCategory = $derived(category.charAt(0).toUpperCase() + category.slice(1))
  let activeValidationWorker: Worker | null = null
  let cancelActiveValidation: (() => void) | null = null
  let validationGeneration = 0
  const fieldGroups = $derived.by(() => {
    const groups: DataFormDefinition["fields"][] = []
    for (const field of definition.fields) {
      if (field.field_type === "hidden") continue
      if (field.field_type === "select" && field.values.length === 0) continue
      if ((field.join ?? false) && groups.length > 0) {
        groups[groups.length - 1].push(field)
      } else {
        groups.push([field])
      }
    }
    return groups
  })

  function preserveCheckedAttribute(node: HTMLInputElement) {
    void tick().then(() => node.setAttribute("checked", "checked"))
  }

  function setPagepathValue(fieldName: string, parent: string, selected: string) {
    if (selected === "+") {
      pagepathCreateNew[fieldName] = { parent, value: "New item" }
      return
    }
    pagepathCreateNew[fieldName] = undefined
    values[fieldName] = selected || (parent.endsWith(":_root") ? "" : parent)
  }

  async function createPagepathChild(
    field: DataFormDefinition["fields"][number],
    levelIndex: number
  ) {
    const pending = pagepathCreateNew[field.name]
    const treeCategory = field.pagepath_category
    if (!pending || !treeCategory) return
    const title = pending.value
    const rootFullname = `${treeCategory}:_root`
    const response = await fetch("/ajax-module-connector.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: "same-origin",
      body: new URLSearchParams({
        action: "DataFormAction",
        event: "newPage",
        category: treeCategory,
        parent: pending.parent === rootFullname ? "" : pending.parent,
        title,
        moduleName: "Empty",
        callbackIndex: String(levelIndex + 1)
      })
    })
    const result = await response.json()
    if (!response.ok || result?.status !== "ok" || typeof result.fullname !== "string") {
      validationErrors.set(
        field.name,
        result?.message || "An error occurred while processing the request."
      )
      return
    }
    const fullname = result.fullname
    pagepathNodes[field.name] ??= []
    if (
      pending.parent === rootFullname &&
      !pagepathNodes[field.name].some((node) => node.fullname === rootFullname)
    ) {
      pagepathNodes[field.name].push({
        fullname: rootFullname,
        name: "_root",
        parent: null
      })
    }
    if (!pagepathNodes[field.name].some((node) => node.fullname === fullname)) {
      pagepathNodes[field.name].push({
        fullname,
        name: title,
        parent: pending.parent
      })
    }
    values[field.name] = fullname
    pagepathCreateNew[field.name] = undefined
    validationErrors.delete(field.name)
  }

  onMount(() => {
    const cleanups = definition.fields.flatMap((field) => {
      if (field.field_type !== "date") return []
      const input = document.getElementsByName(`field-${field.name}`)[0]
      if (!(input instanceof HTMLInputElement)) return []
      return [
        mountWikidotDatePicker(
          input,
          field.options ?? {},
          ({ display, timestamp }) => {
            dateDisplayValues[field.name] = display
            values[field.name] = timestamp
            const altField = field.options?.altField
            if (typeof altField !== "string") return
            const altInput = document.querySelector<HTMLInputElement>(altField)
            if (altInput?.name.startsWith("field-")) {
              values[altInput.name.slice("field-".length)] = altInput.value
            }
          },
          (display) => {
            dateDisplayValues[field.name] = display
            const altField = field.options?.altField
            if (typeof altField !== "string") return
            const altInput = document.querySelector<HTMLInputElement>(altField)
            if (altInput?.name.startsWith("field-")) {
              values[altInput.name.slice("field-".length)] = altInput.value
            }
          }
        )
      ]
    })
    return () => cleanups.forEach((cleanup) => cleanup())
  })

  type MatchField = {
    name: string
    pattern: string
    value: string
  }

  type MatchResult =
    | { kind: "complete"; results: { name: string; matches: boolean }[] }
    | { kind: "invalid"; name: string }
    | { kind: "unsafe" }
    | { kind: "cancelled" }

  function matchFieldsWithinBrowserBudget(
    fields: MatchField[],
    generation: number
  ): Promise<MatchResult> {
    return new Promise((resolve) => {
      const worker = new WikidotDataFormMatchWorker()
      activeValidationWorker = worker
      let complete = false
      const finish = (result: MatchResult) => {
        if (complete) return
        complete = true
        clearTimeout(timeout)
        worker.terminate()
        if (activeValidationWorker === worker) activeValidationWorker = null
        if (cancelActiveValidation === cancelValidation) cancelActiveValidation = null
        resolve(result)
      }
      const cancelValidation = () => finish({ kind: "cancelled" })
      cancelActiveValidation = cancelValidation
      const timeout = setTimeout(() => finish({ kind: "unsafe" }), 250)
      worker.onmessage = (event: MessageEvent<MatchResult>) => {
        if (generation !== validationGeneration) {
          finish({ kind: "cancelled" })
          return
        }
        finish(event.data)
      }
      worker.onerror = () => finish({ kind: "unsafe" })
      worker.postMessage({ fields })
    })
  }

  async function validateSnapshot(
    definitionSnapshot: DataFormDefinition,
    valuesSnapshot: Record<string, string>,
    generation: number
  ) {
    validationErrors.clear()

    for (const field of definitionSnapshot.fields) {
      if (
        field.field_type === "select" &&
        valuesSnapshot[field.name] !== "" &&
        !field.values.some((option) => option.value === valuesSnapshot[field.name])
      ) {
        validationErrors.set(
          field.name,
          "Wikijump requires a configured value for this field."
        )
      }
    }
    if (validationErrors.size > 0) return false

    const matchFields = definitionSnapshot.fields.flatMap((field) =>
      field.field_type === "text" && field.match_pattern
        ? [
            {
              name: field.name,
              pattern: field.match_pattern,
              value: valuesSnapshot[field.name] ?? ""
            }
          ]
        : []
    )
    if (matchFields.length === 0) return true

    const result = await matchFieldsWithinBrowserBudget(matchFields, generation)
    if (generation !== validationGeneration || result.kind === "cancelled") return false
    if (result.kind === "unsafe") {
      for (const field of matchFields) {
        validationErrors.set(field.name, "Wikijump could not safely evaluate this field.")
      }
      return false
    }
    if (result.kind === "invalid") {
      if (matchFields.some((field) => field.name === result.name)) {
        validationErrors.set(
          result.name,
          "Wikijump could not evaluate this field's validation pattern."
        )
      } else {
        for (const field of matchFields) {
          validationErrors.set(
            field.name,
            "Wikijump could not safely evaluate this field."
          )
        }
      }
      return false
    }

    const expectedNames = new Set(matchFields.map((field) => field.name))
    const returnedNames = new Set(result.results.map((field) => field.name))
    if (
      result.results.length !== matchFields.length ||
      returnedNames.size !== expectedNames.size ||
      [...expectedNames].some((name) => !returnedNames.has(name))
    ) {
      for (const field of matchFields) {
        validationErrors.set(field.name, "Wikijump could not safely evaluate this field.")
      }
      return false
    }
    for (const resultField of result.results) {
      if (!resultField.matches) {
        const definitionField = definitionSnapshot.fields.find(
          (field) => field.name === resultField.name
        )
        validationErrors.set(
          resultField.name,
          definitionField?.match_error ||
            `Please enter valid '${definitionField?.label ?? ""}'`
        )
      }
    }
    return validationErrors.size === 0
  }

  const { form, enhance } = superForm(
    untrack(() => editForm),
    {
      dataType: "json",
      multipleSubmits: "abort",
      onSubmit: async ({ jsonData, cancel }) => {
        const generation = ++validationGeneration
        cancelActiveValidation?.()
        const definitionSnapshot = structuredClone(definition)
        const valuesSnapshot = Object.fromEntries(
          definitionSnapshot.fields.map((field) => [field.name, values[field.name] ?? ""])
        )
        const formSnapshot = { ...$form }
        if (creating && initialTags) {
          cancel()
          errorPopupState.current = {
            state: true,
            message: "An error occurred while processing the request.",
            data: {}
          }
          return
        }
        if (!(await validateSnapshot(definitionSnapshot, valuesSnapshot, generation))) {
          cancel()
          return
        }
        if (generation !== validationGeneration) {
          cancel()
          return
        }
        if (
          !creating &&
          (!Number.isSafeInteger(pageId) ||
            (pageId ?? 0) <= 0 ||
            !Number.isSafeInteger(lastRevisionId) ||
            (lastRevisionId ?? 0) <= 0)
        ) {
          cancel()
          errorPopupState.current = {
            state: true,
            message: "The data-form edit target is incomplete.",
            data: {}
          }
          return
        }
        const wikitext = serializeWikidotDataFormSource(
          definitionSnapshot,
          valuesSnapshot
        )
        $form.wikitext = wikitext
        const leaseFields = creating ? undefined : leaseSaveFields?.()
        jsonData({
          ...formSnapshot,
          wikitext,
          siteId,
          pageId: creating ? 0 : pageId,
          lastRevisionId: leaseFields
            ? leaseFields.lastRevisionId
            : creating
              ? 0
              : lastRevisionId,
          ...(leaseFields
            ? {
                lockId: leaseFields.lockId,
                "lockSecret": leaseFields.lockSecret,
                leaseMode: leaseFields.mode,
                sectionIndex: leaseFields.sectionIndex ?? null
              }
            : {})
        })
      },
      onResult: async ({ result, cancel }) => {
        if (result.type === "success" && result.data) {
          cancel()
          onLeaseSaveSuccess?.(result.data.res)
          const destinationSlug = pageMutationDestinationSlug({
            creating,
            requestedSlug: slug,
            responseSlug: result.data.res?.slug
          })
          if (!destinationSlug) {
            errorPopupState.current = {
              state: true,
              message: "Page creation did not return its assigned slug.",
              data: {}
            }
            return
          }
          goto(resolve(`/${destinationSlug}`, {}), { noScroll: true })
        }
        if (result.type === "failure" && result.data) {
          const handled = onLeaseSaveFailure?.({
            code: (result.data as { code?: number }).code,
            message: result.data.message,
            data: result.data.data
          })
          if (!handled) {
            errorPopupState.current = {
              state: true,
              message: result.data.message,
              data: result.data.data
            }
          }
        }
      }
    }
  )

  function failClosedFileFieldForm(formElement: HTMLFormElement) {
    const preventUnsupportedWrite = (event: SubmitEvent) => {
      event.preventDefault()
      errorPopupState.current = {
        state: true,
        message: "An error occurred while processing the request.",
        data: {}
      }
    }
    formElement.addEventListener("submit", preventUnsupportedWrite)
    return {
      destroy() {
        formElement.removeEventListener("submit", preventUnsupportedWrite)
      }
    }
  }

  const formEnhance = $derived(writeSupported ? enhance : failClosedFileFieldForm)

  $form.title = untrack(() => initialTitle)
  $form.altTitle = untrack(() => initialAltTitle)
  $form.wikitext = untrack(() => initialSource)
  $form.tags = untrack(() => initialTags)
  $form.parent = untrack(() => initialParent)
  $form.comments = untrack(() => initialComments)

  onDestroy(() => {
    validationGeneration += 1
    cancelActiveValidation?.()
  })

  function cancelEdit() {
    goto(resolve(`/${slug}`, {}), { noScroll: true })
  }
</script>

<h1>{creating ? "Create" : "Edit"} {headingCategory}</h1>

<!-- svelte-ignore a11y_no_redundant_roles -->
<form
  id="edit-page-form"
  class="form-horizontal data-form"
  action={writeSupported ? "?/edit" : undefined}
  method={writeSupported ? "POST" : undefined}
  role="form"
  use:formEnhance
>
  <input name="page_id" type="hidden" value={pageId ?? ""} />
  <input name="form-use" type="hidden" value="true" />
  <input
    name="form-fields"
    type="hidden"
    value={wikidotDataFormFieldNames(definition).join(",")}
  />
  <input name="form-file-still-uploading" type="hidden" value="0" />

  <div class="form-group">
    <!-- svelte-ignore a11y_label_has_associated_control -->
    <label class="col-sm-2 control-label">Title</label>
    <div class="col-sm-5">
      <input
        id="edit-page-title"
        name="title"
        class="form-control text"
        onkeypress={(event) => {
          if (event.key === "Enter") event.preventDefault()
        }}
        type="text"
        bind:value={$form.title}
      />
    </div>
  </div>

  {#each fieldGroups as fields (fields[0].name)}
    <div
      class="form-group"
      class:has-error={fields.some((field) => validationErrors.has(field.name))}
    >
      <!-- svelte-ignore a11y_label_has_associated_control -->
      <label class="col-sm-2 control-label">{fields[0].label}</label>
      <div class="col-sm-5">
        {#each fields as field, fieldIndex (field.name)}
          {#if fieldIndex > 0 && field.label}{field.label}{/if}{#if field.field_type === "wiki"}
            <div
              class={`form-value field-${field.name}`}
              class:form-error={validationErrors.has(field.name)}
            >
              {field.before ? `${field.before} ` : " "}{#if field.height >= 2}
                <textarea
                  name={`field-${field.name}`}
                  class="form-control form-wiki"
                  cols={field.width}
                  placeholder={field.hint}
                  rows={field.height}
                  bind:value={values[field.name]}></textarea>
              {:else}
                <input
                  name={`field-${field.name}`}
                  class="form-control form-wiki"
                  onkeypress={(event) => {
                    if (event.key === "Enter") event.preventDefault()
                  }}
                  placeholder={field.hint}
                  size={field.width}
                  type="text"
                  bind:value={values[field.name]}
                />
              {/if}{field.after ? ` ${field.after}` : " "}<span
                class="form-message text-danger"
                >{validationErrors.get(field.name) ?? ""}</span
              >
            </div>
          {:else}
            <span
              class={`form-value field-${field.name}`}
              class:form-error={validationErrors.has(field.name)}
              >{field.before
                ? `${field.before} `
                : " "}{#if field.field_type === "static"}
                {field.configured_value ?? ""}
              {:else if field.field_type === "pagepath"}
                {@const levels = buildWikidotDataFormPagepathLevels(
                  field,
                  pagepathNodes[field.name] ?? [],
                  values[field.name] ?? ""
                )}
                <div class="dataform-pagepath-chooser">
                  <input
                    name={`field-${field.name}`}
                    class="dataform-pagepath-value"
                    type="hidden"
                    value={values[field.name] ?? ""}
                  />
                  <input
                    class="dataform-pagepath-category"
                    type="hidden"
                    value={field.pagepath_category ?? ""}
                  />
                  <input
                    class="dataform-pagepath-max-level"
                    type="hidden"
                    value={field.pagepath_max_level ?? ""}
                  />
                  {#each levels as level, levelIndex (`${field.name}:${level.parent}`)}
                    {#if levelIndex > 0}
                      /
                    {/if}<select
                      class={wikidotDataFormPagepathSelectorClass(level.parent)}
                      onchange={(event) =>
                        setPagepathValue(
                          field.name,
                          level.parent,
                          event.currentTarget.value
                        )}
                    >
                      <option selected={level.selected === ""} value=""></option>
                      {#each level.options as option (option.fullname)}
                        <option
                          selected={level.selected === option.fullname}
                          value={option.fullname}>{option.name}</option
                        >
                      {/each}
                      <option
                        selected={pagepathCreateNew[field.name]?.parent === level.parent}
                        value="+">Create new</option
                      >
                    </select>{#if pagepathCreateNew[field.name]?.parent === level.parent}
                      {@const pending = pagepathCreateNew[field.name]}
                      <input
                        class="text"
                        oninput={(event) => {
                          if (pending) pending.value = event.currentTarget.value
                        }}
                        onkeydown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void createPagepathChild(field, levelIndex)
                          }
                        }}
                        type="text"
                        value={pending?.value ?? "New item"}
                      />
                      <!-- svelte-ignore a11y_invalid_attribute -->
                      <a
                        href="javascript:;"
                        onclick={() => (pagepathCreateNew[field.name] = undefined)}>[x]</a
                      >
                    {/if}
                  {/each}
                </div>
              {:else if field.field_type === "file"}
                <input
                  name={`field-${field.name}`}
                  class="dataform-file-value"
                  type="hidden"
                  value={values[field.name] ?? ""}
                />
              {:else if field.field_type === "date"}
                {@const presentation = getWikidotDataFormFieldPresentation(field)}
                <input
                  name={`field-${field.name}`}
                  class={presentation.className ?? ""}
                  oninput={(event) => {
                    const display = event.currentTarget.value
                    dateDisplayValues[field.name] = display
                    values[field.name] = display
                  }}
                  onkeypress={(event) => {
                    if (event.key === "Enter") event.preventDefault()
                  }}
                  placeholder={field.hint || undefined}
                  size={field.width}
                  type="text"
                  value={dateDisplayValues[field.name] ?? ""}
                />
              {:else if field.field_type === "password" || field.field_type === "url"}
                {@const presentation = getWikidotDataFormFieldPresentation(field)}
                <input
                  name={`field-${field.name}`}
                  class={presentation.className ?? ""}
                  onkeypress={(event) => {
                    if (event.key === "Enter") event.preventDefault()
                  }}
                  placeholder={field.hint || undefined}
                  size={field.width}
                  type={presentation.inputType ?? "text"}
                  bind:value={values[field.name]}
                />
              {:else if field.field_type === "checkbox"}
                {#if values[field.name] === "1"}
                  <input
                    name={`field-${field.name}`}
                    class="form-checkbox"
                    checked={true}
                    onchange={(event) =>
                      (values[field.name] = event.currentTarget.checked ? "1" : "0")}
                    type="checkbox"
                    use:preserveCheckedAttribute
                  />
                {:else}
                  <input
                    name={`field-${field.name}`}
                    class="form-checkbox"
                    onchange={(event) =>
                      (values[field.name] = event.currentTarget.checked ? "1" : "0")}
                    type="checkbox"
                  />
                {/if}
              {:else if field.field_type === "select"}
                {#if field.values.length >= 5}
                  <select
                    name={`field-${field.name}`}
                    class="form-control form-select"
                    bind:value={values[field.name]}
                  >
                    {#each field.values as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                {:else}
                  {#each field.values as option (option.value)}
                    <label class="radio-inline">
                      <input
                        name={`field-${field.name}`}
                        class="form-select"
                        checked={values[field.name] === option.value}
                        onchange={() => (values[field.name] = option.value)}
                        type="radio"
                        value={option.value}
                      />{option.label}
                    </label>
                  {/each}
                {/if}
              {:else if field.height >= 2}
                <textarea
                  name={`field-${field.name}`}
                  class="form-control form-text"
                  cols={field.width}
                  placeholder={field.hint}
                  rows={field.height}
                  bind:value={values[field.name]}></textarea>
              {:else}
                <input
                  name={`field-${field.name}`}
                  class="form-control form-text"
                  onkeypress={(event) => {
                    if (event.key === "Enter") event.preventDefault()
                  }}
                  placeholder={field.hint}
                  size={field.width}
                  type="text"
                  bind:value={values[field.name]}
                />
              {/if}{field.after ? ` ${field.after}` : " "}<span
                class="form-message text-danger"
                >{validationErrors.get(field.name) ?? ""}</span
              ></span
            >
          {/if}
        {/each}
      </div>
    </div>
  {/each}

  <div class="form-group">
    <div class="col-sm-offset-2 col-sm-5">
      <!-- svelte-ignore a11y_invalid_attribute -->
      <a
        id="edit-cancel-button"
        class="btn btn-danger"
        href="javascript:;"
        onclick={cancelEdit}>Cancel</a
      >
      <!-- svelte-ignore a11y_invalid_attribute -->
      <a
        id="edit-save-button"
        class="btn btn-primary"
        href="javascript:;"
        onclick={() =>
          document.querySelector<HTMLFormElement>("#edit-page-form")?.requestSubmit()}
        >Save</a
      >
    </div>
  </div>
</form>

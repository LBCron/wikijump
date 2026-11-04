export type WikidotDataFormValue = {
  value: string
  label: string
}

export type WikidotDataFormField = {
  name: string
  label: string
  hint: string
  field_type: string | null
  values: WikidotDataFormValue[]
  default_value: string | null
  configured_value?: string | null
  options?: Record<string, unknown>
  pagepath_category?: string | null
  pagepath_max_level?: number | null
}

export type WikidotDataFormPagepathNode = {
  fullname: string
  name: string
  parent: string | null
}

export type WikidotDataFormDefinition = {
  fields: WikidotDataFormField[]
}

export type WikidotDataFormFieldPresentation = {
  control: "none" | "input" | "existing" | "pagepath" | "file-hidden"
  inputType: "password" | "text" | null
  className: string | null
  includeInFormFields: boolean
  display: "text" | "masked" | "wiki" | "url" | "date" | "pagepath"
}

export const buildWikidotDataFormState = (
  definition: WikidotDataFormDefinition,
  savedValues: Record<string, string>
): Record<string, string> => {
  return Object.fromEntries(
    definition.fields
      .filter((field) => !["hidden", "static"].includes(field.field_type ?? ""))
      .map((field) => [
        field.name,
        Object.hasOwn(savedValues, field.name)
          ? savedValues[field.name]
          : field.field_type === "checkbox"
            ? field.default_value === "1"
              ? "1"
              : "0"
            : (field.default_value ??
              (field.field_type === "select" && field.values.length >= 5
                ? (field.values[0]?.value ?? "")
                : ""))
      ])
  )
}

export const getWikidotDataFormFieldPresentation = (
  field: WikidotDataFormField
): WikidotDataFormFieldPresentation => {
  switch (field.field_type) {
    case "hidden":
      return {
        control: "none",
        inputType: null,
        className: null,
        includeInFormFields: false,
        display: "text"
      }
    case "password":
      return {
        control: "input",
        inputType: "password",
        className: "form-control form-password",
        includeInFormFields: true,
        display: "masked"
      }
    case "static":
      return {
        control: "none",
        inputType: null,
        className: null,
        includeInFormFields: true,
        display: "wiki"
      }
    case "url":
      return {
        control: "input",
        inputType: "text",
        className: "form-control form-url",
        includeInFormFields: true,
        display: "url"
      }
    case "date":
      return {
        control: "input",
        inputType: "text",
        className: "form-control form-date",
        includeInFormFields: true,
        display: "date"
      }
    case "pagepath":
      return {
        control: "pagepath",
        inputType: null,
        className: "dataform-pagepath-chooser",
        includeInFormFields: true,
        display: "pagepath"
      }
    case "file":
      return {
        control: "file-hidden",
        inputType: null,
        className: "dataform-file-value",
        includeInFormFields: true,
        display: "text"
      }
    default:
      return {
        control: "existing",
        inputType: null,
        className: null,
        includeInFormFields: true,
        display: "text"
      }
  }
}

export const wikidotDataFormPagepathSelectorClass = (fullname: string): string =>
  `dataform-pagepath-select-children-of-${fullname.replaceAll(":", "---")}`

export const buildWikidotDataFormPagepathLevels = (
  field: WikidotDataFormField,
  nodes: WikidotDataFormPagepathNode[],
  value: string
): { parent: string; selected: string; options: WikidotDataFormPagepathNode[] }[] => {
  const category = field.pagepath_category ?? ""
  if (!category) return []
  const root = `${category}:_root`
  const byFullname = new Map(nodes.map((node) => [node.fullname, node]))
  const children = new Map<string, WikidotDataFormPagepathNode[]>()
  for (const node of nodes) {
    if (node.parent === null) continue
    const siblings = children.get(node.parent) ?? []
    siblings.push(node)
    children.set(node.parent, siblings)
  }

  const selectedPath: string[] = []
  let selected = byFullname.get(value)
  const seen = new Set<string>()
  while (selected && selected.fullname !== root && !seen.has(selected.fullname)) {
    seen.add(selected.fullname)
    selectedPath.push(selected.fullname)
    selected = selected.parent ? byFullname.get(selected.parent) : undefined
  }
  if (selected?.fullname !== root) selectedPath.length = 0
  selectedPath.reverse()

  const maximumLevels =
    Number.isSafeInteger(field.pagepath_max_level) && (field.pagepath_max_level ?? 0) > 0
      ? (field.pagepath_max_level as number)
      : nodes.length + 1
  const levels: {
    parent: string
    selected: string
    options: WikidotDataFormPagepathNode[]
  }[] = []
  let parent = root
  for (let index = 0; index < maximumLevels; index += 1) {
    const selectedFullname = selectedPath[index] ?? ""
    levels.push({
      parent,
      selected: selectedFullname,
      options: children.get(parent) ?? []
    })
    if (!selectedFullname) break
    parent = selectedFullname
  }
  return levels
}

export const wikidotDataFormFieldNames = (
  definition: WikidotDataFormDefinition
): string[] =>
  definition.fields
    .filter((field) => getWikidotDataFormFieldPresentation(field).includeInFormFields)
    .map((field) => field.name)

const WIKIDOT_BARE_URL = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[A-Za-z0-9._/-]*)?$/u
const WIKIDOT_FTP_URL =
  /^ftp:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[A-Za-z0-9._/-]*)?$/u

export const wikidotDataFormUrlDisplay = (
  value: string
): { text: string; href: string | null } => {
  if (WIKIDOT_FTP_URL.test(value)) return { text: value, href: value }
  if (WIKIDOT_BARE_URL.test(value)) {
    const normalized = `http://${value}`
    return { text: normalized, href: normalized }
  }
  return { text: value, href: null }
}

const WIKIDOT_PLAIN_SCALAR = /^[A-Za-z_][A-Za-z0-9_.-]*$/u
const WIKIDOT_RESERVED_PLAIN_SCALARS = /^(?:false|no|null|off|on|true|yes|~)$/iu

const serializeWikidotTextScalar = (value: string): string => {
  if (value.includes("\n")) {
    return `"${value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")}"`
  }
  if (WIKIDOT_PLAIN_SCALAR.test(value) && !WIKIDOT_RESERVED_PLAIN_SCALARS.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", "''")}'`
}

const serializeWikidotSelectScalar = (value: string): string => {
  if (value === "") return "null"
  if (WIKIDOT_PLAIN_SCALAR.test(value) && !WIKIDOT_RESERVED_PLAIN_SCALARS.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", "''")}'`
}

const serializeWikidotWikiScalar = (value: string): string => {
  if (/^\/\S+$/u.test(value)) return value
  return serializeWikidotTextScalar(value)
}

const serializeWikidotUrlScalar = (value: string): string => {
  if (WIKIDOT_BARE_URL.test(value)) {
    return value
  }
  return serializeWikidotTextScalar(value)
}

const serializeWikidotDateScalar = (value: string): string => {
  if (value === "") return "''"
  if (/\s|^(?:false|null|true)$/iu.test(value)) return serializeWikidotTextScalar(value)
  return value
}

export const serializeWikidotDataFormSource = (
  definition: WikidotDataFormDefinition,
  values: Record<string, string>
): string => {
  if (definition.fields.length === 1 && definition.fields[0]?.field_type === "static") {
    return "null"
  }
  return definition.fields
    .map((field) => {
      const value = values[field.name] ?? ""
      const serialized =
        field.field_type === "hidden"
          ? serializeWikidotTextScalar(field.configured_value ?? "")
          : field.field_type === "static"
            ? "null"
            : field.field_type === "url"
              ? serializeWikidotUrlScalar(value)
              : field.field_type === "date"
                ? serializeWikidotDateScalar(value)
                : field.field_type === "checkbox"
                  ? values[field.name] === "1"
                    ? "'1'"
                    : "'0'"
                  : field.field_type === "select"
                    ? serializeWikidotSelectScalar(value)
                    : field.field_type === "wiki"
                      ? serializeWikidotWikiScalar(value)
                      : serializeWikidotTextScalar(value)
      return `${field.name}: ${serialized}`
    })
    .join("\n")
}

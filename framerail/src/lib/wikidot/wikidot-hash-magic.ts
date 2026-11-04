export type WikidotHashMagicPagePane = "files" | "history" | "edit-page" | "edit-tags"

const HASH_MAGIC_COMMAND = /#_(\w*)/u

const PANE_BY_COMMAND: Record<string, WikidotHashMagicPagePane> = {
  files: "files",
  history: "history",
  editpage: "edit-page",
  edittags: "edit-tags"
}

export function resolveWikidotHashMagicPagePane(
  href: string
): WikidotHashMagicPagePane | null {
  const command = HASH_MAGIC_COMMAND.exec(href)?.[1]?.toLowerCase() ?? ""
  return PANE_BY_COMMAND[command] ?? null
}

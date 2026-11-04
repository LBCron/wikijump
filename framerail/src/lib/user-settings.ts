import { limitLocalePreferences } from "./locales.ts"

/**
 * Parses the display-language preference field into the ordered locale
 * list persisted by Deepwell. Deepwell remains the syntax-validation
 * authority.
 */
export const parseUserLocalePreferences = (input: string): string[] => {
  return limitLocalePreferences(
    input.replaceAll("_", "-").replaceAll(",", " ").split(/\s+/u)
  )
}

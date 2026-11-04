export function inputsValid(
  ...inputs: (
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | HTMLButtonElement
    | HTMLFieldSetElement
    | undefined
    | null
  )[]
) {
  for (const input of inputs) {
    if (input instanceof HTMLFieldSetElement) continue
    if (input instanceof HTMLButtonElement) continue
    if (
      !input ||
      input.disabled ||
      !input.validity.valid ||
      (input.required && input.value.length === 0) ||
      ("readOnly" in input && input.readOnly)
    ) {
      return false
    }
  }

  return true
}

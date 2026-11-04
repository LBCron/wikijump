import "jquery-ui/themes/base/core.css"
import "jquery-ui/themes/base/datepicker.css"
import "jquery-ui/themes/base/theme.css"

let datepickerRuntime: Promise<any> | undefined

const loadDatepickerRuntime = async () => {
  if (!datepickerRuntime) {
    datepickerRuntime = (async () => {
      const { default: jquery } = await import("jquery")
      const browserGlobal: any = globalThis
      browserGlobal.jQuery = jquery
      await import("jquery-ui/ui/version")
      await import("jquery-ui/ui/keycode")
      await import("jquery-ui/ui/widgets/datepicker")
      return jquery
    })()
  }
  return await datepickerRuntime
}

export const mountWikidotDatePicker = (
  input: HTMLInputElement,
  options: Record<string, unknown>,
  onSelect: (selection: { display: string; timestamp: string }) => void,
  onInitialDisplay?: (display: string) => void
) => {
  let active = true
  let mounted = false
  let $: any = null

  void loadDatepickerRuntime()
    .then((runtime) => {
      if (!active) return
      $ = runtime
      const datepickerOptions = {
        ...options,
        onSelect: (display: string, instance: { input: { 0: HTMLInputElement } }) => {
          const selected = instance.input[0]
          const date = $(selected).datepicker("getDate")
          if (date instanceof Date && Number.isFinite(date.getTime())) {
            onSelect({
              display,
              timestamp: String(Math.trunc(date.getTime() / 1000))
            })
          }
        }
      }
      $(input).datepicker(datepickerOptions)
      const storedValue = input.value.trim()
      if (/^-?\d+$/u.test(storedValue)) {
        const timestamp = Number(storedValue)
        const date = new Date(timestamp * 1000)
        if (Number.isFinite(timestamp) && Number.isFinite(date.getTime())) {
          $(input).datepicker("setDate", date)
          onInitialDisplay?.(input.value)
        }
      }
      mounted = true
    })
    .catch((error) => console.error("Wikidot datepicker initialization failed", error))

  return () => {
    active = false
    if (mounted) $(input).datepicker("destroy")
  }
}

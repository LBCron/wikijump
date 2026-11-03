<script lang="ts">
  import { onDestroy } from "svelte"
  import { SvelteSet } from "svelte/reactivity"
  import tippy, {
    createSingleton,
    type CreateSingletonProps,
    type Instance,
    type Props
  } from "tippy.js"
  import type { Snippet } from "svelte"
  import { DEFAULT_TIPPY_OPTS, parseTipOpts } from "./scripts/tippy"

  const DEFAULT_SINGLETON_PROPS: Partial<CreateSingletonProps> = {
    ...DEFAULT_TIPPY_OPTS
  }

  let {
    opts = { ...DEFAULT_SINGLETON_PROPS },
    children
  }: {
    opts?: Partial<CreateSingletonProps>
    children?: Snippet<[typeof tip]>
  } = $props()

  let singleton: ReturnType<typeof createSingleton> | undefined = createSingleton([])
  const tips = new SvelteSet<Instance>()

  function update() {
    if (singleton) {
      singleton.setProps({ ...DEFAULT_SINGLETON_PROPS, ...opts })
      singleton.setInstances([...tips])
    }
  }

  function tip(elem: Element, opts: Partial<Props> | string = "") {
    opts = parseTipOpts(elem, opts)
    const tp = tippy(elem, opts)
    const setState = (content: unknown) => {
      if (!content) tp.disable()
      else tp.enable()
    }
    setState(opts.content)

    tips.add(tp)
    update()

    return {
      update(opts: Partial<Props> | string = "") {
        opts = parseTipOpts(elem, opts)
        tp.setProps(opts)
        setState(opts.content)
        update()
      },
      destroy() {
        tips.delete(tp)
        tp.destroy()
        update()
      }
    }
  }

  onDestroy(() => {
    singleton?.destroy()
    singleton = undefined
  })
</script>

{@render children?.(tip)}

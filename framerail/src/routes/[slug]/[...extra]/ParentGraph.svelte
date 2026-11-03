<script lang="ts">
  import { deserialize } from "$app/forms"
  import { resolve } from "$app/paths"
  import { errorPopupState } from "$lib/layout/stores.svelte"
  import { SvelteMap, SvelteSet } from "svelte/reactivity"
  import IntervalTree from "@flatten-js/interval-tree"

  import type { PageProps } from "./$types"

  let { data }: PageProps = $props()

  const childrenMap = new SvelteMap<number, number[]>()
  const parentMap = new SvelteMap<number, number[]>()
  let pageDetails = new SvelteMap<
    number,
    { slug: string; title: string; page_id: number; x?: number; y?: number }
  >()
  let rootParents = $state<number[]>([])
  let maxY = $state(0)
  let rowIntervals = $state(new IntervalTree<number>())
  let curvedIntervals = $state(
    new IntervalTree<{
      x1: number
      y1: number
      x2: number
      y2: number
      yBranch: number
    }>()
  )
  let radius = $state(0.5)
  let scaleFactor = $derived(30)
  let offset = $state(20)
  let graphContainerWidth = $state(0)
  let graphElem = $state<SVGGraphicsElement | null>(null)
  let viewbox = $derived({
    width: Math.max(
      (childrenMap.size + 1) * scaleFactor + 100,
      (graphElem?.getBBox().width ?? 0) + scaleFactor + offset
    ),
    height: scaleOffset(maxY + 1)
  })
  let graphSignal = $state(0)

  function scaleOffset(input: number) {
    return input * scaleFactor + offset
  }

  function roundedCornerPath(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    r: number,
    yBranch: number
  ) {
    if (y1 > y2) {
      let temp = x1
      x1 = x2
      x2 = temp
      temp = y1
      y1 = y2
      y2 = temp
    }
    let dir = x2 > x1
    if (y1 === y2 && y1 !== yBranch) {
      return `M ${x1} ${y1}
              V ${yBranch - r}
              A ${r} ${r} ${dir ? 180 : 0} 0 ${dir ? 0 : 1} ${dir ? x1 + r : x1 - r} ${yBranch}
              H ${dir ? x2 - r : x2 + r}
              A ${r} ${r} ${dir ? 0 : 180} 0 ${dir ? 0 : 1} ${x2} ${yBranch - r}
              V ${y2}`
    }
    let min = Math.min(Math.abs(x1 - x2), Math.abs(y1 - y2))
    if (r > min) r = min
    if (yBranch < y1 + r) yBranch = y1 + r
    else if (yBranch > y2) yBranch = y2
    else if (yBranch !== y2 && y2 - yBranch < r) yBranch = y2 - r
    if (yBranch === y2) {
      return `M ${x1} ${y1}
              V ${y2 - r}
              A ${r} ${r} ${dir ? 180 : 0} 0 ${dir ? 0 : 1} ${dir ? x1 + r : x1 - r} ${y2}
              H ${x2}`
    } else {
      return `M ${x1} ${y1}
              V ${yBranch - r}
              A ${r} ${r} ${dir ? 180 : 0} 0 ${dir ? 0 : 1} ${dir ? x1 + r : x1 - r} ${yBranch}
              H ${dir ? x2 - r : x2 + r}
              A ${r} ${r} ${dir ? 90 : 270} 0 ${dir ? 1 : 0} ${x2} ${yBranch + r}
              V ${y2}`
    }
  }

  async function traceParents() {
    let res = await fetch(`?/parentTrace`, {
      method: "POST",
      body: JSON.stringify({
        pageId: data.page?.page_id,
        slug: data.page?.slug
      })
    }).then((res) => res.text())

    const result = deserialize<
      {
        res: {
          children_map: number[][]
          parent_map: number[][]
          details: { slug: string; title: string; page_id: number }[]
          root_parents: number[]
        }
      },
      {
        message: string
        code: string
        data: Record<string, unknown>
      }
    >(res)

    if (result.type === "failure" && result.data?.message) {
      errorPopupState.current = {
        state: true,
        message: result.data.message,
        data: result.data.data
      }
    } else if (result.type === "success" && result.data?.res) {
      childrenMap.clear()
      for (const [pageId, ...children] of result.data.res.children_map) {
        childrenMap.set(pageId, children)
      }
      parentMap.clear()
      for (const [pageId, ...parents] of result.data.res.parent_map) {
        parentMap.set(pageId, parents)
      }
      pageDetails.clear()
      for (let i = 0; i < result.data?.res.details.length; i++) {
        const detail = $state(result.data?.res.details[i])
        pageDetails.set(detail.page_id, detail)
      }
      rootParents = result.data?.res.root_parents
      buildParentGraph()
    }
  }

  function sortPagesTopologically(): number[] {
    let unedged = rootParents.toSorted((a, b) => a - b)
    let ordered: number[] = []
    let parentMapClone: Map<number, number[]> = new Map(
      JSON.parse(JSON.stringify(Array.from(parentMap)))
    )
    while (unedged.length) {
      let node = unedged.shift()!
      ordered.push(node)
      let children = (childrenMap.get(node) ?? []).toSorted((a, b) => a - b)
      while (children.length) {
        let child = children.shift()!
        let parents = parentMapClone.get(child) ?? []
        let idx = parents.findIndex((p) => p === node)
        if (idx !== -1) parents.splice(idx, 1)

        if (parents.length === 0) unedged.push(child)
      }
    }
    for (let i = 0; i < ordered.length; i++) {
      pageDetails.get(ordered[i])!.x = i
    }
    return ordered
  }

  function assignStraightRows(ordered: number[]) {
    maxY = 0
    let activeRows: (number | null)[] = []
    let branchChildrenMap = new Map(
      [...childrenMap.entries()].map(([node, children]) => [
        node,
        children.filter((p) => parentMap.get(p)![0] === node)
      ])
    )
    let mergeChildrenMap = new Map(
      [...childrenMap.entries()].map(([node, children]) => [
        node,
        children.filter((p) => parentMap.get(p)![0] !== node)
      ])
    )

    rowIntervals.clear()

    for (let i = ordered.length - 1; i >= 0; i--) {
      let branchChildren = branchChildrenMap.get(ordered[i]) ?? []
      let mergeChildren = mergeChildrenMap.get(ordered[i]) ?? []
      let idx = -1
      let forbiddenRows: number[] = []
      if (mergeChildren.length) {
        let children = mergeChildren.map((child) => pageDetails.get(child))
        let maxX = 0
        for (let j = 0; j < children.length; j++) {
          if ((children[j]?.x ?? 0) > maxX) maxX = children[j]?.x ?? 0
        }
        forbiddenRows = rowIntervals.search([i, maxX], (v) => v)
      }

      if (branchChildren.length) {
        idx = activeRows.findIndex((v) => v === branchChildren[0])
        let child = pageDetails.get(activeRows[idx]!)!
        activeRows[idx] = ordered[i]

        rowIntervals.insert([i, child.x!], idx)

        branchChildren = branchChildren.slice(1)
        for (let j = 0; j < branchChildren.length; j++) {
          let k = activeRows.findIndex((v) => v === branchChildren[j])
          if (k !== -1) activeRows[k] = null
        }
      } else {
        idx = activeRows.findIndex((v, i) => v === null && !forbiddenRows.includes(i))
        if (idx === -1) {
          idx = activeRows.length
          activeRows.push(ordered[i])
        } else {
          activeRows[idx] = ordered[i]
        }
      }
      pageDetails.get(ordered[i])!.y = idx
      if (maxY < activeRows.length) maxY = activeRows.length
    }
  }

  function assignCurveBranches(ordered: number[]) {
    curvedIntervals.clear()

    for (let i = 0; i < ordered.length; i++) {
      let node = pageDetails.get(ordered[i])!
      let children = childrenMap.get(ordered[i]) ?? []
      for (let j = 0; j < children.length; j++) {
        let child = pageDetails.get(children[j])!
        if (node.y === child.y) {
          if (!rowIntervals.exist([node.x!, child.x!])) {
            curvedIntervals.insert([node.x!, child.x!], {
              x1: node.x!,
              y1: node.y!,
              x2: child.x!,
              y2: child.y!,
              yBranch: 0
            })
          }
          continue
        }
        curvedIntervals.insert([node.x!, child.x!], {
          x1: node.x!,
          y1: node.y!,
          x2: child.x!,
          y2: child.y!,
          yBranch: 0
        })
      }
    }

    for (const { key: interval, value } of curvedIntervals.items) {
      if (value.yBranch) {
        continue
      }
      let lowerY = Math.max(value.y1, value.y2)
      let straightIntersect = rowIntervals
        .search(interval, (v, k) => {
          return [k.low, k.high, v] as number[]
        })
        .filter(
          (v) =>
            v[0] !== v[1] &&
            v[0] !== Math.max(value.x1, value.x2) &&
            v[1] !== Math.min(value.x1, value.x2)
        )
      let curveIntersect = curvedIntervals
        .search(interval, (v, k) => {
          return [k.low, k.high, v] as [number, number, typeof v]
        })
        .filter(
          (v) =>
            v[0] !== v[1] &&
            v[0] !== Math.max(value.x1, value.x2) &&
            v[1] !== Math.min(value.x1, value.x2)
        )

      if (
        straightIntersect.every((v) => v[2] !== lowerY) &&
        curveIntersect.every((v) => v[2].yBranch !== lowerY)
      ) {
        value.yBranch = lowerY
        continue
      }
    }

    for (const { key: interval, value } of curvedIntervals.items) {
      if (value.yBranch) {
        continue
      }
      let lowerY = Math.max(value.y1, value.y2)
      let upperY = Math.min(value.y1, value.y2)
      if (value.y1 === value.y2) {
        lowerY++
      }
      let curveIntersect = curvedIntervals
        .search(interval, (v, k) => {
          return [k.low, k.high, v] as [number, number, typeof v]
        })
        .filter(
          (v) =>
            v[0] !== interval[1] &&
            v[1] !== interval[0] &&
            (v[2].yBranch === 0
              ? Math.min(v[2].y1, v[2].y2) < lowerY && Math.max(v[2].y1, v[2].y2) > upperY
              : v[2].yBranch < lowerY && v[2].yBranch > upperY)
        )
      let divisor = curveIntersect.length + 1
      let occupiedRows = new SvelteSet(curveIntersect.map((v) => v[2].yBranch))
      occupiedRows.add(0)
      let yBranch = 0
      let fractional = 0
      while (occupiedRows.has(yBranch)) {
        fractional++
        yBranch = upperY + ((lowerY - upperY) / divisor) * fractional
      }
      if (fractional >= divisor) {
        divisor++
        yBranch = 0
        fractional = 0
        while (occupiedRows.has(yBranch)) {
          fractional++
          yBranch = upperY + ((lowerY - upperY) / divisor) * fractional
        }
      }
      value.yBranch = yBranch
    }
  }

  function normalizeGraphRows() {
    let yValues = curvedIntervals.values.map((v) => v.yBranch)
    yValues.push(...Array(maxY).keys())
    yValues = [...new Set(yValues)].toSorted((a, b) => a - b)

    let yMap = new Map(yValues.map((v, i) => [v, i]))
    for (const id of pageDetails.keys()) {
      let node = pageDetails.get(id)!
      node.y = yMap.get(node.y!)
    }
    for (const { key: interval, value } of rowIntervals.items) {
      rowIntervals.remove(interval, value)
      rowIntervals.insert(interval, yMap.get(value))
    }
    for (const value of curvedIntervals.values) {
      value.y1 = yMap.get(value.y1)!
      value.y2 = yMap.get(value.y2)!
      value.yBranch = yMap.get(value.yBranch)!
    }
    maxY = yValues.length

    graphSignal++
  }

  function buildParentGraph() {
    const ordered = sortPagesTopologically()
    assignStraightRows(ordered)
    assignCurveBranches(ordered)
    normalizeGraphRows()
  }

  $effect(() => {
    traceParents()
  })
</script>

<div class="breadcrumbs" bind:clientWidth={graphContainerWidth}>
  <svg
    bind:this={graphElem}
    class="breadcrumbs-graph"
    viewBox="0 0 {viewbox.width} {viewbox.height}"
    width={Math.min(viewbox.width, graphContainerWidth)}
  >
    <style>
      .current-page {
        path {
          stroke: currentColor;
        }
        text {
          fill: currentColor;
        }
      }

      .breadcrumbs-graph:has(.parent-page:hover) {
        .parent-page:hover {
          path {
            stroke: currentColor;
          }
          text {
            fill: currentColor;
          }
        }

        .current-page {
          path {
            stroke: none;
          }
          text {
            fill: none;
          }
        }
      }

      .breadcrumbs-graph:has(.parent-page:active) {
        .parent-page:active {
          path {
            stroke: currentColor;
          }
          text {
            fill: currentColor;
          }
        }

        .current-page,
        .parent-page:not(:active):hover {
          path {
            stroke: none;
          }
          text {
            fill: none;
          }
        }
      }
    </style>
    {#key graphSignal}
      <g>
        {#each rowIntervals.items.entries() as [i, { key: interval, value }] (i)}
          <path
            d={`M ${scaleOffset(interval[0])} ${scaleOffset(value)}
                H ${scaleOffset(interval[1])}`}
            fill="none"
            stroke="currentColor"
            stroke-width="2px"
          />
        {/each}
        {#each curvedIntervals.values.entries() as [i, value] (i)}
          <path
            d={roundedCornerPath(
              scaleOffset(value.x1 ?? 0),
              scaleOffset(value.y1 ?? 0),
              scaleOffset(value.x2 ?? 0),
              scaleOffset(value.y2 ?? 0),
              radius * scaleFactor,
              scaleOffset(value.yBranch)
            )}
            fill="none"
            stroke="currentColor"
            stroke-width="2px"
          />
        {/each}
      </g>
      {#each pageDetails as [id, detail] (id)}
        <g
          class:current-page={detail.slug === data.page?.slug}
          class:parent-page={detail.slug !== data.page?.slug}
          data-id={detail.page_id}
        >
          {#if detail.slug !== data.page?.slug}
            <a data-id={detail.page_id} href={resolve(`/${detail.slug}`, {})}>
              <circle
                cx={scaleOffset(detail.x ?? 0)}
                cy={scaleOffset(detail.y ?? 0)}
                data-id={detail.page_id}
                fill="currentColor"
                r={5.5}
              /><text
                data-id={detail.page_id}
                fill="none"
                x={scaleOffset(detail.x ?? 0) - 3}
                y={scaleOffset(maxY)}>{detail.title || detail.slug}</text
              ><rect
                fill="transparent"
                height={scaleOffset(maxY + 0.5)}
                stroke="none"
                width={scaleFactor}
                x={scaleOffset((detail.x ?? 0) - 0.5)}
                y="0"
              />
            </a>
          {:else}
            <circle
              cx={scaleOffset(detail.x ?? 0)}
              cy={scaleOffset(detail.y ?? 0)}
              data-id={detail.page_id}
              fill="currentColor"
              r={5.5}
            />
            <text
              data-id={detail.page_id}
              fill="currentColor"
              x={scaleOffset(detail.x ?? 0) - 3}
              y={scaleOffset(maxY)}>{detail.title || detail.slug}</text
            >
          {/if}
          <path
            d={`M ${scaleOffset((detail.x ?? 0) - 0.5)} 0
                V ${scaleOffset(maxY + 0.5)}`}
            fill="none"
            opacity="0.5"
            stroke="none"
            stroke-width="1px"
          />
          <path
            d={`M ${scaleOffset((detail.x ?? 0) + 0.5)} 0
                V ${scaleOffset(maxY - 0.75)}`}
            fill="none"
            opacity="0.5"
            stroke="none"
            stroke-width="1px"
          />
        </g>
      {/each}
    {/key}
  </svg>
</div>

<style lang="scss">
  .breadcrumbs {
    width: 100%;
  }
</style>

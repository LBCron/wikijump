/* eslint-disable no-script-url -- Wikidot footer and fixture markup use javascript:; no-op links that parity requires */
import { strict as assert } from "node:assert"
import test from "node:test"

import {
  performWikidotLegacyAction,
  materializeWikidotRateActionHtml,
  planWikidotRateActionBindings,
  planWikidotStandaloneActionBindings,
  updateWikidotRateWidget,
  wikidotLegacyActions
} from "../src/lib/wikidot/wikidot-legacy-actions.ts"
import {
  performWikidotMembershipAction,
  planWikidotJoinActionBindings,
  wikidotMembershipActions
} from "../src/lib/wikidot/wikidot-membership-actions.ts"

const actionElement = (): any => {
  const attributes = new Map()
  return {
    getAttribute(name: any) {
      return attributes.get(name) ?? null
    },
    removeAttribute(name: any) {
      attributes.delete(name)
    },
    setAttribute(name: any, value: any) {
      attributes.set(name, value)
    }
  }
}

test("typed standalone actions call only their fixed browser behavior", async () => {
  const calls: any[] = []
  const runtime = {
    edit: () => calls.push(["edit"]),
    history: () => calls.push(["history"]),
    source: () => calls.push(["source"]),
    print: () => calls.push(["print"]),
    setTags: (index: any, fingerprint: any) =>
      calls.push(["set-tags", index, fingerprint])
  }

  for (const type of ["edit", "history", "source", "print"]) {
    await performWikidotLegacyAction(actionElement(), { type } as any, runtime)
  }
  await performWikidotLegacyAction(
    actionElement(),
    {
      type: "set-tags",
      index: 7,
      fingerprint: "0123456789abcdef0123456789abcdef"
    },
    runtime
  )

  assert.deepEqual(calls, [
    ["edit"],
    ["history"],
    ["source"],
    ["print"],
    ["set-tags", 7, "0123456789abcdef0123456789abcdef"]
  ])
})

test("custom-class standalone print controls use the typed browser action", async () => {
  const selector = 'a[href="javascript:;"]'
  const print = actionElement()
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (query: any) => (query === selector ? [print] : [])
  }
  print.parentElement = root
  let printCalls = 0

  wikidotLegacyActions(root as any, {
    actions: [{ type: "print" }],
    runtime: { print: () => (printCalls += 1) }
  })

  assert.equal(
    await listeners.get("click")({
      target: print,
      preventDefault: () => {},
      stopPropagation: () => {}
    }),
    true
  )
  assert.equal(printCalls, 1)
})

test("standalone actions activate from Enter without Space activation", async () => {
  const selector = 'a[href="javascript:;"]'
  const action = actionElement()
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (query: any) => (query === selector ? [action] : [])
  }
  action.parentElement = root
  let calls = 0

  wikidotLegacyActions(root as any, {
    actions: [{ type: "source" }],
    runtime: { source: () => (calls += 1) }
  })

  for (const key of [" ", "Spacebar", "Space"]) {
    await listeners.get("keydown")({
      target: action,
      key,
      preventDefault: () => {},
      stopPropagation: () => {}
    })
  }
  assert.equal(calls, 0)

  await listeners.get("keydown")({
    target: action,
    key: "Enter",
    preventDefault: () => {},
    stopPropagation: () => {}
  })
  assert.equal(calls, 1)
})

test("Rate controls preserve Space keyboard activation", async () => {
  const rate = actionElement()
  rate.setAttribute("href", "javascript:;")
  rate.setAttribute(
    "onclick",
    "WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, 1)"
  )
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (selector: any) => {
      if (selector.includes(".rateup")) return [rate]
      return []
    }
  }
  rate.parentElement = root
  let votes = 0
  const fingerprint = "0123456789abcdef0123456789abcdef"

  wikidotLegacyActions(root as any, {
    actions: [],
    rateActions: [{ type: "rate", index: 0, fingerprint, value: 1 }],
    runtime: { rate: () => (votes += 1) }
  })

  await listeners.get("keydown")({
    target: rate,
    key: "Space",
    preventDefault: () => {},
    stopPropagation: () => {}
  })
  assert.equal(votes, 1)
})

test("standalone edit clicks use the exact control set and fail closed on extras", async () => {
  const selector = 'a[href="javascript:;"]'
  const exact = actionElement()
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (query: any) => (query === selector ? [exact] : [])
  }
  exact.parentElement = root
  let editCalls = 0

  wikidotLegacyActions(root as any, {
    actions: [{ type: "edit" }],
    runtime: { edit: () => (editCalls += 1) }
  })
  let prevented = false
  let stopped = false
  assert.equal(
    await listeners.get("click")({
      target: exact,
      preventDefault: () => (prevented = true),
      stopPropagation: () => (stopped = true)
    }),
    true
  )
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.equal(editCalls, 1)

  const extra = actionElement()
  const mismatch = actionElement()
  const mismatchListeners = new Map()
  const mismatchRoot = {
    addEventListener: (name: any, listener: any) => mismatchListeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (query: any) => (query === selector ? [mismatch, extra] : [])
  }
  mismatch.parentElement = mismatchRoot
  wikidotLegacyActions(mismatchRoot as any, {
    actions: [{ type: "edit" }],
    runtime: { edit: () => (editCalls += 1) }
  })
  prevented = false
  stopped = false
  assert.equal(
    await mismatchListeners.get("click")({
      target: mismatch,
      preventDefault: () => (prevented = true),
      stopPropagation: () => (stopped = true)
    }),
    undefined
  )
  assert.equal(prevented, false)
  assert.equal(stopped, false)
  assert.equal(editCalls, 1)
})

test("Rate actions pass only registry-owned vote values", async () => {
  const calls: any[] = []
  const runtime = {
    rate: (index: any, fingerprint: any, value: any) =>
      calls.push(["rate", index, fingerprint, value]),
    cancelRate: (index: any, fingerprint: any) =>
      calls.push(["cancel-rate", index, fingerprint])
  }
  const element = actionElement()
  const fingerprint = "0123456789abcdef0123456789abcdef"

  for (const action of [
    { type: "rate", index: 0, fingerprint, value: 1 },
    { type: "rate", index: 1, fingerprint, value: -1 },
    { type: "rate", index: 2, fingerprint, value: 4 },
    { type: "rate-cancel", index: 3, fingerprint }
  ]) {
    await performWikidotLegacyAction(element, action as any, runtime)
  }

  assert.deepEqual(calls, [
    ["rate", 0, fingerprint, 1],
    ["rate", 1, fingerprint, -1],
    ["rate", 2, fingerprint, 4],
    ["cancel-rate", 3, fingerprint]
  ])
})

test("Rate sidecars bind only the exact renderer-owned control sequence", () => {
  const controls = [actionElement(), actionElement(), actionElement()]
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const actions = [
    { type: "rate", index: 0, fingerprint, value: 1 },
    { type: "rate", index: 1, fingerprint, value: -1 },
    { type: "rate-cancel", index: 2, fingerprint }
  ]
  controls[0].setAttribute(
    "onclick",
    "WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, 1)"
  )
  controls[1].setAttribute(
    "onclick",
    "WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, -1)"
  )
  controls[2].setAttribute(
    "onclick",
    "WIKIDOT.modules.PageRateWidgetModule.listeners.cancelVote(event)"
  )

  assert.deepEqual(planWikidotRateActionBindings(controls, [], actions as any), [
    [controls[0], actions[0]],
    [controls[1], actions[1]],
    [controls[2], actions[2]]
  ])
  assert.deepEqual(
    planWikidotRateActionBindings([...controls, actionElement()], [], actions as any),
    []
  )
  assert.deepEqual(
    planWikidotRateActionBindings(controls, [], [
      actions[0],
      { type: "rate", index: 1, fingerprint, value: 0 },
      actions[2]
    ] as any),
    []
  )
  controls[1].setAttribute("onclick", "alert(1)")
  assert.deepEqual(planWikidotRateActionBindings(controls, [], actions as any), [])

  const starControls = Array.from({ length: 5 }, actionElement)
  const starActions = Array.from({ length: 5 }, (_, index) => ({
    type: "rate",
    index,
    fingerprint,
    value: index + 1
  }))
  assert.deepEqual(
    planWikidotRateActionBindings([], [starControls], starActions as any),
    starControls.map((control, index) => [control, starActions[index]])
  )
  assert.deepEqual(
    planWikidotRateActionBindings([], [starControls, starControls], starActions as any),
    []
  )
})

test("trusted inline Rate bindings remove CSP-blocked handlers and JavaScript URLs", async () => {
  const rate = actionElement()
  rate.setAttribute("href", "javascript:;")
  rate.setAttribute(
    "onclick",
    "WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, 1)"
  )
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (selector: any) => (selector.includes(".rateup") ? [rate] : [])
  }
  rate.parentElement = root
  let votes = 0
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const parameters: any = {
    actions: [],
    rateActions: [{ type: "rate", index: 0, fingerprint, value: 1 }],
    runtime: { rate: () => (votes += 1) }
  }
  const legacyActions = wikidotLegacyActions(root as any, parameters)

  assert.equal(rate.getAttribute("onclick"), null)
  assert.equal(rate.getAttribute("href"), "#")
  assert.equal(rate.getAttribute("data-wikijump-rate-bound"), "1")
  await listeners.get("click")({
    target: rate,
    preventDefault: () => {},
    stopPropagation: () => {}
  })
  assert.equal(votes, 1)

  legacyActions.update(parameters)
  await listeners.get("click")({
    target: rate,
    preventDefault: () => {},
    stopPropagation: () => {}
  })
  assert.equal(votes, 2)
})

test("renderer removes exact Rate inline handlers before the browser parses HTML", () => {
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const actions = [
    { type: "rate", index: 0, fingerprint, value: 1 },
    { type: "rate", index: 1, fingerprint, value: -1 },
    { type: "rate-cancel", index: 2, fingerprint }
  ]
  const html = [
    '<span class="rateup"><a href="javascript:;" onclick="WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, 1)" title="I like it">+</a></span>',
    '<span class="ratedown"><a href="javascript:;" onclick="WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, -1)" title="I don\'t like it">-</a></span>',
    '<span class="cancel"><a href="javascript:;" onclick="WIKIDOT.modules.PageRateWidgetModule.listeners.cancelVote(event)" title="Cancel my vote">x</a></span>',
    '<a href="#" onclick="keepThisUnrelatedHandler()">unrelated</a>',
    '<a href="javascript:;" onclick="keepThisUnrelatedHandler()">unrelated javascript link</a>'
  ].join("")

  const servedHtml = materializeWikidotRateActionHtml(html, actions as any) as any
  assert.equal((servedHtml.match(/onclick=/gu) ?? []).length, 2)
  assert.ok(
    servedHtml.includes('<a href="javascript:;" onclick="keepThisUnrelatedHandler()">')
  )
  const servedRateAnchors = [
    ...servedHtml.matchAll(/<a\b(?=[^>]*data-wikijump-rate-action-index)[^>]*>/giu)
  ].map((match) => match[0])
  assert.equal(servedRateAnchors.length, 3)
  assert.ok(
    servedRateAnchors.every((tag) => /href="#"/u.test(tag) && !/onclick=/u.test(tag))
  )
  assert.deepEqual(
    [...servedHtml.matchAll(/data-wikijump-rate-action-index="([0-9]+)"/gu)].map(
      (match) => match[1]
    ),
    ["0", "1", "2"]
  )
  assert.equal(
    materializeWikidotRateActionHtml(html, actions.slice(0, 2) as any),
    html,
    "a descriptor/control mismatch leaves source HTML untouched"
  )

  const controls = actions.map((_, index) => {
    const control = actionElement()
    control.setAttribute("href", "#")
    control.setAttribute("data-wikijump-rate-action-index", `${index}`)
    return control
  })
  assert.deepEqual(
    planWikidotRateActionBindings(controls, [], actions as any),
    actions.map((action, index) => [controls[index], action])
  )
  assert.deepEqual(
    planWikidotRateActionBindings(
      [controls[1], controls[0], controls[2]],
      [],
      actions as any
    ),
    [],
    "the server marker must retain its matching descriptor position"
  )
})

test("initialized Rate stars preserve the live hidden score value", () => {
  const created: any[] = []
  const widget = {
    dataset: { rating: "4" },
    ownerDocument: {
      createElement: () => {
        const element = actionElement()
        element.append = () => {}
        created.push(element)
        return element
      }
    },
    style: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    append: () => {}
  }
  const root = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: (selector: any) =>
      selector === ".page-rate-widget-start" ? [widget] : []
  }

  wikidotLegacyActions(root as any, { actions: [], runtime: {} })

  assert.equal(created.at(-1).name, "score")
  assert.equal(created.at(-1).type, "hidden")
  assert.equal(created.at(-1).value, "4")
})

test("legacy printuser onclick is rebound without evaluating authored script", () => {
  let handlerReads = 0
  const printuser = (href: any, userId: any): any => {
    const attributes = new Map([
      ["href", href],
      ["onclick", `WIKIDOT.page.listeners.userInfo(${userId}); return false;`]
    ])
    let handler: any = null
    return {
      get onclick() {
        handlerReads += 1
        return handler
      },
      set onclick(value: any) {
        handler = value
      },
      getAttribute: (name: any) => attributes.get(name) ?? null
    }
  }
  const current = printuser("https://www.wikidot.com/user:info/r11-editor", 20000007)
  const legacy = printuser("http://www.wikidot.com/user:info/r11-author", 20000008)
  const root = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: (selector: any) =>
      selector ===
      '.printuser > a[href^="https://www.wikidot.com/user:info/"][onclick], .printuser > a[href^="http://www.wikidot.com/user:info/"][onclick]'
        ? [current, legacy]
        : []
  }
  const calls: any[] = []
  const globalRef: any = globalThis
  const prior = globalRef.WIKIDOT
  globalRef.WIKIDOT = {
    page: {
      listeners: { userInfo: (userId: any) => calls.push(userId) }
    }
  }
  try {
    const action = wikidotLegacyActions(root as any, {
      actions: [],
      runtime: {}
    })
    assert.equal(handlerReads, 0, "binding must not read the attribute handler")
    assert.equal(typeof current.onclick, "function")
    assert.equal(typeof legacy.onclick, "function")
    assert.equal(current.onclick({}), false)
    assert.equal(legacy.onclick({}), false)
    assert.deepEqual(calls, [20000007, 20000008])
    handlerReads = 0
    action.destroy()
    assert.equal(handlerReads, 0, "destroy must not read the attribute handler")
    assert.equal(current.onclick, null)
    assert.equal(legacy.onclick, null)
  } finally {
    globalRef.WIKIDOT = prior
  }
})

test("legacy printuser binding installs the missing Wikidot userInfo runtime", () => {
  const globalRef: any = globalThis
  const prior = globalRef.WIKIDOT
  globalRef.WIKIDOT = { modules: {} }
  const root = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => []
  }
  try {
    wikidotLegacyActions(root as any, { actions: [], runtime: {} })
    assert.equal(typeof globalRef.WIKIDOT.page.listeners.userInfo, "function")
    assert.equal(globalRef.WIKIDOT.page.listeners.userInfo(20000013), false)
  } finally {
    globalRef.WIKIDOT = prior
  }
})

test("a Rate action updates the live hidden star score after the server response", () => {
  const score = { value: "0" }
  const stars = {
    dataset: { rating: "0" },
    querySelector: (selector: any) => (selector === 'input[name="score"]' ? score : null),
    querySelectorAll: () => []
  }
  const widget = {
    querySelector: (selector: any) =>
      selector === ".page-rate-widget-start" ? stars : null
  }
  const element = { closest: () => widget }

  updateWikidotRateWidget(element as any, 4)

  assert.equal(score.value, "4")
})

test("unsupported sidecar actions fail closed without calling authored names", async () => {
  let called = false
  const handled = await performWikidotLegacyAction(
    actionElement(),
    { type: "author-script", onclick: "alert(1)" } as any,
    {
      authorScript: () => {
        called = true
      }
    } as any
  )

  assert.equal(handled, false)
  assert.equal(called, false)
})

test("edit stays visibly busy while overlapping Wikidot activations settle", async () => {
  const releases: any[] = []
  let calls = 0
  const element = actionElement()
  const runtime = {
    edit: async () => {
      calls += 1
      await new Promise((resolve) => releases.push(resolve))
    }
  }

  const first = performWikidotLegacyAction(element, { type: "edit" }, runtime)
  const second = performWikidotLegacyAction(element, { type: "edit" }, runtime)
  assert.equal(calls, 2)
  assert.equal(element.getAttribute("aria-busy"), "true")

  releases[1]()
  assert.equal(await second, true)
  assert.equal(element.getAttribute("aria-busy"), "true")

  releases[0]()
  assert.equal(await first, true)
  assert.equal(element.getAttribute("aria-busy"), null)
})

test("non-edit standalone actions remain serialized while busy", async () => {
  let release: any
  let calls = 0
  const operation = new Promise((resolve) => {
    release = resolve
  })
  const element = actionElement()
  const runtime = {
    source: async () => {
      calls += 1
      await operation
    }
  }

  const first = performWikidotLegacyAction(element, { type: "source" }, runtime)
  const repeated = await performWikidotLegacyAction(element, { type: "source" }, runtime)
  assert.equal(repeated, false)
  assert.equal(calls, 1)
  assert.equal(element.getAttribute("aria-busy"), "true")

  release()
  assert.equal(await first, true)
  assert.equal(element.getAttribute("aria-busy"), null)
})

test("print opens one child window per activation without a busy state", async () => {
  let calls = 0
  const element = actionElement()
  const runtime = {
    print: () => (calls += 1)
  }

  assert.equal(
    await performWikidotLegacyAction(element, { type: "print" }, runtime),
    true
  )
  assert.equal(
    await performWikidotLegacyAction(element, { type: "print" }, runtime),
    true
  )
  assert.equal(calls, 2)
  assert.equal(element.getAttribute("aria-busy"), null)
})

test("Rate controls share one busy boundary across the page runtime", async () => {
  const first = actionElement()
  const second = actionElement()
  const fingerprint = "0123456789abcdef0123456789abcdef"
  let release: any
  const calls: any[] = []
  const runtime = {
    rate: (index: any) => {
      calls.push(index)
      return new Promise((resolve) => (release = resolve))
    }
  }

  const pending = performWikidotLegacyAction(
    first,
    { type: "rate", index: 0, fingerprint, value: 1 },
    runtime
  )
  assert.equal(
    await performWikidotLegacyAction(
      second,
      { type: "rate", index: 1, fingerprint, value: -1 },
      runtime
    ),
    false
  )
  assert.deepEqual(calls, [0])

  release()
  assert.equal(await pending, true)
})

test("sidecar binding preserves exact DOM and fails closed on a count mismatch", () => {
  const exactDomControls = [actionElement(), actionElement()]
  const actions = [
    { type: "edit" },
    {
      type: "set-tags",
      index: 1,
      fingerprint: "0123456789abcdef0123456789abcdef"
    }
  ]

  assert.deepEqual(
    planWikidotStandaloneActionBindings(exactDomControls, actions as any),
    [
      [exactDomControls[0], actions[0]],
      [exactDomControls[1], actions[1]]
    ]
  )
  assert.deepEqual(
    planWikidotStandaloneActionBindings(
      [...exactDomControls, actionElement()],
      actions as any
    ),
    []
  )
  assert.deepEqual(
    planWikidotStandaloneActionBindings(exactDomControls, [
      actions[0],
      { type: "author-script", onclick: "alert(1)" }
    ] as any),
    []
  )
  assert.deepEqual(
    planWikidotStandaloneActionBindings(exactDomControls, [
      actions[0],
      { type: "set-tags", index: 1, fingerprint: "forged" }
    ] as any),
    []
  )
  for (const control of exactDomControls) {
    assert.equal(control.getAttribute("data-wikijump-legacy-action"), null)
    assert.equal(control.getAttribute("onclick"), null)
  }
})

test("standalone action binding fails closed on a malformed present sidecar", () => {
  assert.deepEqual(
    planWikidotStandaloneActionBindings([actionElement()], [null] as any),
    []
  )
})

test("Rate DOM is intercepted but remains inert without a typed sidecar", () => {
  const rate = actionElement()
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: (selector: any) => (selector.includes(".rateup") ? [rate] : [])
  }
  rate.parentElement = root
  let votes = 0
  wikidotLegacyActions(root as any, {
    actions: [],
    runtime: { rate: () => (votes += 1) }
  })
  let prevented = false
  let stopped = false

  listeners.get("click")({
    target: rate,
    preventDefault: () => (prevented = true),
    stopPropagation: () => (stopped = true)
  })

  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.equal(votes, 0)
})

test("Join binds exact renderer DOM out of band and remains busy through reload", async () => {
  const exact = actionElement()
  exact.matches = (selector: any) =>
    selector ===
    `div > a[href="javascript:;"][onclick="WIKIDOT.page.listeners.join(event, 'unified')"]`
  const custom = actionElement()
  custom.matches = () => false
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const actions = [
    {
      type: "join",
      page_id: 42,
      revision_id: 90,
      index: 0,
      fingerprint
    }
  ]

  assert.deepEqual(planWikidotJoinActionBindings([exact], actions as any), [
    [exact, actions[0]]
  ])
  assert.deepEqual(planWikidotJoinActionBindings([exact, custom], actions as any), [])
  assert.equal(exact.getAttribute("data-wikijump-membership-action"), null)

  let release: any
  let reloads = 0
  const calls: any[] = []
  const joining = performWikidotMembershipAction(exact, actions[0] as any, {
    join: (pageId: any, revisionId: any, index: any, selectedFingerprint: any) => {
      calls.push([pageId, revisionId, index, selectedFingerprint])
      return new Promise((resolve) => (release = resolve))
    },
    reload: () => {
      reloads += 1
    }
  })
  assert.equal(exact.getAttribute("aria-busy"), "true")
  assert.equal(
    await performWikidotMembershipAction(exact, actions[0] as any, {
      join: () => {
        throw new Error("repeated Join must not execute")
      }
    }),
    false
  )
  release()
  assert.equal(await joining, true)
  assert.deepEqual(calls, [[42, 90, 0, fingerprint]])
  assert.equal(exact.getAttribute("aria-busy"), null)
  assert.equal(reloads, 1)
})

test("MembershipApply submits the current comment and reloads only after a server transition", async () => {
  const control = actionElement()
  control.closest = (selector: any) =>
    selector === "#membership-by-apply-form"
      ? {
          querySelector: (query: any) =>
            query === '[name="comment"]' ? { value: "apply me" } : null
        }
      : null
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const calls: any[] = []
  let reloads = 0
  let errors = 0

  assert.equal(
    await performWikidotMembershipAction(
      control,
      { type: "application", page_id: 42, revision_id: 90, index: 1, fingerprint },
      {
        application: (...args: any[]) => {
          calls.push(args)
          return "submitted"
        },
        reload: () => (reloads += 1),
        error: () => (errors += 1)
      }
    ),
    true
  )
  assert.deepEqual(calls, [[42, 90, 1, fingerprint, "apply me"]])
  assert.equal(reloads, 1)
  assert.equal(errors, 0)

  reloads = 0
  assert.equal(
    await performWikidotMembershipAction(
      control,
      { type: "application", page_id: 42, revision_id: 90, index: 1, fingerprint },
      {
        application: () => "no_text",
        reload: () => (reloads += 1),
        error: (error: any) => {
          errors += 1
          assert.match(error.message, /write something/u)
        }
      }
    ),
    true
  )
  assert.equal(reloads, 0)
  assert.equal(errors, 1)
})

test("MembershipByPassword exposes the live inline wrong-password state without reloading", async () => {
  const control = actionElement()
  const error = { style: { display: "none" } }
  const form = {
    querySelector: (query: any) =>
      query === '[name="password"]' ? { value: "wrong" } : null
  }
  const box = {
    querySelector: (query: any) => (query === "#mbp-error" ? error : null)
  }
  control.closest = (selector: any) => {
    if (selector === "#membership-by-password-form") return form
    if (selector === "#membership-by-password-box") return box
    return null
  }
  const fingerprint = "0123456789abcdef0123456789abcdef"
  let reloads = 0
  const calls: any[] = []

  assert.equal(
    await performWikidotMembershipAction(
      control,
      { type: "password", page_id: 42, revision_id: 90, index: 2, fingerprint },
      {
        password: (...args: any[]) => {
          calls.push(args)
          return "wrong_password"
        },
        reload: () => (reloads += 1)
      }
    ),
    true
  )
  assert.deepEqual(calls, [[42, 90, 2, fingerprint, "wrong"]])
  assert.equal(error.style.display, "")
  assert.equal(reloads, 0)
})

test("MembershipEmailInvitation replaces only the live box after accepted token consumption", async () => {
  const control = actionElement()
  const box = { innerHTML: "before" }
  control.closest = (selector: any) =>
    selector === "#membership-email-invitation-box" ? box : null
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const calls: any[] = []
  let reloads = 0
  let errors = 0

  assert.equal(
    await performWikidotMembershipAction(
      control,
      { type: "invitation", page_id: 42, revision_id: 90, index: 3, fingerprint },
      {
        invitation: (...args: any[]) => {
          calls.push(args)
          return { status: "accepted", site_name: "Test <Wiki>", site_slug: "test&site" }
        },
        reload: () => (reloads += 1),
        error: () => (errors += 1)
      }
    ),
    true
  )
  assert.deepEqual(calls, [[42, 90, 3, fingerprint]])
  assert.equal(reloads, 0)
  assert.equal(errors, 0)
  assert.match(box.innerHTML, /<h1>Congratulations!<\/h1>/u)
  assert.match(box.innerHTML, /Test &lt;Wiki&gt;/u)
  assert.match(box.innerHTML, /test&amp;site\.wikidot\.com/u)
})

test("MembershipEmailInvitation maps used, canceled, and missing tokens to one visible unavailable error", async () => {
  const control = actionElement()
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const errors: any[] = []
  let reloads = 0

  assert.equal(
    await performWikidotMembershipAction(
      control,
      { type: "invitation", page_id: 42, revision_id: 90, index: 3, fingerprint },
      {
        invitation: () => ({ status: "unavailable" }),
        reload: () => (reloads += 1),
        error: (error: any) => errors.push(error.message)
      }
    ),
    true
  )
  assert.deepEqual(errors, ["Sorry, no invitation can be found."])
  assert.equal(reloads, 0)
})

test("unsupported membership descriptors and authored lookalikes fail closed", async () => {
  const lookalike = actionElement()
  lookalike.matches = () => false
  let joined = false

  assert.deepEqual(
    planWikidotJoinActionBindings(
      [lookalike],
      [
        {
          type: "join",
          page_id: 42,
          revision_id: 90,
          index: 0,
          fingerprint: "0123456789abcdef0123456789abcdef"
        }
      ]
    ),
    []
  )
  assert.deepEqual(
    planWikidotJoinActionBindings(
      [lookalike],
      [
        {
          type: "join",
          page_id: 42,
          revision_id: 90,
          index: 0,
          fingerprint: "forged"
        }
      ]
    ),
    []
  )
  assert.equal(
    await performWikidotMembershipAction(
      lookalike,
      { type: "author-script", onclick: "alert(1)" } as any,
      { join: () => (joined = true) }
    ),
    false
  )
  assert.equal(joined, false)
})

test("Join binding fails closed on a malformed present sidecar", () => {
  const control = actionElement()
  control.matches = () => true
  assert.deepEqual(planWikidotJoinActionBindings([control], [null] as any), [])
})

test("a sidecar mismatch intercepts the exact legacy onclick without joining", () => {
  const first = actionElement()
  const second = actionElement()
  first.matches = () => true
  second.matches = () => true
  const listeners = new Map()
  const root = {
    addEventListener: (name: any, listener: any) => listeners.set(name, listener),
    removeEventListener: () => {},
    querySelectorAll: () => [first, second]
  }
  first.parentElement = root
  second.parentElement = root
  let joined = false
  wikidotMembershipActions(root as any, {
    actions: [
      {
        type: "join",
        page_id: 42,
        revision_id: 90,
        index: 0,
        fingerprint: "0123456789abcdef0123456789abcdef"
      }
    ],
    runtime: { join: () => (joined = true) }
  })
  let prevented = false
  let stopped = false

  listeners.get("click")({
    target: first,
    preventDefault: () => (prevented = true),
    stopPropagation: () => (stopped = true)
  })

  assert.equal(prevented, true)
  assert.equal(stopped, true)
  assert.equal(joined, false)
})

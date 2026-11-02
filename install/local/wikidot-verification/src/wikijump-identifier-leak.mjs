
export const REPORT_SCHEMA = "wikijump_compat.wikijump_identifier_leak.report.v1";

const IDENTIFIER_PATTERN = /(?<![\w-])(?:data-)?wj-[a-z0-9]+(?:-[a-z0-9]+)*/gu;

export const CONSTRUCT_BATTERY = Object.freeze([
  {id: "footnote", wikitext: "text[[footnote]]note[[/footnote]]\n[[footnoteblock]]"},
  {id: "footnote-missing-cite", wikitext: "[[bibcite nosuchreference]]"},
  {
    id: "bibliography",
    wikitext: "[((bibcite ref))]\n[[bibliography]]\n: ref : A citation\n[[/bibliography]]",
  },
  {id: "collapsible", wikitext: '[[collapsible show="+ open" hide="- close"]]\nbody\n[[/collapsible]]'},
  {id: "code-plain", wikitext: "[[code]]\nplain text\n[[/code]]"},
  {id: "code-language", wikitext: '[[code type="css"]]\n.x { color: red; }\n[[/code]]'},
  {id: "tabview", wikitext: "[[tabview]]\n[[tab One]]\nfirst\n[[/tab]]\n[[/tabview]]"},
  {id: "math-block", wikitext: "[[math]]\nx^2\n[[/math]]"},
  {id: "math-inline", wikitext: "[[$ x^2 $]]"},
  {id: "toc", wikitext: "[[toc]]\n+ First\n+ Second"},
  {id: "heading", wikitext: "+ Heading One\n++ Heading Two"},
  {id: "user", wikitext: "[[user Rokurolize]]\n[[*user Rokurolize]]"},
  {id: "date", wikitext: "[[date 1600000000]]"},
  {id: "image", wikitext: "[[image https://example.invalid/i.png]]"},
  {id: "image-missing", wikitext: "[[image nonexistent-local-file.png]]"},
  {id: "video", wikitext: "[[video https://example.invalid/v.mp4]]"},
  {id: "audio", wikitext: "[[audio https://example.invalid/a.mp3]]"},
  {id: "embed", wikitext: "[[embed]]\nhttps://www.youtube.com/watch?v=00000000000\n[[/embed]]"},
  {id: "table", wikitext: "[[table]]\n[[row]]\n[[cell]]c[[/cell]]\n[[/row]]\n[[/table]]"},
  {id: "table-simple", wikitext: "||~ head ||\n|| cell ||"},
  {id: "link-internal", wikitext: "[[[start]]]"},
  {id: "link-missing", wikitext: "[[[no-such-page-here]]]"},
  {id: "link-external", wikitext: "[https://example.invalid label]"},
  {id: "link-interwiki", wikitext: "[[[wikipedia:Example]]]"},
  {id: "link-anchor", wikitext: "[[# anchor]]\n[#anchor jump]"},
  {id: "email", wikitext: "[mailto:nobody@example.invalid mail]"},
  {id: "monospace", wikitext: "{{monospace}}"},
  {id: "raw", wikitext: "@@raw text@@"},
  {id: "align", wikitext: "[[>]]\nright\n[[/>]]\n[[=]]\ncentre\n[[/=]]"},
  {id: "clear-float", wikitext: "~~~~"},
  {id: "list", wikitext: "* one\n* two\n# first\n# second"},
  {id: "blockquote", wikitext: "> quoted\n> more"},
  {id: "div-class", wikitext: '[[div class="custom"]]\nbody\n[[/div]]'},
  {id: "span", wikitext: "[[span style=\"color:red\"]]x[[/span]]"},
  {id: "hidden-block", wikitext: "[[hidden]]secret[[/hidden]]"},
  {id: "invisible-block", wikitext: "[[invisible]]gone[[/invisible]]"},
  {id: "iframe", wikitext: "[[iframe https://example.invalid/]]"},
  {id: "list-pages-row-heading", wikitext: '[[module ListPages limit="3"]]\n+ %%title%%\n[[/module]]'},
  {id: "list-pages-row-body", wikitext: '[[module ListPages limit="3"]]\n%%content%%\n[[/module]]'},
  {id: "count-pages", wikitext: '[[module CountPages]]\n%%total%%\n[[/module]]'},
]);

export function findWikijumpIdentifiers(html) {
  if (typeof html !== "string") throw new Error("rendered body must be a string");
  IDENTIFIER_PATTERN.lastIndex = 0;
  return [...new Set(html.match(IDENTIFIER_PATTERN) ?? [])].sort();
}

export function evaluateRenderedBattery(rendered) {
  const cases = [];
  const seenIds = new Set();
  for (const entry of rendered) {
    if (typeof entry?.id !== "string" || !entry.id) {
      throw new Error("every rendered case needs an id");
    }
    if (seenIds.has(entry.id)) throw new Error(`duplicate rendered case ${entry.id}`);
    seenIds.add(entry.id);
    if (typeof entry.error === "string" && entry.error) {
      cases.push({id: entry.id, status: "render-error", error: entry.error, identifiers: []});
      continue;
    }
    const identifiers = findWikijumpIdentifiers(entry.body);
    cases.push({
      id: entry.id,
      status: identifiers.length > 0 ? "leaked" : "clean",
      identifiers,
    });
  }
  const leaked = cases.filter((entry) => entry.status === "leaked");
  const errored = cases.filter((entry) => entry.status === "render-error");
  return {
    schema: REPORT_SCHEMA,
    case_count: cases.length,
    cases,
    leaked_case_count: leaked.length,
    render_error_count: errored.length,
    identifiers: [...new Set(leaked.flatMap((entry) => entry.identifiers))].sort(),
    status: leaked.length === 0 && errored.length === 0 ? "clean" : "leaked",
  };
}

export async function runWikijumpIdentifierLeakCheck({battery = CONSTRUCT_BATTERY, render}) {
  if (typeof render !== "function") throw new Error("render must be a function");
  if (!Array.isArray(battery) || battery.length === 0) {
    throw new Error("battery must hold at least one construct");
  }
  const rendered = [];
  for (const construct of battery) {
    try {
      rendered.push({id: construct.id, body: await render(construct)});
    } catch (error) {
      rendered.push({id: construct.id, error: error?.message ?? String(error)});
    }
  }
  return evaluateRenderedBattery(rendered);
}

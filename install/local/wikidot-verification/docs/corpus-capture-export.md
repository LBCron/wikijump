# Corpus capture export

The reversed corpus flow: a Wikijump import run fetches the pages it needs
itself, at full fidelity, and — as part of the same run — writes the raw
captures out as corpus records in the scp-wiki-translation corpus format.
That export is the handoff to the translation repo. Previously the flow ran
the other way (the translation repo's sync fetched Wikidot into a corpus
and Wikijump's importer consumed it), and the corpus's stored `meta.json`
was a cut-down projection — it carries `created_by` as a name only, with
the numeric ids and unix names dropped — so Wikijump kept having to
re-fetch pages one by one to recover the lost fields.

## Pieces

- `scripts/capture-pages-wikidot-py.py` — the capture leg (the export
  hook). Fetches pages through the wikidot.py checkout
  (`WIKIDOT_PY_CHECKOUT`, resolved exactly like
  `src/wikidot-py-checkout.mjs`) and writes `captures.jsonl`. With
  `--export-root` it runs the exporter on the captures in the same
  invocation, so a capture run always produces its corpus records.
  Fail-closed: any failed fetch aborts before anything is written.
- `src/corpus-capture-export.mjs` — the format writer. Serializes capture
  records into a corpus branch; also reads stored captures back out of an
  existing corpus branch (`readStoredCorpusCapture`).
- `scripts/export-corpus-captures.mjs` — the standalone export command.
  Modes: `--captures <file>` (fresh capture records), `--from-corpus
  <root>` (re-emit stored raw captures without re-fetching), `--raw-dir
  <dir>` (raw payload JSON dumps, e.g. the runs 459–466 fetch output).

The import side is unchanged: `scripts/import-page.mjs` and
`build-corpus-import-manifest.mjs` consume an exported branch exactly like
the translation repo's corpus, because the page projection files are the
same.

## The capture record

One record per page: `{transport, received_at, payload, meta_payload?}`.

- `payload` is the `pages.get_one` response **exactly as fetched** — page
  source under `content`, rendered HTML under `html`, and every metadata
  field the transport returned. The XML-RPC transport returns 18 fields
  (including `parent_title` / `title_shown`, no identity ids). The
  wikidot.py fallback transport returns the identity fields
  (`created_by_id`, `created_by_unix`, `updated_*`, `commented_*`) that
  XML-RPC omits, and an empty `html` (it does not fetch rendered HTML).
- `meta_payload` is the transport's `pages.get_meta` row when one was
  actually returned. When absent, the meta response recorded in the run is
  the projection of the same fetch — which is also how the fallback
  transport's own `pages_get_meta` is derived.

A payload without string `content`/`html` fields is **not a raw capture**
(it is a digested projection, e.g. the importer's snapshot metadata). The
exporter lists such pages as not exportable and writes nothing for them;
a projection is never re-labeled as a capture.

## The corpus branch layout written

Format source of truth: the translation repo's
`scp_wiki_wikidot/complete_capture.py` (store), `complete_capture_engine.py`
(page capture), `storage.py` (page files), `identity.py` / `models.py`
(index), and `docs/corpus-sync*.md`. Per exported branch
(`<export-root>/<branch>/`):

- `pages/<fullname>/`
  - `source.wikidot.txt` — the payload's `content`, byte-exact.
  - `meta.json` — the corpus projection of the payload (all fields except
    `content`/`html`; `parent_title`/`title_shown` null-filled when the
    transport did not return them), pretty canonical JSON.
  - `api-response.json` — the payload in canonical JSON bytes.
  - `html.xmlrpc.html` — the payload's `html`.
  - `entity_id.txt` — the page's corpus entity UUID + `\n`. An existing
    identity (from the export branch itself or `--identity-corpus-root`)
    is reused; a fresh UUID v4 is minted only for unknown pages.
  - `current.json` — `{schema_version, run_id, entity_id, capture_id,
    payload_sha256, fullname, status}` pointing at the snapshot below.
- `_objects/sha256/<digest[0:2]>/<digest>.json` — every recorded response
  payload, content-addressed and immutable; the digest is the sha256 of
  the canonical payload bytes. An existing object with different bytes is
  a hard error.
- `_runs/<run_id>/manifest.json` + `responses.ndjson` — the run ledger.
  Manifest: `{schema_version, run_id, site, branch, branch_root, profile:
  "wikijump-import-capture", transport: "xmlrpc", status, started_at,
  finished_at, exit_code, response_count, failures, counts,
  complete_gate}`; export runs finish with status `targeted` and a
  targeted-scope gate. Each ledger line is one response envelope
  `{schema_version, run_id, method, request, received_at, payload_object,
  payload_sha256, redactions}`.
- `by-uuid/<entity_id>/snapshots/<capture_id>.json` — immutable record
  binding the two response references:
  `capture_id = sha256("<get_meta payload_sha256>|<get_one payload_sha256>")`
  over the `sha256:...` reference strings, plus the content hash.
- `by-uuid/<entity_id>/observations.ndjson` — append-only change log
  (`first_seen`, `content`, `metadata` kinds), one spaced-JSON line per
  observation, written only when the page changed relative to the export
  branch's stored projection.
- `index.json` — `{schema_version, entities, by_site_created_at,
  pending_ambiguities}`; entity records carry exactly the `identity.py`
  `Entity` dataclass fields, keyed by `<site>|<created_at>` in
  `by_site_created_at`.

Canonical JSON means: object keys sorted by code point, compact
separators, UTF-8, one trailing newline (Python
`json.dumps(..., ensure_ascii=False, sort_keys=True, separators=(",", ":"))`);
`meta.json`/`index.json` use the same canonicalization with `indent=2`.
Capability query parameters in `download_url`/`url` values are stripped
before hashing, mirroring `canonicalize_xmlrpc`.

## What this does not do (step 2, translation-repo side)

- No site enumeration, forum posts, files/attachments or rename
  classification: exports are targeted page sets. A page that was renamed
  on Wikidot appears as a new page here; the translation repo's sync
  engine reconciles identity when it ingests the export.
- The translation repo still needs its receiving convention: ingest an
  export branch into the corpus (verifying with
  `scripts/check_corpus_complete_capture.py`'s per-page invariants), and
  teach its sync to treat export-fed pages as already captured so it does
  not re-fetch them.

# MiniRecentPosts Module

- Feature ID: `module-minirecentposts`
- Category: `module`
- Documentation status: `documented`
- Specification source: frozen local Wikidot documentation corpus
- Behavioral authority: documentation-derived; live Wikidot wins if tested behavior conflicts

## Purpose

Implement the `MiniRecentPosts` module interface, attributes, defaults, selection or side-effect behavior, templates, output, and documented limitations.

## Implementation contract

- The module dispatcher MUST recognize every documented module name and compatibility alias.
- The evaluator MUST implement documented attributes, aliases, defaults, limits, selection rules, permissions, side effects, and URL behavior.
- The renderer MUST implement documented templates, variables, wrappers, generated links, empty states, and interactive behavior.

Every explicit default, accepted value, rejected value, alias, limit, interaction, output form, URL form, permission rule, and stated limitation in the evidence below is part of this specification. Examples are conformance fixtures. Text that merely describes the documentation site or presents a live demo is informative rather than normative.

If the documentation is silent or contradictory, the implementation MUST fail closed or preserve the existing literal behavior until a live Wikidot experiment supplies a stable expectation. The spec and catalog must then be updated with that evidence.

## Live-Wikidot behavioral corrections

The observations in this section are normative and override conflicting or
incomplete documentation-derived evidence below.

### Forum mini modules share own-line, limit, activity, route, and literal-owner contracts

- Observation ID: `forum-mini-current-preview-and-workbench-20260809`
- Classification: `live-clarification`
- Observed at: `2026-08-09`
- Analysis: Anonymous PagePreviewModule probes establish the own-line invocation, invalid-limit fallback, empty wrapper, and literal-owner boundaries for all three mini modules. A fresh anonymous read of the public sandbox workbench establishes populated compact rows and routes without mutating Wikidot. The populated values are point-in-time evidence, not repository fixtures.

Normative behavior:

- Each recognized own-line module renders a forum-mini-stat wrapper; an empty result keeps the wrapper and renders no item rows.
- The default limit is 5. A positive limit constrains rows. Zero, negative, nonnumeric, and unknown attributes preserve the default in the observed matrix.
- Inline module text and a module opener owned by a raw span remain literal.
- MiniRecentThreads orders by newest thread and renders thread routes, started dates, and reply counts.
- MiniActiveThreads renders recently active threads using the documented last-seven-days window and the compact thread row contract.
- MiniRecentPosts orders replies by recency and renders a post anchor, excerpt, printuser identity, date, and thread reply count. Standalone thread roots are absent from the observed saved-page output.
- Live private-content actor matrices, rich-markup excerpt reduction, no-title text, exact truncation, tie-breaking, and mutation-driven cache behavior remain nonterminal gaps.

Evidence:

- `install/local/wikidot-verification/artifacts/forum-mini-live-preview-and-workbench-20260809.json` (SHA-256 `ff093dc2d48fc197828f11271689cb1254057d28e5e9614ccac7f7e8b0a1aee8`), cases: `mini-recent-threads-bare`, `mini-recent-threads-limit-one`, `mini-recent-threads-limit-zero`, `mini-recent-threads-limit-negative`, `mini-recent-threads-limit-text`, `mini-recent-threads-unknown-argument`, `mini-recent-threads-inline`, `mini-recent-threads-literal`, `mini-active-threads-bare`, `mini-active-threads-limit-one`, `mini-active-threads-limit-zero`, `mini-active-threads-limit-negative`, `mini-active-threads-limit-text`, `mini-active-threads-unknown-argument`, `mini-active-threads-inline`, `mini-active-threads-literal`, `mini-recent-posts-bare`, `mini-recent-posts-limit-one`, `mini-recent-posts-limit-zero`, `mini-recent-posts-limit-negative`, `mini-recent-posts-limit-text`, `mini-recent-posts-unknown-argument`, `mini-recent-posts-inline`, `mini-recent-posts-literal`



### Forum mini modules accept the ForumMini registry names and share live selection, limit, argument, and content rules

- Observation ID: `forum-mini-registry-alias-and-content-rules-20261105`
- Classification: `live-clarification`
- Observed at: `2026-11-05`
- Analysis: Anonymous GETs of run-owned saved pages on `sandbox-for-codex`, backed by run-owned forum threads with known post counts, establish the registry and alias spellings, the limit clamp, `categoryId` handling, row selection, and the exact row content contract for all three mini modules. This observation supersedes the earlier inference that standalone thread roots are absent from RecentPosts; it samples standalone roots directly.

Normative behavior:

- `ForumMiniRecentThreads`, `ForumMiniActiveThreads`, and `ForumMiniRecentPosts` are live module names. `MiniRecentThreads`, `MiniActiveThreads`, and `MiniRecentPosts` are registered aliases of the same modules and render identical output. Module names are case-insensitive; other names render the theme's No such module error.
- A positive integer `limit` from 1 through 300 constrains rows and the default is 5. Zero, negative, nonnumeric, single-quoted, unquoted, and spaced attribute forms retain the default. Duplicate double-quoted `limit` attributes use the last value. A numeric non-integer limit renders `<div class="error-block">An error occurred when processing your request.</div>`.
- `RecentPosts` honors a double-quoted `categoryId`: a numeric category that exists renders `<div class="error-block">An error occurred when processing your request.</div>`, a numeric category that does not exist renders `<div class="error-block">The category can not be found.</div>`, and a nonnumeric value renders the generic processing error block. `RecentThreads` and `ActiveThreads` ignore `categoryId`.
- `RecentThreads` selects every site thread ordered by descending thread id, including zero-post page discussion threads, and renders the thread total post count.
- `ActiveThreads` selects threads with at least one post inside the last seven days, ordered by that count descending, and renders the thread total post count. Equal-count tie ordering is not established.
- `RecentPosts` selects every post ordered by descending post id, including standalone thread roots and page-discussion roots, renders the thread total post count, renders `(No title)` for an empty post title, and renders the tag-stripped compiled post text truncated to 100 characters at the last space plus three dots.
- `RecentPosts` preview text is the tag-stripped rendered post text with HTML entities decoded once and re-escaped for output, so a source `<unsafe> & ampersand` renders as `&lt;unsafe&gt; &amp; ampersand` and markup such as `**bold**` renders as `bold`.
- Standalone thread post anchors are `/forum/t-<thread-id>/<unixified-thread-title>#post-<post-id>`; page discussion anchors are `/<page-slug>/comments/show#post-<post-id>`.
- Inline module text and a module opener owned by a raw span remain literal.

Evidence:

- `install/local/wikidot-verification/artifacts/forum-mini-and-comments-live-20261105.json` (SHA-256 `89e139bbbba3234cad5edebcc742c1c692d6203a66c8ca6a69b85f06fa59ba34`), cases: `fm-recent-threads`, `fm-active-threads`, `fm-recent-posts`, `alias-recent-threads`, `alias-recent-posts`, `limit-0`, `limit-negative`, `limit-text`, `limit-301`, `limit-300`, `limit-100`, `limit-duplicate`, `limit-single-quoted`, `limit-bare`, `limit-space`, `limit-empty`, `limit-float`, `limit-unterminated`, `head-junk`, `name-lowercase`, `name-unknown`, `unknown-attribute`, `cat-valid-other`, `cat-text`, `cat-threads`, `cat-posts-limit`, `active-cat`


## Suggested public TDD seams

These seams are recommendations. The implementation agent must present and confirm the actual seam map before writing tests.

- Saved-page or preview rendering through Deepwell's public page-view interface
- Framerail HTTP/browser boundary when the module is interactive or URL-driven

## Feature-specific implementation notes

- Module names and attribute names are compatibility-sensitive and must not be modernized.
- Examples are acceptance-test inputs, not permission to infer behavior beyond the documented case.

## Source inventory

- `~/src/Rokurolize/scp-wiki-translation/corpus/www/pages/doc-modules:minirecentposts-module/source.wikidot.txt:1` through line 18 (canonical)

## Documentation-derived behavioral evidence

### doc-modules:minirecentposts-module (canonical)

Source: `~/src/Rokurolize/scp-wiki-translation/corpus/www/pages/doc-modules:minirecentposts-module/source.wikidot.txt:1` through line 18  
SHA-256 of complete source file: `118693d5e939c2fff478fea3acf34ca212ade1f8ddd8e9ff157bd6a23ad78daa`

```wikidot
L0001 ++ Description
L0002 
L0003 Displays most recent forum threads in a forum suitable to be included e.g. within the welcome page. The list items contain thread title, date started and number of posts.
L0004 
L0005 ++ Attributes
L0006 
L0007 ||~ attribute ||~ required ||~ allowed values ||~ default ||~ description ||
L0008 || {{limit}} || no || positive integer || 5 || how many items to display? ||
L0009 
L0010 ++ Examples
L0011 
L0012 [[code]]
L0013 ++ Most recent forum threads
L0014 
L0015 [[module MiniRecentPosts limit="3"]]
L0016 [[/code]]
L0017 
L0018 simply displays 3 most recent forum posts.
```

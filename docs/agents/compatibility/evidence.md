# Compatibility evidence

## Authority ladder

Use cheapest authority sufficient for acceptance: provenance-backed retained evidence or corpus; anonymous/read-only live behavior; authenticated read-only behavior; run-owned mutation. Before sandbox creation, try anonymous `edit/PagePreviewModule`, `list/ListPagesModule`, or an existing public page if sufficient. Local Wikijump output proves implementation, not Wikidot; genuinely external blockers stay blocked.

Narrow a compatibility rule only after at least 2 positive and 2 negative observations varying generalized property. Byte-exact pages, page-specific conjunctions, and normalizations erasing differences are not general evidence.

Treat security-sensitive output as parity first: reproduce evidenced Wikidot behavior, however obsolete/weak; put discretionary hardening at deployment/network/privilege/isolation boundaries when possible. Diverge only when matching violates an explicit Wikijump deployment boundary or creates materially greater capability; record evidence, reason, and containment. Wikijump-only vulnerabilities are ordinary defects.

## External response cache

External acquisition is cache-first: reuse identity-bound retained responses from Wikidot, WDFiles, public providers, and other external origins. On genuine miss, write durable acquisition barrier before fetch, fetch once, durably sync complete reusable response before routed request completes, and clear barrier only after response sealing; process/transport failure after acquisition begins makes later runs fail closed without guessing/refetching. Inter-request interval: 0 ms. Honor explicit `Retry-After` retry demands on 429/503; on 2xx it is a cache hint (`600` on Wikidot HTML), not browser throttling. Replay keys request variants (`HEAD`, `Range`, HTTP conditional headers) separately; binds named `Vary` fields to exact anonymous request headers; collapses concurrent misses across browser contexts and persistent cache instances to one acquisition; retains terminal HTTP responses, preventing repeated failure/load on reruns. Persistent evidence is append-only: capacity pressure cannot evict identities or trigger refetches. Never put credential-bearing requests in shared URL cache; strip `Set-Cookie` from retained public responses; cache-only candidates fail closed rather than refetching credential-bearing traffic. Candidate/standing reruns replay exact responses, not server hits.

Retained `Vary: *` responses are historical, not exact replay: after first acquisition they block later proof attempts fail-closed and are neither replayed nor reacquired. Retain `304 Not Modified` exchanges as evidence of original conditional requests, but neither replay them as standalone representations in a fresh browser cache nor automatically reacquire them. Older cache manifests remain valid. Legacy `Vary` entries predating request-header binding remain historical, not exact replay; never bulk-refresh. When needed, acquire only exact anonymous request variant once, append its `vary_binding` to the existing manifest, and reuse it. Legacy non-`Vary` entries remain directly reusable.

CI and ordinary developer regression must never perform live compatibility acquisition. Repository-owned offline units, frozen fixtures, retained-artifact checks, syntax differential tests, and other hermetic replay are the normal regression path and may run in CI or local WSL. Live acquisition, authenticated probes, candidate parity against newly acquired evidence, and `live-reference` production are explicit discovery/refresh operations only. Once an external behavior is accepted, reduce it to a frozen fixture so later regression runs do not need Wikidot or another public provider.

The SCP-9506 full-page oracle is the reference model for browser-facing regression: the frozen Wikidot observation and accepted local golden are checked into `install/local/wikidot-verification/fixtures/offline-compatibility/`, public rendering dependencies are replayed from a repository-owned response fixture, and missing responses fail closed instead of falling back to the network. Non-browser offline suites use the process network guard. The browser oracle runs in a fresh user+network namespace with only loopback and reaches the host standing listener only through a Unix-domain-socket bridge fixed to `127.0.0.1:443`, so Chromium has no external IP route.

Browser parity against a retained live reference binds executable identity as evidence. Use the same retained browser binary/SHA when exact identity is required; host Chrome updates can cause ORB, font, layout, and resource-policy differences unrelated to product.

Pass maintained response-cache directory and cache identity explicitly where supported. Unexpected external requests are configuration defects until proven otherwise; classify resource failures as product differences only after that check.

## Browser and file routing

Keep candidate/standing file-routing authorities separate. Candidate helpers may rewrite a non-443 files port; standing owns normal port-443 host routing. Use standing’s 443 route and pin `.localhost` to intended local address when supported; candidate-only rewrites against standing can cause `ERR_TUNNEL_CONNECTION_FAILED`, missing fonts/images, and false geometry differences.

Use the maintained comparison contract; a fresh capture with selectors or normalization differing from candidate admission is a different test on same pages.

Browser-visible compatibility covers intermediate paints/loading, focus, repeated clicks, reload/navigation, and observable cleanup; a settled DOM screenshot alone does not prove temporal acceptance.

## Authenticated Wikidot probes

Before authenticated work, use `wikidot-sandbox-access` and `wikidot-py-operations`. Keep credentials/session material in process memory or restrictive private task-owned files. Records carry the redacted request shape, actor role, site, result, and cleanup, never secrets.

Keep real EN/JP Wikidot sites read-only. Writes require explicit user authorization and a run-owned sandbox; prefer disposable state; never mutate production/reference state.

An authenticated `wikidot.py` AMC session cookie and browser page-login cookie are separate boundaries. For browser auth, follow live UI and observe actual window/navigation before choosing selectors; current Wikidot Sign in may open a popup, not an original-DOM modal.

Site Manager navigation has hidden second-level entries. Use visible parent/navigation controls or an already-observed authenticated module action; hidden-menu selectors can stall probes without testing the product.

After live UI identifies the relevant asset, fetch static Wikidot JavaScript once; retain and decompress or inspect its saved bytes locally. It recovers exact module/action/field names and request shape, not paid server behavior or successful mutation semantics.

## Run-owned mutation authority

Use one disposable, task-owned Wikidot site when a shared sandbox cannot safely roll back required mutations. Batch causal cases: record baseline, perform mutations, verify each cleanup, and delete it when no case remains.

Define rollback before every write. Use run markers for created applications, invitations, pages, and other state; verify terminal state/cleanup, never trusting API success to restore baseline. If a terminal record cannot be removed, use a separate disposable actor or site for the next branch to protect the observation matrix.

Internal membership invitations and email invitation tokens are different contracts: an internal invite proves recipient-bound invited-user transitions, not opaque email-token expiry/cancellation/one-use semantics; keep acceptances separate.

## Paid and external-provider boundaries

When the current free Site Manager exposes only an Upgrade/Pro boundary with no paid test authority or retained paid observation, record that exact boundary. Static JavaScript may establish action names/fields for future acquisition, but cannot prove paid server behavior/mutation success or justify implementing a guessed path.

For mail delivery, Flickr/other providers, private domains, or external capabilities without a controlled sink/account, prove the locally observable boundary, identify the smallest missing authority, and keep the row actionable—not PASS.

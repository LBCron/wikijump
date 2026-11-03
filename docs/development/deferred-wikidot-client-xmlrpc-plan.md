# Deferred wikidot.py and XML-RPC compatibility plan

This later-stage plan owns two implementation classes that do not block the current compatibility campaign:

- changes and acceptance work for the external `Rokurolize/wikidot.py` client;
- changes and acceptance work for the Wikijump implementation of the Wikidot XML-RPC API.

Read-only use of `wikidot.py` as an evidence tool for other Wikijump behavior remains part of the current campaign. Changing the client, accepting its behavior, or closing its client-specific rows belongs here.

## Start condition

Start this plan only after the current campaign has completed its exact candidate, merge, standing verification, and final scoped-zero record. Pin the then-current Wikijump, `wikidot.py`, API guide, fixture, actor, and runtime identities before implementation begins.

## Deferred denominator

Generate a separate denominator from:

1. every public operation, AMC request shape, cookie, response parser, retry, redirect, transport-security, and failure behavior exposed by the supported `wikidot.py` client;
2. every documented, removed, resource, and system XML-RPC method exposed by Wikidot or Wikijump;
3. Basic authentication, multicall, faults, size limits, page persistence, file persistence, cleanup, restart recovery, and candidate and standing behavior;
4. retained work and evidence from issues #1373, #1374, and #1375.

Represent each surface exactly once with evidence, implementation owner, public regression, candidate result, standing result, owning issue, and blocker. Reject missing, duplicate, unknown, unowned, partially implemented, unverified, or unclosed rows.

## Implementation and acceptance

Run the same client code, methods, parameters, authentication fields, cookies, and response parsers against Wikidot and Wikijump. Only endpoint locations and secrets may differ. Do not add target-specific client branches.

Compare parameter omission, duplication, ordering, types, `callbackIndex`, status, body, CSS/JS includes, permission behavior, redirects, retries, and failure shapes. Compare XML-RPC resource and system methods, removed methods, Basic authentication, multicall, faults, size limits, and page/file persistence. Add an unsupported operation only as one coherent public vertical with its Deepwell owner, adapter, source-blind regression, and fail-closed boundaries.

Treat only explicit nondeterministic fields such as IDs, times, and nonces as nondeterministic. Do not broadly normalize DOM, errors, or request failures. Mutation probes must be restart-safe, identity-bound, and prove cleanup before acceptance.

Completion requires focused regressions, `scripts/preflight.sh --final`, one exact candidate, post-merge standing proof, and an independent final-zero record for this deferred denominator.

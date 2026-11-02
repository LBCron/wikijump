-------------------------- MODULE ArticleCacheFence --------------------------
(***************************************************************************)
(* The public-content fence that guards Wikijump's anonymous article      *)
(* caches.                                                                 *)
(*                                                                         *)
(* Writers: any Deepwell transaction that calls                            *)
(*   ctx.defer_public_content_cache_invalidate_site (site settings,        *)
(*   category settings, votes, tags, files, attribution, revisions). The  *)
(*   RPC wrapper in deepwell/src/api.rs commits the transaction, then      *)
(*   runs PostCommitAction::PublicContentSite, which INCRs                 *)
(*   deepwell:public-content:site:<id>:version                             *)
(*   (PublicContentCache::invalidate_site_for_state).                      *)
(*                                                                         *)
(* Readers: one anonymous article_view RPC (ViewService::article) plus     *)
(* the Framerail render that caches its HTML. Its reads are:               *)
(*   "viewer" - Self::preload + Self::apply_article_category_license       *)
(*              (site row, site settings, category license)                *)
(*   "fence"  - ArticlePageCache::metadata -> PublicContentCache::        *)
(*              cache_fence                                                *)
(*   "page"   - Self::page, or an ArticlePageCache::get hit under the      *)
(*              same fence                                                 *)
(* then ArticlePageCache::set (Deepwell Redis, keyed by the fence) and     *)
(* Framerail writeAnonymousArticleResponseCache (keyed by the same         *)
(* fence, holding the viewer data and the page data).                      *)
(*                                                                         *)
(* Data is one version counter: every writer commit bumps it, and a read   *)
(* returns the version it saw. Only changes that leave the Deepwell cache  *)
(* key unchanged are modeled, since the fence is their only guard.         *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Writers,              \* transactions that defer a public-content invalidation
    Readers,              \* concurrent anonymous article views
    IncrAfterCommit,      \* api.rs: txn.commit() before run_post_commit_actions_for_state
    ReaderOrder,          \* order of "viewer", "fence", "page" in ViewService::article
    PerStatementSnapshot  \* article_view runs at READ COMMITTED, not a txn snapshot

VARIABLES
    dbVer,      \* committed data version
    fence,      \* Redis public-content fence
    covered,    \* <<f, v>>: fence value f was published after version v committed
    wpc, wver,  \* writer program counter and the version it commits
    rsteps,     \* reader steps still to run
    snap,       \* reader's transaction snapshot (-1: not taken yet)
    viewerVer, rfence, pageVer,
    dwCache,    \* Deepwell ArticlePageCache entries [fence, ver]
    frCache     \* Framerail response cache entries [fence, ver]

vars == <<dbVer, fence, covered, wpc, wver, rsteps, snap,
          viewerVer, rfence, pageVer, dwCache, frCache>>

Min(a, b) == IF a < b THEN a ELSE b

Init ==
    /\ dbVer = 0
    /\ fence = 0
    /\ covered = {}
    /\ wpc = [w \in Writers |-> "start"]
    /\ wver = [w \in Writers |-> 0]
    /\ rsteps = [r \in Readers |-> Append(ReaderOrder, "store")]
    /\ snap = [r \in Readers |-> -1]
    /\ viewerVer = [r \in Readers |-> -1]
    /\ rfence = [r \in Readers |-> -1]
    /\ pageVer = [r \in Readers |-> -1]
    /\ dwCache = {}
    /\ frCache = {}

----------------------------------------------------------------------------
\* Writers.

Commit(w) ==
    /\ dbVer' = dbVer + 1
    /\ wver' = [wver EXCEPT ![w] = dbVer + 1]

\* The fence covers the writer's version only once that version is committed;
\* an INCR that runs first publishes a fence for data not yet visible.
Incr(w, v) ==
    /\ fence' = fence + 1
    /\ covered' = covered \cup {<<fence + 1, v>>}

WriterFirst(w) ==
    /\ wpc[w] = "start"
    /\ wpc' = [wpc EXCEPT ![w] = "mid"]
    /\ IF IncrAfterCommit
          THEN Commit(w) /\ UNCHANGED <<fence, covered>>
          ELSE Incr(w, dbVer + 1) /\ wver' = [wver EXCEPT ![w] = dbVer + 1]
               /\ UNCHANGED dbVer
    /\ UNCHANGED <<rsteps, snap, viewerVer, rfence, pageVer, dwCache, frCache>>

\* With IncrAfterCommit FALSE the writer's later commit gets whatever version
\* is next, which can be later than the version it announced.
WriterSecond(w) ==
    /\ wpc[w] = "mid"
    /\ wpc' = [wpc EXCEPT ![w] = "done"]
    /\ IF IncrAfterCommit
          THEN Incr(w, wver[w]) /\ UNCHANGED <<dbVer, wver>>
          ELSE Commit(w) /\ UNCHANGED <<fence, covered>>
    /\ UNCHANGED <<rsteps, snap, viewerVer, rfence, pageVer, dwCache, frCache>>

----------------------------------------------------------------------------
\* Readers.

\* What a database read sees: the latest commit at READ COMMITTED, or the
\* snapshot from the transaction's first read otherwise.
ReadVer(r) == IF PerStatementSnapshot \/ snap[r] = -1 THEN dbVer ELSE snap[r]
TakeSnap(r) == snap' = [snap EXCEPT ![r] = IF snap[r] = -1 THEN dbVer ELSE snap[r]]

ReadViewer(r) ==
    /\ rsteps[r] # <<>> /\ Head(rsteps[r]) = "viewer"
    /\ viewerVer' = [viewerVer EXCEPT ![r] = ReadVer(r)]
    /\ TakeSnap(r)
    /\ rsteps' = [rsteps EXCEPT ![r] = Tail(@)]
    /\ UNCHANGED <<dbVer, fence, covered, wpc, wver, rfence, pageVer, dwCache, frCache>>

ReadFence(r) ==
    /\ rsteps[r] # <<>> /\ Head(rsteps[r]) = "fence"
    /\ rfence' = [rfence EXCEPT ![r] = fence]
    /\ rsteps' = [rsteps EXCEPT ![r] = Tail(@)]
    /\ UNCHANGED <<dbVer, fence, covered, wpc, wver, snap, viewerVer, pageVer, dwCache, frCache>>

\* Self::page reads the database. ArticlePageCache::get can only hit when the
\* fence was read first, since the cache key carries it.
ReadPageFromDb(r) ==
    /\ rsteps[r] # <<>> /\ Head(rsteps[r]) = "page"
    /\ pageVer' = [pageVer EXCEPT ![r] = ReadVer(r)]
    /\ TakeSnap(r)
    /\ rsteps' = [rsteps EXCEPT ![r] = Tail(@)]
    /\ UNCHANGED <<dbVer, fence, covered, wpc, wver, viewerVer, rfence, dwCache, frCache>>

ReadPageFromCache(r) ==
    /\ rsteps[r] # <<>> /\ Head(rsteps[r]) = "page"
    /\ rfence[r] # -1
    /\ \E e \in dwCache :
          /\ e.fence = rfence[r]
          /\ pageVer' = [pageVer EXCEPT ![r] = e.ver]
    /\ rsteps' = [rsteps EXCEPT ![r] = Tail(@)]
    /\ UNCHANGED <<dbVer, fence, covered, wpc, wver, snap, viewerVer, rfence, dwCache, frCache>>

\* ArticlePageCache::set stores the page view; Framerail then stores the
\* rendered HTML, which carries both the viewer data and the page view.
Store(r) ==
    /\ rsteps[r] = <<"store">>
    /\ dwCache' = dwCache \cup {[fence |-> rfence[r], ver |-> pageVer[r]]}
    /\ frCache' = frCache \cup
          {[fence |-> rfence[r], ver |-> Min(viewerVer[r], pageVer[r])]}
    /\ rsteps' = [rsteps EXCEPT ![r] = <<>>]
    /\ UNCHANGED <<dbVer, fence, covered, wpc, wver, snap, viewerVer, rfence, pageVer>>

----------------------------------------------------------------------------

Next ==
    \/ \E w \in Writers : WriterFirst(w) \/ WriterSecond(w)
    \/ \E r \in Readers :
          \/ ReadViewer(r) \/ ReadFence(r)
          \/ ReadPageFromDb(r) \/ ReadPageFromCache(r)
          \/ Store(r)

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* Properties.

\* An entry cached under fence f reflects every change that fence f (or an
\* earlier fence) announced. A stale entry under the current fence is served
\* to anonymous readers until its key changes: forever in Deepwell's Redis
\* (no TTL), up to ARTICLE_RESPONSE_CACHE_TTL_SECONDS in Framerail.
Fresh(cache) ==
    \A e \in cache : \A c \in covered : c[1] <= e.fence => e.ver >= c[2]

DeepwellCacheFresh == Fresh(dwCache)
FramerailCacheFresh == Fresh(frCache)

TypeOK ==
    /\ dbVer \in Nat /\ fence \in Nat
    /\ \A r \in Readers : Len(rsteps[r]) <= 4
=============================================================================

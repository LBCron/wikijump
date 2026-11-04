# 計算量・I/O増幅レビュー（2026-09-27）

基準: `e0e40e49d146f5d71c463f8e15fd3ddb616b0f18`（develop）。本変更は
Framerail の記事キャッシュと Redis transport にある三つの増幅を除去する。
リポジトリ全体に二次処理がなくなったという主張ではない。Theme Lab の重複領域は
既存の [PR #1983](https://github.com/Rokurolize/wikijump/pull/1983) が所有している。
そのPRの測定結果を今回の実績に含めていない。

## 入力次元

- `Q`: 処理するキャッシュ操作／Redis要求数。最大同時待機数は `Q_live`。
- `R`: キャッシュ保持件数（上限 `R_max`）。Redisの説明では `R_resp` をRESP値・配列フレームの個数に用いる。
- `B`: Redis応答の総wire bytes、`K`: 受信chunk数、`H`: 配列の最大ネスト深さ。
- `T`: theme数、`W`: browser × viewport × interactionの組合せ数、`J`: 監査JSON bytes。
- `D`: DOM node数、`S`: selector数、`C`: CSS/source bytes、`A`: asset数、`E`: dependency edge数、`P`: pixel数。

キーのhashはキー長に比例する。以下のMap lookupのexpected O(1)表記では
固定長キーを仮定し、可変長なら処理したキーbytesの項を加える。

## 1. 記事キャッシュの期限走査 — 改善済み

対象: `framerail/src/lib/server/cache/article-response/byte-limited-cache.js`、
`expiry-heap.js`。FIFOのmemory storeとLRUのhot cacheが共用する。

```text
current:
CPU O(Q R_max); 空からQ件を保持する場合 Θ(Q²)
memory O(R_max + payload bytes)

target:
CPU amortized O(Q log(R_max + 1))
有効なgetはexpected O(1)、期限切れget/deleteはO(log(R_max + 1))
memory O(R_max + payload bytes)

reason:
旧insertは期限に関係なく毎回全保持entryを訪問する。
新insertは期限min-heapの先頭のみ確認し、期限切れentryだけ削除する。
各entryは一度挿入・一度削除されるため、一括失効も全操作では償却できる。

data structure / algorithm change:
lookup用Map、FIFO/LRU用の双方向リンク、entryにheap indexを持たせた期限min-heapを併設。
上書き・明示削除・容量evictionもheapから即座に除去する。
古いdeadlineを積み続けるlazy heapにはしない。
```

一回の大量失効は依然 `O(R log R)`、全操作をworst-case O(log R)とは主張しない。
FIFO/LRU順、期限の `<=` 境界、失効の除去を容量判定より先に行う順序、
oversized replacement時の旧値削除、bytes集計、clear、時計の後退を維持した。
既存のNaN期限（期限比較が成立しない）も保持し、heapには登録しない。
追加メモリはentryごとのキー参照/index、順序リンクとheap参照 `O(R)`。
最古entryは明示したheadから取得し、Mapの新規iteratorによる削除済み領域の再走査にも依存しない。
デフォルトは1,024件の上限があり、通常運用の無制限増大を主張しているわけではない。

## 2. Redis pending queue — 改善済み

対象: `redis-request-queue.js`、`redis-command-state.js` と store/subscriber。

```text
current:
CPU: burst drain O(Q_live²)、Q回のcancel O(Q Q_live)
memory: O(Q_live)、cancelごとに新しい配列を生成

target:
CPU: enqueue/dequeue/cancel(handle) O(1)、burst drain/reset O(Q_live)
memory: O(Q_live)

reason:
Array.shiftによる残要素の移動と、filterによる全要求走査が不要になる。

data structure / algorithm change:
双方向連結FIFO。write側はenqueue時のnode handleを保持して直接除去。
resetは古いqueueを取り外してdrainし、request間の参照を解放する。
```

`shift()`というメソッド名は残るが、配列のshiftではなくheadのリンクを外すO(1)処理。
FIFO応答順、AUTH/SELECTの順序、timeoutの接続reset、write error時のrejectを維持。
遅れて到着する旧socketのwrite callbackは、捕捉した旧queueだけを操作する。
追加のnodeと前後参照が必要になる。キューは小規模時に配列より重い可能性がある。

## 3. 分割されたRedis応答 — 改善済み

対象: `redis-response-decoder.js` と store/subscriber の `handleData`。

```text
current:
CPU O(K(B + R_resp)) upper bound
buffer copy O(KB); 固定chunk幅で応答を増やすとΘ(B²/chunk_bytes)
partial arrayの既読prefixも各chunkで再decode
memory peak O(B + R_resp)、recursive stack O(H)

target:
CPU amortized O(B + R_resp + K)
buffer copy amortized O(B)、各header/payloadのdecodeは一度
memory peak O(B + R_resp + H)

reason:
旧実装は受信ごとに未完了応答の全bytesをBuffer.concatし、先頭から再parseする。
新実装はCRLF検索位置、bulk length、完成した配列要素を保持する。

data structure / algorithm change:
incremental RESP2 state machine + iterative array stack。
受信bufferを幾何拡張し、消費位置が容量の半分以上の場合だけcompactする。
移動bytesを消費/増加bytesに償却できる。未初期化領域は検索しない。
```

RESP値、UTF-8の復元、null/empty array、server error、invalid length、unsupported
response typeの処理を維持。bulk末尾等の従来の受理範囲も変更していない。
エラー時はstoreが全pendingをrejectし、subscriberはmalformed/disconnectを通知する。
既存の一括 `parseRedisResponse` APIを残し、差分テストの独立した比較対象にも使う。
任意に深い有効配列は再帰stackを消費せず処理できる。
幾何拡張の容量は未消費bytesより大きくなり得る。空になったbufferは次のappend/resetで解放する。

## 実測

再実行:

```sh
node framerail/cache-scaling-bench.ts > /tmp/cache-scaling.json
```

旧cache/parserは固定Git revisionの実ファイルを `git show` で読み込む。
queue比較は旧呼出しそのもの（Array.shift/filter）と新queueを使用する。
Node v24.21.0、共有WSLホスト、warm-up後5回の中央値、単位ms。
fixture作成は時間外、cache/queueの作成と投入は時間内。
単一プロセスのmicrobenchmarkでありHTTP latencyの測定ではない。
小さい値はJIT/GC/他プロセスの影響を受けるため、操作量も併記する。
完全なraw値は `framerail/cache-scaling-results.json`。

| 経路・規模 | n | 2n | 4n | 8n |
|---|---:|---:|---:|---:|
| cache fill旧 (`Q=2,000…16,000`) | 37.110 | 110.235 | 431.560 | 1,645.789 |
| cache fill新 | 1.068 | 1.356 | 3.747 | 4.338 |
| FIFO drain旧 (`Q=16,000…128,000`) | 1.711 | 64.606 | 312.707 | 1,393.821 |
| FIFO drain新 | 0.601 | 1.060 | 1.111 | 3.914 |
| cancel旧 (`Q=1,000…8,000`) | 6.523 | 25.685 | 100.445 | 201.531 |
| cancel新 | 0.075 | 0.084 | 0.121 | 0.216 |
| RESP array旧 (`R_resp`の葉=1,000…8,000; 64B/chunk) | 24.334 | 97.193 | 387.251 | 1,540.381 |
| RESP array新 | 0.894 | 1.451 | 1.956 | 3.569 |
| RESP bulk旧 (`B_payload=256k…2,048k`; 1,024B/chunk) | 6.814 | 19.202 | 72.996 | 311.682 |
| RESP bulk新 | 0.184 | 0.372 | 0.756 | 0.861 |
| RESP line旧 (`B_payload=16k…128k`; 64B/chunk) | 0.298 | 1.148 | 3.505 | 20.235 |
| RESP line新 | 0.138 | 0.139 | 0.204 | 0.478 |

arrayの旧実装は入力8倍で時間63倍。新実装は4.0倍。bulkは旧46倍、新4.7倍。
queue旧実装はV8のサイズ依存の最適化もあり、全域で厳密な4倍とはならない。
改善後に二次増幅がないことはデータ構造と次の作業量の両方で確認する。

| 作業量（最大規模） | before | after |
|---|---:|---:|
| cache期限entry訪問（旧loopの厳密な算術件数） | 127,992,000 | 全件走査を廃止、heap更新のみ |
| array受信bufferコピーbytes（実測） | 40,608,007 | 72,754 |
| array `Buffer.toString` 回数（実測） | 9,023,001 | 16,001 |
| bulk受信bufferコピーbytes（実測） | 2,051,072,012 | 4,144,140 |
| bulk `Buffer.toString` 回数（実測） | 2,002 | 2 |

Bufferの計測は時間計測と別passで実際のconcat/copy/copyWithin/toStringを計数する。
全サイズで改善後のコピー量がwire bytesの4倍以下であることもassertする。
arrayの16,001回は配列header1回＋各bulkのlength/payload各1回。

## CPU以外の評価

| 次元 | 本変更の影響 |
|---|---|
| memory | cache/queueの追加索引はlive件数に線形。decoderは幾何拡張の余剰容量とpartial値を保持。履歴で増える索引はない |
| disk I/O | 本変更のhot pathは旧新とも0。benchmark起動時のGit読出しと結果保存は時間外 |
| serialization/deserialization | Redis command encoding量は不変。応答の重複decodeを排除。記事JSON形式・serialize頻度は不変 |
| filesystem syscall | hot pathは旧新とも0 |
| network request | command/request数、送信bytes、購読数を変更しない。測定は合成入力なので0 request |
| browser navigation | 本変更は0。Theme Labのcase分母を減らしていない |
| process spawn | hot pathは0。benchmark準備のみGitを2回起動 |
| lock / serial section | 新規lockなし。Node event loop内のscan/shift/reparseを削減。lock保持時間の実測は対象外 |
| duplicated hash/render | hash/renderを行う経路ではない。decoderのみparse-once化 |

## 周辺レビュー・残件（今回の変更実績とは区別）

1. **Theme Lab audit** — `capture-interactive.mjs` はthemeごとのlock内で全auditを
   read/parse/merge/serialize/writeする。`J≈T W × record_bytes` とするとCPU・disk・
   serializationが `O(TJ)`、同時workerでもこの部分は直列。targetはdelta shardと
   pass終端のsnapshot mergeによる `O(J + delta_bytes)`/pass。
   #1983で扱われているため、このブランチでは変更・再計測していない。
2. **Theme Lab CSS dependency/DOM** — head-index queueとvisitedで `O(A+E)`、
   ancestorの再走査をactive clipping情報の伝播にすれば `O(DH_dom)` から `O(D)`。
   top-5だけなら全sort `O(D log D)` は不要で `O(D log 5)`。
   いずれも#1983の対象。CSS cascade等価性は同PRの受入対象で、本変更から保証しない。
3. **Theme Lab selector lookup** — `session-server.mjs` のexplicit selector経路は
   `list.map(...rules.find(...))` により `O(S_requested S_rules)`。
   targetはfirst-matchを保持したMapで `O(S_rules + S_requested)`、追加メモリ
   `O(S_rules)`。これは残件。ブラウザのselector matching自体のコストとは別である。
4. **参照cache** — `reference-cache.mjs` はmanifestをメモリに保持し、取得ごとの
   `fetchRaw` は全JSONを保存していない。ループ内の全JSON rewriteと誤認しない。
   `original_urls.includes` は同じobjectに多数URLが集中すると二次的になる余地が
   ある。URL集合索引で改善できるが、今回の測定・修正には含まない。
5. **Deepwell identities/links** — `UserService::get_public_identities` は
   BTreeSet/Mapで `O(U log U)`、最大2回のuser取得にbatch化済み。
   `link/resolver.rs` はHashMap/Setで重複参照を束ね、site/page取得もbatch化済み。
   CPUは取得row・参照bytesにexpected線形（user側はlog項）。DB実行計画を測定して
   いないため、SQLの物理I/Oまで線形と断定しない。安易な置換対象にしない。
6. **画像比較と検証分母** — `visual-diff.mjs` の比較はviewportごとに一回の
   ImageMagick起動。全pixel比較 `Ω(P)`、全case `Ω(TW)` は必要な仕事。
   起動数・navigation数を減らすためにcaseを間引く変更はしていない。

上記3・4の未測定候補、DBの実行計画、#1983のmerge/acceptanceは本変更の完了範囲外。
今回の改善はmemoizationの追加ではなく、索引・直接削除・incremental decodeへの変更。

## 正しさと受入

- seeded differential testでFIFO/LRU各20,000操作を旧full-scan意味論と比較。
  置換、容量eviction、clock変動、期限、NaN/Infinity、delete/clearを含む。
- 中間/tail cancel、既に除去したhandle、reset後の遅いwrite callbackを検証。
- RESPは全split境界と1byte分割、UTF-8、nested/null/empty、長いline/bulk/array、
  深さ20,000、複数応答、malformed後のfail-closedを検証。
- 全Framerail unit: **650/650 PASS**。production build: **PASS**。
- generated-contract consistency (`--full`): **PASS**。
- `scripts/preflight.sh --final` は既存の20ファイルのPrettier違反でlintのみ失敗。
  20ファイルすべてが基準commitとbyte-identicalであることを確認済み。
  変更ファイルのPrettier/ESLintは個別に **PASS**。
- FTML、Wikidot構文/DOM/CSS、検証scanner、oracle/provenanceを変更しない。
  ブラウザ表示変更・standing promotionをこの性能測定の証明に用いていない。

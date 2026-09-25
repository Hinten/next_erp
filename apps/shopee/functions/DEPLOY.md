# Deploying the Shopee Cloud Functions (codebase `shopee`)

These functions are a **deploy-artifact sub-build** of `@delfrance/shopee-app`
— not a pnpm workspace package. `scripts/prepare-deploy.mjs` esbuild-bundles
`src/index.ts` into a single ESM file, writes a minimal workspace-free
`package.json`, and junctions the app's `node_modules` for local trigger
analysis. Mirrors `apps/mercado-pago/functions`, with the deferred-lane sweep
from `apps/mercado-livre/functions`.

> Deploy is **manual and coordinated** — agents never run `firebase deploy`
> (root `CLAUDE.md`, Critical rules) — and never let a stray `firebase deploy`
> push rules. No config in this channel declares a `firestore`/`storage` block,
> so none of them can.

## ⚠️ Deployed to STAGING (2026-09-24); never to production

`firebase.shopee.deploy.json` shipped in step 3 (#1511). A config file deploys
nothing on its own, and the deploy itself stays a manual, coordinated human step
(root `CLAUDE.md` rule 8). A human ran it against the STAGING project on
2026-09-24, in one session of two runs: the first hit the firebase-tools bug
documented below, beside the `TASKS_INVOKER_SA` sections (**the first deploy of
a NEW queue crashes on the enqueuer binding**), and the re-run after the
per-queue enqueuer grants finished clean. All fourteen functions landed, with
the stock valve `SHOPEE_STOCK_SYNC_ENABLED` off.
**Production is a separate project and has never received this codebase.** What
master-plan **step 22 (#1530)** still owns is the production ROLLOUT:
`firebase.shopee.json` (the Firestore-only emulator config) and the second lane
job, `apphosting.yaml`'s `vpcAccess` and the real `SHOPEE_TASKS_REGION` value,
and flipping `implementado`.

Nothing here is blocked on that rollout: until the queue exists the receiver
falls back to persisting each push as `failed` and the 30-minute sweep drains it,
so pushes are not lost (see `SHOPEE_TASKS_DISABLED` in the root `.env.example`).

`tools/deploy-env/preflight.mjs` carries a `shopee` row — now wired as this
config's first `predeploy` step — and `tools/deploy-env/bundle-inlining.test.js`
builds this codebase's `build.mjs` in `CI test`, so the region really does reach
the bundle, proven before the first deploy.

## Prerequisites

- `pnpm install` at the repo root (the junction needs `apps/shopee/node_modules`).
- The App Hosting backend for `apps/shopee` created in the Firebase console.
- Env / secrets on the deployed function: `FIREBASE_PROJECT_ID` + admin creds,
  plus `SHOPEE_PARTNER_ID` and `SHOPEE_PARTNER_KEY` in Secret Manager (see
  **Secrets** below — both are `secrets:` on fourteen of the **fifteen**
  triggers: the **four queue handlers** (step 13's `processShopeePriceSync` is
  the fourth) plus the **ten** schedules. ⚠️ The exception, since step 11, is
  the Firestore trigger `onProdutoShopeeLinkChanged`, and it binds **none** of
  them, because it never calls Shopee).
- **Region match**: the App Hosting backend must enqueue onto the queue in the
  function's region. The enqueuer resolves it from
  `SHOPEE_TASKS_REGION ?? FUNCTIONS_REGION`, and there is **no default** — an
  unset value THROWS on the first enqueue rather than producing a well-formed
  path to a queue that does not exist. App Hosting / Cloud Run does NOT expose
  its own region as an env var (only the metadata server does), so it has to be
  configured: set `SHOPEE_TASKS_REGION` on the App Hosting env to whatever
  `FUNCTIONS_REGION` the deploying shell inlined into this bundle. A mismatch is
  the #1108 failure — the Admin SDK targets `us-central1`, the task is
  **silently dropped**, and the receiver still answers 204.
  ⚠️ `apps/shopee/apphosting.yaml` ships that entry with a **blank** value
  today, deliberately: blank reads as unset, so the enqueue throws and the sweep
  drains — loud and lossless — rather than aiming at a queue that is not there.
  Filling it in is part of step 22 / #1530.
- **One-time IAM** (see below) — required before the callback URL cutover
  (#1534) so the receiver can enqueue.

## Deploy

> ⚠️ **A human runs this, in a coordinated window** — never an agent, never
> unannounced (root `CLAUDE.md` rule 8). Export `TASKS_INVOKER_SA` and
> `FUNCTIONS_REGION` first (both below); the preflight refuses the deploy
> without them.
>
> ⚠️ **Into a project that does not hold these queues yet** — production's first
> deploy, or any deploy that adds a queue — read **the first deploy of a NEW
> queue crashes on the enqueuer binding** under the IAM section below FIRST.
> On firebase-tools 15.28.2 that deploy reports an error for every queue function,
> with a misleading organization-policy message, and the fix is one `gcloud`
> grant per queue per identity plus a re-run.

```bash
# from the repo root
firebase deploy --only functions:shopee \
  --config firebase.shopee.deploy.json \
  --project <project-id>
```

The `predeploy` hook runs `node tools/deploy-env/preflight.mjs shopee` and then
`node apps/shopee/functions/scripts/prepare-deploy.mjs`. To inspect the bundle
locally without deploying: `node apps/shopee/functions/build.mjs` (writes
`dist/index.js`), or `node apps/shopee/functions/scripts/prepare-deploy.mjs` for
the full servable folder at `.deploy/shopee-functions`. Both need
`FUNCTIONS_REGION` set — `requireBuildRegion` throws without it, on purpose.

⚠️ **The inline proof.** **Three** handlers reach this bundle through a
**dynamic** `import()` in `lib/shopee/notificacoes/notificacao.ts` — lazily, so
the App Hosting receiver's own bundle never carries the pedido tree or the
publish tree. The functions bundle is the half that must carry them, and the
bundler inlining them is not something any test asserts. Check it after a build:

```bash
FUNCTIONS_REGION=us-east1 node apps/shopee/functions/scripts/prepare-deploy.mjs
for n in importarPedidoShopee rastrearPedidoShopee tratarPushDeAnuncio \
         onProdutoShopeeLinkChanged; do
  grep -q "$n" .deploy/shopee-functions/index.js || echo "AUSENTE $n"
done
grep -q '"default"' .deploy/shopee-functions/index.js || echo 'AUSENTE database id'
```

Silence is the pass: every name is in the bundle. An `AUSENTE <nome>` line says
the dispatched function would park (step 5), never reach the shipment merge
(step 7) or never reach the listing-lifecycle handler (step 11) instead of
running it — green everywhere else, because nothing but this check looks.
`onProdutoShopeeLinkChanged` is not a dynamic import but an EXPORT, so its
absence would mean the trigger was not deployed at all.

⚠️ **The last line is a SMOKE CHECK, not the guard.** The thing that really
pins the inlined Firestore database id is `src/index.test.ts`'s exact-equality
assertion on the trigger's `eventFilters.database` (plus a source assertion over
`build.mjs`, because unbundled `process.env.FIREBASE_DATABASE_ID ?? 'default'`
answers `'default'` whether the build inlined anything or not — the runtime test
cannot see that mutation). The bundle `grep` only tells you the literal survived
esbuild; it cannot tell you it landed on the trigger.

⚠️ **One check PER NAME, never a combined `grep -c -e A -e B`.** That form prints
one SUM, so a bundle carrying only `importarPedidoShopee` still prints a non-zero
number and exits 0 — it reports green over exactly the step-7 regression this
block exists to catch. Only `grep -q` per name has a per-name exit status.

⚠️ **Step 12 adds NO name to that loop, and neither does step 13 — the
omission is deliberate.** `sendShopeeStock`, `sweepShopeeStock`,
`sweepShopeeStockDaily`, `sweepShopeeStockReconciliacao` and step 13's
`processShopeePriceSync` are **static exports** of `src/index.ts`, not
dynamic `import()`s, so esbuild cannot silently drop them the way it could drop
a lazily-imported handler: an absent one is a missing EXPORT, which
`src/index.test.ts`'s three maps (`FILAS` is 4, `AGENDAMENTOS` is 10,
`GATILHOS` is 1) already fail on. Adding them here would suggest the loop is a
completeness check when it is a dynamic-import smoke check.

## Functions in this codebase

| Export                           | Trigger                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processShopeeNotification`      | `onTaskDispatched` (Cloud Tasks queue) | #1511 / #1513 — process one queued Shopee push: dispatch on the **push code**, run the conta arms (1 / 2 / 12) and, since step 5, the **order import** on code 3 (`get_order_detail` + `get_escrow_detail` → one pedido transaction; an unmapped shop DEFERS, a reauth/credential/daily-quota failure defers, a provider/schema/write failure parks); park a code whose handler is not built yet. Rate-limited + retry-with-backoff; `timeoutSeconds 300` (two Shopee calls + per-line queries + the transaction; 3 × 300 s + backoff stays inside the hot sweep's hour); the receiver enqueues and answers 204. Persists to `notificacoesShopee` only on retry-exhaustion / park / defer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `processShopeeMassImport`        | `onTaskDispatched` (Cloud Tasks queue) | #1517 / master-plan step 9 — the RESUMABLE MASS PRODUCT IMPORT: one dispatch of an `importacoesShopee` job. Scans one `get_item_list` page when both queues are empty (the server's `next_offset`, never a computed one), drains up to ten listings per dispatch through the step-9 importer (one batched `get_item_base_info`, one `get_model_list` per has-model item), checkpoints the job document after EVERY item and then re-enqueues ITSELF for the next slice. `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }` — ONE dispatch at a time, deliberately, because Shopee's rate limit is per app and a second worker would only spend the same quota twice; `timeoutSeconds 300` with a 3-attempt ladder (30 s → 300 s, ×2), so the whole ladder closes at 1500 s, inside Cloud Tasks' 1800 s. A burst rate limit is a PAUSE, not a failure: the drain stops, the job checkpoints and re-enqueues with `scheduleDelaySeconds`. A daily quota, a reauth/credential/config refusal and the Tasks valve stamp the job `failed` on the FIRST attempt. Enqueued by the `/importar-todos` route (App Hosting runtime SA) **and by itself** (functions runtime SA) — two identities, see the IAM section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sendShopeeStock`                | `onTaskDispatched` (Cloud Tasks queue) | #1520 / master-plan step 12 — the STOCK PUSH, and the channel's THIRD queue: one dispatch is ONE `update_stock` for ONE listing, carrying up to 50 of its models with a per-model `success_list`/`failure_list`. `timeoutSeconds 120` with a 3-attempt ladder (30 s → 300 s, ×2), so the whole ladder closes at 960 s, inside Cloud Tasks' 1800 s. `rateLimits { maxConcurrentDispatches, maxDispatchesPerSecond }` are read from `SHOPEE_STOCK_CONCURRENT_DISPATCHES` / `SHOPEE_STOCK_DISPATCHES_PER_SECOND` **in the deploying shell**, defaulting to **2/2** — see the deploy-shell knobs below. Binds both secrets; **no per-function `region:`**. ⚠️ **It ENQUEUES ITSELF**, twice over: a burst rate limit becomes a delayed re-enqueue that consumes no attempt, and the conta-pause rung re-enqueues for `pausadoAte` — so the functions runtime SA is an enqueuer on this queue, exactly like the mass import. ⚠️ **The export name IS the queue name** (`SHOPEE_STOCK_SEND_QUEUE = 'sendShopeeStock'`); `src/index.ts` carries a third rename-safety `if` whose one static literal names **`functions/src/sendStock.ts`** — the file holding the export to rename — and which compares against `SHOPEE_STOCK_SEND_QUEUE`, declared in **`lib/shopee/estoque/constantesEstoque.ts`** (`shopeeStockTasks.ts` only imports it). Its own `if` rather than a loop, because the message must name its own file in one static literal. ⚠️ It **never** sets `ignoreSyncFlag` (pinned twice, on the built deps object and on the comment-stripped source): with `SHOPEE_STOCK_SYNC_ENABLED` unset the handler answers `pulado` at step 0.5 and reads NOTHING. **Resolving is success to the queue** — every outcome, `descartado` and `erro-registrado` included; only a throw asks for a retry, so do not wrap the body in a try/catch that logs and returns. |
| `processShopeePriceSync`         | `onTaskDispatched` (Cloud Tasks queue) | #1521 / master-plan step 13 — the ACCOUNT-WIDE PRICE JOB, and the channel's FOURTH queue: one dispatch of an `enviosPrecoShopee` job either PLANS one page of anchors into its `fila` as identities (`SHOPEE_PRICE_PAGE_LIMIT`, default 25) or DRAINS up to `SHOPEE_PRICE_ITEMS_PER_DISPATCH` listings (default 10, also the ceiling) — each priced at DRAIN time, sent as ONE `update_price` and checkpointed with its report rows in ONE batch — and then re-enqueues ITSELF. `timeoutSeconds 300` with a 3-attempt ladder (30 s → 300 s, ×2), so the whole ladder closes at 1500 s, inside Cloud Tasks' 1800 s; `maxAttempts` IS `ENVIO_PRECO_MAX_TENTATIVAS`, which the job reads to know its LAST attempt. `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }` **LITERAL** — the job document is the checkpoint, so two concurrent dispatches would race it — hence no deploy-shell knob and no preflight row. A burst is a delayed self re-enqueue that consumes no attempt; the daily quota PARKS the job until 00:00 UTC+8. Binds both secrets, and needs them even on a plan-only dispatch, because the conta context it loads first reads the partner configuration; **no per-function `region:`**. ⚠️ **The export name IS the queue name** (`SHOPEE_PRICE_SYNC_QUEUE`, declared in **`lib/shopee/precos/constantesPreco.ts`**); `src/index.ts` carries a FOURTH rename-safety `if` whose one static literal names **`functions/src/processPriceSync.ts`**. No valve of its own: every job is an operator's start, and the `/atualizar-precos` route refuses with 503 BEFORE creating one while `SHOPEE_TASKS_DISABLED` is set. Enqueued by that route (App Hosting runtime SA) **and by itself** (functions runtime SA) — two identities, see the IAM section.                                                                    |
| `reprocessShopeeNotifications`   | `onSchedule('every 30 minutes')`       | #1511 — the backstop, draining BOTH lanes on one tick: `failed` pushes older than 1 h (hot) and pushes whose `shop_id` matches no active integração (deferred, 24 h window). Logged separately — summing them would hide a growing deferred backlog inside a healthy `processed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sweepShopeeAuthorizationExpiry` | `onSchedule('0 4 * * 1')`              | #1511 / master-plan P8 — the WEEKLY authorization-expiry sweep. Walks `get_shops_by_partner` (PUBLIC-signed, reads no token anywhere) and raises the `shopeeAutorizacaoExpirando` aviso at ≤ 30 days, resolving it once a re-consent pushes the clock back out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sweepShopeeLostPushes`          | `onSchedule('20 */2 * * *')`           | #1512 — the LOST-PUSH sweep. Reads `get_lost_push_message` (PUBLIC-signed; the earliest 100 lost within 3 days and not confirmed), re-parses each entry's `data` string into the receiver's payload, **enqueues every entry onto `processShopeeNotification` first**, and only then acks the page with `confirm_consumed_lost_push_message`. Paging is cursor-by-ACK, so one undurable entry blocks every later one for 3 days — hence the ordering, and hence "never confirm an empty page". `timeoutSeconds 540`; binds both secrets; **ENQUEUES** (see the IAM note). `SHOPEE_LOST_PUSH_CONFIRM_DISABLED=1` skips only the confirm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `monitorShopeePushConfig`        | `onSchedule('45 5 * * *')`             | #1512 — the DAILY push-health monitor. One PUBLIC GET of `get_app_push_config`; folds `live_push_status` and raises `shopeePushDegradado` (Warning, `atencao`) or `shopeePushSuspenso` (Suspended, **`critico`** — a suspension loses everything not already in the lost-push queue), resolving both on `Normal`. Also logs three divergences no aviso tipo covers: a `callback_url` that is not ours byte for byte, our push codes present in `push_config_off_list`, and a non-empty `blocked_shop_id`. `timeoutSeconds 120` — deliberately NOT 540: one call, so a longer budget would only hide a hang. It never calls `set_app_push_config`; the package exposes no such operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sweepShopeeEscrowSettlement`    | `onSchedule('10 5 * * 1')`             | #1514 — the WEEKLY SETTLEMENT SWEEP, and the only thing in this channel that ever learns what the marketplace actually PAID. Shopee ships no payment push, and `escrow_release_time` is exposed by exactly ONE endpoint (`get_escrow_list`), so the final figure cannot arrive by event. Per active conta it pages that listing over a release-time window from a durable MILLISECOND cursor (`liquidacaoShopee/{integracaoId}`), re-reads each row's escrow and stamps the top-level `pagamento.liquidacao`; a row whose pagamento does not exist yet is parked and re-driven with a synthetic code 3, capped at 50 per tick. Mondays 05:10 America/Sao_Paulo, `timeoutSeconds 540`; binds both secrets; **ENQUEUES**. ⚠️ It ships **ON, with no `*_ENABLED` flag** — deliberately, unlike the backfill: a backstop that ships off is #778's failure, and the fan-out is bounded on every axis (300 settlements, 50 synthetic pushes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sweepShopeeStuckReservations`   | `onSchedule('40 4 * * 1')`             | #1516 — the WEEKLY STUCK-RESERVATION SWEEP: the backstop BEHIND the other three, and the only one reaching past the 3-day lost-push window. Walks pedidos still holding a stock reservation in `aguardandoConfirmacaoDePagamento` past `MAX_IDADE_D` (paged, ≤ 2 000 documents scanned), reads `get_order_detail` in batches of 50 with a three-token optional-field allow-list, **ENQUEUES** a synthetic code 3 (`origem: 'reserva-travada'`) for an order that MOVED, and raises a `pedidoPrecisaDecisao` aviso for the residual — an order Shopee still reports `UNPAID`/`PENDING`, no longer knows, or holds in `TO_RETURN` — with the machine resolver that tipo has owed since it was declared. ⚠️ **It never writes the pedido and runs no transaction**, so `pedido.estado` keeps ONE writer, step 5. Mondays 04:40 America/Sao_Paulo, `timeoutSeconds 540`; binds both secrets. **DOUBLY GATED and it SHIPS OFF**: `SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED=1` is the master flag (off ⇒ the tick reads nothing at all) and `SHOPEE_PEDIDO_TRAVADO_DRY_RUN=1` is the report-only rehearsal that is the load-bearing artefact of the step — see "Runtime env" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `backfillShopeeOrders`           | `onSchedule('every 15 minutes')`       | #1512 — the ORDER BACKFILL: pages `get_order_list` by `update_time` per active conta from its durable cursor and enqueues one SYNTHETIC code-3 notification per `order_sn`, i.e. the same import path a real push takes. The only way to reach `PENDING` / `RETRY_SHIP` / `TO_CONFIRM_RECEIVE` / `TO_RETURN` orders, which the status filter cannot list, and the only documented recovery from a suspended subscription. **No-op until `SHOPEE_ORDER_BACKFILL_ENABLED=1`** (see "Runtime env" below) — since step 5 that flag is the ONLY gate, and every synthesized code 3 runs the order import. `timeoutSeconds 540`; binds both secrets; **ENQUEUES**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sweepShopeeStock`               | `onSchedule('10,25,40,55 * * * *')`    | #1520 — the INCREMENTAL stock tier, four times an hour. Per active conta: the conta gates (three read caches), then the discovery pipeline paged from a durable cursor, the ledger pre-pass memoised once per TICK, the planner, and one task per listing onto `sendShopeeStock`. Window: no cursor ⇒ `now − SHOPEE_STOCK_INCREMENTAL_WINDOW_MIN − overlap`; a cursor ⇒ `max(cursor, now − SHOPEE_STOCK_CURSOR_MAX_LOOKBACK_H) − overlap`. ⚠️ **It skips its own 02:10 and day-1 03:10 slots IN CODE** — a cron cannot express the exclusion, so the wrapper asks `ehSlotDoDiario` / `ehSlotDaReconciliacao` before it starts, off the tick’s ONE clock read. `America/Sao_Paulo`, `timeoutSeconds 540`, both secrets, no `region:`; **ENQUEUES**. Gated by `SHOPEE_STOCK_SYNC_ENABLED` — off ⇒ one log line and zero reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sweepShopeeStockDaily`          | `onSchedule('10 2 * * *')`             | #1520 — the DAILY tier, 02:10 America/Sao_Paulo. The same walk over a 24 h window, so a listing that is high on BOTH sides of a movement (`min(anterior, atual)` above `SHOPEE_STOCK_LIMIAR_ALTO`) still gets one pass a day even though the incremental tier deliberately skipped it. ⚠️ Its window carries **no overlap**, unlike the incremental one — the frozen seam, and the residual is a cron-jitter sliver the quarter-hourly tier re-covers. `timeoutSeconds 540`, both secrets, no `region:`; **ENQUEUES**; same single valve.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sweepShopeeStockReconciliacao`  | `onSchedule('10 3 1 * *')`             | #1520 — the MONTHLY FORCE-SEND, 03:10 on day 1. `changedSinceMs: -1` and no ledger pre-pass: every live listing of every active conta is re-sent at the number the ERP holds now. ⚠️ **It ships ON with no flag of its own** — announcement 1445 says Shopee returns stock by itself when an order is cancelled, which makes keeping the number right an obligation rather than an optimisation, and a backstop that ships off is #778’s failure. It is still under the ONE master valve, and its blast radius is bounded by `SHOPEE_STOCK_MAX_TASKS_PER_SWEEP` (2 000): a tick that hits the cap writes a `truncada` carimbo and the NEXT tick resumes from it. `timeoutSeconds 540`, both secrets, no `region:`; **ENQUEUES**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `onProdutoShopeeLinkChanged`     | `onDocumentWritten` (Firestore)        | #1519 / master-plan step 11 — the codebase's **FIRST Firestore trigger** and the TENTH: `onDocumentWritten` on `produtos/{produtoId}/prodshopee/{linkId}`, the only one here that never calls Shopee. It maintains `produtos.integracoesComProduto`, so `/produtos` can badge a Shopee-linked produto. ⚠️ **Zero reads and zero writes on the overwhelming majority of invocations**: `planejarMudancaDeLinkShopee` is pure and answers "nothing moved" for a status-only merge, so the handler never even opens a Firestore handle — a test pins that path. When affiliation DOES move it adds the conta with `arrayUnion`, or re-derives orphanhood by reading the produto's WHOLE `prodshopee` subcollection (no `where`, so **no new composite index**) and removes with `arrayRemove`. `database` is the LITERAL name **`default`**, inlined at build time from `FIREBASE_DATABASE_ID` — never the `(default)` sentinel, which fails every op `5 NOT_FOUND`. `retry: true`, safe because the add is an `arrayUnion` and the remove re-derives inside its own read set. **No secrets**, and it **does not enqueue**, so it needs no Cloud Tasks IAM at all. No per-function `region:`: it inherits `setGlobalOptions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Secrets: `SHOPEE_PARTNER_ID` + `SHOPEE_PARTNER_KEY`

Both are declared as `secrets:` on **all four queue handlers** and on **every
one of the ten schedules** — fourteen of the fifteen triggers, the exception
being step 11's
Firestore trigger, which binds neither because it makes no Shopee call at all
(`src/index.test.ts` asserts that absence, so a secret drifting onto it reds CI)
— because all of them can reach a PUBLIC-signed Shopee call
(`shopeeConfig()` → `createShopeePartnerClient`) — and the order backfill needs
them for its Shop-signed calls too, since the access token rides in the query
while the HMAC is always partner-keyed. Without the bindings none of them fails
at startup:
`ShopeeConfigError` is raised on the first call, the pipeline treats it as
transient, and the symptom is retries and parked documents rather than anything
that names the missing secret. Grant them before the first real push.

`reprocessShopeeNotifications` carries them too — a re-drive runs the same conta
arms as the original delivery. `src/index.test.ts` asserts the EXACT set on
every schedule (a third name that drifts in deploys fine and then 403s the
function at startup) and, since step 4, that no exported schedule escapes that
loop at all.

### Durability & the residual loss window

A push is durable once it is either (a) processed, or (b) persisted as `failed`
for the sweep. Two narrow windows remain:

- The task handler persists a `failed` doc only on its **final** attempt. If
  Firestore is unavailable for that whole retry window (a _correlated_ outage —
  the same Firestore the handler reads and writes), the final persist also
  fails. It logs and re-throws so the failed final attempt shows in Cloud Tasks'
  error metrics, but the push is lost and Shopee already got its 204.
- Shopee's own retry ladder (+5 min / +30 min / +3 h) ends in the **lost-push
  queue**, which `get_lost_push_message` can replay for 3 days —
  `sweepShopeeLostPushes` (step 4) is that replay, so a push that fails every
  one of Shopee's retries AND our persist now comes back on the next 2-hourly
  tick. What is left is what the queue itself drops: an entry unconfirmed for
  more than 3 days expires, and a SUSPENDED subscription is never queued at all
  ("you will not receive Push Mechanism notifications missed during the period
  where your subscription was disabled"). `backfillShopeeOrders` is the only
  recovery for the second case, and it is flag-gated — see "Runtime env".

⚠️ A sustained non-2xx rate is worse than a lost push: >600 pushes / 6 h with
<30 % success **auto-disables the subscription**, and a disabled subscription
loses everything not already in the lost-push queue. That is why the receiver
answers 204 on every path it can and never converts an enqueue failure into a
5xx.

## Runtime env (step 4's two valves + step 8's three + step 12's ten + step 13's two)

None of them is a secret and none belongs in Secret Manager: they are operator
switches read with `process.env.X === '1'` at the use site (the exceptions are
step 8's horizon and step 12's nine tunables, which are numbers), exactly like
`SHOPEE_SANDBOX` and `SHOPEE_TASKS_DISABLED`. Step 4's and step 8's are read
**only by this
nested Cloud Functions codebase**, never by Next — the App Hosting backend hosts
the receiver, which acks and enqueues without ever reaching a sweep — so a value
set in `apphosting.yaml` or the console would be read by nothing and fail
silently. The root `.env.example` names them all anyway, so the one file
operators consult lists every var the channel reads; their real home is here.

⚠️ **Step 12 breaks the "only this codebase" half in FOUR places, and a value
put in the wrong home is silently ignored rather than refused.** Most of its
knobs follow the rule above, but:

- **`SHOPEE_STOCK_CONCURRENT_DISPATCHES` and `SHOPEE_STOCK_DISPATCHES_PER_SECOND`
  are read in the DEPLOYING SHELL**, not at runtime — firebase-tools bakes
  `sendShopeeStock`'s `rateLimits` into the queue during local trigger analysis.
  See the deploy-shell knobs below.
- **`SHOPEE_STOCK_CONCURRENT_DISPATCHES` is read in TWO homes**: the deploy
  shell (the queue's ceiling) **and** the App Hosting console, where it also
  caps the manual push's in-process concurrency
  (`Math.max(1, Math.min(manualConcurrencyRaw(), concurrentDispatches()))`,
  `concorrenciaEnvioManual` in `apps/shopee/lib/shopee/estoque/enviarEstoqueManual.ts`).
  Keep the two values in step or the button and the queue disagree about the
  same number.
- ⚠️⚠️ **`SHOPEE_STOCK_KIT_INCLUI_PROPRIO`, `SHOPEE_STOCK_RATE_PAUSE_MIN` and
  `SHOPEE_STOCK_PROMOCAO_RETRY_MIN` are read in TWO homes as well** — here and
  in the App Hosting console — because the manual push runs the REAL send
  handler in the Next process (`enviarEstoqueManual.ts` defaults `enviarTarefa`
  to `processShopeeStockSendTask`) and the route, the button and the CLI compute
  their quantities with the same `quantidadesDaFamiliaShopee` the sweep uses.
  The first of the three is the one that matters most: it changes the QUANTITY
  that reaches Shopee, so setting it only in `.env.deploy` (the template below
  offers it, commented) makes the unattended sweep and the operator's button
  send DIFFERENT numbers for the same produto, each `update_stock` overwriting
  the other with no signal anywhere. Set it in both homes or in neither.
  ⚠️ It moves the SYNC only — the sweeps and the manual push — and never the
  create-time `seller_stock`: the publish route runs on the same App Hosting
  backend, and `opcoesPublicacaoShopee` pins the knob off there whatever either
  home says.
- **`SHOPEE_STOCK_MANUAL_DEADLINE_MS` and `SHOPEE_STOCK_MANUAL_CONCURRENCY`
  belong to App Hosting**, not here: the manual push runs in the Next process.
  `apps/shopee/apphosting.yaml`'s header documents them and
  `runConfig.timeoutSeconds: 180` deliberately sits ABOVE the deadline, so what
  normally ends a long request is the deadline and not the platform. ⚠️ That
  guarantee is per LISTING, not per request: the budget is checked between
  listings, never during one, and the transport sets no fetch timeout, so a call
  that hangs inside a listing already started is bounded only by the platform's
  180 s — which ends the request with no envelope at all.

**Step 13's two follow the rule** — both are read only by
`processShopeePriceSync`:

- **`SHOPEE_PRICE_PAGE_LIMIT`** — anchors the price job PLANS per dispatch,
  default 25, clamped to [1, 50].
- **`SHOPEE_PRICE_ITEMS_PER_DISPATCH`** — listings it SENDS per dispatch,
  default 10, clamped to [1, 10]. ⚠️ The default IS the ceiling, and the
  ceiling is the timeout budget: ≈ 20 s per listing at worst is ≈ 200 s of the
  queue's 300 s, so no value the knob accepts can outrun it. The knob only goes
  DOWN; raising the ceiling is a code change on a MEASURED per-listing time,
  never an env change.

What step 13 deliberately does NOT add: a valve (every price job is an
operator's start through `/atualizar-precos`, and that route already refuses
with 503 while `SHOPEE_TASKS_DISABLED` is set), a pause knob (the burst pause
REUSES `SHOPEE_STOCK_RATE_PAUSE_MIN` — one limiter, one number — so that
knob's value now paces the price job too), and a deploy-shell knob (the price
queue's `rateLimits` are a literal 1/1). The manual price push's
`SHOPEE_PRICE_MANUAL_DEADLINE_MS` / `SHOPEE_PRICE_MANUAL_CONCURRENCY` belong
to App Hosting, exactly like step 12's manual twins above.

firebase-tools' documented lane for gen2 runtime env vars is a `.env` /
`.env.<project-id>` file in the functions **source** directory. Here that
directory is the generated `.deploy/shopee-functions`, and
`scripts/prepare-deploy.mjs` opens with
`rmSync(deployDir, { recursive: true, force: true })` — it **wipes and
regenerates the whole folder** as the `predeploy` hook, i.e. after you would
have dropped a file in it and before firebase reads the source. So a hand-placed
`.env` **there** does not survive, and there is no `--no-predeploy` escape
hatch.

Instead, put it in the **package** directory and let the hook carry it across
the wipe. Create `apps/shopee/functions/.env.deploy` (gitignored):

```bash
# The ORDER BACKFILL (#1512). SHIPS OFF; only the literal `1` enables it. While
# off, backfillShopeeOrders deploys, ticks, logs one info line and reads
# nothing — not Firestore, not Shopee.
# ⚠️ **Leave it COMMENTED OUT.** This USED to be the weaker of two gates — the
# sweep also refused while push code 3 had no handler — and step 5 flipped that
# (`DISPATCH[3] = 'pedido'`). Since then, uncommenting this line IS the switch
# that starts live order imports: the first enabled tick enqueues one task per
# order in the cursor window (up to 1 000 per conta), and each one writes a
# pedido plus its clientes/enderecos/incidentes. That makes it a
# migration-window decision (#1208 / root CLAUDE.md rule 8), never part of a
# first deploy — same shape as the lost-push valve below, and for a bigger
# reason.
# SHOPEE_ORDER_BACKFILL_ENABLED=1
# The LOST-PUSH CONFIRM valve (#1512) — leave it COMMENTED OUT except for the
# one rehearsal it exists for. `1` makes sweepShopeeLostPushes read, parse and
# enqueue as usual but SKIP `confirm_consumed_lost_push_message`, so the first
# production tick proves the whole path without sending an irreversible ack
# (the sandbox cannot exercise these APIs at all). It is opt-in-to-DISABLE, so
# an unset or blank value can never leave the sweep inert. While it is on the
# tick stops after the first page — the queue did not advance, and the next
# read would return the same entries.
# SHOPEE_LOST_PUSH_CONFIRM_DISABLED=1
# The STUCK-RESERVATION SWEEP (step 8, #1516). SHIPS OFF; only the literal `1`
# enables it. While off, sweepShopeeStuckReservations deploys, ticks, logs one
# info line naming this variable and reads NOTHING — not Firestore, not Shopee.
# ⚠️ **Leave it COMMENTED OUT until the rehearsal has been read.** Uncommenting
# it lets the tick enqueue synthetic code-3 re-drives (each one a real step-5
# import) and write real `avisos` documents. It never writes a pedido — the
# sweep has no writer for one and runs no transaction — but it is still a
# migration-window decision (#1208 / root CLAUDE.md rule 8), and the intended
# order is: run the DRY RUN below for a few weeks, read veredictos.ainda-nao-pago
# against the statusPorIdade cross-tab, and only then flip this.
# SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED=1
# The step-8 REHEARSAL. `1` makes the tick query, gate, READ Shopee and classify
# exactly as a live run would and skip exactly two effects — the enqueue and the
# aviso writes/resolves. It is not a formality: no page of Shopee's documentation
# says whether an unpaid BR order is ever auto-cancelled, and the sandbox cannot
# produce an aged unpaid one, so this log's marketplace.status x age cross-tab
# beside the live per-verdict counts is the ONLY instrument for that question.
# ⚠️ Both flags are read BEFORE the early return, so a tick with the master flag
# off still reports `dryRun` honestly.
# SHOPEE_PEDIDO_TRAVADO_DRY_RUN=1
# How long a pedido may sit in aguardandoConfirmacaoDePagamento before the sweep
# examines it. Unset or unreadable falls back to 7.
# ⚠️ The EFFECTIVE age is 7-14 days: the schedule is weekly, so a pedido that
# goes stale just after a tick waits for the next one. Do not document "7" as a
# promise.
# SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D=7
# ---- The STOCK SYNC (step 12, #1520). Every line below is COMMENTED OUT. ----
# ⚠️ THE MASTER VALVE, and it is the switch that starts WRITING TO A LIVE
# MARKETPLACE. Unset or blank = off, and while off the three stock sweeps and
# the sendShopeeStock queue deploy, tick, log one line and read NOTHING — not
# Firestore, not Shopee. Turning it on is a runtime env change for the
# migration window (#1208 / root CLAUDE.md rule 8), never part of a first
# deploy. ⚠️ It does NOT gate the MANUAL push (the route and the
# `enviar:estoque` CLI), which passes `ignoreSyncFlag: true` on purpose: the
# operator asked explicitly, and the button has to work before the automatic
# sync is switched on.
# SHOPEE_STOCK_SYNC_ENABLED=1
# The incremental window, in minutes, used when a conta has no cursor yet.
# SHOPEE_STOCK_INCREMENTAL_WINDOW_MIN=15
# Subtracted from the incremental window's lower bound, in seconds, to cover
# cron jitter. ⚠️ The DAILY window deliberately carries no overlap.
# SHOPEE_STOCK_WINDOW_OVERLAP_SEC=20
# How far back a stored cursor may reach, in hours, before the tier clamps it.
# SHOPEE_STOCK_CURSOR_MAX_LOOKBACK_H=24
# The daily tier's window, in hours.
# SHOPEE_STOCK_DAILY_WINDOW_H=24
# A listing high on BOTH sides of a movement — min(anterior, atual) above this
# — waits for the daily pass instead of riding every quarter-hour tick.
# SHOPEE_STOCK_LIMIAR_ALTO=100
# Anchor produtos read per discovery page.
# SHOPEE_STOCK_ANCHOR_PAGE_LIMIT=250
# The per-tick blast radius, and the monthly reconciliação's only bound: it
# force-sends EVERY live listing (announcement 1445 — Shopee returns stock by
# itself on a cancellation, so keeping the number right is an obligation), and
# a tick that hits this cap stamps `truncada` for the next one to resume from.
# SHOPEE_STOCK_MAX_TASKS_PER_SWEEP=2000
# The BURST pause, in minutes, for when Shopee sends no Retry-After. The DAILY
# quota uses the 00:00 UTC+8 rollover instead, which is pure arithmetic and has
# no knob.
# SHOPEE_STOCK_RATE_PAUSE_MIN=5
# How many times one task may re-enqueue itself for a pause before it is
# dropped as `pausa-reenqueues-esgotados`.
# SHOPEE_STOCK_MAX_PAUSE_REENQUEUES=10
# How long a listing locked by a promotion stays skipped before it is retried,
# in minutes. A promotion ending moves no `item_status`, so this skip is a
# CLOCK, not a state fingerprint.
# SHOPEE_STOCK_PROMOCAO_RETRY_MIN=60
# Adds the kit's OWN stock to the minimum over its components. Off = the same
# arithmetic publishing has always used. It moves the SYNC only (the sweeps and
# the manual push), never the create-time seller_stock: publishing pins it off
# (`opcoesPublicacaoShopee`).
# ⚠️ Read on BOTH surfaces: set the SAME value in the App Hosting console, or
# the sweep and the manual button send different quantities for one produto.
# SHOPEE_STOCK_KIT_INCLUI_PROPRIO=1
# ⚠️ THESE TWO ARE READ IN THE DEPLOYING SHELL, not at runtime — putting them
# here does nothing. firebase-tools bakes sendShopeeStock's rateLimits during
# trigger analysis. Source of truth: envInt() in
# apps/shopee/lib/shopee/estoque/constantesEstoque.ts, drift-checked by
# tools/deploy-env/preflight.mjs. Listed here only so a reader looking for them
# finds the pointer.
# SHOPEE_STOCK_CONCURRENT_DISPATCHES=2
# SHOPEE_STOCK_DISPATCHES_PER_SECOND=2
# ⚠️ AND THESE TWO BELONG TO APP HOSTING (the manual push runs in Next), not to
# this codebase. Same reason: listed for the pointer only.
# SHOPEE_STOCK_MANUAL_DEADLINE_MS=120000
# SHOPEE_STOCK_MANUAL_CONCURRENCY=2
# ---- The PRICE JOB (step 13, #1521). Commented out = the defaults below. ----
# No master valve: every job is an operator's start through /atualizar-precos,
# and SHOPEE_TASKS_DISABLED already makes that route refuse with 503.
# Anchors the job PLANS per dispatch, clamped to [1, 50].
# SHOPEE_PRICE_PAGE_LIMIT=25
# Listings the job SENDS per dispatch, clamped to [1, 10]. ⚠️ The default IS
# the ceiling (≈ 20 s per listing at worst, ≈ 200 s of the queue's 300 s): the
# knob only goes DOWN, and raising the ceiling is a code change, never an env one.
# SHOPEE_PRICE_ITEMS_PER_DISPATCH=10
# ⚠️ AND THESE TWO BELONG TO APP HOSTING (the manual price push runs in Next).
# Listed for the pointer only.
# SHOPEE_PRICE_MANUAL_DEADLINE_MS=120000
# SHOPEE_PRICE_MANUAL_CONCURRENCY=2
```

⚠️ The scheduled function is deployed either way — a flag only decides whether a
firing does any work. Flipping one is therefore a redeploy, not a code change.

`prepare-deploy.mjs` copies the file into the artifact **as `.env`** after the
wipe, and firebase-tools applies it at deploy. It survives redeploys — no
`gcloud run services update` to re-apply, and no Secret Manager entry for a
non-secret tunable.

**Per-project targeting.** `.env.deploy` applies to whatever project you deploy
to, so a staging file deployed to produção takes its values with it. For values
that belong to ONE project, name the file `.env.deploy.<project-id>`: it lands
as `.env.<project-id>`, which firebase-tools applies only for that `--project`.
Both can coexist; firebase-tools layers the project-specific file over `.env`.

⚠️ The allowlist is anchored and shared by all five `prepare-deploy.mjs` scripts
(`tools/deploy-env/env-files.mjs`). Exactly two source names are copied —
`.env.deploy` and `.env.deploy.<project-id>`. A **`.env.secrets*` fails the
hook**, and so does a bare `.env` (with a rename instruction): everything that
reaches the artifact is uploaded to the project's `gcf-sources-*` bucket and
baked in plaintext into the Cloud Run revision, so real secrets stay in Secret
Manager (`firebase functions:secrets:set` + the `secrets: [...]` option, which
is how `SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY` travel).

## ⚠️ One-time IAM — the App Hosting backend enqueues Cloud Tasks

⚠️ **Nothing below applies to step 11's Firestore trigger, and adding it here
would do HARM.** A Firestore trigger is invoked by **Eventarc**, not by a Cloud
Tasks enqueuer, so `onProdutoShopeeLinkChanged` needs no
`roles/cloudtasks.enqueuer`, no `roles/iam.serviceAccountUser` and no
per-service `roles/run.invoker` — it declares no `invoker` at all. And
`TASKS_INVOKER_SA` is **AUTHORITATIVE**: a deploy REPLACES the member list it
names, so adding a principal "for the trigger" would DISPLACE one that matters
and break the queue leg instead. Grant the roles below for the **queue**
functions only.

The receiver route (`/api/webhooks/shopee`, on the App Hosting backend) enqueues
onto the `processShopeeNotification` queue via `firebase-admin`'s
`getFunctions().taskQueue(...).enqueue(...)`, since step 9 the
`/api/marketplace/shopee/importar-todos` route enqueues onto
`processShopeeMassImport` the same way, and since step 13 the
`/api/marketplace/shopee/atualizar-precos` route onto `processShopeePriceSync`.
That requires the **App Hosting
runtime service account** to be able to enqueue tasks and act as the functions'
invoker SA — grant these **once**, before switching the push callback URL
(#1534). ⚠️ Since step 13 there are **four queue functions**
(`sendShopeeStock` is the third, and the `enviar-estoque` route does **not**
enqueue onto it — the manual push runs IN-PROCESS by design;
`processShopeePriceSync` is the fourth, and the same holds for its
`enviar-precos` manual push, while its `atualizar-precos` job route DOES
enqueue), and the per-service grant
below has to be repeated for each: a grant on one of them buys nothing for the
others, and the failure is the silent one (task created, dispatched,
`403 run.routes.invoke`, no document anywhere).

```bash
# App Hosting runtime SA (the identity the receiver route runs as):
#   PROJECT_NUMBER-compute@developer.gserviceaccount.com  (or the backend's SA)
gcloud projects add-iam-policy-binding <project-id> \
  --member="serviceAccount:<apphosting-runtime-sa>" \
  --role="roles/cloudtasks.enqueuer"

gcloud iam service-accounts add-iam-policy-binding <functions-runtime-sa> \
  --member="serviceAccount:<apphosting-runtime-sa>" \
  --role="roles/iam.serviceAccountUser"
# ⚠ THE THIRD ROLE, and the one everyone forgets. Enqueuing is only half the
# trip: Cloud Tasks then DISPATCHES the task, presenting an OIDC token whose
# principal is the enqueuer's own identity - and a gen2 function is a Cloud Run
# service, so that principal needs run.invoker ON THE SERVICE. Without it the
# task is created and delivered and the service answers 403 run.routes.invoke,
# with NO failure document written anywhere.
#
# ⚠ SINCE #1133 THE DEPLOY DOES THIS FOR YOU when TASKS_INVOKER_SA is set (see
# below). Run it by hand only for a deploy without that variable.
#
# ⚠ ONCE PER QUEUE FUNCTION - since step 13 there are FOUR.
for fn in processShopeeNotification processShopeeMassImport sendShopeeStock \
          processShopeePriceSync; do
  gcloud run services add-iam-policy-binding "$fn" --region=<region> \
    --member="serviceAccount:<apphosting-runtime-sa>" \
    --role="roles/run.invoker"
done
```

### The deploy aborts if `TASKS_INVOKER_SA` is missing (#1133)

`firebase.shopee.deploy.json`'s `predeploy` hook runs
`node tools/deploy-env/preflight.mjs shopee` **before** the artifact is built.
It prints every build-time value about to be baked into the bundle — and whether
each came from your shell or from a `build.mjs` default — then refuses to
continue if either of these is true:

- **`TASKS_INVOKER_SA` is unset or blank.** Without it `invoker` is omitted, no
  `roles/run.invoker` is granted, and the dispatch leg 403s _after_ the enqueue
  reported success — so nothing writes a failure document anywhere.
- **the task/schedule region has no Cloud Tasks.** That deploy fails every queue
  and schedule function at once while any Firestore trigger succeeds — the
  asymmetric failure list from #1108, refused up front instead.

Run it by hand any time; it changes nothing:

```bash
node tools/deploy-env/preflight.mjs shopee
```

⚠️ It does **not** run in CI. `predeploy` hooks are skipped under
`emulators:exec`, which is deliberate — the emulators have no IAM layer, so
`ci-shopee.yml` is unaffected either way and builds the artifact itself.

### The deploy-shell knobs (step 12) — read from the shell, not from `.env.deploy`

`node tools/deploy-env/preflight.mjs shopee` prints these two beside the
build-time values, with `[code default]` when the shell did not set them:

```
SHOPEE_STOCK_CONCURRENT_DISPATCHES  2  [code default]
SHOPEE_STOCK_DISPATCHES_PER_SECOND  2  [code default]
```

They are the `rateLimits` of the `sendShopeeStock` queue, and firebase-tools
bakes them in during **local trigger analysis** — so the value that lands on the
queue is whatever the deploying shell exported, and a value put in
`.env.deploy` is read by nothing. Source of truth: `envInt(...)` in
`apps/shopee/lib/shopee/estoque/constantesEstoque.ts`, drift-checked from the
preflight side by `tools/deploy-env/preflight.test.js`.

⚠️ **2/2 is a CHOICE, not a measurement.** It is ML's stock queue, not the mass
import's 1/1, and nobody has watched a real Shopee partner rate-limit budget
under a stream of stock writes — the quota is per APP, shared by every conta and
every Shopee call this monorepo makes. This is the first knob a rehearsal
should move.

⚠️ `SHOPEE_STOCK_CONCURRENT_DISPATCHES` has a **second home**: the App Hosting
console, where the same name caps the manual push's in-process concurrency. The
two are independent settings of one number; keep them in step.

### `TASKS_INVOKER_SA` — the third role, applied by the deploy (#1133)

Export it in the shell you run `firebase deploy` from. `build.mjs` inlines it
(esbuild `define`, exactly like `FUNCTIONS_REGION`) and the `onTaskDispatched`
in this codebase declares it as `invoker`; firebase-tools then applies the list
to **both** legs of the trip — `roles/run.invoker` on the function's Cloud Run
service **and** `roles/cloudtasks.enqueuer` on its queue.

```bash
export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"
firebase deploy --only functions:shopee \
  --config firebase.shopee.deploy.json \
  --project <project-id>
```

⚠️ **Name every enqueuer, comma-separated** — drop the duplicate when the two
are the same identity. A deploy **replaces** the members of both bindings, so an
identity left out **loses** the role. Today the receiver route is the only
enqueuer; list the functions runtime SA anyway, because a handler that
re-enqueues makes it one and rediscovering the 403 later is the expensive path.

⚠️ **Unset ⇒ the option is omitted entirely.** The build prints a warning and
the manual `gcloud run services add-iam-policy-binding` above stays required. It
never guesses a value: a wrong one would lock out the legitimate caller, and a
permissive one would be far worse.

⚠️ A redeploy with **no** `invoker` declared does not clear an existing binding
— firebase-tools skips `setInvokerUpdate` when the option is absent — but a
service **create**, i.e. a new or renamed task function, leaves no binding at
all. That silent case is what this variable exists for.

Verify it took, with nobody having run gcloud — **once per queue function**:
`gcloud run services get-iam-policy processShopeeNotification --region=<region>`,
`gcloud run services get-iam-policy processShopeeMassImport --region=<region>`,
`gcloud run services get-iam-policy sendShopeeStock --region=<region>`
and
`gcloud run services get-iam-policy processShopeePriceSync --region=<region>`.

### ⚠️ firebase-tools 15.28.2: the first deploy of a NEW queue crashes on the enqueuer binding

Measured on the staging deploy of 2026-09-24, and **not specific to Shopee**:
the first deploy of ANY codebase's brand-new task queue whose function declares
`invoker` hits it — and in this repo every functions codebase's `build.mjs`
inlines `invoker` from `TASKS_INVOKER_SA`. No deploy path pins firebase-tools
— the CI emulator lanes pin their own version and never deploy — so this is the
deploying machine's CLI: check whether a newer release fixed it before relying
on the workaround.

- **The mechanism.** `cloudtasks.setEnqueuer` (firebase-tools
  `lib/gcp/cloudtasks.js`) runs `existing.bindings.filter(...)` over the queue's
  IAM policy. A brand-new queue's `getIamPolicy` answers `{"etag":"ACAB"}` with
  **no `bindings` key**, so it throws
  `Cannot read properties of undefined (reading 'filter')`.
- **The misleading symptom.** The deploy prints "Unable to set the invoker for
  the IAM policy … `roles/functions.admin` … organization policy" for EVERY queue
  function. It reads like a permissions problem and is not one.
- **What lands anyway.** The functions, the queues and the `roles/run.invoker`
  bindings on the Cloud Run services. What is MISSING is only the queue-level
  `roles/cloudtasks.enqueuer` binding — the enqueue leg.
- **Re-running alone does not help.** The deploy never passes `assumeEmpty`, so
  a retry reads the same binding-less policy and crashes identically.

The workaround — **once per new queue, per identity** named in
`TASKS_INVOKER_SA`:

```bash
gcloud tasks queues add-iam-policy-binding <queue> \
  --location=<region> --project=<project-id> \
  --member="serviceAccount:<sa>" \
  --role=roles/cloudtasks.enqueuer
```

then re-run the SAME deploy: the policy now has a `bindings` array, so the
deploy re-applies `TASKS_INVOKER_SA` authoritatively and finishes clean. For this
codebase a first deploy means up to four queues (`processShopeeNotification`,
`processShopeeMassImport`, `sendShopeeStock`, `processShopeePriceSync`) × each
identity in the list; a later deploy that adds a queue pays it for that queue
only. ⚠️ **So the first STAGING deploy after step 13 pays it for the price
queue ALONE** — the other three have existed there since 2026-09-24 — **and
production's first deploy pays it for all FOUR**: production is a separate
project, so its first deploy hits this for every queue — put the grants in the
window's runbook. Verify the enqueue leg, which the `run` check above
cannot see: `gcloud tasks queues get-iam-policy <queue> --location=<region>`
must list `roles/cloudtasks.enqueuer` for every identity in `TASKS_INVOKER_SA`.

### ⚠️ Since step 4 the SCHEDULED functions enqueue too (#1512), since step 9 a queue function enqueues ITSELF (#1517), since step 12 three more schedules and a third self-enqueuer (#1520), and since step 13 a fourth self-enqueuer (#1521)

`sweepShopeeLostPushes` and `backfillShopeeOrders` both enqueue onto
`processShopeeNotification`; `sweepShopeeStock`, `sweepShopeeStockDaily` and
`sweepShopeeStockReconciliacao` enqueue onto `sendShopeeStock`; and
`processShopeeMassImport` re-enqueues onto its
OWN queue for every scan/drain continuation and for the rate-limit pause, as
does `sendShopeeStock` on a burst pause and on the conta-pause rung, and as
does `processShopeePriceSync` for every plan/drain continuation, a burst pause
and the daily-quota park — so
the **functions runtime service account** — not
just the App Hosting one — needs `roles/cloudtasks.enqueuer` on **all four**
queues and `roles/run.invoker` on **all four** Cloud Run services. The
mass-import function and, since step 13, the price job are the two
dispatched by two DIFFERENT identities (the App Hosting route starts a job, the
function continues it), which is exactly why leaving either out of the list below
breaks one in the middle of a walk rather than at the start.
⚠️ `sendShopeeStock` is dispatched by two identities as well, but **both are the
functions runtime SA** (the three sweeps, and itself): no App Hosting route ever
enqueues onto it, because the manual push runs in-process. So the App Hosting SA
needs `run.invoker` there for nothing — and it is still granted by the same
`TASKS_INVOKER_SA` list, which is authoritative and must not be trimmed per
function.
`TASKS_INVOKER_SA`
already applies both roles at deploy time and it is **authoritative**: a deploy
REPLACES the members of both bindings, so an identity left out of that list
LOSES the role it had. Name **both** identities, comma-separated:

```bash
export TASKS_INVOKER_SA="<apphosting-runtime-sa>,<functions-runtime-sa>"
```

The prose above already told you to list the functions SA "because a handler
that re-enqueues makes it one". Two schedules now do, and since step 9 so does a
queue handler. ⚠️ Granting this on PRODUCTION is **step 22's action** (#1530)
— this codebase has reached only staging (once, on 2026-09-24), and an agent
never runs it (root `CLAUDE.md` rule 8). The failure it prevents is silent in
the worst direction: the enqueue succeeds, Cloud Tasks dispatches with an OIDC
token the service refuses (`403 run.routes.invoke`), and no failure document is
written anywhere — a lost-push tick would then CONFIRM a page whose entries
never arrived, and the queue only holds them for 3 days.

Until this is granted the enqueue fails; the receiver then **falls back** to
persisting the push as `failed` (the reprocess sweep drains it) and still answers
204 — so pushes are not lost, but the intended rate-limited queue path is
inactive. ⚠️ The lost-push sweep degrades the same way and stays lossless: an
enqueue that throws is persisted `failed`, which COUNTS as durable, so the page
is still confirmed and the 30-minute reprocess sweep drains it. A page is left
unconfirmed only when an entry could not be made durable at all — not even
persisted. ⚠️ **The mass import has no such fallback**: `/importar-todos`
answers **503** and creates no job at all when the enqueue cannot happen, rather
than leaving a `running` document that nothing will ever drain. ⚠️ **Neither
has the price job**: `/atualizar-precos` answers **503** before creating a job
while `SHOPEE_TASKS_DISABLED` is set, and when the enqueue itself fails after
the job exists it stamps that job `failed` with one `job-interrompido` report
row before answering — so it, too, never leaves a `running` document for
nothing to drain. ⚠️ **The stock
sweeps have no fallback either, and they need none**: an enqueue that throws
propagates out of the tick, which fails the execution loudly — there is no
document to lose, because the next tick re-derives the same window from the same
durable cursor. Verify **all four**
queues exist after the first deploy:
`gcloud tasks queues describe processShopeeNotification --location=<region>`,
`gcloud tasks queues describe processShopeeMassImport --location=<region>`,
`gcloud tasks queues describe sendShopeeStock --location=<region>`
and
`gcloud tasks queues describe processShopeePriceSync --location=<region>`.

## What CI proves, and what it does not

`ci-shopee.yml` runs `Shopee Cloud Tasks round trip`: the real receiver → the
real region-qualified enqueue → the tasks emulator → the real
`processShopeeNotification` → a real Firestore document. Since step 9 the same
job also drives the second queue: the real
`createShopeeMassImportScheduler().enqueue(...)` → the tasks emulator → the real
`processShopeeMassImport` → a seeded `importacoesShopee` job document stamped
**`failed` on the first attempt**, because its `integracao` is of the WRONG
`tipo` and `loadShopeeContext` refuses before a Shopee client is ever
constructed — **zero Shopee calls**, proved by call ORDER rather than by a mock,
and by `retryCount: 0` on the single dispatch. `ci.yml`'s `CI test`
runs every unit suite in this app, this codebase included.

Since step 12 that same job drives a THIRD end-to-end shape: the real
`createShopeeStockTaskScheduler().enqueue(...)` → the tasks emulator → the real
`sendShopeeStock` → a seeded `prodshopee` link document stamped
`estoqueRecusaCodigo: 'erp:task-excede-limite'`, because the task carries 51
models and the chunk guard sits **above** the pause gate, above the context load
and above the client. Chosen for the same reason as the other two — it is the
only outcome that writes a document with NO Shopee call — and here the
guarantee is **CALL ORDER**, never a mock, because the lane's fetch kill-switch
lives in the vitest process and does not cover the dispatched function. That one
row proves four things nothing offline can: the queue NAME and the REGION
resolve to a real deployed `onTaskDispatched` (the silent drop of #1108); the
payload survives Cloud Tasks' JSON with `itemId`/`modelId` as NUMBERS; the FLAT
`mergeIfExists` write-back lands on a real Firestore engine, patching rather
than resurrecting a ghost; and `SHOPEE_STOCK_SYNC_ENABLED=1` really reaches the
functions process — with the valve unset the handler answers `pulado` and writes
nothing, so the assertion could not pass and the failure would be a POLL
TIMEOUT rather than a value mismatch.

Since step 13 the job drives a FOURTH shape, in three cases
(`lib/shopee/precos/atualizarPrecos.tasks.test.ts`): the real
`createShopeePriceSyncScheduler().enqueue(...)` → the tasks emulator → the real
`processShopeePriceSync`. A job started by the real `iniciarEnvioPrecoShopee`
over four anchors that are all refused at PLAN time walks the classic keyset
discovery across two full pages — the case refuses to run unless the lane's
env sets `SHOPEE_PRICE_PAGE_LIMIT` to 2, so the job must re-enqueue itself, and
the exact multiple costs one more, empty, page — and reaches `completed` through the class-B finalize transaction, with
ONE report shard carrying the four rows from two separate checkpoints and
`expiraEm` on the job and the shard, 180 and 187 days after `startedAt`. A job
cancelled before its first dispatch answers `noop` with one `job-cancelado`
row, and a conta of the WRONG `tipo` is stamped `failed` on attempt 0 with one
`job-interrompido` row. All three make ZERO Shopee calls, by CALL ORDER again:
the job's only Shopee calls are in the DRAIN, which runs only while `fila`
holds a listing, and a plan-time refusal never puts one there. What that proves
and nothing offline can: the keyset read (`startAfter` on an id value, after a
`select`, under `orderBy` document id) on a real engine, the batch checkpoint
DEEP-merging two pages' rows into one shard, the finalize through a real
transaction, and the fourth queue's name resolving to a deployed
`onTaskDispatched` — the self-continuation included. What it cannot prove is
the DRAIN (every step of it needs a Shopee call) and the burst pause and the
daily park: both set a scheduling delay, which the tasks emulator ignores
(firebase-tools#8254), so all of it is pinned offline in
`lib/shopee/precos/atualizarPrecos.test.ts`.

Three gaps to know about:

- **The Firestore trigger never executes in CI either.** `firebase.shopee.tasks.json`
  runs firestore + functions + tasks, and the functions emulator loads
  `onProdutoShopeeLinkChanged` without ever delivering it an event: no lane
  writes a `prodshopee` document through the emulated Firestore to watch the
  handler wake up. Its BODY is covered by unit tests over the app's own FakeDb
  and its OPTIONS by `src/index.test.ts` over `__endpoint` — the document
  pattern, `database: 'default'` (exact equality on the parsed field, never a
  `JSON.stringify().toContain()`, because the serialized endpoint always carries
  `"namespace":"(default)"`), `retry: true` and the empty secret set. What no
  test can show is that **Eventarc** delivers anything at all; the first real
  proof is the deploy (see Cutover).
- **None of the ten `onSchedule` triggers ever executes in CI.** The functions
  emulator logs them as "ignored because the pubsub emulator does not exist or
  is not running", so the lane loads them and nothing drives them. Their bodies
  are covered by unit tests and their _options_ — each cron, the
  `America/Sao_Paulo` zone, the timeout and the exact `secrets:` set — by
  `src/index.test.ts`, which asserts over `__endpoint` exactly as
  `processNotification.test.ts` does for the queue handler (#778 is the worked
  example of that gap costing a silently inert sweep). ⚠️ That file's coverage
  is itself asserted: an exhaustiveness test enumerates every export whose
  `__endpoint` carries a `scheduleTrigger` and fails if one is missing from its
  map, because between step 3 and step 4 three schedules arrived at once and
  "remember to grow the test file" is not a mechanism. What no test can show is
  that Cloud Scheduler actually fires them; the first real proof is the deploy.
- **Nothing here proves the composite indexes are declared.** The emulator
  auto-creates every composite and on Enterprise a missing one does not throw —
  it full-scans and bills the scan. The **seven** Shopee composites deploy in the
  migration window (#1532): `notificacoesShopee (status, processedAt)`;
  `integracao (tipo, shop_id, ativo)`;
  `prodshopee (item_id, contaProdutoShopeeOuterRef)`, collection-group;
  `variashopee (model_id, contaVariacaoShopeeOuterRef)`, collection-group;
  since step 9 `importacoesShopee (integracaoId, status)`, the guard that stops
  a second mass import starting while one is `running`; and since step 13
  `enviosPrecoShopee (integracaoId, status)`, the price job's one-active guard,
  and `enviosPrecoShopee (integracaoId, startedAt DESC)`, its history route —
  plus that collection's `expiraEm` TTL policy, which rides the same indexes
  deploy. All seven are declared in `firestore.indexes.json`; declaring is not
  deploying.

## Cutover

There are **no legacy Flutter Shopee Cloud Functions to coordinate with.** The
legacy stack had no server-side Shopee receiver at all — its push handling and
token store are the anti-patterns the shared seams replaced (master plan §3), and
it never wrote a `pedshopee`. So this codebase does not race a predecessor for a
document, and the only coordination it owes is the ORDER of the window steps:
grant the IAM above, deploy this codebase, deploy the App Hosting backend, and
only THEN register the push callback URL with Shopee (#1534). Registering first
means every delivery arrives at a backend whose queue does not exist — each one
persisted as `failed` and drained late, at best.

⚠️ **Eventarc for the first Firestore trigger (step 11) — settled on STAGING,
still open for PRODUCTION.** Whether a project needs Eventarc and Pub-Sub APIs
enabled (and the Eventarc service agent granted) before
`onProdutoShopeeLinkChanged` can be created is **not settled by anything in this
repo** — no test, no emulator and no CI lane exercises it, because the functions
emulator never runs a Firestore trigger here. The staging deploy of 2026-09-24
answered it for THAT project: firebase-tools enabled `eventarc.googleapis.com`
itself and generated the Eventarc service identity, the trigger was created, and
its first live run stamped the conta onto `integracoesComProduto`. ⚠️ Production
is a separate project and inherits none of staging's API state, so there it is
still a **migration-window fact** (root `CLAUDE.md` rule 8, register item 81),
settled by that project's first deploy and **never run by an agent**. If that
deploy refuses the trigger, the other thirteen functions are unaffected — the
failure is per-function — and enabling the APIs plus re-running the same deploy
is the whole remedy. ⚠️ **But a refused trigger is no longer cosmetic.** Since
step 12 the stock discovery's S1 anchor term is
`integracoesComProduto array-contains <conta>`, so a produto the trigger never
stamped is invisible to every stock sweep, and the manual push answers
`conta-fora-do-produto` for it; the `/produtos` "Canais de venda" column reads
the same array.

⚠️ **Cloud Scheduler and Cloud Tasks enablement (step 12) — settled on STAGING,
still open for PRODUCTION.** Step 12 added **three** schedules and a **third**
queue at once, and whether a project needs the Cloud Scheduler and Cloud Tasks
APIs enabled, and their service agents granted, before they can be created is
**not settled by anything in this repo**: the functions emulator logs every
schedule as "ignored because the pubsub emulator does not exist", and the tasks
lane runs against an emulated queue that no IAM layer touches. The staging
deploy of 2026-09-24 — this codebase's first deploy anywhere — created all ten
schedules and all three queues with **no manual API enablement**. Its one
failure was not an enablement problem: it was the queue-IAM crash documented
beside the `TASKS_INVOKER_SA` sections (firebase-tools 15.28.2), cleared by the
per-queue `gcloud` grant and a re-run. ⚠️ Staging did NOT show two things: the
SCHEDULED path end to end — a sweep enqueuing onto `sendShopeeStock` through a
real queue, dispatched with the OIDC invoker, which needs
`SHOPEE_STOCK_SYNC_ENABLED=1` in the functions deploy env and a redeploy, a
human's call — and anything about the PRODUCTION project. There it stays a
**migration-window fact** (root `CLAUDE.md` rule 8, register item 92), settled
by that project's first deploy and **never run by an agent**. The remedy, if
enablement does bite there, is the same shape as the Eventarc one — enable the
APIs, re-run the same deploy — and the failure is again per-function, so the
three stock sweeps and the stock queue can refuse while everything else lands.

⚠️ **The fourth queue (step 13) has reached no project yet.**
`processShopeePriceSync` was not part of the 2026-09-24 staging deploy. Its
first staging deploy creates one new queue and pays the firebase-tools 15.28.2
enqueuer workaround for that queue alone; production's first deploy pays it for
all four (the IAM section above). And the price job's rehearsal will be the
first time a ROUTE-started Shopee job crosses a real queue — step 9's
`importar-todos` has no staging record — which is what finally proves the App
Hosting identity's first enqueue: the tasks lane runs against an emulated queue
that no IAM layer touches. Both are a human's, in a coordinated window, and
**never run by an agent** (root `CLAUDE.md` rule 8).

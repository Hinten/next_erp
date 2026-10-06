# `lib/shopee/devolucoes/` — returns, refunds and disputes (step 17, #1525)

The design notes for the step that makes this app follow a Shopee **return**
(a `return_sn`: the buyer asked for a refund, with or without sending the goods
back) and lets the operator answer it. `apps/shopee/CLAUDE.md` keeps only the
rules a reader must not break and points here for the reasoning. The reconciled
design, the explorations and the wave reports that produced this folder are in
the step-17 review directory named by the PRs that close #1525.

**What the folder does.** Every code-29 push (`push 32`, `return_updates_push`)
names a return; the folder re-reads that return from Shopee, writes it as ONE
incidente on the order's pedido, keeps one aviso per return open while the
seller owes an answer, re-reads every 6 hours what the push never announces,
and lets the operator run three seller actions from the pedido screen.

**What it does NOT do.** It opens no disputes, uploads no evidence, writes no
frete estado for the reverse leg, books no settlement money and creates no
pedido. §14 lists each, with the reason.

Step 17 is built as seven stacked PRs: (1) the overlay predicate and origem 5 in
`packages/schemas` (the one `pedido/` edit, `nfe-live`); (2) the package's six
returns operations, schemas and the wire corpus; (3) this folder's importer,
the code-29 arm, the aviso, the transaction and the tasks round trip; (4) the
poller and its schedule and the `importar:devolucao` dry run; (5) the actions
and the two routes; (6) the web panel and the Incidentes lock; (7) the docs.
None is merged and nothing is deployed (§18).

Everything here is **offline-verified**. The SG sandbox has no Returns module
(`guide 644`), so every wire fact below comes from Shopee's documentation, and
everything only a Brazilian shop can settle is a register row (§16).

## 1. The modules, in families

- **The seam.** `idsDevolucao.ts` derives the incidente id
  (`shopee-devolucao-<return_sn>`, guarded by `ehReturnSnShopee`).
  `pushDevolucao.ts` reads a code 29 as a POINTER — the order, the return, the
  origem and a log-only diary of what the push claimed.
- **The pure rules.** `devolucaoMapping.ts` is the ONE home of every return
  rule: the status sets, the stored block and its schema, the field-by-field
  content compare, the seller's pendência, the poller's re-import predicate and
  the aviso clock. `recusaDevolucao.ts` is the ONE refusal vocabulary (our gate
  and Shopee's refusals) with its pt-BR sentences and the classifier.
  `estadoDevolucao.ts` is THE actions gate and the projection the panel shows.
  `tokenParaLog.ts` is the ONE rule for a Shopee token reaching a log line.
- **The writes.** `devolucaoTx.ts` is the ONE incidente write, a class-B
  transaction. `avisoDevolucao.ts` raises and resolves the aviso from what that
  transaction CONFIRMED.
- **The drivers.** `importarDevolucao.ts` is the code-29 handler.
  `acoesDevolucao.ts` is the domain half of the two routes (it holds no `db`).
  `devolucoesSweep.ts` is the 6-hourly poller (PR 4), and
  `importarDevolucaoCli.ts` the dry run's tested parser (§17).
- **Outside the folder.** The arm in `notificacoes/notificacao.ts`
  (`DISPATCH[29] = 'devolucao'`, reached through a lazy `await import`); the
  code-29 builder
  `notificacaoSinteticaDeDevolucao` and `carimboDoDiaUtcMs` in
  `notificacoes/notificacaoSintetica.ts`; the routes under
  `app/api/marketplace/shopee/reclamacao/{acao,estado}/`; `sweepShopeeReturns`
  in `functions/src/index.ts`; `scripts/importar-devolucao.ts`; the package's
  `devolucoes.ts` + the "Returns (step 17)" section of `types.ts` and `api.ts`
  (its README has a returns section); `packages/schemas/src/devolucaoShopee.ts`
  (`ehReturnSnShopee`, the ONE return_sn shape) and the aviso tipo in
  `aviso.ts`; the web panel (§11).

`notificacoes/notificacao.ts` reaches every module here ONLY dynamically (its
static imports from this folder are `import type`, pinned by a test), so the
receiver bundle stays lean; the routes, the sweep's function and the CLI import
statically, and static value imports from `../pedidos/*` are fine inside the
folder.

## 2. Code 29 is a POINTER — the flow, end to end

`push 32` names a return and reports FOUR fields (`return_status`,
`return_solution`, `seller_proof_status`, `logistics_status`), each with a
per-field `old_value` / `new_value` / `update_time` in SECONDS. It carries no
top-level clock, and its status is not monotone (Shopee's own sample moves
`JUDGING → PROCESSING`). So nothing the push claims is written: the handler
re-fetches `get_return_detail` and applies THAT. A replayed, an out-of-order and
a synthetic delivery are all idempotent for the same reason.

`importarDevolucaoShopee`, in order:

1. Derive the pedido id with `makePedidoIdShopee(integracaoId, orderSn)` (a
   digest, never a query) and the incidente id (a malformed return_sn throws a
   `RangeError` before any read).
2. A CHEAP existence read of the pedido. Absent ⇒ ONE synthetic code 3 and ZERO
   Shopee calls (§12). It is a skip, not the guard: the transaction re-reads the
   pedido.
3. ONE `get_return_detail`. A refusal the classifier reads as
   `devolucao-inexistente` ⇒ `ignorado-inexistente`. Everything else propagates
   to the arm's class table — `error_permission` included, which is not "not
   found".
4. The detail must describe THIS delivery's `order_sn` and `return_sn`, else
   `ignorado-outro-pedido` with zero writes (an integrity check, never a
   re-key).
5. `mapearDevolucaoShopee` → `salvarIncidenteDevolucaoShopee` (§4).
6. The aviso, from the transaction's CONFIRMED state (§7).
7. ONE `console.info('[shopee/devolucao] entrega de devolução', …)`: ids,
   tokens, counts and booleans only (§6).

The push's diary (`DiarioPushDevolucao`: up to eight changed field names, the
latest per-field clock in seconds, the pushed status) rides the log line only.
`divergePushVsPull` says when the pushed status and the pulled one disagree;
the PULL wins.

## 3. One incidente per return

`pedidos/{makePedidoIdShopee(conta, order_sn)}/incidentes/shopee-devolucao-<return_sn>`.
Both halves are derived, so the importer, the poller (`db.getAll` over the
derived refs) and the dry run all land on the same document without a query or
an index. The id keeps the return_sn readable (the legacy app wrote no Shopee
incidente, so no digest is owed), which is safe only because
`ehReturnSnShopee` admits `[A-Za-z0-9]{1,64}` and nothing else. ⚠️ Shopee's
return_sns are ALPHANUMERIC (the doc samples are), so every test uses an
alphanumeric fixture as well as a digits-only one: a digits guard would pass a
digits-only suite.

| field                                          | value                                                       | owner                            |
| ---------------------------------------------- | ----------------------------------------------------------- | -------------------------------- |
| `origem`                                       | `ORIGEM_INCIDENTE.pedidoShopee` (5)                         | importer, re-asserted            |
| `tipo`                                         | `TIPO_INCIDENTE.devolucao` (`'returns'`), for life          | importer, re-asserted            |
| `externalId`                                   | the `return_sn`                                             | importer                         |
| `claimStatus`                                  | `'closed'` iff the status is terminal (§5), else `'opened'` | importer                         |
| `claimStage`, `entregue`                       | `null`                                                      | importer                         |
| `timestamp`                                    | the detail's `create_time` in µs, else the watermark        | create only                      |
| `motivoDoIncidente`                            | `'Devolução Shopee'` + `' — <reason token>'`, ≤ 2000        | create only, then the operator's |
| `relogioProvedorUs`                            | the watermark (§4)                                          | importer                         |
| `ultimaModificacao`                            | `= relogioProvedorUs` on every applied write, display only  | importer (and the web)           |
| `devolucaoShopee`                              | the block: tokens, amounts, six deadlines in µs, `revisao`  | importer                         |
| `comentarios`, `resolucao`, `overrideBloqueio` | never written by the importer                               | the operator / the server        |

⚠️ **origem 5, never 2.** The web reads origem 2 plus an all-digits
`externalId` as a Mercado Livre claim and would mount ML's panel on a Shopee
return. 99 (`outros`) is step 5's produto incidente and an operator's
hand-pick, and must never count as a marketplace claim. `ORIGENS_INCIDENTE_MARKETPLACE`
= {2, 5} is the ONE allow-list the overlay predicate and the web lock read.

⚠️ **The block.** Every optional token goes through one reader (`''` and `'-'`
read as absent). `reassessed_request_reason: 'NONE'` is stored as `null`, but
`reason: 'NONE'` is KEPT (it is a real `reason` value). Amounts are stored as
Shopee sent them, `0` included. Every deadline goes through the 2020 floor
first: Shopee zero-fills an absent timestamp, and a `0` stored as a deadline is
fifty years overdue.

## 4. The watermark (rule 7, tier 2)

The guard is the incidente's own top-level `relogioProvedorUs`: the detail's
`update_time` (REQUIRED on the wire; a body without it fails the parse),
converted ONCE by `microsDeSegundosShopee`. The callback re-derives it from its
own `tx.get`:

| incoming vs stored                     | content   | outcome                | writes                                          |
| -------------------------------------- | --------- | ---------------------- | ----------------------------------------------- |
| absent document                        | —         | `criado`               | `tx.create`, `revisao` 1                        |
| older                                  | any       | `ignorado-obsoleto`    | none                                            |
| equal                                  | same      | `ignorado-sem-mudanca` | none                                            |
| equal                                  | different | `atualizado`           | the importer-owned keys, `revisao` + 1          |
| newer                                  | same      | `relogio-avancado`     | `{ relogioProvedorUs, ultimaModificacao }` only |
| newer                                  | different | `atualizado`           | the importer-owned keys, `revisao` + 1          |
| stored watermark absent / not a number | any       | read as OLDER          | as "newer" above                                |
| pedido absent (re-read in the tx)      | —         | `ignorado-sem-pedido`  | none                                            |

- ⚠️ **Equal-and-different must write.** Shopee's stamps have 1-second
  resolution, so two changes inside one second share one `update_time`; a strict
  `>` would never converge on the second.
- ⚠️ **Never `ultimaModificacao`.** The web editor stamps WALL-CLOCK µs there on
  every operator save, so an operator who added a comment would block every
  later import for as long as Shopee's clock trails ours. The importer writes it
  and never reads it. `relogioProvedorUs` joined
  `onIncidenteChanged.ignoreFields`, so a watermark-only advance files no history
  row.
- **"Same content" is `mesmoConteudoDevolucao`**: field by field, strict, NO
  generic deep-equal (#1372 — a fold that folds too much reads a real edit as
  "no change"). Both sides are re-parsed by `devolucaoShopeeArmazenadaSchema`
  first, so `null` and absent are one value; `'ACCEPTED'` vs `'Accepted'`, 10.5
  vs 10.51 and a 1 µs deadline change all stay distinct (pinned).
- **origem and tipo are content.** An operator's retype of an imported row reads
  as a difference and is RE-ASSERTED by the next fresher-or-equal delivery; the
  web lock (§11) is the other half.
- **`revisao` moves with content, never with the clock.** It is assigned inside
  the callback from the stored block, and the aviso clock is built from it.
- **Operator turf survives.** The update names exactly `origem`, `tipo`,
  `externalId`, `claimStatus`, `claimStage`, `entregue`, `ultimaModificacao`,
  `relogioProvedorUs` and `devolucaoShopee`, and `tx.update` masks at top-level
  keys.

The decision and the exact payload are ONE pure function,
`preverIncidenteDevolucaoShopee`, which the callback runs on its own snapshot
and the dry run runs on a plain read: the rehearsal prints the bytes a live
delivery writes. The inventory row in
`packages/config-eslint/rules/firestore-transaction-inventory.test.js` (class
**B**: the detail is pulled BEFORE the callback opens, so no network call sits
inside it) carries the same text.

## 5. Open or closed, and what it blocks

- **Terminal = {`CLOSED`, `CANCELLED`}**, one constant
  (`STATUS_DEVOLUCAO_TERMINAIS`). `ACCEPTED`, `JUDGING`, `PROCESSING`,
  `REQUESTED`, `SELLER_DISPUTE` and ANY unknown token are `opened`: an unknown
  status fails CLOSED, i.e. it keeps blocking. Shopee never states the terminal
  set (register 232).
- **tipo `returns` for life ⇒ a Shopee return blocks `finalizar` only**, never
  despacho or NF-e emission. `classificarIncidenteBloqueante` yields `'disputa'`
  only for a non-`returns` tipo on an undelivered order, and a Shopee return is
  post-delivery (Brazil's NF-e precedes shipping). So `SELLER_DISPUTE` does NOT
  flip the tipo. A return before shipment (register 247) would reopen this.
- **What heals a wrongly-open row — and what does NOT.** The poller
  re-enqueues a row whose stored `claimStatus` differs from the one derived
  from its live status (§8), so a change to the terminal set heals, within 6
  hours, the row of every return Shopee still LISTS: one whose `update_time`
  moved in the trailing 15 days (§8's window). ⚠️ A return that came to rest
  before that is never listed again, so its row keeps blocking `finalizar` for
  ever — exactly the population register 232 asks about (`ACCEPTED` at rest
  after the refund). Correcting the set therefore owes one of two remedies for
  the older rows: a one-shot pass that re-uses `runShopeeDevolucoesSweep` over
  successive earlier 15-day windows (Shopee refuses a wider one; no tool drives
  it yet), or `liberarBloqueioIncidente` per pedido (superuser, no UI — the
  manual release). Either is a person's act on production data, and its
  tracking issue is ASKED for, never opened unasked (rule 8).
- ⚠️ **Deploy order.** `apps/functions` must carry the widened predicate BEFORE
  any Shopee incidente is written: `onIncidenteBloqueioSync` folds a row only
  when that row is written, so a row written under the old predicate stays
  non-blocking until its next write (§18).

## 6. Buyer data never lands (R-11)

The package's returns RESPONSE schemas are plain `z.object` and STRIP — the one
exception to `types.ts`' "every object is `.passthrough()`" — and declare only
the fields something here reads. So `user`, the pickup address, `image[]`,
`buyer_videos[]`, `text_reason`, `dispute_text_reason`, the reverse
`tracking_number`, `activity[]`, `item[]` and
`negotiation.latest_offer_creator` never reach this folder. The stored block's
schema strips too. Adding a field later is a one-line declaration in
`types.ts`.

Logs carry ids, tokens, counts and booleans, never an amount or a sentence.
Shopee's status, reason and logistics TOKENS are logged once per delivery,
through `tokenParaLog` (`tokenParaLog.ts`, `/^[A-Za-z0-9_]{1,64}$/` — the ONE
copy the importer, the push parser and the CLI read): anything else is logged
as `<nao-token>`. A Shopee error CODE reaches a log only through `codigoSeguro`
(`nfe/redacaoNfe.ts`), never raw; the one raw `error` value logged is a
SUCCESS envelope's (`''`/`' '`/`'-'`, register 231's instrument).
The redaction of the wire corpus (`fixtures/redact.ts`) learned the return
paths BEFORE any body was written, and closes the masked exit under `user`,
`return_pickup_address` and `buyer_videos`.

## 7. The aviso — `reclamacaoAguardandoVendedor`

One row per RETURN: `chaveDeAviso({ tipo, conta: integracaoId, entidade:
returnSn })`, no window. Channel-neutral tipo, severity `atencao`, `canal:
'shopee'`, route `ROTAS_AVISO.pedido`. `motivo` is Shopee's raw status token;
`params` are exactly `{ pedido, devolucao, pendencia }`.

`pendenciaDoVendedor` (in `devolucaoMapping.ts`) decides what the seller owes on
an OPEN return:

| pendência               | holds when                                 | deadline                                              |
| ----------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `responder-solicitacao` | status `REQUESTED` or `PROCESSING`         | the nearer of `return_seller_due_date` and `due_date` |
| `responder-proposta`    | `negotiation_status === 'PENDING_RESPOND'` | `offer_due_date`                                      |
| `enviar-evidencias`     | `seller_proof_status === 'PENDING'`        | `seller_evidence_deadline`                            |

⚠️ The CHOSEN one has the NEAREST present deadline, not the first in the table:
the aviso shows one `prazo`, and showing a later one while an earlier one runs
out is how a seller loses a return by default (Shopee refunds the buyer at the
deadline, `faq 477`). No deadline sorts last; a tie keeps the table's order.
`prazo` is written as an explicit `null` when the chosen pendência has none. A
compensation request is not a pendência, and neither is `organizar-coleta` in
v1 (register 242). No pendência ⇒ the row resolves.

**Derived from the CONFIRMED state, never from the delivery.** A stale detail
reads `ignorado-obsoleto` and projects nothing, so it can neither raise nor
resolve.

| outcome                                    | aviso effect                                                   |
| ------------------------------------------ | -------------------------------------------------------------- |
| `criado`, `atualizado`                     | ALWAYS — `mudouAviso` is a diagnostic, never the gate (below)  |
| `ignorado-sem-mudanca`                     | ALWAYS — a crash-replay re-applies, churn-free (below)         |
| `relogio-avancado`                         | none — it would bump `ocorrencias` on every `update_time` bump |
| `ignorado-obsoleto`, `ignorado-sem-pedido` | none                                                           |

⚠️ **`atualizado` projects even when the aviso's fields did not move.** The
retry of a delivery whose aviso write failed reads `atualizado` with
`mudouAviso: false` when Shopee changed only an unshown field (the refund
amount) in between; gating on the flag lost that aviso until the return's
deadline (review on #1762). The cost is one `repetido` per Shopee revision
while the return waits — `ocorrencias` + 1, `criadoEm` untouched, so no
re-alert (`avisoNaoLido` keys on `criadoEm`).

**The event clock.** `relogioEvento = relogioProvedorUs + min(revisao,
999 999)` — strictly rising per content change (`escreverAviso` drops an EQUAL
clock), and still rising across a delete-and-recreate of the incidente in a
later second (a bare `revisao` would restart at 1 and every raise would be
dropped). It goes to BOTH `escreverAviso` and `resolverAviso`, which gained
`opts.relogioEvento` for this step: a resolve skips when the stored clock is
`>=` the given one and stamps it when it closes, and a newer clock still
advances an ALREADY-resolved row's stamp (so resolved → open → closed with the
last two effects inverted cannot reopen it). So two deliveries whose aviso
effects run in the inverse order of their commits cannot leave the older state
standing — and when they run CONCURRENTLY, a resolve whose update loses its
precondition to the other write re-reads and re-decides under the clock
(bounded, like `escreverAviso`'s own retry) instead of reading the loss as
"already resolved". On `ignorado-sem-mudanca` the incoming watermark equals
the stored one, so a replay reuses the first run's clock and writes nothing if
it already landed.

A clocked resolve also supplies the notice's base metadata. If the row is absent,
`resolverAviso` atomically creates a complete, already resolved row carrying the
clock; an older or equal FIRST raise is then ignored. The seed has the pedido and
devolução parameters, severity, channel and internal link; status, pending action
and deadline remain null/absent until a newer raise supplies them. It returns
`false` (`inalterado`), because it closed no existing open notice and alerts nobody.
The initial occurrence count is 1, as for any first stored observation. A newer
raise can reopen it normally. Resolved rows follow the existing 90-day retention.

An ALREADY_EXISTS creation collision or FAILED_PRECONDITION update re-reads and
re-decides against the winner; a clocked NOT_FOUND retries through the missing-row
branch. Three unsuccessful clocked attempts throw so the delivery is retried,
instead of reporting success without its newer observation. Clockless resolvers
retain their existing behavior. Existing-row resolves never replace base metadata.

## 8. The poller — `sweepShopeeReturns` (PR 4)

Code 29 reports four fields. Whether a negotiation, compensation or due-date
change even moves `update_time` is unverified (register 233), and a lost push is
not resent forever (register 244). So `runShopeeDevolucoesSweep`, every 6 hours
at minute 35 (`'35 */6 * * *'`, a minute no other cron of the codebase uses),
re-lists each active conta's returns and re-imports what looks stale.

- **Gates, before ANY read:** the valve `SHOPEE_DEVOLUCAO_SWEEP_DISABLED` (only
  the literal `'1'` stops it; it ships ON) ⇒ `sweep-desligado`;
  `destinoDoCodigo(29) !== 'devolucao'` ⇒ `handler-ausente` (the guard READS
  the dispatch table, the `orderBackfill.ts` shape); `SHOPEE_TASKS_DISABLED` ⇒
  `tasks-desabilitado`.
- **Window:** the trailing `[now − (15 d − 300 s), now]` on `update_time` only.
  The page documents 15 days as the maximum span, and the package refuses one
  second more before sending. ⚠️ So a return whose `update_time` stopped moving
  before the window is never listed again, and nothing here re-reads it (§5,
  §15).
- **Paging:** `page_no` 0, then +1 while `more`; at most 10 pages and 200
  enqueues per conta. ANY return_sn already seen in this run ⇒ stop and warn
  `paginacaoAmbigua` — that catches both an offset reading of `page_no` and a
  0 ≡ 1 base (register 235).
- **Per page:** a row the code-29 arm's own parser would refuse (an unreadable
  row, a non-alphanumeric return_sn) is counted `linhasIlegiveis` and never
  enqueued; then ONE `db.getAll` of the derived incidente refs and
  `motivoDeReimportacao` per row:

| reason       | when                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ausente`    | no incidente yet                                                                                                                                                 |
| `relogio`    | the row's `update_time` in µs is newer than the stored watermark (or the stored one is not a number)                                                             |
| `divergente` | a list-visible field differs: `status`, the three flat sub-statuses, the three common deadlines, `refund_amount`                                                 |
| `invariante` | the stored doc breaks an importer invariant: origem ≠ 5, tipo ≠ `returns`, `externalId` ≠ the return_sn, `claimStatus` ≠ the derived one, or an unreadable block |

- **Enqueue:** one synthetic code 29 (`origem: 'reconciliacao'`), stamped with
  `carimboDoDiaUtcMs(now)` — the START of the UTC day — so its
  `notificacoesShopee` doc id is stable for the day. If that failure row stands
  AND still holds the return — `parked`, or `deferred` while the return's
  pedido is still absent (one pedido read, only then) — the return is skipped
  and counted `comFalhaHoje`. A `failed` row, or a deferred one whose pedido
  has since appeared, is re-enqueued: a cleared precondition waits for the next
  tick, never for the rest of the day. At most ONE failure row per return per
  UTC day holds by the doc id alone (re-creating an existing id is a no-op);
  the skip bounds ATTEMPTS (the step-15b shape, `3685867cc`).
- **It writes nothing itself.** The importer is the single writer; a false
  positive costs one `get_return_detail`, never a wrong write.
- **Containment.** A rate limit is tested FIRST and aborts the whole tick (the
  quota is per APP; the next tick is the retry). Everything else
  `erroContidoPorConta` names is recorded on the conta and the walk moves on;
  `ShopeeConfigError` — our own misconfiguration — rethrows. ⚠️ A Cloud Tasks
  enqueue failure carries a STRING code (`FirebaseFunctionsError` /
  `FirebaseAppError`), never a gRPC one: the real scheduler (`shopeeTasks.ts`,
  #1759) names the transient ones `ShopeeTasksTransientError` and the shared
  boundary contains them per conta; a permission, a missing queue or a bad
  argument arrives as the raw SDK class — a broken deploy — and rethrows.

## 9. The seller actions and the two routes (PR 5)

v1 answers three actions: **`confirmar`** (`confirm`: refund in full, no goods
back), **`ofertar`** (`offer`: propose a solution and, when adjustable, an
amount) and **`aceitar-oferta`** (`accept_offer`: accept the buyer's
counter-offer). Reads: `get_return_detail`, `get_available_solutions`, and the
poller's `get_return_list`.

**ONE gate, `estadoDevolucao.ts`.** Every action re-reads the return LIVE
immediately before the write and runs the gate on that read, never on what the
panel loaded:

| action           | refused when                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all              | the return belongs to another pedido (`pedido-divergente`); terminal; an unknown status; `SELLER_DISPUTE` / `JUDGING` (in dispute)                                          |
| `confirmar`      | status not `REQUESTED`/`PROCESSING`; request type ≠ 0; `warehouse_validation`; refund type `RRAOC`; no `refund_amount`; the amount the operator saw differs (`valor-mudou`) |
| `ofertar`        | the chosen solution is not eligible; an amount for a fixed one; no amount for an adjustable one; outside the bounds (NEVER clamped)                                         |
| `aceitar-oferta` | no buyer offer pending (`negotiation_status !== 'PENDING_RESPOND'`); the live amount or solution differs from what the operator saw                                         |

⚠️ **The "what you saw" echo is required** (rule 7, tier 3 — tell the human).
`confirmar` sends `valorExibidoMinor`, `aceitar-oferta` sends
`valorExibidoMinor` and `solucaoExibida`, every action sends `pedidoId`. A
counter-offer landing between the read and the click is answered 409, never
accepted unseen.

⚠️ **`acoesDevolucao.ts` holds NO `db` and NO scheduler** — the absence IS the
enforcement (tier 0). A state written there would be clobbered by the next code
29 or would win a race and disagree with Shopee forever. After a success the
ROUTE enqueues ONE synthetic code 29 (`origem: 'acao-vendedor'`), and the
importer reflects the action under its own watermark. If that enqueue fails in a
KNOWN way — the valve, a missing region, a transient Cloud Tasks failure (the
real scheduler's `ShopeeTasksTransientError`, #1759), a deploy-shaped Admin SDK
error the scheduler hands back raw (`FirebaseFunctionsError` /
`FirebaseAppError`: a missing IAM grant, no queue in that region) or a
gRPC-coded error — the route still answers 200 with
`atualizacao: 'nao-enfileirada'`: the action is done, and the next push or the
poller reflects it (register 239). ⚠️ The deploy-shaped ones are contained here
although the poller's boundary rethrows them: there a rethrow fails a tick,
here it would be a 500 AFTER an irreversible write, which the panel reads as a
failure — the second click. They are logged with `console.error`. Any other
enqueue failure is a bug and rethrows, even after the action.

⚠️ **Money crosses once, in this module.** The HTTP wire carries integer
CENTAVOS (`valorReembolsoMinor`); Shopee's `offer` takes REAIS. Converted by
`roundReais(minor / 100)` and asserted back through `centavosDeReais`. Bounds
are compared in centavos. Brazil's decimal count for the offer amount is
assumed to be 2 (register 238).

`POST /api/marketplace/shopee/reclamacao/acao` (`PERM.incidenteResolucao.write`,
a STRICT body validated before the conta loads) answers 200 `{ ok, acao,
returnSn, atualizacao }` with ZERO Firestore writes · 400
`SHOPEE_RECLAMACAO_BODY_INVALIDO` · 404 `SHOPEE_RECLAMACAO_INEXISTENTE` · 409
`SHOPEE_RECLAMACAO_ACAO_RECUSADA` (our gate, with `motivo` and
`acoesDisponiveis`) · 409 `SHOPEE_RECLAMACAO_RECUSADA_PELA_SHOPEE` (a classified
refusal) · 502 `SHOPEE_RECLAMACAO_FALHA_SHOPEE` (an unclassified one: Shopee
answered and refused, so the outcome is KNOWN; `codigoShopee` goes through
`codigoSeguro` — trimmed, never segment-stripped, `null` when it is not a
short token — and Shopee's sentence never reaches the body or the log).

⚠️ **No Shopee sentence leaves either route.** The package builds every
envelope error's message as `Shopee <path> respondeu <code> (HTTP n) — <the
sentence>`, and the shared `shopeeErrorResponse` logs and returns `message`
verbatim. So every other envelope error — re-auth, rate limit, transient —
reaches that mapper through `semFraseDaShopee` (`respostaReclamacao.ts`, which
both routes import): same class, kind and status, the code through
`codigoSeguro` (else `<nao-token>`), our message only. Errors whose message is
already ours (network, non-envelope HTTP, schema, config, the conta classes)
go to the mapper as they are.

`GET /api/marketplace/shopee/reclamacao/estado?integracaoId=&returnSn=`
(`PERM.incidenteResolucao.read`, `Cache-Control: no-store`) answers the live
`EstadoDevolucaoShopee`: status, amounts in reais, the deadlines in
MILLISECONDS (Shopee seconds × 1000, the HTTP unit), the eligible solutions,
`acoesDisponiveis`, `motivoSemAcao` and `pendenciasForaDoErp` (`contestar`,
`enviar-evidencias`, `organizar-coleta`: what only the Seller Centre can do).
`get_available_solutions` is read only when the status leaves the actions open,
and six classified refusals of that SIDE read degrade to `solucoes: []` rather
than losing the panel. A refusal of the return read itself is 404
`SHOPEE_RECLAMACAO_INEXISTENTE` when the classifier reads
`devolucao-inexistente`, and otherwise the same 502
`SHOPEE_RECLAMACAO_FALHA_SHOPEE` — never a 409, because a read has no remedy
the operator could apply.

## 10. The refusal vocabulary (`recusaDevolucao.ts`)

ONE vocabulary, `MOTIVO_RECUSA_DEVOLUCAO` (twenty slugs), serves both our gate
and Shopee's refusals, and `FRASE_RECUSA_DEVOLUCAO` holds its ONE pt-BR sentence
per slug: two near-identical tables were designed and merged before either
shipped (#1369). The slug is PERSISTED on the wire (the 409's `motivo`), so a
rename is a change on both sides of a deploy.

`classificarRecusaDevolucaoShopee` reads the envelope code through
`codigoCanonicoShopee` and Shopee's sentence through `fraseCanonicaShopee` (the
app's established seam), and NEVER `err.message`, which is our own formatted
sentence. ⚠️ The one-segment strip of `codigoCanonicoShopee` is safe here only
because none of the six v1 pages documents a dotted code; the dotted family
(`number.error`, `return.status.illegal`) belongs to the DEFERRED `dispute`, where
`number.error` would fold to `error`. A structural test pins every table key to
`/^(error_|err_|rraoc_)/`. `null` means "not a refusal we know": the importer
lets it propagate, the route answers 502.

## 11. The web panel (PR 6 — step 21's surface, shipped here)

In the pedido's Incidentes tab, an incidente of origem 5 whose trimmed
`externalId` passes `ehReturnSnShopee` mounts `ReclamacaoShopeePanel`
(collapsed until "Ver situação e ações"; query key `['shopeeReclamacao',
integracaoId, returnSn]`, `staleTime: 0`, `gcTime: 0`, no retry). The panel
renders buttons ONLY from the backend's `acoesDisponiveis` — the web holds NO
availability rule — writes nothing locally, sends centavos, and after an
unknown outcome says the action MAY have been done and refetches instead of
retrying. Unknown means a network error, an unreadable 2xx, or ANY HTTP status
≥ 500 — the route can answer one after the write reached Shopee — except the
two whose outcome is known: 502 `SHOPEE_RECLAMACAO_FALHA_SHOPEE` (Shopee
refused) and 503 `SHOPEE_REFRESH_EM_ANDAMENTO` (nothing was sent). While the
estado read is in error the action buttons are disabled: a failed refetch keeps
the previous list, which may offer what Shopee has withdrawn. The offer modal
preselects nothing and refuses an out-of-range amount rather than clamping it.

The **lock (R-16, both channels):** an imported row (origem in
`ORIGENS_INCIDENTE_MARKETPLACE` with a non-blank `externalId`) shows Tipo and
Origem disabled, and `buildIncidentePatch` drops both keys structurally;
marketplace origens are not offered for a manual row. The importer's
re-assertion (§4) is the other half.

## 12. Dispositions — what parks, what defers

| what                                                                  | disposition                                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| no `shop_id`, or the parser refuses (incl. a JSON-number `return_sn`) | **park**, before any Firestore read                                                            |
| a shop that maps to no active integração                              | **defer**, the shared UNPREFIXED `sem-conta` (connecting the shop makes the return actionable) |
| the pedido does not exist                                             | **defer** `devolucao-adiada`, plus ONE synthetic code 3 (`origem: 'devolucao'`)                |
| `ignorado-inexistente`                                                | **park** "devolução <sn> não existe na Shopee"                                                 |
| `ignorado-outro-pedido`                                               | **park** with the importer's own `detail`, which names the id that differed                    |
| a null `pedidoId` / status on any other action                        | **park** "contrato do handler violado"                                                         |
| the importer throws                                                   | `disposicaoDaFalhaDeDevolucao`: the shared class table with the `devolucao:` prefix            |
| every other action (obsolete and unchanged included)                  | **resolve**, label `devolucao`                                                                 |

The synthetic code 3 is stamped `carimboDoDiaUtcMs(nowMs)`, so the deferred
lane's daily re-drives of one return land on ONE code-3 row per order per UTC
day, and it is contained only on `ShopeeTasksDisabledError` (a configured mode).
No age gate: a REAL code 3 at `TO_RETURN` already creates the same pedido for a
never-imported order.

## 13. Units

- Wire SECONDS → µs ONLY through `microsDeSegundosShopee` (µs site 3); every
  deadline through the 2020 floor first. ⚠️ Never `coerceToMicros` on a wire
  value: it reads Shopee seconds as milliseconds (1970), a watermark that says
  "older" for ever (a test pins that near-miss).
- The aviso's "now" through `agoraUsDe` / `depsDeEscrita`
  (`avisos/autorizacao.ts`, site 1). The incidente `timestamp` is
  `create_time` in µs, else the watermark, never a wall clock.
- The HTTP estado speaks MILLISECONDS (`segundos * 1000`, not a µs
  conversion); money is centavos on the HTTP wire and reais to Shopee.
- So step 17 adds NO µs site: `apps/shopee/CLAUDE.md`'s list still says eight.

## 14. What it does NOT do, on purpose

- **`dispute`, `cancel_dispute`, `upload_proof`, `convert_image`,
  `query_proof`, `get_return_dispute_reason`.** Deferred together: `dispute` and
  `cancel_dispute` both REQUIRE the operator's email (whose? undecided), the
  evidence upload needs an `arquivos` owner, and the reads drive nothing without
  them. Their codes are dotted, so they bring a full-code classifier.
- **Reverse logistics.** The two status tokens are stored on the block; no frete
  estado is written for the reverse leg (step 7's `retorno` reason now points
  here, `freteShopeeMapping.ts`). A reverse-leg estado is an open follow-up.
- **Settlement money** (`seller_return_refund`, `total_adjustment_amount`):
  step 6 declared the fields and books nothing from them.
- **A `Conversa`.** Shopee returns expose no message thread.
- **An unpark tool, a release button, a `?aba=` deep link, a
  `pedido.marketplace.status` badge.** Not adopted (reconcile R-20).
- **Any window operation.** No index (every read is by derived id), no ruleset
  (incidentes are not in `VALIDATOR_WHITELIST`; both `gen:rules*:check` stay
  green), no migration, no backfill.

## 15. Residuals, stated rather than fixed

- **A lost aviso effect behind a `relogio-avancado` replay** stays lost until a
  later `ignorado-sem-mudanca` delivery or any content change (`atualizado`):
  rebuilding the old clock would need the PREVIOUS watermark, which the
  confirmed state does not carry.
- **A hand-edited, unreadable block resets `revisao` to 1**, which can move the
  aviso clock backwards at an equal watermark. Not reachable by the importer.
- **A JSON-number `return_sn` parks** (the parser refuses what `JSON.parse` may
  already have rounded); the poller is its backstop.
- **Deleting an imported row lifts the overlay** until a delivery or the
  poller re-creates it — the poller within 6 hours, but only for a return
  updated in the trailing 15 days; an older return at rest stays lifted until
  its next push (or §5's one-shot pass).
- **A row left open by an unverified terminal set blocks `finalizar`** with no
  in-app release (superuser `liberarBloqueioIncidente` only), and once its
  return rests past the poller's 15-day window, correcting the set no longer
  heals it (§5).
- **A persistent `divergente`** (the list spelling a sub-status differently from
  the detail, register 240) costs one `get_return_detail` per such return per
  tick, bounded by the per-conta caps; the fix is ONE fold in
  `motivoDeReimportacao`.
- **A 409 on `confirmar` / `aceitar-oferta` never lists `ofertar`** among the
  remaining actions: the solutions are not read on those paths.

## 16. What is UNVERIFIED, and what settles it

The settle-live register for step 17 is **rows 231–247** in the master plan, all
open; most need a Brazilian shop. The ones with an instrument already in the
code:

| register | question                                                | instrument / constant                                                                                                       |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 231      | the success `error` per op (`""` / `" "` / `"-"`)       | `erroEnvelope` on the importer, estado and action log lines; the poller's `errosDeEnvelope`; `SHOPEE_RETURNS_ERROR_ALIASES` |
| 232      | the terminal `ReturnStatus` set                         | `STATUS_DEVOLUCAO_TERMINAIS` (one constant); the poller heals only returns updated in the last 15 days — the rest: §5       |
| 233      | whether silent changes move `update_time`               | the poller's `enfileiradas.divergente` count                                                                                |
| 235      | `page_no` page index vs offset, and its base            | `paginacaoAmbigua`                                                                                                          |
| 237      | `confirm` accepted in `PROCESSING`                      | the gate's `confirmar` status set                                                                                           |
| 238      | BR decimals for the offer amount (2 assumed)            | the modal's `CurrencyInput` (`decimalScale={2}`)                                                                            |
| 239      | read-after-write convergence after an action            | the synthetic `acao-vendedor` code 29 and the panel refetch                                                                 |
| 240      | `seller_compensation_status` spelling, list vs detail   | `motivoDeReimportacao`'s one fold point                                                                                     |
| 241      | `reverse_logistics_status` vs `reverse_logistic_status` | the package's `grafiasDaLogisticaReversa` (both read)                                                                       |
| 242      | how often BR returns have `is_seller_arrange`           | `organizar-coleta` in `pendenciasForaDoErp`; not an aviso trigger                                                           |
| 245      | `v2.returns.*` rate limits                              | a rate limit aborts the poller's tick, logged; the next tick is the retry                                                   |

The rest — push 32's `return_solution` encoding and the
`LOGISTICS_NOT_STARTED` spelling (236; capture the sandbox Push Test Data body
as a fixture), an update-only list window (234), code 29's redelivery cadence
(244), `dispute` in `ACCEPTED` (243), the `order_status` after `TO_RETURN` (246)
and a return before shipment (247) — are questions for the first BR traffic.

## 17. The dry run and the tasks round trip

`importar:devolucao` (`scripts/importar-devolucao.ts`, PR 4) rehearses ONE
return against a conta: it prints the envelope's `error`, the mapped block, the
decision the transaction WOULD take (`preverIncidenteDevolucaoShopee` on a plain
read) and the aviso effect it would apply (`preverEfeitoDoAvisoDeDevolucao`).
It writes nothing and refuses `--live` with a reason — the parser, with that
refusal and the `ehReturnSnShopee` gate, is the tested
`importarDevolucaoCli.ts`; the runbook is `scripts/README.md`. It is never run
by an agent.

`devolucao.tasks.test.ts` joins the `Shopee Cloud Tasks round trip` job by its
suffix (no new check), with four cases. Three go through the real queue: a
signed code 29 for an unmapped shop defers `sem-conta` (a bundle from before
this step would park it); a synthetic code 29 on a conta with no credential and
a present pedido resolves BOTH dynamic imports in the BUILT artifact and defers
with the `devolucao:` prefix before any fetch; and one with no pedido defers
naming the synthetic code 3, whose own row lands at the UTC-day stamp. The
fourth runs IN-PROCESS, because a dispatched path that reached
`get_return_detail` would really leave the runner: `importarDevolucaoShopee`
with a stub client against the emulator Firestore — `criado`, an identical
replay that leaves `updateTime` unchanged, an older detail ignored, an
equal-and-different one at `revisao` 2, and a newer one that only advances the
clock.

## 18. Deploy order, and the window

**`apps/functions` (codebase `storage`) → `apps/shopee` App Hosting →
`apps/web` → this codebase's functions.** The storage functions carry the
widened overlay predicate and `relogioProvedorUs` in `ignoreFields` (a Shopee
row written before them never blocks until its next write); App Hosting carries
the two routes the web calls; the web carries the panel, the lock and the
aviso's `mensagens.ts` row; the Shopee functions — the importer, the poller and
the aviso producer — go last.

⚠️ **Rule 8.** The poller's valve ships ON, so the cutover deploy imports every
return updated in the 15 days before it and starts blocking `finalizar` on
those pedidos. To hold it, set `SHOPEE_DEVOLUCAO_SWEEP_DISABLED=1` in the
cutover's `functions/.env.deploy` (`functions/DEPLOY.md`). Two window items are
ASKED, never opened: a one-shot `get_return_list` pass over the return horizon
for the returns open at the cutover (the legacy app wrote no Shopee incidente,
and the poller's first run sees only 15 days), and this deploy order joining
#1208.

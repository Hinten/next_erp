# lib/shopee/pedidos/ — payments, settlement and shipment tracking (steps 6 and 7)

Moved out of `apps/shopee/CLAUDE.md` in step 12 (#1520) to free the Codex
instruction budget (`.codex/project-config.test.mjs`). The two sections below
are the guide's own bytes; only this title and this paragraph are new, and
nothing needed repairing — both `##` heading lines stayed in the guide as
stubs, and the one internal "below" points inside its own section. ⚠️ The one
byte-level difference: `**/CLAUDE.md` is `.prettierignore`d and this file is
not, so Prettier aligned the settle-live table's pipes. No cell text changed.

## Payments and settlement (`lib/shopee/pedidos/pagamento*.ts` + `liquida*.ts`, step 6)

**There is no payment event.** Shopee ships no payment push and no payment
resource of its own, so a pagamento is written on the SAME code-3 task that
writes the pedido, from the SAME two calls (`get_order_detail` +
`get_escrow_detail`), in a SECOND transaction (`pagamentoTx.ts`) that runs after
`salvarPedidoShopee` and before the incidentes. **Nothing new is fetched on the
task path**, which is why `processShopeeNotification`'s 300 s budget is
unchanged. ⚠️ A pedido that came out `ignorado-sem-mudanca` does **not** skip the
pagamento path — the escrow carries no clock of its own, so the money can move
while the order row does not. Only `ignorado-obsoleto` skips it.

**Identity: a digest, and a DIFFERENT preimage from the pedido's.**
`makePagamentoIdShopee(contaId, orderSn, sufixo?) =
sha256("integracao/<contaId>-<order_sn><sufixo>")` — the LEGACY Flutter
preimage, which built it from `pathNoDocuments`. ⚠️ It is **not** Mercado
Livre's `sha256("/documents/integracao/…")` — the leading slash and the
`documents/` segment are exactly what differ — and it is **not** the pedido's
bare `sha256("<contaId>-<order_sn>")` one collection up. The legacy corpus
survives the cutover with its ids, so a different spelling forks every migrated
Shopee pagamento on its first re-import. The `id` FIELD is `order_sn` on the
primary and `<order_sn>-<n>` on a secondary, but **ownership inside the
transaction is decided by RECOMPUTING the doc id**, never by reading that field:
it rides `...base` through the operator's form and is therefore reachable by an
edit. That is also what keeps the legacy `<order_sn>-desconto` sibling out of
this transaction entirely — a numeric suffix can never collide with it, and
step 6 never reads, writes or deletes it.

**N documents, not one.** A BR order's `get_order_detail.payment_info[]` is a
LIST (NT 2025.001) and a combined payment really does carry two rows — one
`credit_card`, one `pix`, each with its own `payment_amount`. The fan-out
happens only when `2 ≤ N ≤ 8` **and** `Σ payment_amount` equals the pedido's
`valorCobrado` to the centavo; anything else collapses to ONE primary document
with a named reason (`soma-divergente` / `excede-maximo`) and one `console.warn`
carrying numbers only. Entries are ordered DETERMINISTICALLY by content (method,
authorization code, amount, joined on a NUL) so the wire order can never decide
which document takes which id.

**⚠️ Σ pagante `valor` MUST equal `valorCobrado` to the centavo.** The NF-e
bundle sums `vPag` over `isPagamentoPagante` and throws (cStat 866 for an
excess, 865 for a shortfall), and `<vTroco>` is not available to us —
`canalDevolveTroco` is FALSE for every marketplace. So `valor` is the
BUYER-facing figure (the pedido's own `valorCobrado`, from
`buyer_total_amount` → `total_amount` → Σ items + frete), **never
`escrow_amount`**, which moves until the order completes. A non-pagante status
makes a payment invisible to the NF-e rather than merely unpaid.
⚠️ A later delivery carrying FEWER entries never deletes, never neutralises and
never re-takes the primary's `valor` — whether `payment_info` survives past
`READY_TO_SHIP` is settle-live register item 22 and is **NOT yet known**, so a
shrinking payload is read as lost detail either way — and re-taking it would
nearly double Σ pagante against the siblings an earlier, richer delivery wrote.
That is the "degraded delivery" freeze, and a stored document is never
deleted — one the operator removed is recreated on the next delivery, because
the money really did move.
⚠️ **The freeze has a second direction, and it costs the same.** While the DATA
group is frozen — by `degradado` or by a human's `hasUserInteraction` — a
delivery that maps MORE documents than we own does not CREATE the extra ones
either: the stored primary is still standing at whatever a poorer earlier
delivery gave it (often the WHOLE `valorCobrado`, because that delivery carried
no `payment_info` at all), so a new sibling at its own leg amount lands Σ
pagante ABOVE the nota. `hasUserInteraction` is a LATCH, so nothing later
repairs it. One `console.info` says the set could not grow. The gate needs at
least one document of OURS already stored: a pedido a human touched before its
first pagamento arrived still gets the whole set created, and so does one the
operator deleted.

**The status ladder is driven by the ORDER status, never by a payment event.**
No usable `pay_time` ⇒ no pagamento is CREATED (⚠️ the gate is creation-only: a
document of ours that already exists still gets the ladder and the dates, so a
`CANCELLED` re-read whose `pay_time` came back `0` still moves a stored
`aprovado` to `estornado`). `PENDING` + `pay_time` ⇒ `em_processo_aprovacao`;
the five shipping statuses + `COMPLETED` ⇒ `aprovado`; `IN_CANCEL` / `TO_RETURN`
⇒ `em_disputa`, which **STILL COUNTS AS PAID** (`isPagamentoPagante`'s own
docblock: a mediation is a hold, not a reversal); `CANCELLED` ⇒ `estornado`.
`aprovado` never regresses to `em_processo_aprovacao`; `estornado → aprovado` is
allowed and logged as a resurrection (the ladder is driven by a re-fetch of the
live order); a stored value outside the governable set — an operator's
`recusado` or `devolvido` — is never walked back.

**`tarifas` is the marketplace's cut, and it is Shopee's own fee columns**:
`commission_fee + service_fee + seller_transaction_fee` (FAQ 479's three Income
Report columns), with the BR `net_*` variants preferred where they arrive.
⚠️ `credit_card_transaction_fee` is a ROLLUP of the buyer and seller halves and
is **never** summed with them. The value is clamped at 0 (`pagamentoSchema`
declares `.min(0)`; an unclamped negative is a ZodError that PARKS the code-3
delivery terminally — `disposicaoDaFalhaDeImportacao` in
`notificacoes/notificacao.ts` — and, on the weekly sweep, is not in
`erroContidoPorConta` at all, so it aborts the WHOLE tick rather than one
conta — #794); the pre-clamp raw and the named fees ride the new
`pagamento.marketplace` block, a DIARY nothing gates on. The legacy composition
(`buyer_total_amount − escrow_amount_after_adjustment`) survives as the named
seam `COMPOSICAO_TARIFAS_SHOPEE`. ⚠️ `tarifas` and `tarifasBrutas` are NOT the
two readings — they are the shipped composition clamped and unclamped, i.e. one
number twice — so the import log carries a third, `tarifasSpread`, and that is
what the first live BR orders compare as data rather than as an argument. On N
documents the fee rides the PRIMARY and the secondaries carry a real `0`.

**`cartao` is written only for formas 3/4/17 and is NEVER cleared.** It comes
from a `payment_info` entry (`tpIntegra '2'`, the processor's CNPJ, the brand,
`transaction_id` as `cAut`) and is OMITTED — not `null` — when no entry supplies
it: PIX needs a `<card>` block or SEFAZ rejects with cStat 391, and a `null`
would mean "there is none" where the truth is "we did not learn". A masked or
CPF-shaped register is written nowhere, and `payment_processor_register` /
`transaction_id` never reach a log line.

**Two writers, DISJOINT masks.** The task path owns `valor`,
`forma_de_pagamento`, `status_pagamento`, `parcelas`, `aVista`, `cartao`, `id`,
`descricaoPagamento` and the date stamps, and it never names `liquidacao` in a
patch. The weekly sweep owns the **top-level `liquidacao`** — top level, not
nested inside `marketplace`, precisely because an `update()` masks at a
top-level key, and that is what makes the two masks genuinely disjoint — and it
REFRESHES the marketplace-owned money (`tarifas` and the `marketplace` escrow
diary). Both compute that money with the SAME pure `tarifasDeShopee` /
`diarioMarketplaceDeEscrow`, imported by each and re-derived by neither, so two
writers racing one document agree by construction instead of by a comparison.
⚠️ `onPagamentoChanged` ignores only `id` and `ultimaModificacao`, so a replay
that re-stamps anything else files a `historicoDeModificacoes` row: both writers
compare field by field (no `deepEqual`, no `stripNullsDeep`) and a byte-identical
delivery produces an EMPTY patch and no write at all. That is also why
`marketplace.atualizadoEm` carries the ORDER clock and never `now`.

**The sweep: `sweepShopeeEscrowSettlement`, Mondays 05:10 America/Sao_Paulo.**
Per active conta it pages `get_escrow_list` on `escrow_release_time` — the ONLY
Shopee surface that exposes that field at all — from a durable per-conta cursor
(`liquidacaoShopee/{integracaoId}`, MILLISECONDS, this sweep its only writer,
ONE merge per conta per tick, no transaction) with a one-day overlap, a 30-day
initial lookback and a 15-day self-imposed maximum window (the page documents
none). Paging is by `page_no`, not a cursor, and Shopee documents **no
ordering**.

- **Drained** (`more === false`) ⇒ the cursor advances to the WINDOW's upper
  bound, never to `now`: `[ateMs, now]` was not queried. **Truncated** by the
  page cap or the per-tick liquidation budget ⇒ nothing advances and the window
  plus the next page number are persisted for the next tick.
- ⚠️ **A cold conta takes two ticks to reach the present, and that is not a
  bug.** `ateMs` is measured from `deMs`, so the first window of a conta with no
  cursor is `[now − 30 d, now − 15 d]`; the following week's tick covers the
  rest. The alternative — measuring the bound from `now` — would claim ground
  the query never covered.
- **The page-repeat guard.** A non-empty page with `more: true` that contributes
  ZERO new `order_sn` means `page_no` is being ignored: the tick stops, names
  it, CLEARS the stored page number and restarts from page 1 next week. An
  EMPTY page with `more: true` keeps paging (bounded by the page cap) — the two
  cases read identically and are deliberately tested as a near-miss pair.
- **Parked rows (`pendentes`, ≤ 200, ≤ 4 attempts).** A row whose pagamento does
  not exist yet is stored WHOLE (not as an id) and gets ONE synthetic code 3
  with `origem: 'liquidacao'`, so the pedido and its pagamento arrive by the
  normal import path. ⚠️ **Every tick REPLAYS that list before it pages
  anything**, and that replay is what `MAX_TENTATIVAS = 4` counts: a released
  row is visible only in the windows covering its release time, so once the
  cursor moves past it the row never comes back and the parked copy is the only
  place its payout still exists. A row that settles leaves the list; one still
  missing a pedido four weeks later is dropped with a warning, because that is a
  human question and not a retry. ⚠️ The same is true of a row whose escrow
  answers `order_not_found`: it is counted in `puladas` and skipped for ever, and
  `--order-sn` can only CONFIRM that answer, because the flag is dry-run only —
  there is no CLI path that settles such a row.
- **Budgets per tick**: 100 rows per page, 20 pages, 300 settlements, 50
  synthetic pushes. A contained conta error leaves the cursor untouched and
  records `lastError` — a 30-second outage must never skip 300 orders and then
  advance past them.
- **The rehearsal CLI `liquidar:pagamentos`** runs the same window derivation
  and the same pure decision function a live tick runs, so a dry run prints the
  exact patch rather than a second implementation's opinion of it. ⚠️ Sharing
  the DECISION is not enough — the ROW SET has to match too, so the dry run also
  REPLAYS the parked list before it pages, and tags every row with its source
  (`pendente` / `listagem`). Without that it would print "nothing to do" for
  exactly the rows the parked list exists for, and `--live` would then write
  them. ⚠️ Two behaviours an operator will notice: `--order-sn` is
  **dry-run only** (the
  escrow listing is queried BY WINDOW and has no by-id form, so that path never
  learns `payout_amount` or `escrow_release_time`; the settlement itself is
  FILL-OR-KEEP, so a null incoming stamp never overwrites a stored one, and the
  refusal is defence in depth against a write that could never learn anything),
  and a `--de`/`--ate` window
  override **never advances the cursor** (an operator-chosen window would
  otherwise claim the unqueried ground between the cursor and that window).

**Not built, and not a shortcut anybody may add later: `get_escrow_detail_batch`.**
Its response drops eleven fields the single call carries — including
`buyer_total_amount`, `escrow_amount_after_adjustment`, `total_adjustment_amount`
and `tenure_info_list` — so it can produce neither the pagamento's `valor` nor
its `tarifas`, and it carries **no per-order `error`**, so a batch of 50 in which
one order fails is indistinguishable from a batch in which none did.

**The settle-live register for step 6** — four questions the docs cannot answer,
each instrumented rather than guessed:

| question                                         | state, and what settles it                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payout_amount`: cents or units?                 | ⏳ the page contradicts itself INSIDE one document (table `"5733.04"`, rendered JSON `57334`). The per-order settlement log prints `payoutAmount` beside `escrowAmount` / `escrowAmountAfterAdjustment` **and their ratio** — ~1 is units, ~100 is cents. Nothing in the package or the sweep converts it. |
| BR `payment_info[]`: present, and masking-gated? | ⏳ the SG sandbox answered `payment_info: null` (key present); announcement 1240 says `READY_TO_SHIP`. The import log carries `entradasPaymentInfo` — a COUNT, never a value — so the first live BR orders answer both halves without a field ever reaching a log line.                                    |
| `instalment_plan` format beyond `"N/A"`          | ⏳ three shapes on record (the `"N/A"` sentinel, a quoted number, an int), so the package schema is a union and ONE reader owns the fold; an unparsable raw is logged once, by the parser.                                                                                                                 |
| when is the escrow READABLE, and when FINAL?     | ⏳ undocumented. The escrow read stays CONTAINED on the task path (an absent one omits the fee keys rather than erasing them), and the sweep is what stamps final — `liquidacao.escrowReleaseTimeUs` being set is the strongest "money is final" signal this channel has.                                  |

## Shipment tracking (`lib/shopee/pedidos/frete*.ts` + `rastrearPedido*.ts`, step 7)

Three push codes — **4** (`order_trackingno_push`), **30**
(`package_fulfillment_status_push`) and **47** (`package_info_push`) — become
ONE thing: a per-package observation merged into `pedidos/{id}.freteInicial`.

**The push is a POINTER, never a payload.** Every delivery re-fetches
`v2.order.get_package_detail` for the named package — one call, one package —
and applies THAT. `guide 746` says it in Shopee's own words ("Push NÃO substitui
API. O Push só diz: 'Algo mudou.'"), and here it is load-bearing three times
over: it makes a replayed or out-of-order delivery idempotent, it gives **code 4**
a clock (its page documents no `update_time`, so the only clock on that body is
the envelope stamp, which is OURS), and it is what stops `push 44`'s
echoed-unchanged `logistics_channel_id` from rewriting a channel nothing moved.
`changed_fields` is therefore a DIAGNOSTIC and never a gate: the gate is
structural, because no push value has a path into a patch.

**Why `get_package_detail` and not `get_tracking_info`.** The tracking page is
per-ORDER, returns **no tracking number**, types its package-level field against
the 13-value `LogisticsStatus` while push 33 sends the 11-value
`PackageFulfillmentStatus`, and is the only page in the whole cached API corpus
that documents `logistics.error_status_limit` — a status gate whose passing
statuses no page names. The package page answers `fulfillment_status` +
`tracking_number` + `ship_by_date` + `logistics_channel_id` + `update_time` for
up to 50 packages in one call, in the same enum the push uses.
`get_tracking_info` is **not built**; `get_tracking_number` is step 15's.

**Two `-` problems, one page.** `get_package_detail` samples `"error": "-"`
where every other order page samples `""`, so the op carries its own
`emptyErrorAliases: ['-']` — per OPERATION, because the contradiction is per
PAGE, and it is now the THIRD such constant beside the two lost-push ones. And
it samples `"tracking_number": "-"` on the PAYLOAD, so `textoShopeeUtilizavel`
— the string twin of `positivoOuNull`, in `orderMapping.ts` — is the one reader
that turns it into `null` before anything is written. The rule is the WHOLE
trimmed value: `'--'` and `'BR-123'` survive. A `codRastreio` of `"-"` is a
value `/pedidos` renders verbatim beside a copy button.

**Three push codes and one order import, ONE record.** Everything that can
observe a package produces the same `PacoteObservadoShopee` — the pull (always,
on a push) and the code-3 order import from `get_order_detail.package_list[]`,
which is the **BACKSTOP** and costs no new call because step 5 already fetched
that body. The backstop is not optional politeness: the pushes are lossy by
design (`timeout=3`, `push_guarantee=0`, three retries and then gone) and the
sandbox console cannot emit codes 30 or 47 at all. The record carries the RAW
wire token and its `fonte`, and the fold is one table in one place.

**The pedido may not exist yet, and that is expected.** No page anywhere states
an ordering between push codes, so a code 4 can precede the code 3 that creates
the pedido. The handler reads the pedido FIRST — before spending the Shopee
call — and on a miss enqueues ONE synthetic code 3 (`origem: 'rastreio'`, the
**fourth** `OrigemSintetica` member and the only one driven by a push rather
than by a sweep) and DEFERS. The bound is **`1 + MAX_TENTATIVAS_DEFERRED` = 8**
synthetics per delivery — a `defer` does not retry on the queue, the deferred
lane re-drives daily seven times and then parks, and this handler enqueues at
most one per invocation — and the sequence stops the moment the pedido exists.
⚠️ "Only on the last retry" is NOT implementable: the shared pipeline's
`process(db, payload)` carries no attempt count.

**The arm's outcomes.** `frete { acaoFrete, orderSn, packageNumber, pedidoId,
statusMarketplace, estadoEscrito, campos, detail }` resolves (its own
`toDisposition` label, `'frete'`), and `frete-adiado { shopId, orderSn,
packageNumber, reason, sintetica }` defers. ⚠️ The field is `acaoFrete` and not
`acao` on purpose: `handleNotificationTask` reads the result with structural
`in` checks and the `pedido` outcome already carries an `acao`, so an `acao`
here would put an import action in the frete column of the task log.
`TaskResult` gained `packageNumber?` and `acaoFrete?`, both spread only when
present (the key is ABSENT, never `null`), and `acaoFrete` rides a **code-3**
delivery too — there it is the BACKSTOP's verdict.

⚠️ **The arm reaches both the reader and the handler through
`await import(...)`.** A static import would pull the schema tree into the
receiver route's Next bundle: `fretePushShopee.ts` imports the small tolerant
readers from `orderMapping.ts`, which imports `@delfrance/schemas` as VALUES. A
test bans any static value import from `../pedidos/` in `notificacao.ts` for
exactly that reason, and it covers the reader as well as the handler.

**What this step never writes.** `lastMarketplaceUpdate` — the ORDER clock,
step 5's single writer, and comparing a package event against it is ADR 0011's
cross-clock failure — and `freteInicial.ultimaModificacao`, step 5's order
watermark: rewriting it would ping-pong with `mesmoFrete` and file one audit row
per delivery. ⚠️ **"Never written" here means never ASSIGNED.** The stored
`ultimaModificacao` IS carried by the whole-map rebuild's spread and must be,
because `update()` masks at the top-level key and omitting a nested field from
the rewrite ERASES it — so the honest assertion, and the one a test pins, is
that the value in the patch is byte-identical to the stored one. Also never
written: a `historicoFtIni` row (the `onPedidoChanged` trigger derives that trail
from the `freteInicial.estado` this step writes, comparing the NESTED estado only
— call-site appends were rejected in PR #720); a `freteInicial` block that does
not exist (step 5 seeds it; an absent one answers `ignorado-sem-frete-inicial`,
an absent pedido `ignorado-sem-pedido`, and this transaction creates neither);
`externalId`, `volumes`, `valorCobrado`, `custoCalculado`, `custoFinal`,
`dataPrevisaoEntrega` and `dataEntrega` (no source — `pickup_done_time` is not a
delivery time), all of which ride the spread unchanged; the pedido's own
`estado` / `itens` / `marketplace` / `capturaComprador`; any stock; a label; a
return; an `int_frete`. **Beyond the block it writes exactly one thing**: the
pedido's `ultimaModificacao`, which is in both ignore lists, so it files no audit
row and only surfaces the pedido in the recency monitor.

⚠️ **`freteInicial.estado` moves PHYSICAL STOCK.** `sincronizarEstoquePedido`
observes it and `ESTADOS_FRETE_REMOVE_ESTOQUE` starts at `empacotado` — and this
channel's table puts `LOGISTICS_REQUEST_CREATED` at `aguardandoPostagem`, which
is inside that set. A fold that answers one estado too eagerly takes goods out of
inventory; one that never answers leaves a delivered order reserving them. That
is why an **unknown token writes nothing at all** and is logged once per
delivery, rather than defaulting to anything.

⚠️ **"Nothing" is the BLOCK estado, and the rule is about N packages.** An
unknown token — or a return-only one, or a `package_list[]` row carrying no
`logistics_status` at all — on **ANY** package blocks the block-estado write for
the whole pedido: `dobrarPacotesShopee` answers `estado: null` and raises
`estadoBloqueadoPorPacoteSemEstado`, which rides `diagnosticos` into the one log
line, and `preverFreteShopee` then refuses with `token-desconhecido` (the outcome
is `ignorado-desconhecido` when nothing else changed). The diary still records
the raw token, so **a table fix retro-applies on the next delivery**, with no
wire event. Read as "an unreadable row is simply invisible to the fold" the
sentence was true for ONE package and false for two: the remaining packages
decided alone, and the only direction they can move the answer is UP the ladder,
into the removal set, for a parcel nobody could read. The other three fold
outputs (`codRastreio`, `prazoDespacho`, `externalOptionId`) and the diary merge
are untouched — an unreadable token costs the estado slot, never the delivery.
⚠️ A FAILED package is NOT this case: `faq 510` says to ignore it and the fold
still does (a `cancelado` beside a `postado` folds to `postado`), because a
failure is a state we READ.

**The diary is `freteInicial.pacotes`** — an array of typed rows sorted ASC by
`numero` (plain code-unit comparison, never `localeCompare`), nested inside a
block the rulesets emit one `is map` clause for, so it regenerated no ruleset and
needs no index. Each row keeps the RAW `estadoMarketplace` as the **source of
truth** and its `estado` as a PROJECTION re-derived from that token on every
delivery (#1369), so a correction to the table retro-applies with no wire event.
`atualizadoEm` (µs, the PACKAGE clock) advances ONLY when one of the four WIRE
fields changed — never because we looked, never on a change to the derived
estado — which is what makes a replay an empty patch and stops the backstop
re-stamping every row on every import. Rows the delivery did not name are left
exactly as stored: Shopee splits ONE order into N packages (`package_list[]`, and
`get_package_detail.is_split_up` / `can_split_order`), so a number missing from
one answer is not evidence the parcel stopped existing. ⚠️ That is NOT what
`consolidaPacote: 'nao'` says — that row says the other direction, several orders
are never consolidated into one parcel here (`orderPedidoTx.ts` reads it that
way), and it carries no split claim at all.

**The block's single `estado` is a FOLD over the diary**, not the latest event:
the LEAST-ADVANCED live package by ladder index, and when none is live the first
member of a DECLARED failure precedence (never "the latest by clock", which is
not idempotent under out-of-order pushes). It reproduces `faq 510` — Shopee's own
order status follows the package fulfilled earliest, ignores failed packages and
completes only when all are delivered — and it is the stock-safe direction, since
a pedido's stock leaves as a WHOLE. The write is then gated by a monotone verdict
that refuses a regression, preserves a return or an `error` state, and logs a
`ressuscitado` when a terminal is traded for a non-terminal.

⚠️ **`prazoDespacho` CHANGED OWNER.** Step 5 no longer refreshes it —
`CAMPOS_FRETE_ATUALIZAVEIS_SHOPEE` is **seven** fields now and `mesmoFrete`
compares those seven — because step 5's order-level value and step 7's
per-package minimum would otherwise overwrite each other on every delivery of a
split order. The create path still seeds the order-level deadline. Step 7 folds
the EARLIEST package deadline, never `min(stored, incoming)`: `push 44`'s two
samples disagree on the DIRECTION of a `ship_by_date` move, so a monotone floor
would make a pushed-out deadline unreachable for ever.

⚠️ **Convergence between the push and the backstop is REAL but narrower than
"the package call wins".** A `get_package_detail` observation has higher
fidelity than a `get_order_detail` one, and the lower-fidelity source never
re-stamps `fonte` or `atualizadoEm` — those two are what the sentence is about.
`estadoMarketplace` is deliberately **take-new-when-present**, so a later order
import really does overwrite a pull's token in the diary ROW: measured, a pull
that wrote `LOGISTICS_PICKUP_DONE` is followed by an import that rewrites that
row's token to `LOGISTICS_READY`. Two nets contain it and both are pinned — the
ladder never walks the BLOCK estado back (`postado` stands), and the clock and
`fonte` are not re-stamped, so the row does not claim to be fresher than it is.
A fill-or-keep on the token was the alternative and is worse: it would make the
machine one-way and a `PICKUP_RETRY` after a `PICKUP_FAILED` unreachable. Whether
the two readings ever disagree LIVE is register item 28, and the per-delivery log
prints both tokens plus a `divergePushVsPull` boolean.

⚠️ **A step-7 write is not literally byte-preserving over an under-populated
stored block** — and that is true of every writer of `freteInicial`, not of step
7 alone. `parseMerge` validates the nested block in FULL, so a partially stored
sub-object (a `transportadora` holding only `nome`) comes back with its own
schema defaults materialised. The field-by-field content comparison is what keeps
a replay an empty patch; it is not a byte comparison of the stored map.

⚠️ **`hasUserInteraction` is NOT read here**, deliberately, and step 5's freeze
is not widened. That freeze exists for MONEY and step 7 writes none; the estado
it writes is stock-moving, so blinding the tracking feed of the one pedido an
operator touched is the expensive direction; Mercado Livre's shipment import
ignores the flag too. An operator hand-edit made before the web fix below is
simply a stored value the ladder arbitrates — a hand-set `entregue` refuses a
later `postado`, a hand-typed `codRastreio` is replaced by the first fold value.

**The Frete tab now locks on the BLOCK.** `apps/web`'s `FreteTab` used to key
`marketplaceOwned` on the resolved `int_frete` document alone, and step 5 never
sets an `integracaoFreteOuterRef` (step 20 does) — so a Shopee pedido rendered
the editable generic body and a save latched `hasUserInteraction`. Ownership is
now the OR of the two declarations over the marketplace-owned PREDICATE: a
resolved document can WIDEN the lock and can never narrow it. ⚠️ One consequence
worth knowing before someone reports it as a bug: `headerDisabled` also disables
the `IntegracaoFreteSelect`, so an operator can no longer attach a different
`int_frete` to a Shopee pedido by hand — the importer owns the block.

⚠️ **Code 24 is not part of this step** (see the re-park note under **Inbound
push**), and **`FREIGHT_TIPO_CAPS.shopee.canTrack` stays `false`** until step 15
flips it with `canFetchLabel`, `canPrint` and `channel`. Nothing reads the flag
today except `freightCapsFor` consumers, and `mercadoLivre` carries
`canTrack: false` beside a live shipments handler — so flipping it alone would
make Shopee the first marketplace with `canTrack: true` for no behavioural
reason.

**The rehearsal.** `rastrear:pedido` is the only way to exercise the estado path
before a BR shop exists: of the codes this step owns, the sandbox console's Push
Test Data offers **only 4** — not 30, not 47 — so a state transition cannot be
pushed at all from there. Dry-run by default, it runs the SAME pure prediction the transaction runs
and prints the exact patch — plus what the code-3 backstop would fold from the
same order, which is register item 28 answered by eye. See `scripts/README.md`
§9.

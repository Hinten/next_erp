# apps/shopee/scripts/

Dev-only CLIs. **Never run by an agent** (root `CLAUDE.md` rule 8) — a human
runs them, from this worktree, against the project the environment points at.

| script                   | what it does                                          | writes?                   |
| ------------------------ | ----------------------------------------------------- | ------------------------- |
| `oauth-url.ts`           | mints a Shopee consent URL without the web UI         | one `oauthState` document |
| `importar-pedido.ts`     | imports ONE order through the real step-5 path        | only with `--live`        |
| `liquidar-pagamentos.ts` | rehearses the weekly escrow settlement (step 6)       | only with `--live`        |
| `rastrear-pedido.ts`     | rehearses the shipment merge of ONE order (step 7)    | only with `--live`        |
| `varrer-reservas.ts`     | rehearses the weekly stuck-reservation sweep (step 8) | only with `--live`        |

⚠️ No `--` separator in any command below: pnpm forwards that token into the
script, which parses `process.argv` itself and rejects it.
`packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
that carries one.

---

## `importar:pedido` — rehearsing the first ERP write

`importarPedidoShopee` normally runs unattended: a Shopee push → Cloud Tasks →
`processShopeeNotification` → the code-3 arm. This script drives the same code
from a terminal against one named order, so the channel's first write to
`pedidos` / `clientes` / `enderecos` / `incidentes` is deliberate and observable
instead of arriving on a queue.

### 1. Environment

Same `.env.local` the app itself uses — the script is
`dotenv -e ../../.env.local -- tsx …`, exactly like `oauth:url`.

| variable                                                                      | why it matters here                                                                                   |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `FIREBASE_PROJECT_ID` (or `FIREBASE_SERVICE_ACCOUNT_PATH`'s own `project_id`) | the project written to. `--project <id>` overrides it.                                                |
| `FIREBASE_DATABASE_ID`                                                        | Enterprise names the database `default`; unset resolves to that.                                      |
| `SHOPEE_SANDBOX=1`                                                            | the sandbox app. ⚠️ **Opt-in, exactly `'1'`** — unset, blank, `true` and `0` all mean **PRODUCTION**. |
| `SHOPEE_PARTNER_ID` / `SHOPEE_PARTNER_KEY`                                    | without them `loadShopeeContext` throws before any Shopee call.                                       |

The script prints the project, the database, the raw `SHOPEE_SANDBOX`, the
resolved Shopee environment and the shop id **before it does anything** — read
those five lines before you let it continue.

### 2. The integração must already be connected

The script does not connect anything. It needs an `integracao` document that is
`tipo: shopee` and carries a `shop_id` (a consent given by MAIN ACCOUNT has no
`shop_id`, cannot sign a call, and the script stops on it saying so).

Connect it either from the panel (`/canais/shopee/<id>` → **Conectar conta**) or
headless:

```bash
pnpm --filter @delfrance/shopee-app oauth:url --project <projectId> --integracao <integracaoId>
```

Open the printed URL, log in with the sandbox shop, land on
`?shopee=connected`. The `<integracaoId>` is the Firestore document id of that
integração — the same one both commands take.

### 3. Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app importar:pedido --integracao int-1 --order-sn 220810QSK8S7BX
```

It calls `get_order_detail` and `get_escrow_detail`, resolves the produto of
every line, runs the mappers and prints what a write **would** store. It writes
nothing — the function it calls (`prepararImportacaoPedidoShopee`) contains no
writer at all, which is why the guarantee is structural rather than a promise in
a comment.

⚠️ A dry run is **not offline**: it spends the same two Shopee calls against the
same rate limits.

Add `--json` for the machine-readable form: the same redacted summary on stdout,
with the preamble on stderr so the stdout stays parseable.

### 4. What to read in the output

| line                 | what it tells you                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `escrow`             | `lido` or `AUSENTE`. Absent means prices came from the detail alone — expected on an unpaid order, worth a look otherwise.                 |
| `pedido já existe?`  | whether this run would be a `criado` or an update.                                                                                         |
| `conferência`        | `Σ itens + frete` against the order's own `total_amount`. A `diferença` of `0` is the healthy answer; `—` means the order is not paid yet. |
| `estado alvo`        | what the ladder wants (`pago`, `aguardandoConfirmacaoDePagamento`, …), or `(erro)` for a status this ladder does not model.                |
| `capturaComprador`   | `capturado` / `pendente` / `expirado`, plus the refused field NAMES.                                                                       |
| `linhas sem produto` | how many lines bound to no produto. On staging, expect **all of them**.                                                                    |
| `freteInicial`       | `valorCobrado` is what the buyer paid, `custoCalculado` what the shipment costs.                                                           |
| item rows            | ids, sku, quantity, price, per-unit discount.                                                                                              |

⚠️ **The output carries no buyer data by construction** — no name, document,
phone, address or e-mail, `observacoesInternas` shows only a character count,
and the cliente/endereço appear as outer-ref ids. It is safe to paste into an
issue. Keep it that way if you extend it.

### 5. The live run

```bash
pnpm --filter @delfrance/shopee-app importar:pedido --integracao int-1 --order-sn 220810QSK8S7BX --live
```

This calls `importarPedidoShopee(db, { integracaoId, shopId, orderSn, nowMs })` —
the same call, the same arguments and the same client seam the task handler
uses. It prints the stored `estado` / `lastMarketplaceUpdate` **before** the
import, then the outcome, then the pedido read back:

- `criado` — the document did not exist;
- `atualizado` — it did, and this payload was newer or equal and changed
  something;
- `ignorado-obsoleto` — the stored watermark is newer; a stale redelivery;
- `ignorado-sem-mudanca` — accepted, re-mapped, nothing came out different.
  **Re-running the same order lands here, and that is the idempotence working.**
- `ignorado-inexistente` — Shopee denies the order.

Every one of those exits `0`; only a throw exits `1`, and it is reported by
error CLASS plus Shopee's `code`/`message`, never a payload.

There is no `--force` and none is needed: the importer is idempotent on
`(integracaoId, order_sn)` — the pedido id is a digest of the pair, not a query.

### 6. Then look at the staging web app

`/pedidos` — the pedido appears with `numero` = the `order_sn`. Open it and
check: the estado, the items (unbound lines sit in the `NONE` bucket), the Frete
tab (`valorCobrado`, the dispatch deadline, the package as one volume, and — see
the caveat below — the freight `estado` the step-7 backstop folded), and the
`observacoesInternas` if the buyer wrote one. `/incidentes` carries one
non-blocking row per unbound line. ⚠️ Since step 7 the Frete tab is **read-only**
on a Shopee pedido: the block declares `externalOptionIntegracao: 'shopee'`, and
that alone now locks it even though the importer sets no
`integracaoFreteOuterRef`.

### 7. Caveats you should expect to see (none of these is a bug)

- **Every line resolves to NONE, with one incidente each.** Step 9 has not
  written a `prodshopee` / `variashopee` link document yet, so the first two
  rungs of the cascade have nothing to match and the SKU rung only fires if a
  produto in staging happens to carry that exact SKU.
- **The two composite indexes are not deployed on staging** — `variashopee
(model_id, contaVariacaoShopeeOuterRef)` and `prodshopee (item_id,
contaProdutoShopeeOuterRef)`, which is **#1532**, migration-window work. On
  Firestore Enterprise a missing composite index does not throw and offers no
  one-click link: the query silently full-scans and is billed by data scanned.
  Here it scans an EMPTY collection group, so the cost is nil — but do not read
  the absence of an error as the indexes being there.
- **A non-BR order gets `bloquearEmissaoNFe: true` and
  `capturaComprador: expirado`.** The sandbox order is Singaporean: there is no
  CPF on that wire to unmask, so the capture is not "pending", it is over, and
  the pedido is blocked from an NF-e it could never legally carry. `regiao:nao-br`
  is the refused field.
- **In a dry run `clientePedidoOuterRef` and `enderecoFiscalOuterRef` are always
  null**, even for an order the live run would link — resolving a buyer means
  `findOrCreateCliente`, which is a write. The `capturaComprador` verdict is what
  answers "would it have linked".
- **`descontoTotal` is `0`**, always. Shopee has no order-level discount; its
  five escrow discounts are item-level and already ride each line's
  `descontoUnitario`.
- **`custoFinal` stays null; `codRastreio` is step 7's** — written by
  `rastrear:pedido` and by the code-4/30/47 push arm, never by the import.
  `get_order_detail` carries no tracking number at all, so a value invented here
  would look like a shipment that happened.
- **A LIVE import now MOVES `freteInicial.estado`, and a dry run does not.**
  Step 7 attached its BACKSTOP to this path: after the pedido and the pagamentos,
  the same fold runs over the `get_order_detail.package_list[]` this import
  already fetched — no new Shopee call. So the SG sandbox order lands at
  `despachoAutorizado` (its package reads `LOGISTICS_READY`) with a one-row
  `freteInicial.pacotes` diary, **not** at step 5's `iniciado` seed. ⚠️ The DRY
  RUN still prints `iniciado`: it stops at step 5's mapper, and the backstop
  lives in the write half. ⚠️ `despachoAutorizado` is **not** in
  `ESTADOS_FRETE_REMOVE_ESTOQUE`, so this particular fold moves no stock — an
  order whose package already reads `LOGISTICS_REQUEST_CREATED` folds to
  `aguardandoPostagem`, which is. Use `rastrear:pedido --dry-run` to see the
  diary; this script's summary does not print it.
- **A live run can move stock, indirectly.** The importer itself moves none, but
  both `aguardandoConfirmacaoDePagamento` and `pago` are estados that
  `onPedidoEstoqueSync` reserves against — so wherever that trigger is deployed,
  writing the pedido is what sets it off. Deleting the pedido afterwards is not a
  clean undo.

---

## `liquidar:pagamentos` — rehearsing the weekly settlement

`sweepShopeeEscrowSettlement` runs unattended, **once a week** (Mondays 05:10
America/Sao_Paulo), and it is the only thing in this channel that ever writes
what the marketplace actually PAID. Shopee sends no payment event of any kind:
`escrow_release_time` — the field that says the money really left — is exposed by
exactly ONE endpoint, `get_escrow_list`, so the final figure has to be fetched.
This script drives that same code from a terminal, against one named integração,
so the channel's first settlement write is deliberate and observable instead of
arriving on a Monday morning.

### 8.1 Environment

Identical to `importar:pedido` — same `.env.local`, same five lines printed
before anything happens (project, database, raw `SHOPEE_SANDBOX`, resolved Shopee
environment, shop id). Read them before you let it continue.

The integração must already be connected and carry a `shop_id` (see §2 above).

### 8.2 Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app liquidar:pagamentos --integracao int-1
```

With no window it uses **the window the next tick would use**: the stored cursor
minus a one-day overlap, or 30 days back on a conta that has never drained one.
It replays the conta's parked list (`pendentes`) FIRST — exactly as a live tick
does, and for the same reason: a parked row does not come back from the listing
once the cursor moved past its release time, so a rehearsal that only paged would
print "nothing to do" for precisely the rows the parked list exists for. Then it
pages `get_escrow_list`, calls `get_escrow_detail` for every row, reads each row's
pagamento and prints what a live tick **would** change. Every row says which
source it came from (`[pendente]` or `[listagem]`). It writes nothing — the
function it calls (`simularLiquidacaoShopee`) contains no writer at all, and its
verdict comes from the very same `preverLiquidacaoShopee` the transaction uses, so
the rehearsal cannot disagree with the run it rehearses.

⚠️ One honest difference, and it is a COST not a disagreement: a live tick parks
an absent pagamento WITHOUT calling `get_escrow_detail`, while the rehearsal reads
the escrow for every row so it can show what the settlement would look like once
the pedido arrives. A rehearsal over a long parked list therefore spends one
rate-limited call per parked row.

A fixed window:

```bash
pnpm --filter @delfrance/shopee-app liquidar:pagamentos --integracao int-1 --de 2026-09-01 --ate 2026-09-08
```

⚠️ **Both dates are read as midnight UTC**, never in the machine's zone, so
`--ate 2026-09-08` does **not** include the 8th. Pass both or neither.

One order, inspect-only:

```bash
pnpm --filter @delfrance/shopee-app liquidar:pagamentos --integracao int-1 --order-sn 220810QSK8S7BX
```

⚠️ `--order-sn` is refused together with `--live`, and that is a fact about
Shopee rather than a missing feature: the escrow LISTING is queried by
release-time window and has no by-id form, so a single-order path never learns
`payout_amount` or `escrow_release_time`. Writing through it would stamp both as
null **over a release time an earlier tick had already recorded**. Use it to look;
use `--live --de/--ate` to write.

Add `--json` for the machine-readable form — the same redacted summary on stdout,
preamble on stderr.

### 8.3 What to read in the output

| line                        | what it tells you                                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `janela`                    | the release-time window actually asked for, as ms + ISO UTC.                                                                                                                                                                                 |
| `janela drenada?`           | `sim` means `more: false` — the window finished. `NÃO` means a page or budget cap stopped it and the cursor would not move.                                                                                                                  |
| `[pendente]` / `[listagem]` | which of the live tick's two row sources produced the row — a replayed `pendentes` entry, or a `get_escrow_list` page. A parked row is invisible to the listing once the cursor passed its release time.                                     |
| `pedidoId` / `pagamentoId`  | both are DIGESTS of `(integracaoId, order_sn)`; `AUSENTE` on either is what parks the row and sends a synthetic code 3.                                                                                                                      |
| `payout / escrow`           | ⚠️ the open question of step 6. `payout_amount`'s unit is unresolved on Shopee's own page (the table prints a float, the sample prints an integer 100× larger), so the sweep logs the RATIO beside it: **~1 means units, ~100 means cents.** |
| `tarifas`                   | the clamped figure `pagamento.tarifas` would take — commission + service + seller transaction, BR net variants preferred.                                                                                                                    |
| `ação`                      | `liquidado`, `ignorado-sem-mudanca` (the idempotent overlap — writes nothing), `ignorado-obsoleto` (the stored release stamp is newer) or `ignorado-sem-pagamento`.                                                                          |
| `campos que mudariam`       | the exact dotted field names a live run would write. `(nenhum)` beside `ignorado-sem-mudanca` is the healthy steady state.                                                                                                                   |

⚠️ **The output carries no buyer data by construction.** The escrow body it is
built from has ~100 money fields plus `buyer_payment_info`; the summary is an
allow-list of fourteen, and a buyer field has nowhere to travel. It is safe to
paste into an issue. Keep it that way if you extend it.

### 8.4 The live run

```bash
pnpm --filter @delfrance/shopee-app liquidar:pagamentos --integracao int-1 --live --de 2026-09-01 --ate 2026-09-08
```

This calls `runShopeeEscrowSettlement` exactly as the schedule does, scoped to
one integração. ⚠️ **The cursor document is NOT written unless you add
`--cursor`**, so a rehearsal cannot silently advance a conta's week; and even
with `--cursor`, a run that carried `--de/--ate` never advances `cursorMs` — a
hand-picked window says nothing about the ground between the cursor and it.

What a live run can change:

- `pagamento.liquidacao` — `payoutAmount`, `escrowReleaseTimeUs`, `liquidadoEmUs`,
  `fonte`. The sweep is this block's only writer.
- `pagamento.marketplace` and `pagamento.tarifas` — refreshed from a fresher
  escrow, through the same pure functions the order import uses.
- `pagamento.ultimaModificacao` — only when something above actually changed.

What it can **never** change: `valor`, `forma_de_pagamento`, `status_pagamento`,
`parcelas`, `aVista`, `cartao`, the date stamps, the pedido, the `estado` or any
stock. So `Σ pagante valor == valorCobrado` (and therefore `Σ vPag == vNF` on the
nota) cannot move from here.

It can also enqueue **synthetic code-3 notifications** — up to 50 per run, one per
released order whose pedido or pagamento is missing — and each of those imports a
pedido through the normal step-5 path. That is the one pedido-creating side
effect, and it is why the run prints `sintéticas` separately from `liquidados`.

### 8.5 Caveats you should expect to see (none of these is a bug)

- **Every row answers `ignorado-sem-pagamento` on a fresh staging project.** Step
  5 has to have imported the order first; until then the rows are parked in
  `liquidacaoShopee/<integracaoId>.pendentes` and re-driven by a synthetic push.
- **`ignorado-sem-mudanca` on a second run is the idempotence working**, and it
  writes _nothing at all_ — not even `ultimaModificacao`. Any write would file a
  `historicoDeModificacoes` row per conta per week for ever.
- **The sandbox may answer an empty page.** Whether a sandbox order's escrow is
  ever released is settle-live **register item 27** and is UNMEASURED — nobody
  has called this endpoint yet. An empty page exercises the endpoint and settles
  nothing; a row that DOES come back is the answer to item 27, so record it.
- **`janela drenada? NÃO` on a first run over a wide window is normal** — the page
  cap (20) and the per-tick settlement budget (300) both truncate deliberately,
  and the next tick resumes at the persisted page.
- **`payout / escrow` may look 100× apart.** That is the open question, not a
  defect; record the ratio you see.

---

## `rastrear:pedido` — rehearsing the shipment merge

`rastrearPedidoShopee` normally runs unattended: a Shopee push (code **4**
`order_trackingno_push`, **30** `package_fulfillment_status_push` or **47**
`package_info_push`) → Cloud Tasks → `processShopeeNotification` → the frete arm.
Those three pushes are **lossy by design** — `timeout=3`, `push_guarantee=0`,
three retries and then gone — and the sandbox console's Push Test Data offers
code 4 but **not** 30 and **not** 47. So the first time this channel ever moves a
`freteInicial.estado`, which is a **stock-moving** field, would otherwise happen
unattended, from a push nobody can replay, against whatever `get_package_detail`
decided to answer. This script drives the same code from a terminal, against one
named order.

### 9.1 Environment

Identical to `importar:pedido` — same `.env.local`, and the same connected
integração carrying a `shop_id` (see §2 above). The preamble goes to **stderr**
and leads with the mode: `modo: DRY-RUN — não grava nada` or
`modo: LIVE — VAI GRAVAR`, then the project, the database, the raw
`SHOPEE_SANDBOX`, the integração, the `order_sn`, the `--package` value, the
resolved Shopee environment and the shop id. Read them before you let it
continue.

A conta connected by MAIN ACCOUNT has no `shop_id`, cannot sign a call, and the
script stops on it saying so (exit `1`).

### 9.2 Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app rastrear:pedido --integracao int-1 --order-sn 260910KJBHUJDM
```

It reads the pedido at its digest id (no query, no mirror collection), resolves
the package set in three **tagged rungs** and prints where each package came
from — `[flag]` (`--package`), `[volume]` (the stored
`freteInicial.volumes[].numero`, which step 5 wrote one per package) and
`[order_detail]` (`get_order_detail.package_list[].package_number`) — then prints
the difference in **both** directions (`só na Shopee` / `só no pedido`). Then it
makes ONE batched `get_package_detail` for that set, runs the same producer the
push arm runs, and runs the **same** `preverFreteShopee` the transaction runs —
so `campos que mudariam` is the exact dotted field list a live delivery would
write, not a second implementation's opinion of it. Last it prints what the
**code-3 backstop** would fold from the same order's `package_list[]`.

It writes nothing and enqueues nothing, and that is structural rather than a
promise: `simularRastreioShopee` contains no writer and no scheduler, and a test
strips its comments and asserts the module names neither.

⚠️ A dry run is **not offline**: it spends one `get_package_detail` and, unless
`--package` was given, one `get_order_detail`, against the same rate limits.

One package only:

```bash
pnpm --filter @delfrance/shopee-app rastrear:pedido --integracao int-1 --order-sn 260910KJBHUJDM --package OFG242672552205937
```

⚠️ `--package` makes the tool skip `get_order_detail` **entirely** — that is the
whole meaning of the flag — so that run has **no drift report and no backstop
comparison**.

| flag                | meaning                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--integracao <id>` | required — the integração document id                                                                                                                                                                                            |
| `--order-sn <sn>`   | required — the Shopee order                                                                                                                                                                                                      |
| `--package <n>`     | ONE `package_number`. Refused: a blank value, a bare `-` (Shopee's own absence sentinel on this page) and any value containing a comma (the batch separator) — all three in the parser, before a Firestore read or a Shopee call |
| `--dry-run`         | the **DEFAULT**                                                                                                                                                                                                                  |
| `--live`            | writes; **refused together with `--dry-run`** rather than resolved by precedence                                                                                                                                                 |
| `--project <id>`    | overrides `FIREBASE_PROJECT_ID` before the admin app resolves it                                                                                                                                                                 |
| `--json`            | the same redacted summary on stdout, preamble on stderr                                                                                                                                                                          |
| `--help`, `-h`      | prints the usage and exits `0` — answered before any dynamic import, so it touches no environment, no Firestore and no Shopee                                                                                                    |

⚠️ A bare `--` is refused with the pnpm explanation — no command in this file
carries one (see the note at the top).

### 9.3 What to read in the output

| line                                     | what it tells you                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pedido existe?` / `tem freteInicial?`   | a `NÃO` on either is what a real delivery answers `ignorado-sem-pedido` / `ignorado-sem-frete-inicial` for. This step creates neither.                                                                        |
| `só na Shopee` / `só no pedido`          | the drift between the stored volumes and Shopee's packages. A package Shopee knows and the volumes do not is a SPLIT, and nothing in the web UI shows it.                                                     |
| `[flag]` / `[volume]` / `[order_detail]` | which rung produced that package.                                                                                                                                                                             |
| `fulfillment_status → estado alvo`       | the RAW wire token and what the channel's table projects it to. A `—` on the right means the table does not know the token: a real delivery would write **nothing** and log it once.                          |
| `tracking_number`                        | printed in the clear, deliberately — it IS `codRastreio`, and `/pedidos` renders it verbatim beside a copy button.                                                                                            |
| `ship_by_date` / `update_time`           | wire **SECONDS**, with the ISO UTC beside them.                                                                                                                                                               |
| `ação`                                   | what the transaction would answer: `atualizado`, `ignorado-sem-mudanca`, `ignorado-obsoleto` (a stored package clock is newer), `ignorado-desconhecido`, `ignorado-sem-frete-inicial`, `ignorado-sem-pedido`. |
| `campos que mudariam`                    | the exact dotted names (`freteInicial.estado`, `.codRastreio`, `.prazoDespacho`, `.externalOptionId`, `.pacotes`). `(nenhum)` beside `ignorado-sem-mudanca` is the healthy steady state.                      |
| the BACKSTOP block                       | what a code-3 import would fold from the SAME order, token by token. Comparing it with the pull's token is settle-live **register item 28** answered by eye.                                                  |

⚠️ **The output carries no buyer data by construction.** The package summary is
an allow-list of **fourteen** fields; the `get_package_detail` body it is built
from also carries `recipient_address`, `driver_info`, `virtual_contact_number`
and a prescription block, and none of them has a field to travel in. The
`--live` re-read is a SECOND allow-list, which is why `externalOptionData`
(Melhor Envio's untyped bag, rendered raw) never appears. It is safe to paste
into an issue. Keep it that way if you extend it.

### 9.4 The live run

```bash
pnpm --filter @delfrance/shopee-app rastrear:pedido --integracao int-1 --order-sn 260910KJBHUJDM --live
```

This calls `rastrearPedidoShopee` **once per resolved package** — the real arm
body, the real transaction and the real synthetic code 3 — then re-reads the
pedido and prints the stored block: `estado`, `codRastreio`, `externalOptionId`,
`prazoDespacho`, `ultimaModificacao` and every `pacotes` row.

What a live run can change:

- `freteInicial.estado` — ⚠️ **stock-moving**: `onPedidoEstoqueSync` observes it
  and everything from `aguardandoPostagem` onward removes physical stock.
- `freteInicial.codRastreio`, `.prazoDespacho`, `.externalOptionId` and the
  `.pacotes` diary.
- the pedido's own `ultimaModificacao` — in both ignore lists, so it files no
  audit row.

What it can **never** change: `lastMarketplaceUpdate` and
`freteInicial.ultimaModificacao` (step 5 owns both), `valorCobrado`,
`custoCalculado`, `volumes`, the items, the pedido's `estado`, any pagamento.

⚠️ It can also enqueue a **synthetic code 3** — one per package whose pedido does
not exist yet, printed as `code 3 sintético ... ENFILEIRADO` — and each of those
imports a pedido through the normal step-5 path. That is the one pedido-creating
side effect, and a dry run cannot reach it: it never calls the handler.

⚠️ A rehearsal has no push behind it, so the diagnostic it hands the handler
carries `code: 4` with **every claim field null** — no `statusDoPush`, no
`trackingNoDoPush`, no clock. That pattern is how a reader tells a rehearsal line
from a real delivery in the task log.

Exit `0` on **any** `ação`, the `ignorado-*` ones included — those are answers,
not failures. Exit `1` only on a throw (reported by error CLASS plus Shopee's
`code`/`path`, never a payload) or on a conta with no `shop_id`.

### 9.5 Caveats you should expect to see (none of these is a bug)

- **`pedido existe? NÃO` on a fresh staging project.** Run `importar:pedido`
  first. A real delivery would DEFER and enqueue one synthetic code 3 (bounded at
  8 per delivery); a dry run enqueues nothing.
- **`ignorado-sem-mudanca` on a second run is the idempotence working**, and it
  writes _nothing at all_ — not even `ultimaModificacao`. Any write would file a
  `historicoDeModificacoes` row per delivery for ever.
- **What `get_package_detail` answers for a `LOGISTICS_READY` package on a
  SANDBOX shop is settle-live register item 33 and is UNMEASURED** — nobody has
  called this endpoint. Record what comes back. ⚠️ A body worth committing to
  `__wire__` needs `redact.ts` extended FIRST (the `driver_info` SEGMENT plus six
  more suffixes): the row leaves those keys undeclared and they ride
  `.passthrough()`, so a raw capture records them in full.
- **`só na Shopee` being non-empty is not a defect.** Step 5 writes one volume
  per package AT IMPORT and Shopee can split an order afterwards — that drift is
  exactly what this report exists to show.
- **`tracking_number: —` before the label exists is normal**, and so is a literal
  `-` arriving on the wire: the reader turns that whole-value sentinel into
  `null` before anything is written (how often it really arrives is settle-live
  register item 30).
- **More than 50 resolved packages are truncated** to the batch's own limit, with
  a printed warning — `get_package_detail` refuses a longer list before it
  fetches.
- **The BACKSTOP block can omit `freteInicial.prazoDespacho` on an order whose
  `ship_by_date` is absent or zero-filled.** The rehearsal hands the fold
  `prazoDaOrdemUs: null`; a live code-3 import hands it the mapped deadline,
  which on such an order comes from the mapper's 14:00-on-`pay_time` fallback. So
  when that fallback differs from the STORED deadline, the live import writes one
  more field than the rehearsal predicts. The per-package half and the PUSH half
  are exact — production passes `null` there too — and the divergence is named in
  `rastrearPedidoSimulacao.ts`'s header.
- **A live run can move stock, indirectly.** The transaction moves none itself,
  but `onPedidoEstoqueSync` reacts to the `estado` it writes, so wherever that
  trigger is deployed, writing the freight state is what sets it off.

---

## `varrer:reservas` — rehearsing the weekly stuck-reservation sweep

`sweepShopeeStuckReservations` normally runs unattended, Mondays 04:40, over
every active conta. This script drives the same tick from a terminal.

**It is the load-bearing artefact of step 8, not a formality.** The whole step
rests on one question nobody can answer from documentation: **does Shopee
auto-cancel an unpaid BR order, after how long, and with which
`cancel_by` / `cancel_reason`?** The 215-page documentation cache contains no
payment deadline, no auto-cancel rule and no window, and the sandbox cannot
produce an aged unpaid order at all (order creation there has no payment step).
So a few weeks of DRY-RUN ticks read week over week are the only instrument that
exists — and they have to run **before** anyone decides whether to turn the
master flag on.

### 10.1 Environment

Same `.env.local` as every other script here (`dotenv -e ../../.env.local -- tsx
…`), and the same variables as §1 — plus the three the sweep itself reads, whose
real home is `apps/shopee/functions/.env.deploy`:

| variable                              | why it matters here                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED` | the master flag. `--live` **honours** it: with it unset the tick prints `enabled: false`, names the variable and exits `0`.                      |
| `SHOPEE_PEDIDO_TRAVADO_DRY_RUN`       | if it is `1`, the environment forces a dry run and `--live` cannot override it — the preamble says `⚠️ o ambiente força DRY_RUN`.                |
| `SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D`   | the horizon in days (default 7). `--max-idade-d <n>` sets this same variable before the imports, so the rehearsal exercises the one real reader. |

The preamble goes to **stderr** and leads with the mode
(`modo: DRY-RUN — não grava nada` / `modo: LIVE — VAI GRAVAR`), then the
project, the database, the raw `SHOPEE_SANDBOX`, the integração scope, the
horizon, **both** flag values raw, and the resolved Shopee environment (plus the
shop, when `--integracao` scoped it to one conta). The two flags are separate
lines on purpose: `--live` honours one of them and the other outranks `--live`.

### 10.2 Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app varrer:reservas
```

That is the schedule's own scope: **every active conta**. Scope it to one while
you are learning what it prints:

```bash
pnpm --filter @delfrance/shopee-app varrer:reservas --integracao int-1
```

⚠️ **A dry run is not offline.** It reads Firestore _and_ calls Shopee —
`get_order_detail`, batched 50 `order_sn` at a time — and spends the same
rate-limited calls a live tick does. What it skips is exactly **two** effects:
the synthetic code-3 enqueue and the aviso writes/resolves. Every verdict is
decided on the same side of that boundary in both modes, which is what makes the
report an instrument rather than a rehearsal of the plumbing.

⚠️ **`--dry-run` is the default and it supplies BOTH seams** — `forcarDryRun`
_and_ `ignorarFlagMestra` — so the rehearsal runs before
`SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED` exists anywhere. The sweep asserts that
pair and throws `ShopeeConfigError` when they come apart, so "can rehearse
before the flag, can never write before the flag" is structural rather than a
promise.

| flag                | meaning                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--integracao <id>` | restricts the tick to ONE conta. Omitted ⇒ every active conta, as the schedule runs. An id that is not an ACTIVE Shopee conta ⇒ `contas: []`, a loud stderr line naming it, exit `0`          |
| `--max-idade-d <n>` | overrides the horizon; must be a number greater than zero. `0`, `-1`, `x` and `7d` are all **refused** — a clamp would silently rehearse a horizon nobody asked for                           |
| `--dry-run`         | the **DEFAULT**                                                                                                                                                                               |
| `--live`            | runs the tick for real; **refused together with `--dry-run`** rather than resolved by precedence                                                                                              |
| `--project <id>`    | overrides `FIREBASE_PROJECT_ID` before the admin app resolves it                                                                                                                              |
| `--json`            | one parseable document on stdout (`{ resultado, candidatos }`), preamble on stderr                                                                                                            |
| `--help`, `-h`      | prints the usage and exits `0` — it wins over every validation, a contradiction included, and is answered before any dynamic import, so it touches no environment, no Firestore and no Shopee |

⚠️ A bare `--` is refused, and no command in this file carries one (see the note
at the top).

### 10.3 What to read in the output

Three blocks: the run header, the verdict vector, and the tables.

| line                                                           | what it tells you                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` / `dryRun` / `motivo`                                | `enabled: false` means the master flag is off and NOTHING was read — the honest `dryRun` beside it is what tells you whether you also set the rehearsal flag.                                                                                                                     |
| `examinados` / `paginas` / `truncado`                          | how much of the candidate page was walked. A `truncado: true` week after week means the tick never reaches the tail — read `naoMarketplace` next.                                                                                                                                 |
| `naoMarketplace` / `adotado` / `contaInativa` / `foraDoEscopo` | the four gate-1 rejects — rows this channel does not own, or that this run is not scoped to. ⚠️ **Never summed with `candidatos`**: only a row the channel PROVED it owns can carry a verdict. (`semShopId` is separate again — a conta skipped before its candidates were read.) |
| `candidatos` + `veredictos`                                    | the vector, with the zero arms present. `Σ veredictos === candidatos` on every tick; an absent arm would be indistinguishable from an arm that never existed, so the zeros are printed.                                                                                           |
| `statusArmazenado` × `idadeStatusDias` → `statusPorIdade`      | the stored `marketplace.status` distribution cross-tabulated against age, computed from the candidate documents alone — **zero Shopee calls**. This is the instrument.                                                                                                            |
| `statusArmazenadoPorVeredito`                                  | the join: what each stored status turned into once Shopee was asked.                                                                                                                                                                                                              |
| `redriveAparentementeNaoAplicado`                              | a `redirecionado-*` whose stored status already equalled the live one — a delivery was accepted and the estado still did not move.                                                                                                                                                |
| `avisosVarridos` / `reconciliados` / `reconciliacaoTruncada`   | pass (b). A sustained `reconciliacaoTruncada: true` means stale rows at the tail are never reconciled, and the fix is a discriminated index (migration window), not a code change.                                                                                                |
| the per-candidate rows                                         | twelve allow-listed fields: `pedidoId`, `integracaoId`, `orderSn`, `veredito`, `orderStatus`, `pendingTerms`, `temPayTime`, `idadeDias`, `cancelBy`, `cancelReason`, `enfileiraria`, `avisaria`.                                                                                  |

**How the tables answer the central question**, read over three or four
consecutive Mondays:

| what you read                                                                                         | what it means                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNPAID` mass in the `30-60` / `60-90` buckets migrating to `redirecionado-cancelado`                 | Shopee DOES auto-cancel; the bucket where the mass moves IS the horizon, and `MAX_IDADE_D` should be tuned to just past it                                                                                                      |
| `UNPAID` persisting as `ainda-nao-pago` at `60-90` and `90+`, tick after tick, `ocorrencias` climbing | Shopee does **not** auto-cancel; the residual is real and non-empty, and whether the sweep should ever write the release itself becomes a conversation to have with Lucas                                                       |
| `PENDING` + `temPayTime` appearing at all                                                             | a PAID sale held on Shopee's side past a week. Its aviso says do not cancel it; if `pending_terms` reads `SYSTEM_PENDING` and its documented four hours have become twelve days, that is a Shopee ticket, not a design question |
| `inexistente` concentrating in one age bucket                                                         | Shopee purges orders at that age — nothing in the corpus states it                                                                                                                                                              |
| `naoMarketplace` dominating `examinados`, with `truncado: true`                                       | the candidate page is colonised by stale non-Shopee pedidos; that is the evidence for a discriminated index, which is migration-window work (#1208)                                                                             |
| `nao-verificavel` non-trivial                                                                         | the read itself was unreliable — every other number that tick is a lower bound and must be read as one                                                                                                                          |

⚠️ **The output carries no buyer data by construction.** The per-candidate
summary is an ALLOW-LIST of twelve fields built one at a time, and `temPayTime`
is a **boolean** — the stamp itself never leaves the sweep. The defence is
layered: the sweep never lets a `get_order_detail` row out in the first place,
and it never requests `buyer_cancel_reason`, so the buyer's own words never
reach this process. It is safe to paste into an issue. Keep it that way if you
extend it.

### 10.4 The live run

```bash
pnpm --filter @delfrance/shopee-app varrer:reservas --live
```

`--live` supplies **neither** seam, so `SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED=1`
must already be in the environment. That is deliberate: flipping the master flag
is a human's act in the migration window (root `CLAUDE.md` rule 8), and a CLI
must not be a second door. With the flag off the tick prints `enabled: false`,
names the variable and exits `0` having read nothing at all.

What a live run can do — and it is only ever these two things:

- **enqueue** one synthetic code 3 (`origem: 'reserva-travada'`) per candidate
  whose order MOVED, onto the same queue a real push uses. Each one is a real
  step-5 import, and the estado step 5 writes is what releases the reservation
  through `onPedidoEstoqueSync`.
- **write or resolve `avisos`** — one `pedidoPrecisaDecisao` row per residual
  candidate, plus the two in-line resolves and pass (b)'s.

What it can **never** do: write the pedido. Not the estado, not an incidente,
not `ultimaModificacao` — the sweep has no writer for one and runs no
transaction, so `pedido.estado` keeps exactly one writer on this channel,
step 5. It also never cancels anything on Shopee's side.

Exit `0` on **any** verdict. `ainda-nao-pago`, `inexistente` and
`nao-verificavel` are answers, not failures, and so is an empty conta list. Exit
`1` only on a throw, described by CLASS (the same table `importar:pedido` uses)
and never a payload.

### 10.5 Caveats you should expect to see (none of these is a bug)

- **`candidatos: 0` on a fresh staging project** just means nothing has been
  sitting in `aguardandoConfirmacaoDePagamento` past the horizon. Note that the
  horizon is measured from the pedido's `timestamp`, which is the ORDER's
  creation time — so importing an old enough `UNPAID` order makes it a candidate
  immediately.
- **`naoMarketplace` counting rows you did not expect.** The candidate query
  carries no channel clause — no declared index could give it one — so manual
  and Mercado Livre pedidos are read and rejected by the ownership proof. That
  number is the measurement, not a defect (settle-live register item 45).
- **A second run prints the same verdicts and `ocorrencias: 2` on the avisos.**
  The chave carries no `janela` and no event clock, so a re-raise increments the
  counter without moving `criadoEm` — which is what makes "this has been stuck
  for N weeks" readable at all.
- **An aviso stays open for one extra week after the pedido is genuinely
  fixed.** The sweep resolves in line only on the two verdicts that void the
  aviso's own premise; everything else waits for pass (b) to OBSERVE that the
  pedido left the candidate set. Observing the fix is worth more than guessing
  it.
- **`status-desconhecido` never enqueues**, deliberately: a re-drive would make
  step 5 write `estado: error`, which is outside the reserve set and would
  RELEASE the reservation for a token nobody understands. Read the raw token off
  the log and add a rung to step 5's ladder (settle-live register item 43).
- **`inexistente` never enqueues either.** The code-3 arm parks an order Shopee
  no longer knows, and the synthetic doc id carries the tick's own clock, so a
  re-driver would write one new parked dead-letter document per candidate per
  week and release nothing.
- **A rate-limit error of either class ends that conta's tick**, with its
  remaining candidates counted `nao-verificavel`. There is no retry, on purpose:
  the daily quota resets at 00:00 UTC+8 and un-restricting an app that hammered
  the API is a human ticket.
- **`chamadas` can exceed `⌈candidatos / 50⌉`.** A batch refused with
  `error_not_found` falls back to one call per `order_sn`, so one refused batch
  of 50 costs 51 calls. Measured on the SG sandbox, that only happens when EVERY
  `order_sn` of the call is unknown — settle-live register item 38.
- **Never run by an agent** (root `CLAUDE.md` rule 8) — in `--live` it enqueues
  real Cloud Tasks and writes real documents.

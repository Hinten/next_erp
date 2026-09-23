# apps/shopee/scripts/

Dev-only CLIs. **Never run by an agent** (root `CLAUDE.md` rule 8) — a human
runs them, from this worktree, against the project the environment points at.

| script                   | what it does                                                       | writes?                   |
| ------------------------ | ------------------------------------------------------------------ | ------------------------- |
| `oauth-url.ts`           | mints a Shopee consent URL without the web UI                      | one `oauthState` document |
| `importar-pedido.ts`     | imports ONE order through the real step-5 path                     | only with `--live`        |
| `liquidar-pagamentos.ts` | rehearses the weekly escrow settlement (step 6)                    | only with `--live`        |
| `rastrear-pedido.ts`     | rehearses the shipment merge of ONE order (step 7)                 | only with `--live`        |
| `varrer-reservas.ts`     | rehearses the weekly stuck-reservation sweep (step 8)              | only with `--live`        |
| `importar-anuncio.ts`    | imports ONE anúncio through the real step-9 path                   | only with `--live`        |
| `publicar-anuncio.ts`    | publishes ONE produto through the real step-11 path                | only with `--live`        |
| `enviar-estoque.ts`      | sends the stock of up to 50 produtos through the real step-12 path | only with `--live`        |

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
(`modo: DRY-RUN — não enfileira e não grava nada` /
`modo: LIVE — VAI ENFILEIRAR E ESCREVER AVISOS` — this CLI's own wording, not
the three above: its live run has exactly two effects and the line names both),
then the project, the database, the raw `SHOPEE_SANDBOX`, the integração scope,
the
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
  RELEASE the reservation for a token nobody understands. ⚠️ The scheduled tick
  logs the COUNT only — the raw token is in the `orderStatus` column of THIS
  rehearsal's per-candidate table and nowhere else, so a `status-desconhecido`
  seen in the weekly log is read by re-running `varrer:reservas` scoped to that
  conta. Then add a rung to step 5's ladder (settle-live register item 43).
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

---

## `importar:anuncio` — rehearsing the first produto write

`importarAnuncioShopee` normally runs unattended: the `importar-todos` job
drains a queue of `item_id`s through the Cloud Tasks function, ten per dispatch.
This script drives the same code from a terminal against ONE named anúncio, so
the channel's first write to `produtos` / `grupoDeVariacoes` / `categorias` /
`arquivos` — and its first write to `prodshopee` / `variashopee`, which step 5
only ever READ — is deliberate and observable instead of arriving on a queue.

It is also the only place the whole plan is printed. The importer is split
`preparar` (write-free) → `planejar` (pure) → `aplicar`, so a dry run runs the
first two halves and renders the plan the third one would execute. That is not a
re-implementation of the live path: it is the live path, minus the writer.

### 11.1 Environment

Same `.env.local` as every other script here (`dotenv -e ../../.env.local -- tsx
…`), and the same variables as §1. Step 9 adds **no** variable of its own —
what it adds are three fields read off the **integração document**, and the
preamble prints all three because each one silently disables a leg:

| field on `integracao/{id}`  | what its absence does                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tabelaNormalOuterRef`      | `(nenhuma — sem preço)` — no price is written anywhere, on the parent or on any child                                 |
| `tabelaPromocionalOuterRef` | printed, and printed as **`NUNCA escrita — #803`**: the import never writes the promotional table even when it is set |
| `depositoOuterRef`          | `(nenhum — sem estoque)` — the estoque leg skips with one log line                                                    |

The preamble goes to **stderr** and leads with the mode
(`modo: DRY-RUN — não grava nada` / `modo: LIVE — VAI GRAVAR`), then the
project, the database, the raw `SHOPEE_SANDBOX`, the integração, the `item_id`,
the resolved Shopee environment, the shop id and those three refs — read all of
them before you let it continue. A conta connected by MAIN ACCOUNT has no
`shop_id`, so nothing can be signed; the script says so and exits `1` rather
than printing a stack.

### 11.2 Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app importar:anuncio --integracao int-1 --item 2500139861
```

⚠️ **A dry run is not offline.** It reads Firestore _and_ calls Shopee — always
one `get_item_base_info`, then `get_kit_item_info` for a `tag.kit` listing or
`get_model_list` for a `has_model` one, never both — and spends the same
rate-limited calls a live run does. What it skips is exactly the writing. That
property is **structural**, not a promise: `prepararImportacaoShopee`'s call
graph contains no writer, no bucket and no fetch, and a test drives it with a
FakeDb that throws on every write verb.

The usage the script itself prints (`--help`, answered before any dynamic
import, so it touches no environment, no Firestore and no Shopee):

```
Importa UM anúncio da Shopee para o catálogo do ERP, pelo caminho real do step 9.

  pnpm --filter @delfrance/shopee-app importar:anuncio \
    --integracao <integracaoId> --item <item_id> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --item <item_id>    o anúncio da Shopee, só dígitos (ex.: 2500139861)

Opções
  --dry-run           lê, resolve e PLANEJA, sem gravar nada. É o PADRÃO.
  --live              GRAVA: roda o importador de verdade (produto, variações,
                      grupos, categorias, vínculos, estoque, preço e fotos) e
                      depois relê o produto.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.
```

| flag                | meaning                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--integracao <id>` | **required** — the Shopee integração document. A conta that is missing, inactive or of another tipo fails HERE, in `loadShopeeContext`, rather than at Shopee |
| `--item <item_id>`  | **required** — digits only. `2500139861`, never a URL and never a `model_id`                                                                                  |
| `--dry-run`         | the **DEFAULT**                                                                                                                                               |
| `--live`            | runs the real importer and then re-reads the produto                                                                                                          |
| `--project <id>`    | overrides `FIREBASE_PROJECT_ID` before the admin app resolves it                                                                                              |
| `--json`            | the same REDACTED summary as one parseable document on stdout, preamble on stderr                                                                             |
| `--help`, `-h`      | prints the usage and exits `0`, ahead of every validation and before any dynamic import                                                                       |

⚠️ A bare `--` is refused, and no command in this file carries one (see the note
at the top).

### 11.3 What to read in the output

Five blocks: the produto, preço and estoque, the variations, the grupos, and
categoria/vínculos/fotos — plus a sixth, the component table, when the listing
is a kit.

| line                                          | what it tells you                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `produto … criar/atualizar id=… kit=…`        | the deterministic id, and whether this run mints or merges. The id is `sha256("shopee\|<integracaoId>\|<item_id>")` — the same anúncio under a different integração is a DIFFERENT produto, on purpose.                         |
| `campos do produto` / `campos de extraData`   | the exact key set a merge would carry. On an UPDATE this is the fill rule at work: only absent fields are filled, except the small `sobrescreverDadosProduto` carve-out.                                                        |
| `descrição` / `tax_info`                      | **counts and field NAMES only.** The description's characters are counted and the `tax_info` values are never rendered — the summary is an allow-list, so it is safe to paste into an issue. Keep it that way if you extend it. |
| `preço … (nenhum) motivo=<token>`             | why no price would be written: `opcao-desligada`, `sem-tabela`, `pai-com-filhos`, `sem-price-info`, `moeda-nao-brl`, `valor-abaixo-do-minimo`. On the SG sandbox this is normally `moeda-nao-brl` — see §11.5.                  |
| `estoque … (nenhum) motivo=<token>`           | the same shape for stock. A parent that owns children never carries one.                                                                                                                                                        |
| `### variações (N models → …)`                | `criar` / `existentes` / `semLink`. A `semLink` row is a `model_id: 0` child: the produto is created, the `variashopee` link is not, and that is the wire's answer rather than a failure.                                       |
| the per-model rows                            | `criar` / `atualizar` / `sem mudança`, the child's own id, and its own `link` and `estoque`. A re-import of an unchanged listing should read `sem mudança` on every row.                                                        |
| `### grupos de variações`                     | `novo` / `match + patch` / `match` per grupo. `match` with no patch on a second run is the `linksVariacoesShopee` merge proving it does not churn.                                                                              |
| `categoria …`                                 | the root-first path, or `(nenhuma — id desconhecido ou opção desligada)`. No API call is made: the chain comes from step 10's cached tree.                                                                                      |
| `prodshopee` / `variashopee`                  | `CRIAR` vs `MERGE`, per document. Nothing is ever deleted, so a `MERGE` over a link you did not expect is information, not damage.                                                                                              |
| `fotos … no anúncio · já em cache · a baixar` | counts only; the image URLs are deliberately omitted. `já em cache` is the `externalIds` hit — a second run should download nothing.                                                                                            |
| `### kit — componentes (R/N resolvidos)`      | the K1 table. `R < N` means the kit is REFUSED — see §11.5.                                                                                                                                                                     |

### 11.4 The live run

```bash
pnpm --filter @delfrance/shopee-app importar:anuncio --integracao int-1 --item 2500139861 --live
```

`--live` runs `importarAnuncioShopee` (or `importarKitShopee`) for real and then
re-reads the produto, so the last block of the output is what Firestore actually
holds rather than what the plan intended. The writes happen in ONE order —
taxonomia → categorias → the guarded price patch → produto → extraData →
estoque → the parent link → each child → `filhoUnicoId` → photos — and two of
those placements are load-bearing: taxonomia is first because a lost grupo race
must refuse the item before any produto exists, and the price patch precedes the
produto merge because the merge bumps `updateTime` and would invalidate the
price precondition we are about to assert.

⚠️ **A lost race is answered by re-planning, exactly once.** Both guarded writes
fail loudly on a concurrent winner; the importer then re-reads and re-plans the
whole item against a fresh memo rather than re-applying a patch that would write
the loser's values over the winner's. A second loss ends the item as
`taxonomia-em-conflito`, with no PRODUTO written — a `grupoDeVariacoes` this item
created or patched before the losing write does survive, which the CLI says out
loud on that motivo.

Exit `0` on any DRY RUN, including a BLOCKED plan — there a refusal is an answer
and it prints as `bloqueado: <motivo>`. ⚠️ Under `--live` a refusal is **not**
caught: it takes the error path, prints `❌ ShopeeImportBlockedError (<motivo>)`
and exits `1`, like any other throw. Every failure is described by CLASS and
never by payload.

### 11.5 Caveats you should expect to see (none of these is a bug)

- **The sandbox shop is SGD, so a rehearsal imports NO price.** The import takes
  only the first **BRL** `price_info` entry, so the plan prints
  `preço … (nenhum) motivo=moeda-nao-brl`. Measured on the sandbox, not assumed.
  It is the currency rule working; a BR shop is the only place the price leg can
  be observed at all.
- **`tax_info` is absent on a non-BR shop**, so the summary prints
  `tax_info … ausente · campos: —`. The fiscal block is a BR-only answer;
  `need_tax_info` is sent on every call regardless.
- **`standardise_tier_variation[]` comes back all-zero outside Fashion.**
  Measured: `variation_id: 0` and every `variation_option_id: 0`, with no
  `variation_group_id`. `0` means CUSTOM, so outside Fashion only the NAMES
  identify a tier or an option — which is why the grupo rung falls through to an
  exact-name match instead of a `shopee-<id>` document.
- **`weight` arrives as a STRING** (kilograms). `'1,1'`, `'0'` and `''` all map
  to `null` rather than to a default — an invented weight is worse than an
  absent one, because freight would quote against it.
- **A `gtin_code` of `"00"` means ABSENT** and is dropped; `'0'` and `'000'` are
  kept, because they are values somebody typed.
- **A kit prints no stock at all.** A kit produto's stock is its components',
  so no estoque row is written for it in either mode.
- **A kit on a fresh catálogo is REFUSED** — `bloqueado:
kit-componente-nao-vinculado`, printed together with the component table so
  you can see exactly which component has no produto yet. Import the components
  first and run the same command again; **run it twice** is the procedure, not a
  workaround. The mass-import job avoids it by draining `filaKits` LAST.
- **A `has_model` listing has no `price_info` on the item itself** — it is on
  every model. The parent therefore prints `motivo=pai-com-filhos` and each
  child carries its own price. Measured on the sandbox.
- **The categoria leg is skipped when the category id is unknown to the cached
  tree**, printing `(nenhuma — id desconhecido ou opção desligada)` and one
  warn. Nothing fails: a category tree is a cached read, and an import that
  blocked on it would be worse than an unlinked categoria that says so once.
- **A second run should write almost nothing** — every model `sem mudança`,
  every grupo `match`, `fotos … a baixar 0` — and that is the idempotence check
  worth doing before any live run against a real catalogue.
- **Never run by an agent** (root `CLAUDE.md` rule 8) — in `--live` it writes
  real produtos, real links and real files into Storage.

---

## `publicar:anuncio` — rehearsing the first listing WRITE

Every script above this one either READS Shopee or writes the ERP. This one is
the first that writes **Shopee**: `--live` creates or updates a real listing on
a real marketplace, visible to real buyers. `publicarAnuncioShopee` normally
runs from the `publicar` route; this script drives the same code from a terminal
against ONE named produto, so the channel's first `add_item` is deliberate and
observable instead of arriving on an HTTP call nobody was watching.

It is also where the whole plan is printed. The publisher is split `preparar`
(write-free) → `planejar` (pure) → `aplicar`, so a dry run runs the first two
halves and renders what the third would send. That is not a re-implementation of
the live path: it is the live path, minus the writer. The reasoning behind every
line it prints is `lib/shopee/anuncios/README.md`.

### 12.1 Environment

Same `.env.local` as every other script here (`dotenv -e ../../.env.local -- tsx
…`), and the same variables as §1. Step 11 adds **no** variable of its own —
what it needs are three fields on the **integração document**, and each one
silently disables a leg:

| field on `integracao/{id}` | what its absence does                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `operacaoOuterRef`         | `tax_info` is omitted with `motivo=sem-operacao` — the listing publishes with NO fiscal block             |
| `tabelaNormalOuterRef`     | the produto reads as priceless and the plan is BLOCKED with `sem-preco` / `filho-sem-preco`               |
| `depositoOuterRef`         | the available stock reads as `0`, which a shop with a stock minimum refuses as `estoque-abaixo-do-minimo` |

⚠️ **The shop must be authorized.** A conta connected by MAIN ACCOUNT has no
`shop_id`, so nothing can be Shop-signed: the script prints an instruction and
exits `1` rather than a stack. That is a legitimate state, not a bug.

⚠️ **This CLI writes on the real marketplace**, so the project the environment
points at decides which shop you are publishing to. Read the preamble — mode,
project, database, `SHOPEE_SANDBOX`, the integração, the produto — before you let
it continue, exactly as in §1.

### 12.2 Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app publicar:anuncio --integracao int-1 --produto prod-1
```

⚠️ **A dry run is not offline, and it is not free.** It reads Firestore, calls
`get_item_limit`, the category tree and `get_channel_list` — and **it uploads the
pictures**. The `add_item` body needs real `image_id`s to be a body at all, so
the photo resolver runs for real; the cost is paid ONCE, because every id lands
in `arquivos.externalIds` and the next pass reuses it. What a dry run never does
is WRITE Firestore or create a listing, and that property is **structural**:
neither `prepararPublicacao` nor `planejarPublicacao` has a writer anywhere in
its body, proved by a FakeDb that throws on every write verb.

The usage the script itself prints (`--help`, answered before any validation and
before the first dynamic import, so it touches no environment, no Firestore and
no Shopee):

```
Publica UM produto do ERP como anúncio na Shopee, pelo caminho real do step 11.

  pnpm --filter @delfrance/shopee-app publicar:anuncio \
    --integracao <integracaoId> --produto <produtoId> [opções]

Obrigatórios
  --integracao <id>   documento da integração Shopee (ex.: int-1)
  --produto <id>      o produto PAI do ERP (nunca uma variação)

Opções
  --link <docId>      o vínculo prodshopee a usar, quando o produto tem mais de um
  --categoria <id>    category_id folha, só dígitos. Só é usado quando o vínculo
                      NÃO tem categoria; nunca sobrescreve a armazenada.
  --status UNLIST     publica pausado. O padrão é NORMAL (à venda).
  --dry-run           lê, resolve as fotos e PLANEJA, sem escrever. É o PADRÃO.
  --live              PUBLICA DE VERDADE na Shopee e grava os vínculos.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore
                      nem chamar a Shopee.
```

| flag                | meaning                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--integracao <id>` | **required** — the Shopee integração document. A conta missing, inactive or of another tipo fails HERE, in `loadShopeeContext`                                                    |
| `--produto <id>`    | **required** — the **PARENT** produto. A child or a native kit is refused inside `prepararPublicacao`, before a plan exists (see the exit codes below)                            |
| `--link <docId>`    | optional — which `prodshopee` link to use when the produto has more than one. A `linkDocId` belonging to another conta resolves to nothing and the script exits `1`, never to 404 |
| `--categoria <id>`  | optional — **digits only, and never trimmed**: `' 100017'` is refused rather than repaired. Used ONLY when the resolved link carries no `category_id`; it never overwrites one    |
| `--status`          | `NORMAL` (default) or `UNLIST`, **exactly** — no case fold and no alias, so `unlist` is refused                                                                                   |
| `--dry-run`         | the **DEFAULT**, and redundant. ⚠️ `--live --dry-run` is **REFUSED**, never resolved by precedence                                                                                |
| `--live`            | the only opt-in to a real publish                                                                                                                                                 |
| `--project <id>`    | overrides `FIREBASE_PROJECT_ID` before the admin app resolves it                                                                                                                  |
| `--json`            | the same REDACTED summary as one parseable document on stdout, preamble on stderr                                                                                                 |
| `--help`, `-h`      | prints the usage and exits `0`, ahead of every validation                                                                                                                         |

⚠️ A bare `--` is refused, and no command in this file carries one (see the note
at the top).

### 12.3 What to read in the output

Thirteen blocks, in order. The whole rendering is an **allow-list** — named
fields only, never a raw payload — so it is safe to paste into an issue. Keep it
that way if you extend it.

| line                                                                                                                          | what it tells you                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `## O que uma publicação faria (produto …, sequência create\|update)`                                                         | whether this run would CREATE a listing or update the one the link already names. `create` on a produto you believe is published means the link is missing, not that Shopee forgot it.                                                                                   |
| `item_id … vínculo=`                                                                                                          | `novo` on a create, else the stored id, plus which `prodshopee` document decided.                                                                                                                                                                                        |
| `status … pedido=… add_item envia=…`                                                                                          | the two are DIFFERENT on purpose: a create with children always sends `UNLIST` and is re-listed after the models exist. `pedido=` is what you asked for.                                                                                                                 |
| `categoria … (folha\|nao-folha\|desconhecida)`                                                                                | the resolved id, the leaf verdict and the root-first path, or `(fora da árvore)`. A non-leaf is refused as `categoria-invalida`.                                                                                                                                         |
| `item_name` / `descrição` / `condition` / `weight` / `dimension` / `brand` / `item_sku / gtin_code` / `pre_order` / `imagens` | the body's scalar fields. The description is **counted, never rendered** (`«REDIGIDA — N caractere(s)»`), and `imagens` is a COUNT: the URLs and the `image_id`s are omitted deliberately.                                                                               |
| `### attribute_list (N)`                                                                                                      | per attribute the id, how many values and whether it is mandatory — then `obrigatórios SEM valor` as NAMES, which is exactly the `atributo-obrigatorio` refusal spelled out.                                                                                             |
| `### tax_info`                                                                                                                | `bloco … ENVIADO inteiro` or `omitido (<motivo>)`, the `chaves` line always, then one `chave valor` line per field. ⚠️ **The VALUES are printed here** — unlike `importar:anuncio`, which prints keys only. A CFOP or a CSOSN is a catalogue code, not a seller's datum. |
| `### logistic_info (N a enviar)`                                                                                              | one row per channel sent (`fee_type`, `enabled`, `is_free`) and then `pulados` with each channel's reason. A channel can appear in both lists — one says "on anyway", the other "not sent by us".                                                                        |
| `### tiers (N)`                                                                                                               | per grupo the `variation_id` and the group, then each option with `foto=sim\|não` and `(ocupada por modelo sem filho)` where a live model holds a position nothing of ours binds.                                                                                        |
| `### modelos (acao=…, profundidade mudou=…)`                                                                                  | `init` / `update` / `nenhuma`, the new models' `tier_index`, sku, price and stock, the re-listed ones, the skus to update, the `modelos sem filho` that are KEPT, and any `vínculos desaparecidos`.                                                                      |
| `### fotos e sequência`                                                                                                       | five counts plus one line per failure (`arquivoId — motivo`, **never** the message or the URL), and which re-list door is planned.                                                                                                                                       |
| `### passos que o --live executaria (N)`                                                                                      | the plan's own step list, numbered. It is READ from the plan, never re-listed by the renderer, so it cannot start lying about what the publisher does.                                                                                                                   |
| `### problemas: NENHUM — este produto é publicável`                                                                           | the line you are looking for. Otherwise `### problemas (N) — NADA seria enviado` and one line per problema (campo · motivo · mensagem) — a non-empty list means **nothing** would be sent, not that part of it would.                                                    |

### 12.4 The live run

```bash
pnpm --filter @delfrance/shopee-app publicar:anuncio --integracao int-1 --produto prod-1 --live
```

⚠️ **`--live` creates a REAL listing.** Use `--status UNLIST` to publish it
paused and look at it in Seller Centre before it is for sale — that is the
rehearsal shape for a first real publish, and re-listing it later is one
`anuncio-status reativar` away.

The live printout is shorter and different on purpose: `item_id` / `vínculo` /
`sequência`, then the **read-back** (`estadoAnuncio`, `item_status`, `deboost`)
or `DEGRADOU — a segunda escrita de vínculo NÃO aconteceu` when the confirmation
read refused, `relistagem` naming which door worked, `tax_info` (`enviado` or
`omitido (<motivo>)`), the violation aviso, the count of calls spent on Shopee,
and the modelos / fotos counters. Everything there comes from what Shopee
ANSWERED — the status is never echoed back from the request.

**The exit codes.** `0` on any DRY RUN that reached a PLAN, **including a blocked
one**: a `problema` is an answer, and reading them is what the dry run is for.
`0` on `--help`. `1` on any throw, described by CLASS plus the Shopee code and
path, never by a payload. `1` when the produto is not found, or the named
`--link` belongs to another conta. `1` on a conta with no `shop_id`.
⚠️ **`1` in BOTH modes for a produto that is a CHILD or a native KIT**, because
`prepararPublicacao` refuses those before a plan exists — the rule is "was a plan
reached", not "how bad is the refusal". ⚠️ Under `--live` a refusal is not caught
either, and the transcript adds `Nada garante que nada foi criado` plus
`releia com --dry-run`.

⚠️ **"Native kit" is the whole rule, and step 12 corrected the code to match
this sentence.** `produto-e-kit` = a NATIVE Shopee kit = `link.kitNativo ===
true` on a republish, or `produto.ehKitVirtual === true` on a first publish.
`produto.ehKit` **never** refuses a publish: an ERP kit publishes as an ordinary
Shopee listing with the component-derived quantity. Until step 12 the refusal
keyed on `ehKit` alone, so a produto this paragraph said would publish did not —
the slug is unchanged, its meaning narrowed, and the first republish after that
fix can create listings for produtos previously unpublishable.

### 12.5 Caveats you should expect to see (none of these is a bug)

- **THE DRY RUN UPLOADS ITS PICTURES.** Said again because it surprises
  everyone: the body needs real `image_id`s. Paid once, cached on the arquivo.
- **`tax_info` omitted with `motivo=sem-operacao`** on a produto whose conta has
  no `operacaoOuterRef`, or whose operação has no rule matching the produto. The
  block is whole or absent — there is no partial `tax_info`.
- **`taxInfoOmitido: 'recusado-incompleto'`** after a live run means Shopee
  refused the block as incomplete and the publisher retried the SAME call ONCE
  without it. The listing published; the fiscal block did not.
- **`logistica-sem-canal`** on a shop whose only enabled channel needs a
  `size_id` the produto has none of (`SIZE_SELECTION`). A shop with no usable
  channel cannot publish, and that is Shopee's rule, not ours.
- **The ≥ 5 s wait looks like a hang** between `add_item` and the tier leg on a
  create with children. It is `esperar(5000)`, and it is deliberate: Shopee
  needs the item to settle before `init_tier_variation`.
- **The parent's price and stock are ignored once models exist.** They ride the
  create because the body requires them, and the models replace them inside the
  same sequence.
- **`estoque-abaixo-do-minimo`** names a band you did not choose: the shop's own
  `stock_limit.min_limit`. The sandbox shop's minimum is **2**, measured — so a
  produto with one unit available is refused, and Mercado Livre accepting `0`
  here is not evidence about Shopee.
- **A re-list refused with `error_set_normal_unlisted_item`** falls back to
  `update_item {item_status: 'NORMAL'}`. Two documented doors, one literal
  ordering them; seeing the second one used is information, not a failure.
- **`modelos sem filho`** is a live model with no ERP child. It is **KEPT** in
  every list, because an omitted model is a DELETED model at Shopee.
- **The model plan on an UPDATE path is PROVISIONAL in a dry run.** `preparar`
  reads no `get_model_list`, so the printed leg is reconciled against an unknown
  live tree; the live run re-derives it from a FRESH read. Stated in the module
  header too.
- **A dry run over an existing listing prints the CREATE body's fields** —
  `item_status`, `seller_stock` and `pre_order` included — because `criar` is
  always the complete body and `atualizar` is the field-wise subset of it. The
  header line tells you which sequence would actually run.
- **Never run by an agent** (root `CLAUDE.md` rule 8) — in `--live` it publishes
  on a real marketplace, and in either mode it uploads pictures to Shopee.

---

## `enviar:estoque` — rehearsing the first quantity WRITE

`publicar:anuncio` above writes a listing. This one writes a **number on a
listing that already exists**, which is the one Shopee write an operator will
run again every day. `enviarEstoqueManualShopee` normally runs from the
`enviar-estoque` route; this script drives **the same module** from a terminal
against up to 50 named produtos, so the channel's first `update_stock` is
deliberate and observable instead of arriving on an HTTP call nobody was
watching.

It is also the only place the whole PLAN is printed. The dry run stops one step
short of the sender — `buscarFamiliasShopeePorIds` →
`quantidadesDaFamiliaShopee` → `montarTarefasDeEstoqueShopee` plus one
`get_item_promotion` for the floor column — and renders exactly the tasks the
live path would enqueue. That is not a re-implementation: it is the live path's
own planner, minus the writer, and the two branches load **different modules**
(`lib/shopee/estoque/enviarEstoqueCli.ts:19-30`), so the dry run cannot reach a
sender even by accident. The reasoning behind every line it prints is
`lib/shopee/estoque/README.md`.

### 13.1 Environment

Same `.env.local` as every other script here (`dotenv -e ../../.env.local -- tsx
…`), and the same variables as §1. Step 12 adds **no variable this command
reads** — its `SHOPEE_STOCK_*` knobs belong to the nested Cloud Functions
codebase (`functions/DEPLOY.md`). What it needs are two things on the
**integração document**:

| field on `integracao/{id}` | what its absence does                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `depositoOuterRef`         | **refused**, `SHOPEE_CONTA_SEM_DEPOSITO`: with no depósito there is no quantity to derive, so the command stops rather than sending a guess |
| an authorized `shop_id`    | a conta connected by MAIN ACCOUNT can sign nothing Shop-scoped; the script prints a re-consent instruction and exits `1`, never a stack     |

⚠️ **This CLI IGNORES `SHOPEE_STOCK_SYNC_ENABLED`**, on purpose, and the
preamble prints the raw value beside that sentence
(`scripts/enviar-estoque.ts:155-160`). That variable is the master valve of the
three **scheduled** sweeps and of the `sendShopeeStock` queue; the manual push
passes `ignoreSyncFlag: true` because the button has to work before the
automatic sync is switched on. So a project with the sweeps OFF still sends from
here.

⚠️ **This CLI writes on the real marketplace**, so the project the environment
points at decides which shop receives the quantity. Read the preamble — mode,
project, database, `SHOPEE_SANDBOX`, the integração, the produto list, the valve
— before you let it continue, exactly as in §1.

### 13.2 Dry run first — always

```bash
pnpm --filter @delfrance/shopee-app enviar:estoque --integracao int-1 --produto prod-1
```

```
--integracao <id>     obrigatório — o documento da integração Shopee.
--produto <id>        obrigatório e REPETÍVEL — o produto ÂNCORA da família.
--reenviar-com-erro   ignora a impressão digital da última recusa, e SÓ ela.
--dry-run             É O PADRÃO.
--live                a única forma de enviar.
--project <id>        sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
--json                resumo redigido em JSON no stdout; cabeçalho no stderr.
--help, -h            sai com 0 antes de tocar env, Firestore ou Shopee.
```

| flag                  | meaning                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--integracao <id>`   | **required** — the Shopee integração document. A conta missing, inactive or of another tipo fails HERE, in `loadShopeeContext`                                                      |
| `--produto <id>`      | **required and REPEATABLE** — the family **ANCHOR**, never a variação. ⚠️ **No comma-separated form**, because a comma is a legal character in a document id. Deduped in flag order |
| `--reenviar-com-erro` | bypasses the per-link **skip set** and NOTHING else. A removed, banned, in-review, native-kit or id-less listing still refuses with it on                                           |
| `--dry-run`           | the **DEFAULT**, and redundant. ⚠️ `--live --dry-run` is **REFUSED**, never resolved by precedence                                                                                  |
| `--live`              | the only opt-in to a real quantity write                                                                                                                                            |
| `--project <id>`      | sets `FIREBASE_PROJECT_ID` before the admin app opens                                                                                                                               |
| `--json`              | the same REDACTED summary as one parseable document on stdout, preamble on stderr                                                                                                   |
| `--help`, `-h`        | prints the usage and exits `0`, ahead of every validation and before the first `await import(`                                                                                      |

⚠️ **The cap is 50 produtos, counted AFTER the duplicates are removed**
(`SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS`). 51 flags naming 50 distinct produtos is
ACCEPTED; 51 distinct ones is refused by this command's own argument error, with
the usage — not by the module, which would answer a server-misconfiguration
error, the wrong sentence for a human who typed one flag too many.

⚠️ A bare `--` is refused, and no command in this file carries one (see the note
at the top).

**What the dry run calls, and what it can never call.** It reads
`produtoCollection.docRef(…).get()` once per requested id (for the name),
`buscarFamiliasShopeePorIds`, `quantidadesDaFamiliaShopee`,
`montarTarefasDeEstoqueShopee`, `lerEstadoEstoque`, and
`client.getItemPromotion` chunked at `SHOPEE_ITEM_PROMOTION_MAX_IDS`. It never
reaches `enviarEstoqueManualShopee`, `processShopeeStockSendTask`,
`update_stock`, any scheduler or any Firestore write — the sender module is not
even imported on that path, and a test over the script's raw text is what keeps
it that way.

### 13.3 What to read in the output

A header, then one block per anúncio, then the skips. The whole rendering is an
**allow-list** — named fields only, never a raw payload — so it is safe to paste
into an issue. Keep it that way if you extend it.

| line                                                | what it tells you                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integração` / `solicitados` / `famílias lidas`     | what you asked for and how many family rows discovery returned. `famílias lidas` below `solicitados` means an anchor came back with no row — it is reported as a skip, never dropped silently.                                                                |
| `anúncios no plano` / `modelos no plano`            | how many `update_stock` calls a live run would make, and how many models ride in them. One call per **listing**, never per model.                                                                                                                             |
| `orçamento da task`                                 | the encoded-body budget and the warning threshold. A listing above the warning prints `⚠️ acima do aviso` on its own `tamanho` line; at 50 models a real payload is ~6 KiB against 80 KiB, so this is a drift backstop, not a bound.                          |
| `### anúncio i/N — <produtoId>`                     | one block per planned listing: `produto` (with its name), `anúncio` (the `item_id`), `vínculo` (the `prodshopee` document), `estado`, `kit nativo` and `parte P/T`.                                                                                           |
| `parte 1/1`                                         | the normal case. `1/2` means the listing's models exceeded the wire's 50-model ceiling and were split across two tasks — possible only on drifted link data, and safe, because a partial `stock_list` leaves the omitted models untouched.                    |
| `modelos (N)` — the table                           | `model_id · produto · qtd · envia · piso · banda · clampeado`. ⚠️ `qtd` is the planner's **unclamped** number and `envia` is what would actually go — read them as a pair. `model_id 0` is the no-model listing, a real id, never "no model".                 |
| `piso` / `clampeado: piso`                          | the reserved floor `get_item_promotion` reported for that model. `clampeado: piso` means **Shopee has promised more units than you hold** and the send would be raised to the floor — the thing this column exists to show.                                   |
| `banda` — always `—` today                          | the category's `stock_limit.max`. **Nothing resolves a band on this path**, deliberately: filling it would cost one `get_item_limit` per listing. The column is the seam a future band read plugs into, so `clampeado` can only say `piso` or `nenhum` today. |
| `kit <produtoId> — a conta que produz a quantidade` | for an ERP kit, one line per component (`disponivel`, `por kit`, `limita`) and then `min =`. This is the whole arithmetic behind the number, printed rather than asserted.                                                                                    |
| `### pulos (N) — não seriam enviados`               | one line per refusal or annotation: produto, anúncio, motivo slug, the rendered pt-BR message, and `model=` / `modelos=` when the line is about one model or about a chunk.                                                                                   |
| `### totais por motivo`                             | the same skips folded by motivo, each marked `recusa` or `aviso `. ⚠️ `clampado-na-reserva` is an **aviso**, not a `recusa` — counting `motivo !== null` as a failure reports every clamped send as one.                                                      |

⚠️ **A dry run cannot tell you what Shopee currently shows.** It prints what the
ERP would send and what the promotion read says the floor is; only a live send
plus a read-back proves what the listing now holds. And do not look for
`update_time` to confirm anything — a stock write does **not** move it
(measured, probe P5), so `get_item_list?update_time_from` can neither detect
Shopee-side drift nor confirm your write.

### 13.4 The live run

```bash
pnpm --filter @delfrance/shopee-app enviar:estoque --integracao int-1 --produto prod-1 --live
```

⚠️ **`--live` writes a REAL quantity** on a real listing, and it force-sends:
the manual path passes `ignoreSyncFlag: true`, so the master valve does not
protect you here. It also writes the link documents' eleven stock fields
through the real handler.

The live printout is shorter and different on purpose: the header counters
(`enviados`, `pulados`, `falhas`, `não tentados`, `pausado até`), then one row
per listing — `produtoId`, the produto's **name**, `anuncioId`, its `outcome`
and the counts — followed by its motivo and the rendered message, then one
`model …` line per model with `pedida=` / `enviada=` / the per-model result /
`clampado piso=` / Shopee's verbatim code, and finally
`### produtos sem envio`. Everything there comes from what Shopee ANSWERED —
`enviada=` is what was sent, never echoed back out of `success_list`.

**The exit codes.**

| code | when                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | any envelope, **including one where every listing failed** — a per-listing refusal is DATA, and the route answers `200` there, so the two surfaces must not disagree |
| `0`  | a dry run that plans nothing at all                                                                                                                                  |
| `0`  | `--help`                                                                                                                                                             |
| `1`  | a bad command line (`--live --dry-run`, a missing `--produto`, more than 50 distinct ids); prints THIS command's usage                                               |
| `1`  | a conta with no `shop_id`, printed as a re-consent instruction rather than a stack                                                                                   |
| `1`  | any throw: the depósito guard by CLASS plus its `code`, then the Shopee ladder by class plus code/path. ⚠️ Never a payload, and never the guard's `extra` bag        |

### 13.5 Caveats you should expect to see (none of these is a bug)

- **A paused conta is REPORTED, not refused.** The route answers `409
SHOPEE_CONTA_PAUSADA` before any provider call; this command reads the state
  document, prints the pause and **proceeds**, because inspecting a paused conta
  is exactly what a dry run is for. Under `--live` you then get a page of
  `nao-tentado` rows carrying `pausadoAte` — the refusing scheduler's answer,
  per listing. The two surfaces still agree on the exit code. ⚠️ The pause is
  printed, not honoured: the shop-signed client is built and the dry run's one
  `get_item_promotion` per ≤50 listings is still spent, so that a paused conta
  gets its real `piso` column. What the 409 saves on the web surface, this one
  deliberately does not.
- **`kit-derivado`** on a **native Shopee kit** (`link.kitNativo === true`). An
  ERP `ehKit` produto is an ordinary listing and IS sent, at its
  component-derived quantity — that is what the `kit` block prints.
- **`recusa-anterior`** on a listing that has not changed state since its last
  refusal. That is the skip set working: it lifts on a state change or on a
  clock, and `--reenviar-com-erro` bypasses it (and nothing else).
- **`clampado-na-reserva` plus an aviso.** A clamp is an ANNOTATION on a
  SUCCESSFUL send, and it raises `estoqueAcimaDoDisponivel` in the operator
  inbox for the MODEL's produto. The row closes itself on the next clean,
  unclamped send of the same produto — nothing else closes it.
- **`bloqueado-por-promocao`** clears itself after `SHOPEE_STOCK_PROMOCAO_RETRY_MIN`
  minutes. A promotion ending moves no `item_status`, so this one is a TIME
  skip, not a fingerprint skip.
- **A whole conta skipped** as `loja-fbs`, `multi-armazem`, `loja-cbsc`,
  `loja-outlet`, `loja-banida-ou-congelada` or `loja-em-ferias`. Those are the
  conta gates, decided once per run before any listing is read.
- **`envio-parcial`** when one model of fifty is refused: the listing keeps the
  models Shopee accepted and the refusal is recorded per model. It deliberately
  does **not** stamp `estoqueEnviadoEm`, so the next tick re-sends.
- **The plan is PROVISIONAL about the floor.** `get_item_promotion` is read once,
  before the send; a promotion that starts between the two answers a refusal the
  sender handles by re-reading the floor and retrying ONCE.
- **`produtoNome` costs one extra document read per requested id** (up to 50, in
  parallel). It buys the name in every row; nothing else reads it.
- **Never run by an agent** (root `CLAUDE.md` rule 8) — under `--live` it writes
  quantities on a real marketplace, and even a dry run calls Shopee.

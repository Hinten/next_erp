# apps/shopee/scripts/

Dev-only CLIs. **Never run by an agent** (root `CLAUDE.md` rule 8) — a human
runs them, from this worktree, against the project the environment points at.

| script                   | what it does                                    | writes?                   |
| ------------------------ | ----------------------------------------------- | ------------------------- |
| `oauth-url.ts`           | mints a Shopee consent URL without the web UI   | one `oauthState` document |
| `importar-pedido.ts`     | imports ONE order through the real step-5 path  | only with `--live`        |
| `liquidar-pagamentos.ts` | rehearses the weekly escrow settlement (step 6) | only with `--live`        |

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
tab (`valorCobrado`, the dispatch deadline, the package as one volume), and the
`observacoesInternas` if the buyer wrote one. `/incidentes` carries one
non-blocking row per unbound line.

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
- **`custoFinal` and `codRastreio` stay null.** Step 7 owns tracking and the
  shipment; a value invented at import would look like a shipment that happened.
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
It pages `get_escrow_list`, calls `get_escrow_detail` for every row, reads each
row's pagamento and prints what a live tick **would** change. It writes nothing —
the function it calls (`simularLiquidacaoShopee`) contains no writer at all, and
its verdict comes from the very same `preverLiquidacaoShopee` the transaction
uses, so the rehearsal cannot disagree with the run it rehearses.

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

| line                       | what it tells you                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `janela`                   | the release-time window actually asked for, as ms + ISO UTC.                                                                                                                                                                                 |
| `janela drenada?`          | `sim` means `more: false` — the window finished. `NÃO` means a page or budget cap stopped it and the cursor would not move.                                                                                                                  |
| `pedidoId` / `pagamentoId` | both are DIGESTS of `(integracaoId, order_sn)`; `AUSENTE` on either is what parks the row and sends a synthetic code 3.                                                                                                                      |
| `payout / escrow`          | ⚠️ the open question of step 6. `payout_amount`'s unit is unresolved on Shopee's own page (the table prints a float, the sample prints an integer 100× larger), so the sweep logs the RATIO beside it: **~1 means units, ~100 means cents.** |
| `tarifas`                  | the clamped figure `pagamento.tarifas` would take — commission + service + seller transaction, BR net variants preferred.                                                                                                                    |
| `ação`                     | `liquidado`, `ignorado-sem-mudanca` (the idempotent overlap — writes nothing), `ignorado-obsoleto` (the stored release stamp is newer) or `ignorado-sem-pagamento`.                                                                          |
| `campos que mudariam`      | the exact dotted field names a live run would write. `(nenhum)` beside `ignorado-sem-mudanca` is the healthy steady state.                                                                                                                   |

⚠️ **The output carries no buyer data by construction.** The escrow body it is
built from has ~100 money fields plus `buyer_payment_info`; the summary is an
allow-list of thirteen, and a buyer field has nowhere to travel. It is safe to
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
- **The sandbox has no released escrow.** `get_escrow_list` over any window will
  answer an empty page there; the endpoint is exercised, the settlement is not.
- **`janela drenada? NÃO` on a first run over a wide window is normal** — the page
  cap (20) and the per-tick settlement budget (300) both truncate deliberately,
  and the next tick resumes at the persisted page.
- **`payout / escrow` may look 100× apart.** That is the open question, not a
  defect; record the ratio you see.

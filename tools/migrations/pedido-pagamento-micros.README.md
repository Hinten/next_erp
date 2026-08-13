# Migration: `pedido` + `pagamento` datetime fields → microseconds

**Status: TOOLING BUILT, NOT YET EXECUTED.** The runner + script live in the
`@delfrance/migrations` package (see **How to run** below); the backfill is
executed once the project core is finished. Until then the schemas read
tolerantly (see below), so no data has to move for the app to work — this
document is the runbook and the reference for the future Flutter import.

## Why

> **⚠️ Corrected 2026-08-12 — read this before running anything.**
>
> This document used to justify the migration as a move to "the higher-precision
> microseconds". **That justification was wrong at the time it was written**, and
> is only partly right now.
>
> `nowMicros()` is `Date.now() * 1000` — microsecond _units_ at millisecond
> _precision_, low three digits structurally zero. And until the ISO parser was
> fixed, `coerceToMicros` truncated provider strings with `Date.parse` and then
> refilled the lost digits with zeros. So at the time this migration was written,
> **every** value it produced was padding: multiplying integers by 1000 bought
> nothing, on a corpus that costs a coordinated migration-window slot to rewrite.
>
> What changed: the parser now preserves the sub-millisecond digits providers
> actually send (Django REST Framework emits up to 6). So microseconds are now
> genuinely justified — **but only for the fields whose value comes from a
> provider.** For fields we stamp ourselves, the precision is still padding.
>
> The field-by-field split is below. Run `--report-only` first: the shape report
> now prints `µs=REAL` or `µs=PADDING` per field, which is the empirical version
> of that table.

Datetime fields were standardized onto a **plain integer epoch** (never a
Firebase `Timestamp`, which each SDK deserializes differently). `pedido`,
`pagamento` and the embedded `frete` converged on **microseconds since epoch**
via `microsSinceEpoch()` from `@delfrance/schemas`. Their previous wire formats
were:

| Collection / path                                            | Field(s)                                                                                                                                        | Old format                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pedidos/{id}`                                               | `timestamp`, `ultimaModificacao`, `dataFinalExpedicao`, `dataIndisponivelEstoque`, `dataRemocaoEstoque`, `lastMarketplaceUpdate`, `dtImpressao` | `int` **milliseconds** (legacy Flutter) |
| `pedidos/{id}` (embedded `itens.{produtoUid}[]`)             | `timestamp`                                                                                                                                     | ISO-8601 string                         |
| `pedidos/{id}` (embedded `freteInicial` / `itensDevolvidos`) | `timestamp`, `ultimaModificacao`, `prazoDespacho`, `dataEntrega`, `dataPrevisaoEntrega`, `externalOptionSelectionDate`                          | `int` **milliseconds**                  |
| `pedidos/{id}/pagamento/{pagId}` _(singular!)_               | `vencimento`, `ultimaModificacao`, `dataCancelamento`, `dataAprovacao`, `dataCadastro`                                                          | ISO-8601 string                         |
| `metodo_pgto/{id}`                                           | `dataCadastro`                                                                                                                                  | ISO-8601 string                         |

> **Path note (corrected #791):** BOTH paths exist and the migration walks
> both. Legacy Flutter wrote the **singular** `pedidos/{id}/pagamento`; this app
> writes the **plural** `pedidos/{id}/pagamentos` (`pagamentoMeta.collectionPath`,
> which `pagamento.ts` records as matching legacy's own `PAGAMENTO_COLLECTION`
> constant). The earlier note claimed singular was "the path the app actually
> reads/writes" — it is not, and as built the migration would have scanned
> **zero** of this app's pagamento documents and still reported success.

## Does each field actually need microseconds?

Classified by reading the **writers**, not the field names. "Provider" means the
value is parsed from a provider payload, so it can carry real sub-millisecond
precision; "self" means we stamp it from our own clock, where µs is padding;
"human" means an operator or a calendar supplies it, where sub-second precision
is meaningless.

| Field                                           | Source         | Evidence                                                                                    | µs justified?                                                |
| ----------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `pedido.ultimaModificacao`                      | **provider**   | `avancarWatermark(coerceToMicros(raw.ultimaModificacao), nowUs)` — `orderImport.ts:653,751` | **yes** — it is a watermark compared against provider clocks |
| `pedido.lastMarketplaceUpdate`                  | **provider**   | `relogioFinal = relogioOrdemUs ?? core.ultimaModificacao` — `orderPedidoTx.ts:586,605`      | **yes**                                                      |
| `freteInicial.dataPrevisaoEntrega`              | **provider**   | `coerceToMicros(leadTime?.estimated_delivery_time?.date)` — `orderShipmentMapping.ts:134`   | **yes**                                                      |
| `freteInicial.prazoDespacho`                    | **provider**   | `resolvePrazoDespacho(...)` off ML `estimated_delivery_limit.date` — `orderImport.ts:982`   | **yes**                                                      |
| `pagamento.dataAprovacao`                       | **provider**   | `coerceToMicros(payment.date_approved)` — `orderPaymentMapping.ts:227`                      | **yes**                                                      |
| `pagamento.ultimaModificacao`                   | mixed          | mapper value, else our clock                                                                | yes (compared against provider stamps)                       |
| `pedido.timestamp`                              | **self**       | `timestamp: nowUs` — `orderImport.ts:574,895`, `orderPedidoTx.ts:666`                       | no — padding                                                 |
| `pedido.dtImpressao`                            | **self**       | `dtImpressao: nowMicros` — `apps/web/lib/pedido-print/batch.ts:77`                          | no — padding                                                 |
| `pedido.dataIndisponivelEstoque`                | **self**       | `agoraUs` — `sincronizarEstoquePedido.ts:946`                                               | no — padding                                                 |
| `pedido.dataRemocaoEstoque`                     | **self**       | `agoraUs` — `sincronizarEstoquePedido.ts:949`                                               | no — padding                                                 |
| `pagamento.dataCadastro`                        | **self**       | `nowMicros()` — `pedidoReconcile.ts:221`                                                    | no — padding                                                 |
| `pagamento.vencimento`                          | **human**      | payment form — `PagamentoForm.ts`                                                           | no — a due _date_                                            |
| `pagamento.dataCancelamento`                    | human/provider | `mapping/payment.ts:190` writes null; otherwise operator-set                                | no                                                           |
| `pedido.dataFinalExpedicao`                     | **human**      | form field                                                                                  | no                                                           |
| `freteInicial.dataEntrega`                      | **human**      | form field ("Data de entrega")                                                              | no                                                           |
| `freteInicial.externalOptionSelectionDate`      | **self**       | stamped when the option is chosen                                                           | no — padding                                                 |
| `freteInicial.timestamp` / `ultimaModificacao`  | mixed          | follows the parent pedido                                                                   | yes, by association                                          |
| `itens[].timestamp`, `metodo_pgto.dataCadastro` | **self**       | creation stamps                                                                             | no — padding                                                 |

**What this means for the run.** The direction (ms → µs) stays correct: the
fields that _are_ provider-sourced need microseconds, and a single unit across
the document is worth more than shaving padding off the others — a mixed-unit
document is exactly the "cross-unit comparison is a guard that never fires"
hazard Critical rule 7 warns about. So **the scope does not change**; only the
justification does. Do not split the corpus into µs and ms fields.

## Why a backfill is not urgent (tolerant reads)

`microsSinceEpoch()` wraps `z.preprocess(coerceToMicros, z.number().int())`.
`coerceToMicros` (in `@delfrance/core/datetime`) normalizes **any** legacy shape
— a millisecond number, a microsecond number, an ISO string, or a `Date` — to
microseconds by magnitude. So a document written before the backfill still reads
and renders correctly (the data-layer converter normalizes on read). New writes
already go out as microseconds. The backfill only canonicalizes data **at rest**.

## The transform (idempotent)

The migration **imports the same `coerceToMicros`** the runtime preprocess uses,
so there is one definition of "what is microseconds":

```ts
import { coerceToMicros } from '@delfrance/core/datetime';
// number (ms, ≤ MILLIS_UPPER_BOUND) → ×1000 ; number (µs, ≥ MICROS_LOWER_BOUND) → unchanged ;
// ISO string → Date.parse ×1000 ; Date → ×1000 ; null/unparseable/gap → null
```

Idempotency falls out of the magnitude heuristic: a value already in
microseconds (`≥ MICROS_LOWER_BOUND` = 1e14) is returned unchanged, so re-running
is a no-op. A value in the undeterminable gap `(MILLIS_UPPER_BOUND, MICROS_LOWER_BOUND)`
= `(9e12, 1e14)` — unreachable by any real ERP timestamp in either unit, and
capped at 9e12 so `ms × 1000` never overflows `Number.MAX_SAFE_INTEGER` —
returns `null`; the migration **logs and skips** it, never guesses. A field is
written back only when `coerceToMicros` returns a value **different** from what
is stored.

## Scope to rewrite per document

1. `pedidos/{id}` — the seven top-level numeric fields, the embedded
   `freteInicial.*` (six fields, same doc), `itens.{produtoUid}[].timestamp`
   (`Object.values(itens).flat()`), and `itensDevolvidos`
   (record-of-record-of-arrays). One `update()` per pedido with all rewritten
   fields.
2. `pedidos/{id}/pagamento/{pagId}` — the five fields, per pagamento doc.
3. `metodo_pgto/{id}` — `dataCadastro`.

The Admin SDK does not cascade: page `db.collection('pedidos')`
(`startAfter`, ~300/page) and, per pedido, read `.collection('pagamento')`.
Batch writes ≤ 500 ops/commit.

## Runner contract (`tools/migrations/README.md`)

- **Idempotent** (the heuristic above).
- **`--project <id>` required** — never default to a production project.
- **Dry-run by default**; `--apply` to write. Dry-run logs every intended
  `path · field · old → new` without writing.
- **Log every change** to a timestamped file under `out/`.
- firebase-admin v14.

This is implemented by the `@delfrance/migrations` package:

- `src/runner.ts` — `parseArgs` (`--project` required, `--apply`, dry-run
  default), the `out/` change log (`ChangeSink`), and a batched `BatchWriter`
  (≤ 400 ops/commit). `src/admin.ts` binds to the **explicit** `--project` and
  refuses if the service account names a different project.
- `src/2026-06-pedido-pagamento-micros/transform.ts` — the **pure** per-doc
  transforms (`transformPedido` / `transformPagamento` / `transformMetodoPgto`)
  reusing `coerceToMicros`; `migrate.ts` — the Firestore walk + CLI entry.
- `transform.test.ts` feeds the output back in to assert the no-op (idempotency)
  and covers every legacy shape; `runner.test.ts` covers the arg contract.

## How to run

```bash
# 1. Dry-run (no writes) — logs every intended `path · field · old → new`:
pnpm --filter @delfrance/migrations migrate:pedido-pagamento-micros -- \
  --project <staging-project-id>

# 2. Inspect the log under tools/migrations/out/<timestamp>-…-dryrun.jsonl
# 3. Apply (writes), once the core is ready and the dry-run looks right:
pnpm --filter @delfrance/migrations migrate:pedido-pagamento-micros -- \
  --project <staging-project-id> --apply
```

Credentials come from `FIREBASE_SERVICE_ACCOUNT` / `FIREBASE_SERVICE_ACCOUNT_PATH`
(the `migrate:*` script loads `.env.local`), or `--service-account <path>`. The
target database is `FIREBASE_DATABASE_ID` (default `default`). Re-running is
safe (idempotent). **Run against staging first; never default `--project` to a
production project.**

## Legacy Flutter coexistence (future third-backend import)

This project runs on a **separate test backend**; the legacy Flutter app does
**not** read it. A future migration will move the Flutter project onto a **third,
separate backend**. At that point the incompatibility surfaces and must be
resolved **during that import**, because Flutter wrote these fields as `int`
**milliseconds** (and pagamento as ISO strings), while this project now expects
**microseconds**:

- A Flutter millisecond `int` (e.g. `1.70e12`) read as microseconds would be a
  date in 1970; written into a `microsSinceEpoch()` field unchanged it would be
  wrong by 1000×.
- Conversely, a microsecond value (`~1.78e15`) read by Flutter's
  `DateTime.fromMillisecondsSinceEpoch` would be a date around the year 57000.

**Resolution:** when importing Flutter-authored `pedido` / `pagamento` /
`frete` data onto the new backend, run every datetime field through the same
`coerceToMicros` rules in this document (ms `int` → ×1000, ISO string →
`Date.parse` ×1000, µs → unchanged). The magnitude heuristic distinguishes the
units automatically, so a mixed dump (some Flutter ms, some already-migrated µs)
converts correctly in a single pass. Keep `intFrete.dataCadastro` and
`tokenMelEnv.expirationDate` in **milliseconds** — they were intentionally left
on the legacy unit for the freight integration.

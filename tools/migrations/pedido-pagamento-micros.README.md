# Migration: `pedido` + `pagamento` datetime fields → microseconds

**Status: DESIGNED, NOT YET EXECUTED.** The backfill runs once the project core
is finished. Until then the schemas read tolerantly (see below), so no data has
to move for the app to work — this document is the runbook for when it does, and
the reference for the future Flutter import.

## Why

Datetime fields were standardized onto a **plain integer epoch** (never a
Firebase `Timestamp`, which each SDK deserializes differently). `pedido`,
`pagamento` and the embedded `frete` converged on the higher-precision
**microseconds since epoch** via `microsSinceEpoch()` from
`@delfrance/schemas`. Their previous wire formats were:

| Collection / path                                            | Field(s)                                                                                                                                        | Old format                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pedidos/{id}`                                               | `timestamp`, `ultimaModificacao`, `dataFinalExpedicao`, `dataIndisponivelEstoque`, `dataRemocaoEstoque`, `lastMarketplaceUpdate`, `dtImpressao` | `int` **milliseconds** (legacy Flutter) |
| `pedidos/{id}` (embedded `itens.{produtoUid}[]`)             | `timestamp`                                                                                                                                     | ISO-8601 string                         |
| `pedidos/{id}` (embedded `freteInicial` / `itensDevolvidos`) | `timestamp`, `ultimaModificacao`, `prazoDespacho`, `dataEntrega`, `dataPrevisaoEntrega`, `externalOptionSelectionDate`                          | `int` **milliseconds**                  |
| `pedidos/{id}/pagamento/{pagId}` _(singular!)_               | `vencimento`, `ultimaModificacao`, `dataCancelamento`, `dataAprovacao`, `dataCadastro`                                                          | ISO-8601 string                         |
| `metodo_pgto/{id}`                                           | `dataCadastro`                                                                                                                                  | ISO-8601 string                         |

> **Path note:** the pagamento subcollection is `pedidos/{id}/pagamento`
> (singular). The `pedido` cascade metadata lists a plural `pagamentos` — that
> is a pre-existing inconsistency; the migration must walk the **singular**
> path the app actually reads/writes.

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
// number (ms, ≤ 1e13) → ×1000 ; number (µs, ≥ 1e14) → unchanged ;
// ISO string → Date.parse ×1000 ; Date → ×1000 ; null/unparseable/gap → null
```

Idempotency falls out of the magnitude heuristic: a value already in
microseconds (`≥ MICROS_LOWER_BOUND = 1e14`) is returned unchanged, so re-running
is a no-op. A value in the undeterminable gap `(1e13, 1e14)` — unreachable by any
real ERP timestamp in either unit — returns `null`; the migration must **log and
skip** it, never guess. Only write a field back when `coerceToMicros` returns a
value **different** from what is stored.

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
- firebase-admin v13. Narrow every `catch` to a specific error class and
  rethrow (repo lint rule — no generic `catch`).

Suggested layout when built: `tools/migrations/src/runner.ts` (arg parsing +
`out/` logging) and `tools/migrations/2026-XX-pedido-pagamento-micros/migrate.ts`
(the per-doc transform importing `coerceToMicros`), with a unit test feeding a
microsecond value back in to assert the no-op.

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

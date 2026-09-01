# Census: produtos that hold their own stock — the legacy "Produto Simples" (#1402)

**Status: CENSUS ONLY — this script has no `--apply` path and never writes.**

The one-time conversion script will live in this same folder and share this
runbook. It is not written yet, deliberately: the count is what tells it what it
has to handle.

## Why

#1398 settles the shape of a produto with no variations:

> **A produto never holds available stock. The sellable unit is always a child.**

New produtos are born as a family, and the Mercado Livre importer already writes
that shape — `import.ts:371-374` skips the parent's stock entirely when the
produto owns children.

The legacy Flutter corpus does not. It has a first-class, separately-rendered
concept for the other shape — `.old/lib/produtos/pages/entradaEstoque.dart:81-86`:

```dart
if (widget.produto!.paiId != null) {
  futuroProdutoPai = Produto.documents.doc(widget.produto!.paiId!);
} else {
  // Produto Simples (Sem variações)
  futuroProdutoPai = Future.value(widget.produto!);
}
```

and `.old/packages/produtos/lib/src/models.dart:2137-2156` (`criarEstoques`)
saves each estoque row `parent: this` — for a Produto Simples, the root produto.

So every legacy Produto Simples arrives holding stock that, after #1398, **no ERP
surface reads**. This counts them.

### ⚠️ Why it is wider than `census:up-single`

`apps/mercado-livre/scripts/census-up-single.ts` asks a related question and
answers it for a different population: its universe is `produtoMercadoLivre`
links carrying `isUserProductModel`. A Produto Simples that was never sold on
Mercado Livre is **invisible** to that script and squarely in scope here.

Run both. They are not substitutes.

### ⚠️ Why a zero-quantity estoque row proves nothing

**Every** legacy root produto has an `estoques` subcollection, variations or not.
Flutter's `criarEstoques` fires unconditionally on produto create _and_ update
(`produtoTableProvider.dart:423,447`), one zero row per depósito, and a Cloud
Function did the same (`tasks.dart:84-92`).

So "has an `estoques` subcollection" is not a discriminator — the question has to
be asked of the quantities, and `temEstoque` is keyed on
`quantidade !== 0 || quantidadeReservada !== 0`, matching `EstoqueManager`'s own
`residualEstoquePai` rule.

## Run it

```bash
pnpm --filter @delfrance/migrations audit:produto-sem-variacoes --project <project-id>
```

`--project` is required and never inferred; it is matched against the service
account, so a credential naming a different project is refused. `--apply` is
**rejected**, not ignored.

Three optional passes, each costing a full extra collection scan:

```bash
pnpm --filter @delfrance/migrations audit:produto-sem-variacoes \
  --project <project-id> --target pedidos,balancos,residuais
```

| `--target`  | Adds                                                                          | Costs                                      |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `pedidos`   | how many pedidos hold an open reservation against each produto                | a full `pedidos` scan                      |
| `balancos`  | whether a produto sits in a depósito with an **open** balanço                 | a full `balanco` scan                      |
| `residuais` | estoque rows on produtos that **already** have children — the risk-2 residual | one subcollection read per existing family |

⚠️ Their columns read `null` — _not measured_ — when they do not run. That is
deliberate: "no open pedido reserves against this" and "we did not look" must
never be the same value in a report someone sizes a migration from.

⚠️ **`--target pedidos` reads two sources, and it has to.** `estoqueAplicado` is
the authoritative answer, but it is server-owned and written **only** by
`sincronizarEstoquePedido` — and a Firestore import fires no Cloud Functions
triggers (root `CLAUDE.md` rule 8). So on the freshly imported corpus this census
exists to measure, **no** pedido carries a snapshot, and keying on it alone would
report a confident `0` for every produto. A pedido with no snapshot therefore
falls back to the legacy marker: `dataIndisponivelEstoque` set with
`dataRemocaoEstoque` still null, whose reserved produtos are its `itens` keys.
The run prints how many pedidos each source answered. A snapshot that exists and
reserves nothing is a **measured** zero, and the fallback does not override it.

⚠️ **`--target residuais` only ever ADDS a line.** The conversion totals —
`MOVERIA`, `FICARIAM no pai`, the anomaly counts — are scoped to roots with no
children, always. A produto that already has children gets no sole child from the
conversion and relocates none of its units, so its stock is reported on its own
`RESÍDUO (fora da conversão)` line instead of widening the headline number.

## What it reports

Five verdicts. Only the first is conversion work; the rest are reported so the
totals add up and a surprising distribution is visible rather than rounded away.

| Verdict               | Meaning                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `simples-com-estoque` | Root produto, no children, holds non-zero stock. **The work.**                                   |
| `simples-sem-estoque` | Root produto, no children, every row zero. Needs a child; nothing moves.                         |
| `ja-familia`          | Root produto that already owns children. Nothing to do.                                          |
| `filho`               | Carries a `paiId` naming a produto that exists.                                                  |
| `orfao`               | Carries a `paiId` naming a produto that is **not in the corpus**. A real defect, found for free. |

The JSONL under `out/` carries a row for `simples-com-estoque`,
`simples-sem-estoque` and `orfao` — plus, under `--target residuais`, any
`ja-familia` still holding stock on the parent. `filho` and clean `ja-familia`
are **counted only**; the run says so on stdout rather than leaving you to infer
it from a row count.

The stdout summary is the part to read first:

- **`unidades que a conversão MOVERIA para o filho único`** — the total the
  conversion relocates. Scoped to roots with no children, whatever `--target`
  was passed.
- **`RESÍDUO (fora da conversão)`** — only under `--target residuais`: units
  still sitting on the parent of a family that ALREADY exists. Never folded into
  the line above.
- **`unidades que FICARIAM no pai`** — ⚠️ the residual, and the number nobody
  expects. See below.
- **`produtos com linha de estoque não canônica`** / **`com depositoOuterRef
irreconhecível`** — the anomalies the conversion has to tolerate.

Per produto the JSONL also carries `nKitsQueReferenciam` (how many other produtos
name it in `componentesKitKeys`) and `semUltimaModificacao` — an **absent**
`ultimaModificacao` key, which makes the produto invisible in `/produtos`
altogether (#1213), separate from a stored `null`, which is fine.

## ⚠️ Two things the count must not be read as

### 1. `ficariaNoPai` is a residual, not a rounding error

The conversion moves **available units only**. A reservation is keyed on the
produto the pedido _line_ names, so the eventual release decrements the parent's
row. `upSoleMember.ts:243-257`:

> Move the reserve with the rest and that release lands on a document we emptied,
> while the child keeps a phantom reserve for ever: the produto then
> under-reports its stock permanently, with nothing to signal it.

Those units are **visible in the Balanço, not lost**, and a human moves them from
the produto's Estoque tab once the pedido ships. `ficariaNoPai` is how much manual
cleanup the window leaves behind — size it before the window, not during.

### 2. Estoque doc ids are not derivable on this corpus

`upSoleMember.ts:53-60`:

> the migrated corpus also holds rows at auto-ids that are matched by
> `depositoOuterRef` instead — so re-deriving the id here would patch a document
> that does not exist and leave the real row untouched, **silently doubling the
> stock**.

`.old/packages/produtos/lib/src/tasks.dart:92` makes it concrete: that Cloud
Function calls `makeEstoqueUid(depositoId, produtoId)` with the arguments
**transposed** relative to every other call site, minting
`est-<depositoId>-<produtoId>`. Those are presumably the non-canonical rows
`aplicarBalanco.ts:251` already counts as `estoquesExtras`.

The census therefore **enumerates** rows and uses `makeEstoqueUid` only as a
comparison that produces a count. The conversion must do the same. It also
matches both depósito encodings, `documents/depositos/<id>` and `depositos/<id>`,
because readers tolerate the bare form (`aplicarBalanco.ts:228-233`).

## Cost

⚠️ A full key-order walk of `produtos`, plus one `estoques` subcollection read per
candidate. Firestore **Enterprise** bills data scanned.

No index is required and none should be added. Every walk is
`orderBy(documentId())` with the tests done in memory — the one ordering Firestore
always serves without a declared index. `where('paiId','==',null)` looks cheaper
and is a trap: on Enterprise an undeclared filter never throws
`FAILED_PRECONDITION`, it silently full-scans and bills it — and it would not help
anyway, because "has children" is only knowable by observing some _other_
document's `paiId`, so every produto has to be read regardless.

That is also why this is one pass rather than the per-candidate
`where('paiId','==',<id>).limit(1)` that `census-up-single.ts:136` uses. That
shape is right for a handful of Mercado Livre links and wrong for a whole
catalogue.

⚠️ The pass buffers a compact record per produto — roughly 200 bytes each, so a
500k-produto catalogue is ~100MB of heap. The buffered count is printed, and the
run warns above 200k.

## Meaningless before the import

Staging is disposable and re-seedable from `tools/test-fixtures`, so a run there
measures fixtures rather than the corpus. The number that matters is a run
against the **new** project after the Phase 2 import — which is where #1402
places it.

## Verify

- Exit 0, and `simples-com-estoque` = 0 ⇒ nothing to convert and the step is done.
- Non-zero ⇒ that is when the one-time script gets written, reusing
  `planejarMembroUnico` (already unit-tested and shared with publish).
- `orfao` > 0 is worth resolving on its own, whatever the rest says.
- Re-running after the conversion must report `simples-com-estoque` = 0. That
  pass is the check, not a formality.
- Record the counts in #1402.

# Produtos that hold their own stock — the legacy "Produto Simples" (#1402)

**Two scripts, one folder, one runbook.**

| script                        | writes?                                     | command                         |
| ----------------------------- | ------------------------------------------- | ------------------------------- |
| `audit.ts` — the census       | ⛔ never, rejects `--apply` by construction | `audit:produto-sem-variacoes`   |
| `migrate.ts` — the conversion | only with `--apply`; dry-run otherwise      | `migrate:produto-sem-variacoes` |

Run the census **first**. Its counts are what tell you whether the conversion
has anything to do and what it will have to handle — above all how many units
are reserved (they stay on the parent, see below) and how many estoque rows sit
at non-canonical doc ids.

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

## Verify the census

- Exit 0, and `simples-com-estoque` = 0 ⇒ nothing to convert and the step is done.
- `orfao` > 0 is worth resolving on its own, whatever the rest says.
- Record the counts in #1402.

---

# The conversion — `migrate:produto-sem-variacoes`

Turns each legacy Produto Simples into a **family of one** — parent + a single
child, with the available units moved onto the child and the pointer
`filhoUnicoId` stamped on the parent — and then repoints every kit's
`componentesKit` at the produto that actually holds the stock.

```bash
pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id>
```

```bash
pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id> --apply
```

Dry-run is the default and writes a JSONL to `out/` suffixed `-dryrun`. `--project`
is required and is matched against the service account, so a run cannot land on
the wrong database by omission.

## Two phases, and the ordering is the risky part

```bash
# both phases, in order — this is what the window runs
pnpm --filter @delfrance/migrations migrate:produto-sem-variacoes --project <id> --apply
```

| `--target`  | what it does                                                                    |
| ----------- | ------------------------------------------------------------------------------- |
| _(omitted)_ | **both**, `conversao` then `kits`. The default, and what the window should use. |
| `conversao` | mint the sole members, move the units, stamp the pointers.                      |
| `kits`      | repoint every `componentesKit` at the produto that holds the stock.             |

⚠️ **The order is not negotiable and the script enforces it.** A kit's map can
only name a child once that child exists, so `kits` has to follow `conversao` —
and a run that converts without repointing leaves every kit naming a parent whose
available stock has just moved away, which _creates_ the harm this script exists
to remove. So a `--target conversao` run that actually converted something
**exits non-zero** and tells you to run the `kits` phase; it does not report a
half-done corpus as done.

⚠️ An unknown `--target` **throws**. `runner.ts` accepts any string, so a typo
like `--target kit` would otherwise select neither phase, write nothing, and exit
**0** reporting success.

`--target kits` alone is the re-runnable half: it resolves from the live child
sets and is idempotent, so it is the right thing to run after a later conversion
(publish's `'adotar'` arm converts an ML-linked produto long after this script
skipped it) or after a human clears a residual.

## Phase 1 also stamps the pointer on families that ALREADY exist

Not just the ones it converts. **Nothing else ever backfills `filhoUnicoId`** —
its four writers (ML publish, the ML importer, `VariationManager`, produto
creation) all fire on a _write_, and `apps/functions` only reads it. So a family
publish created before #1398 keeps a null pointer for ever: `unidadeVendavel`
resolves it to the parent, whose available stock publish already moved to the
child, and every kit naming it reads 0. That is #1398's opening symptom, and
without this arm it survives its own migration untouched.

The rules, all reported:

| outcome                 | meaning                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- |
| stamped                 | exactly one live child, and the stored pointer was absent or wrong.                |
| `ja-correto`            | already right. The common case on a re-run, and it costs no write.                 |
| `muitos-filhos`         | more than one child — there is no single sellable unit, so no script may pick one. |
| `sem-filhos`            | the fresh re-read found none after all (the opening walk was stale).               |
| `filho-e-o-proprio-pai` | ⛔ corrupt: the only child names this produto as its own parent.                   |
| `ponteiro-conflito`     | the produto changed mid-write, twice. Nothing was overwritten — **re-run**.        |

⚠️ **It moves no stock.** Units already sitting on such a parent stay there; that
is the `--target residuais` follow-up the census sizes, unchanged.

⚠️ **Cost.** One extra `where('paiId','==',id).limit(2)` per produto that already
has children, plus one parent read for each one that actually needs the write.
On a corpus that is mostly families that is this run's dominant new read cost. It
rides the existing `produtos(paiId ASC, nome ASC)` index on its prefix.

⚠️ The write carries the parent's `lastUpdateTime` (rule 7 tier 1) and a lost
precondition **re-runs the whole derivation**, not just the write — the value
comes from a child QUERY and no precondition covers a query, so re-deriving is
what sees the sibling that invalidated it. Copied from the ML importer's
`aplicarPonteiroMembroUnico`, which documents the same reasoning.

## Phase 2 — every kit map names the produto that holds the stock

Reads nothing new. The opening walk already projects `componentesKit`, and it now
keeps `filhoUnicoId` and `componentesKitKeys` alongside — so the rewrite costs
**zero extra reads**, which is why it lives here rather than in a second script
that would have to walk `produtos` again.

Per produto carrying a composition — a root, a sole member, or a kit-variation
child, all of which own one — `componentesKit` and `componentesKitKeys` are
rewritten **together**, in one `update`.

⚠️ **Two components can fold onto one id** — a kit listing a family-of-one parent
_and_ its own sole member, which the picker shows with identical nome and SKU and
no badge. Their `quantidade` is **summed**; keeping one understates what the sale
removes.

⛔ **A mixed collision is refused, not merged.** `limitarEstoque` decides both
halves at once — a `false` component neither caps availability nor is decremented
on sale — and the schema carries one flag per key, so summing removes 7 units
where 2 are due while keeping 2 loses the 5 the cost and weight rollups read.
Both entries are left exactly as they were and the run reports it: that kit still
names a produto with no available stock and **a human has to choose**.

⚠️ **A component that is a family of MANY is left alone and counted.** No script
picks which variation a kit means. Pre-existing — the component picker never
filtered `paiId` — and found for free.

⚠️ **Idempotent by construction.** `unidadeVendavel` is a fixpoint, so a second
pass rewrites nothing.

⚠️ **A dry-run's targets do not exist yet.** Phase 1 wrote no children, so the
destination ids in the JSONL are the _prediction_ of an `--apply`. The run says so
on stdout.

## ⚠️ What phase 2 leaves for a human

`pedido.estoqueAplicado` is **not** rewritten. `planSincronizacaoEstoque` diffs
the target against the snapshot, so an open pedido's next write releases the
reservation on the old id and takes it on the new one — q and r stay conserved,
nothing is lost. But a reserved remainder then becomes **available units on a
parent**, and a fully reserved component can leave the child at a negative
available (the #931 shape).

Those units stay visible: `useEstoqueDisponivel` falls back to the other half of
the family when a component's own row is absent. They still have to be moved by
hand from the produto's Estoque tab, exactly like the `ficariaNoPai` residual —
size both with `--target pedidos` and `--target residuais` **before** the window.

## What it writes, per produto

One **atomic batch**, flushed per produto rather than per 400 ops:

1. `produtos/<childId>` — the sole member, built by the SAME `montarMembroUnico`
   the ERP uses when a produto is born a family, plus `ultimaModificacao` (the
   `/produtos` default sort key — a document missing it is invisible, #159/#861).
2. `produtos/<parentId>` — `filhoUnicoId`, and nothing else.
3. Per depósito with units: `+n` onto the child's canonical row
   (`est-<childId>-<depositoId>`, a merge-set with `FieldValue.increment` so it
   is created when absent and ADDED to when present) and `-n` off the parent's
   **stored** row id.

⚠️ The parent's row is decremented, **never deleted**. A delete cascades through
`onEstoqueDeleted` and takes the row's whole `historicoEstoque` ledger with it —
and a migration run _inside_ the cutover window does fire triggers; only the
import fires none (ADR 0013).

## What it SKIPS, and why each skip matters

| motivo                      | meaning                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ja-tem-filho`              | already a family, so no member is minted — but it is **not** a blind skip any more: the pointer arm above runs for it. Re-read just before the write rather than taken from the opening walk, since a variation created mid-run would otherwise get a second member minted beside it. |
| `nao-e-raiz`                | carries a `paiId` — it is a child.                                                                                                                                                                                                                                                    |
| `tem-vinculo-mercado-livre` | ⛔ sells on ML. **Publish owns this one.**                                                                                                                                                                                                                                            |

⛔ **The ML skip is not caution, it is a live listing.** Under User Products,
publish's `'adotar'` arm is what seeds the sole member's link with the existing
item id. Give the produto a child here and publish sees `childrenCount > 0`,
answers `'nenhum'`, and the family fan-out finds a member with **no** link — so
it POSTs a _second_ item and `sweepRemovedMembers` then confirms the original as
an orphan and pauses-then-closes it. Under the legacy model the failure is
quieter and just as real: a childless produto publishes as a simple item, and one
child turns its next republish into a `variations[]` payload for a listing that
has none. Those produtos keep the shape they have — which read-tolerance handles
correctly, a childless produto resolves to itself — and publish converts them
when it next runs.

## ⚠️ Idempotence is arithmetic, not a flag

There is no "already migrated" marker, deliberately: a flag can disagree with the
data. What moves is `max(0, quantidade − reservaEfetiva)` **recomputed from the
parent's current row**, so after a successful run the parent's quantidade equals
its reserve and the same computation yields 0. No delta is ever stored, so no
delta can be applied twice.

⛔ **What that does not buy.** A second run skips an already-converted produto as
`ja-tem-filho` **before reading any estoque row**, so units booked on the parent
_after_ the conversion are never swept up by re-running. They stay on a parent
whose pointer now routes every availability read to the child — so they are
invisible, not merely misplaced.

The arithmetic is idempotent; the pipeline short-circuits above it. Both are
true, and the first version of this runbook wrote down only the first. Sweeping
those residuals means a pass over produtos that **already** have children — the
census's `--target residuais` mode sizes it — and that is a follow-up, not this
script.

⚠️ **So run the conversion INSIDE the window, after the source app is off.** The
residual it cannot recover is exactly what a pre-window run accumulates.

## Verify the conversion

1. Dry-run. Read the JSONL in `out/`: one `change` line per produto for
   `filhoUnicoId`, one per estoque move. Check the skip counts against the
   census — `tem-vinculo-mercado-livre` in particular should match the number of
   produtos you expect to have ML links.
2. `--apply`.
3. **Run it again, unchanged.** A clean second pass must convert **0** and move
   **0 units** — every produto reporting `ja-tem-filho`. That pass is the
   idempotence check, not a formality.
4. Re-run the census: `simples-com-estoque` must be 0 apart from the produtos
   skipped for an ML link.
5. Spot-check one produto in `/produtos`: it shows one variation row, and its
   available stock reads the same number it did before the run.

⚠️ **The reserved remainder is left behind on purpose.** A reservation is keyed on
the produto the pedido _line_ names — the parent — so moving it would make the
eventual release decrement a document this script emptied while the child keeps a
phantom reserve for ever. The run prints the total; once those pedidos ship, the
units sit on the parent and a human moves them in the Balanço. They are visible,
not lost.

## Staging is a rehearsal, never a data-preservation goal

Staging is disposable and re-seedable from `tools/test-fixtures`, so a run there
measures fixtures rather than the corpus. Rehearse the sequence — dry-run, apply,
clean second pass — and then re-seed. The authoritative run is the one **inside**
the window: the legacy Flutter app keeps writing the source project until the
window switches it off, so an earlier run is partially superseded by its own
later writes.

⛔ **Agents never run either script.** Root `CLAUDE.md` rule 8 / ADR 0013.

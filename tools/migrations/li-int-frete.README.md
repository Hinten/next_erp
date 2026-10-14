# Migration: the Loja Integrada `int_frete` adoption pass (`2026-10-li-int-frete`)

Brings every Loja Integrada conta's freight doc (`int_frete`, tipo
`lojaIntegrada`) in step with its conta once, inside the migration window: it
**adopts** each imported per-conta freight doc, **creates**
`lojaIntegrada-<integracaoId>` for a conta that has none, **deactivates** the
docs whose conta is gone or no longer Loja Integrada, and **reports** duplicates,
non-canonical back-refs and docs two contas claim. On a dry run it also prints a
read-only **`mapa` audit** (below). Loja Integrada master-plan step 20, #1826.

## Why it exists

From the cutover on, the `onIntegracaoLojaIntegradaChanged` trigger
(`loja-integrada` functions codebase) keeps each conta's doc in step on every
conta save. But **a Firestore import fires no Cloud Functions trigger** (root
`CLAUDE.md` rule 8), so no imported conta ever reaches it: without this pass the
migrated docs stay exactly as imported until each conta's next relevant save, and
the doc of a conta that no longer exists stays active for good.

The doc matters beyond the sync: the order importer reads it to route each
order's shipping method through its `mapa`. The trigger's binding has no tolerant
scan, so a migrated doc whose back-ref is not canonical is invisible to its
lookup. That conta's first save after the deploy would create
`lojaIntegrada-<integracaoId>` beside it with a null `mapa`, and every order
would then import unmapped while the operator's mapping sits on a doc nothing
reads. The pass reports that case once, instead, and refuses to apply around it.

## No decision of its own

The pass holds no rule. Its plan — the labels, the STOP verdict, the JSONL rows
— is the shared `src/intFreteAdocao/plano.ts`, the same one Shopee's pass binds
(#1889), and it calls the shared core's own pure planner and chooser
(`planejarIntFreteDaConta`, `escolherIntFreteDaConta` from
`@delfrance/data/admin/frete`) through the SAME zero-option binding the trigger
runs — `intFreteContaSync(VINCULO_INT_FRETE_CONTA.lojaIntegrada)`, no
`refTolerante`. `--apply` hands each executable conta id, verbatim, to that
binding's `reconciliarIntFreteDaConta`, which re-reads the conta and the doc
inside its own transaction and converges the doc to the conta as it stands at
commit (transaction-inventory class A). So the dry run and the apply decide
alike, a conta written after the scan is handled by the core rather than by a
stale plan, and there is **no clock** anywhere in the pass.

## What it reports, per conta

The contas planned are every `integracao` of tipo Loja Integrada (`3`) plus every
conta id a scanned doc's back-ref names (an orphan's conta). One line each,
labelled from the core's plan:

| label                    | means                                                                             | writes? |
| ------------------------ | --------------------------------------------------------------------------------- | ------- |
| `criar`                  | complete conta, no doc → `lojaIntegrada-<integracaoId>`                           | yes     |
| `adotar`                 | an imported doc (no `ultimaModificacao`) that differs → patched                   | yes     |
| `atualizar`              | a doc the core already stamped, that differs → patched                            | yes     |
| `desativar-orfao`        | the conta is gone or no longer Loja Integrada, its doc is active → `ativo: false` | yes     |
| `inalterado`             | the doc already mirrors its conta                                                 | no      |
| `orfao-inativo`          | the conta is gone, its doc is already inactive                                    | no      |
| `incompleto`             | no doc, and the conta lacks nome / filial / dataCadastro                          | no      |
| `bloqueado-nao-canonico` | only NON-canonical back-refs, no `lojaIntegrada-<integracaoId>` — never planned   | no      |

Plus, per doc whose back-ref names no conta at all and that no line claims, a
`ref-ilegivel` row (report only).

A patch or a deactivation writes only the mirrored scalars (`nome`, `ativo`, the
filial, `dataCadastro`), plus `tipo` and the back-ref when they drifted, and the
core's `ultimaModificacao` stamp. **`mapa`, `horarioDeCorte`, `faixaCep` and
`enderecoDeOrigem` are never written by a patch or a deactivation**, so the
operator's shipping-method mapping and cut-off hours survive the adoption
byte for byte. A create (`criar`) writes the full schema-parsed doc, with those
keys (and `client_id` / `client_secret`) at null and `prazoExtra` at 0 — and a
`criar` row's JSONL `to` lists only the computed fields, not those defaults.
Nothing is ever deleted — migrated pedidos hold `integracaoFreteOuterRef`
pointing at these docs.

**Expect `dataCadastro` and `ativo` patches on adopted docs in the first dry
run.** The core mirrors both fields from the conta, so an imported doc whose
stored `dataCadastro` or `ativo` differs from its conta's is labelled `adotar`
with that field in its JSONL `from` / `to`. That is the adoption working, not a
finding.

## ⛔ STOP on duplicates, non-canonical refs and shared docs

A conta reporting `duplicados` (more than one doc carries its canonical back-ref),
any non-canonical back-ref (a `nao-canonico` row — every `bloqueado-nao-canonico`
line has one, and so does a non-canonical twin beside a canonical doc), or a doc
it shares with another conta (a `compartilhado` row, below) **stops the pass**:
`--apply` refuses before its first write and names every such conta. Grep the
dry-run JSONL for `"field":"duplicados"`, `"field":"nao-canonico"` and
`"field":"compartilhado"`.

The canonical back-ref is `contaLojaIntegradaEnviosOuterRef:
documents/integracao/<integracaoId>`. The bare `integracao/<integracaoId>` form,
or one with stray slashes, names the same conta but is **not** adopted.

Which doc a conta's line takes, with several: the newest `dataCadastro`, and on
an equal one the lowest doc id — with **no** `ativo` filter, as the sync itself
chooses, so re-enabling a conta re-activates its own doc instead of creating a
second one. (The order importer adds an `ativo == true` filter to the same pick.
After a clean run each conta has at most one doc, so both picks name it — the
importer's only while it is active.)

The doc AT `lojaIntegrada-<integracaoId>` is the one exception: the core takes it
as the conta's whatever its back-ref (its deterministic-id fallback), so the pass
plans it the same way, and on its own it stops nothing. For a live conta that
plan is a patch that rewrites the ref to canonical. For an orphan it is a
deactivation, which writes only `ativo`: a non-canonical ref there stays as
stored and is reported nowhere — acceptable, since no conta remains to own it.
Beside a doc that carries the canonical back-ref, a
`lojaIntegrada-<integracaoId>` doc whose ref names this conta in a non-canonical
form is a twin like any other and STOPs; one with a null or unreadable ref is
reported as `ref-ilegivel` only. The id is exact: `lojaintegrada-<id>` or
`shopee-<id>` is an ordinary doc, never the fallback.

A **shared** doc is one that two contas' lines both target. Every writer stamps
its own canonical ref at its own `lojaIntegrada-<integracaoId>`, so only
tampered or rehearsal data reaches it — e.g. `lojaIntegrada-<a>` carrying conta
b's canonical back-ref while conta a has no canonical doc. Applied, the outcome
would depend on the order, so each such conta gets a `compartilhado` row naming
the others, and the pass STOPs.

Which twin migrated pedidos keep is a **human call**. Resolve means: decide which
doc is the conta's, then make every other one stop carrying the conta's back-ref,
or rewrite a non-canonical ref to `documents/integracao/<id>` when that doc IS the
conta's. Keep the doc that holds the operator's `mapa` and `horarioDeCorte` — the
pass never moves them between docs. A shared doc: decide which conta owns it. If
it is the conta at its id, rewrite its back-ref to that conta's canonical form;
otherwise give the conta at its id a doc of its own carrying its canonical
back-ref, which that conta's lookup then takes first. Never delete one. Then
dry-run again.

⚠️ **The `loja-integrada` functions codebase does not deploy until a dry run
reports zero of all three.** Its trigger has no tolerant scan, so a conta's first
save would create `lojaIntegrada-<id>` beside a doc whose back-ref is not
canonical.

## The `mapa` audit (read-only)

On a dry run and on `--report-only`, the pass reads one more thing — the **ids
only** (an empty field mask, so no credential is pulled in) of the `int_frete`
docs of the five tipos a row may be mapped to: `melhorEnvios`, `motoboy`,
`retiradaNaLoja`, `fob` and `outros` — and prints, over every scanned Loja
Integrada doc (inactive, duplicated and orphaned ones too):

| count                 | means                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `docsComMapaInvalido` | docs whose `mapa` is present and neither null nor a list — the importer registers nothing there |
| `linhas`              | the rows (object elements of every `mapa` list)                                                 |
| `mapeadas`            | rows whose `integracaoUid` names a doc (decided by the uid, never by `targetTipoIntegracao`)    |
| `tipoForaDosAlvos`    | mapped rows whose `targetTipoIntegracao` is not one of the five                                 |
| `alvoAusente`         | mapped rows whose target id is the id of no scanned doc of the five tipos                       |
| `uidComCaminho`       | mapped rows whose `integracaoUid` is a path rather than the bare id it names                    |

One row can count under several of them. A dry run also writes them as ONE
`"field":"auditoria-mapa"` JSONL row; `--apply` neither reads nor prints them.

**They are counts, never a STOP verdict, and the pass never writes `mapa`.** A
row mapped to an unsupported or missing target is fixed by the operator in the
conta screen's "Mapeamento do Frete" tab after the window, never by a script. A
`docsComMapaInvalido` doc needs a person before the importer can register new
shipping methods on it.

⚠️ **A row mapped to an inactive target is not flagged.** The target scan reads
ids only, so a doc of the five tipos whose `ativo` is false counts as present,
never under `alvoAusente`. Such a row needs the same fix as one mapped to a
missing target. To find these rows, list the inactive docs of the five tipos (a
handful) and search the Loja Integrada docs' `mapa` for their ids.

## When

Inside the window (a #1208 Phase 2 step; Shopee's twin is #1889), in this order:

1. after the Phase 2 import;
2. after step 20's index is **READY** —
   `int_frete (tipo, contaLojaIntegradaEnviosOuterRef, ativo, dataCadastro DESC)`.
   The lookup rides it, and without it every conta full-scans `int_frete`
   (Enterprise bills data scanned);
3. **before** the `loja-integrada` functions deploy (Phase 3 step 1), which waits
   for the clean dry run above.

Not earlier: until the switch, the legacy app is the sole live writer of these
docs on the SOURCE project — it appends to `mapa` as it imports orders — so an
earlier run is superseded. The authoritative run is the one inside the window.

## Running it

```bash
# 1. Counts per label, the STOP verdict and the mapa audit. Writes nothing, logs no per-conta rows.
pnpm --filter @delfrance/migrations migrate:li-int-frete --project <project-id> --report-only

# 2. Dry run — one JSONL row per conta, plus the STOP, ref-ilegivel and auditoria-mapa rows, to out/*-dryrun.jsonl
pnpm --filter @delfrance/migrations migrate:li-int-frete --project <project-id>

# 3. Apply — refused while any conta reports a duplicados, nao-canonico or compartilhado row
pnpm --filter @delfrance/migrations migrate:li-int-frete --project <project-id> --apply

# 4. ⚠️ The idempotence proof: this must report 0 contas com escrita planejada.
pnpm --filter @delfrance/migrations migrate:li-int-frete --project <project-id>
```

`--project` is required and is matched against the service account, so a
credential for another project refuses to run.

⚠️ **The runner's closing `… 0 writes` is expected.** The core writes in its own
transactions, never through the runner's `BatchWriter`. The record is
`docsChanged` (the applied `criado` / `atualizado` / `desativado` dispositions)
and the JSONL: an `aplicado` row per reconciled conta, carrying the core's
disposition, and a `divergente` row wherever it differs from the plan — expected
only when something wrote the conta or the doc after the scan, and then the core
is the one that is right. One more shape logs it, on tampered or rehearsal data
only: a `lojaIntegrada-<integracaoId>` doc whose `tipo` was altered is outside
the `tipo == lojaIntegrada` scan, so its conta's line plans `criar`, while the
core reads that doc by its id and patches it back (`atualizado`). The outcome is
correct — one doc, patched — and the second dry run shows it `inalterado`. A
crash mid-apply needs no repair: re-run; the pass is idempotent and the dry run
shows what is left.

A conta reported `incompleto` needs the conta fixed (its filial, nome or
dataCadastro), then a re-run.

## Verify

1. The second dry run (step 4) reports **0** contas with planned writes.
2. Spot-check two contas: the doc's `nome`, `ativo` and filial equal the conta's,
   and its `mapa` and `horarioDeCorte` equal the imported ones.
3. The `mapa` audit counts were read, the inactive-target check above was done,
   and any finding was handed to the operator.

## Cost

Two equality scans over small populations (one doc per conta), each on the
`tipo` prefix of a composite declared before step 20 — `integracao` where `tipo`
is Loja Integrada, masked to `tipo` plus the mirrored fields so no credential is
pulled into the process, and `int_frete` where `tipo` is `lojaIntegrada` — plus,
on a dry run, the audit's id-only `int_frete` scan of the five target tipos (the
`tipo` prefix of `int_frete (tipo, nome)`), and, on `--apply`, one transaction
per executable conta (a conta get, the lookup query, and on a miss the
deterministic-id get). That lookup query is the one that needs step 20's new
`int_frete` composite. No collection is walked by key, so nothing here belongs in
`key-walks.json`.

## Staging is a rehearsal

Contas connected through `/canais/loja-integrada` exist on staging only. Rehearse
there — dry run, `--apply`, then a clean second dry run as the idempotence check
— or re-seed; staging data never needs to be preserved.

## Code

- `src/intFreteAdocao/plano.ts` — the plan, shared by every channel's pass:
  labels, the STOP verdict, the JSONL rows. Pure.
- `src/intFreteAdocao/executar.ts` — the two scans, the rows, the optional
  read-only audit hook, and the `--apply` loop over the core. I/O only.
- `src/2026-10-li-int-frete/transform.ts` — binds that pass to the Loja
  Integrada row (`syncLojaIntegrada`, the trigger's own binding) and holds the
  pure `mapa` audit (`auditarMapa`); `backfill.ts` is the entry point and the
  audit's one read. Unit-tested in `transform.test.ts`.
- The decisions themselves: `packages/data/src/admin/frete/intFreteContaSync.ts`;
  the "mapped" reading: `packages/schemas/src/mapaFreteLojaIntegrada.ts`.

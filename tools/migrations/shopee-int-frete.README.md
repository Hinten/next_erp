# Migration: the Shopee `int_frete` adoption pass (`2026-10-shopee-int-frete`)

Brings every Shopee conta's freight doc (`int_frete`, tipo `shopee`) in step with
its conta once, inside the migration window: it **adopts** each imported legacy
`FreteShopee` doc, **creates** `shopee-<integracaoId>` for a conta that has none,
**deactivates** the docs whose conta is gone or no longer Shopee, and **reports**
duplicates, non-canonical back-refs and docs two contas claim. Shopee master-plan
step 20, #1528.

## Why it exists

From the cutover on, the `onIntegracaoShopeeChanged` trigger (`shopee` functions
codebase) keeps each conta's doc in step on every conta save. But **a Firestore
import fires no Cloud Functions trigger** (root `CLAUDE.md` rule 8), so no
imported conta ever reaches it: without this pass the migrated docs stay exactly
as imported until each conta's next relevant save, and the doc of a conta that no
longer exists stays active for good.

## No decision of its own

`transform.ts` holds no rule. It calls the shared core's own pure planner and
chooser (`planejarIntFreteDaConta`, `escolherIntFreteDaConta` from
`@delfrance/data/admin/frete`) through the SAME zero-option binding the trigger
runs, and `--apply` hands each executable conta id, verbatim, to that binding's
`reconciliarIntFreteDaConta` — which re-reads the conta and the doc inside its
own transaction and converges the doc to the conta as it stands at commit
(transaction-inventory class A). So the dry run and the apply decide alike, a
conta written after the scan is handled by the core rather than by a stale plan,
and there is **no clock** anywhere in the pass.

## What it reports, per conta

The contas planned are every `integracao` of tipo Shopee plus every conta id a
scanned doc's back-ref names (an orphan's conta). One line each, labelled from
the core's plan:

| label                    | means                                                                     | writes? |
| ------------------------ | ------------------------------------------------------------------------- | ------- |
| `criar`                  | complete conta, no doc → `shopee-<integracaoId>`                          | yes     |
| `adotar`                 | a legacy doc (no `ultimaModificacao`) that differs → patched              | yes     |
| `atualizar`              | a doc the core already stamped, that differs → patched                    | yes     |
| `desativar-orfao`        | the conta is gone or no longer Shopee, its doc is active → `ativo: false` | yes     |
| `inalterado`             | the doc already mirrors its conta                                         | no      |
| `orfao-inativo`          | the conta is gone, its doc is already inactive                            | no      |
| `incompleto`             | no doc, and the conta lacks nome / filial / dataCadastro                  | no      |
| `bloqueado-nao-canonico` | only NON-canonical back-refs, no `shopee-<integracaoId>` — never planned  | no      |

Plus, per doc whose back-ref names no conta at all and that no line claims, a
`ref-ilegivel` row (report only).

A patch or a deactivation writes only the mirrored scalars (`nome`, `ativo`, the
filial, `dataCadastro`), plus `tipo` and the back-ref when they drifted, and the
core's `ultimaModificacao` stamp: `mapa`, `faixaCep`, `horarioDeCorte` and
`enderecoDeOrigem` are never written by a patch or a deactivation. A create
(`criar`) writes the full schema-parsed doc, with those keys (and `client_id` /
`client_secret`) at null and `prazoExtra` at 0 — and a `criar` row's JSONL `to`
lists only the computed fields, not those defaults. Nothing is ever deleted —
migrated pedidos hold `integracaoFreteOuterRef` pointing at these docs.

## ⛔ STOP on duplicates, non-canonical refs and shared docs

A conta reporting `duplicados` (more than one doc carries its canonical back-ref),
any non-canonical back-ref (a `nao-canonico` row — every `bloqueado-nao-canonico`
line has one, and so does a non-canonical twin beside a canonical doc), or a doc
it shares with another conta (a `compartilhado` row, below) **stops the pass**:
`--apply` refuses before its first write and names every such conta. Grep the
dry-run JSONL for `"field":"duplicados"`, `"field":"nao-canonico"` and
`"field":"compartilhado"`.

The doc AT `shopee-<integracaoId>` is the one exception: the core takes it as the
conta's whatever its back-ref (its deterministic-id fallback), so the pass plans
it the same way, and on its own it stops nothing. For a live conta that plan is a
patch that rewrites the ref to canonical. For an orphan (conta gone or no longer
Shopee) it is a deactivation, which writes only `ativo`: a non-canonical ref
there stays as stored and is reported nowhere — acceptable, since no conta
remains to own it. Beside a doc that carries the canonical back-ref, a
`shopee-<integracaoId>` doc whose ref names this conta in a non-canonical form is
a twin like any other and STOPs; one with a null or unreadable ref is reported as
`ref-ilegivel` only.

A **shared** doc is one that two contas' lines both target. Every writer stamps
its own canonical ref at its own `shopee-<integracaoId>`, so only tampered or
rehearsal data reaches it — e.g. `shopee-<a>` carrying conta b's canonical
back-ref while conta a has no canonical doc: a's deterministic-id fallback and b's
canonical match both take it. Applied, the outcome would depend on the order (a
rewrites the ref and b then creates `shopee-<b>`, or b patches the doc first and a
overwrites it), so each such conta gets a `compartilhado` row naming the others,
and the pass STOPs. A line that writes nothing still counts: an orphan's
already-inactive doc is still the doc its line names.

Which twin migrated pedidos keep is a **human call**. Resolve means: decide which
doc is the conta's, then make every other one stop carrying the conta's back-ref,
or rewrite a non-canonical ref to `documents/integracao/<id>` when that doc IS the
conta's. A shared doc: decide which conta owns it. If it is the conta at its id,
rewrite its back-ref to that conta's canonical form; otherwise give the conta at
its id a doc of its own carrying its canonical back-ref, which that conta's lookup
then takes first. Never delete one. Then dry-run again.

⚠️ **The Shopee functions codebase does not deploy until a dry run reports zero of
all three.** Its trigger has no tolerant scan, so a conta's first save would create
`shopee-<id>` beside a legacy doc whose back-ref is not canonical.

## When

Inside the window (#1889, a #1208 Phase 2b step), in this order:

1. after the Phase 2 import;
2. after #1532 is **READY** — the lookup rides
   `int_frete (tipo, contaShopeeFreteOuterRef, ativo, dataCadastro DESC)`, and
   without it every conta full-scans `int_frete` (Enterprise bills data scanned);
3. **before** the Shopee functions deploy (Phase 3), which waits for the clean
   dry run above.

Not earlier: until the switch, the legacy app is the sole live writer of the
SOURCE project and writes `FreteShopee` docs from its conta screen, so an earlier
run is superseded. The authoritative run is the one inside the window.

## Running it

```bash
# 1. Counts per label and the STOP verdict. Writes nothing, logs no per-conta rows.
pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <project-id> --report-only

# 2. Dry run — one JSONL row per conta, plus the STOP and ref-ilegivel rows, to out/*-dryrun.jsonl
pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <project-id>

# 3. Apply — refused while any conta reports a duplicados, nao-canonico or compartilhado row
pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <project-id> --apply

# 4. ⚠️ The idempotence proof: this must report 0 contas com escrita planejada.
pnpm --filter @delfrance/migrations migrate:shopee-int-frete --project <project-id>
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
only: a `shopee-<integracaoId>` doc whose `tipo` was altered is outside the
`tipo == shopee` scan, so its conta's line plans `criar`, while the core reads
that doc by its id and patches it back (`atualizado`). The outcome is correct —
one doc, patched — and the second dry run shows it `inalterado`. A crash
mid-apply needs no repair: re-run; the pass is idempotent and the dry run shows
what is left.

A conta reported `incompleto` needs the conta fixed (its filial, nome or
dataCadastro), then a re-run.

## Verify

1. The second dry run (step 4) reports **0** contas with planned writes.
2. Spot-check two contas: the doc's `nome`, `ativo` and filial equal the conta's.
3. A migrated Shopee pedido's Frete tab shows "`<conta>` (Shopee)" in its
   (disabled) picker, and its print's "Tipo:" line shows the conta name.

## Cost

Two equality scans over small populations (one doc per conta), each on the
`tipo` prefix of a composite declared before step 20 — `integracao` where `tipo`
is Shopee, masked to `tipo` plus the mirrored fields so no credential is pulled
into the process, and `int_frete` where `tipo` is `shopee` — plus, on `--apply`,
one transaction per executable conta (a conta get, the lookup query, and on a
miss the deterministic-id get). That lookup query is the one that needs #1532's
new `int_frete` composite.

## Staging is a rehearsal

Contas connected through `/canais/shopee` before step 20 shipped exist on staging
only. Rehearse there — dry run, `--apply`, then a clean second dry run as the
idempotence check — or re-seed; staging data never needs to be preserved.

## Code

- `src/2026-10-shopee-int-frete/transform.ts` — the plan: labels, the STOP
  verdict, the JSONL rows. Pure, unit-tested in `transform.test.ts`.
- `src/2026-10-shopee-int-frete/backfill.ts` — the two scans, the rows, and the
  `--apply` loop over the core. I/O only.
- The decisions themselves: `packages/data/src/admin/frete/intFreteContaSync.ts`.

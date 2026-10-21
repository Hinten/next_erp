# Migration: the Amazon `int_frete` adoption pass (`2026-10-amazon-int-frete`)

Brings every Amazon conta's freight doc (`int_frete`, tipo `amz`) in step with
its conta once, inside the migration window: it **adopts** each imported legacy
freight doc, **creates** `amz-<integracaoId>` for a conta that has none,
**deactivates** the docs whose conta is gone or no longer Amazon, and **reports**
duplicates, non-canonical back-refs and docs two contas claim. Amazon
master-plan step 20 (#1930), window item **W12**.

## Why it exists

From the cutover on, the `onIntegracaoAmazonChanged` trigger (`amazon` functions
codebase) keeps each conta's doc in step on every conta save. But **a Firestore
import fires no Cloud Functions trigger** (root `CLAUDE.md` rule 8), so no
imported conta ever reaches it: without this pass the migrated docs stay exactly
as imported until each conta's next relevant save, and the doc of a conta that no
longer exists stays active for good.

The trigger's binding has no tolerant scan either: a migrated doc whose back-ref
is not in the canonical form is invisible to its lookup, so that conta's first
save after the deploy would create `amz-<integracaoId>` beside it. The pass
reports that case once, instead, and refuses to apply around it. That is why the
`amazon` functions codebase deploys only after this pass is clean
(`apps/amazon/functions/DEPLOY.md`, "Before `functions:amazon` (step 20)").

## No decision of its own

The pass holds no rule. Its plan — the labels, the STOP verdict, the JSONL rows
— is the shared `src/intFreteAdocao/plano.ts`, the same one the Shopee and Loja
Integrada passes bind, and it calls the shared core's own pure planner and
chooser (`planejarIntFreteDaConta`, `escolherIntFreteDaConta` from
`@delfrance/data/admin/frete`) through a binding equal to the trigger's:
`intFreteContaSync(VINCULO_INT_FRETE_CONTA.amazon)`, the same row and the same
zero options (no `refTolerante`). `@delfrance/migrations` cannot import
`apps/amazon`, so it binds the row itself; `transform.test.ts` pins that it is
the Amazon row and that a bare back-ref is never chosen.

`--apply` hands each executable conta id, verbatim, to that binding's
`reconciliarIntFreteDaConta`, which re-reads the conta and the doc inside its
own transaction and converges the doc to the conta as it stands at commit
(transaction-inventory class A). So the dry run and the apply decide alike, a
conta written after the scan is handled by the core rather than by a stale plan,
and there is **no clock** anywhere in the pass.

There is no `mapa` audit (the Loja Integrada pass has one): nothing in the
Amazon flow reads `mapa`, `faixaCep` or `horarioDeCorte` on this doc.

## What it reports, per conta

The contas planned are every `integracao` of tipo Amazon (`8`, the number — a
conta whose `tipo` is the string `"8"` is not one) plus every conta id a scanned
doc's back-ref names (an orphan's conta). One line each, labelled from the
core's plan:

| label                    | means                                                                     | writes? |
| ------------------------ | ------------------------------------------------------------------------- | ------- |
| `criar`                  | complete conta, no doc → `amz-<integracaoId>`                             | yes     |
| `adotar`                 | an imported doc (no `ultimaModificacao`) that differs → patched           | yes     |
| `atualizar`              | a doc the core already stamped, that differs → patched                    | yes     |
| `desativar-orfao`        | the conta is gone or no longer Amazon, its doc is active → `ativo: false` | yes     |
| `inalterado`             | the doc already mirrors its conta                                         | no      |
| `orfao-inativo`          | the conta is gone, its doc is already inactive                            | no      |
| `incompleto`             | no doc, and the conta lacks nome / filial / dataCadastro                  | no      |
| `bloqueado-nao-canonico` | only NON-canonical back-refs, no `amz-<integracaoId>` — never planned     | no      |

Plus, per doc whose back-ref names no conta at all and that no line claims, a
`ref-ilegivel` row (report only).

Only docs of tipo `amz` are in the pass, exactly as the scan filters them: a doc
whose `tipo` reads `amazon` (the conta tipo's name, not the freight tipo) is
outside it, and its conta's line plans as if it did not exist.

A patch or a deactivation writes only the mirrored scalars (`nome`, `ativo`, the
filial, `dataCadastro`), plus `tipo` and the back-ref when they drifted, and the
core's `ultimaModificacao` stamp, in ms. A create (`criar`) writes the full
schema-parsed doc, with `mapa`, `faixaCep`, `horarioDeCorte`,
`enderecoDeOrigem`, `client_id` and `client_secret` at null and `prazoExtra` at
0 — and a `criar` row's JSONL `to` lists only the computed fields, not those
defaults. Nothing is ever deleted — migrated pedidos hold
`freteInicial.integracaoFreteOuterRef` pointing at these docs.

**Expected in the first dry run, and not a finding:**

- a doc whose stored `dataCadastro` differs from its conta's is labelled
  `adotar` with that field in its JSONL `from` / `to` — the freight doc mirrors
  its conta's registration date;
- every applied line stamps `ultimaModificacao`;
- an **inactive** freight doc under an **active** conta is set back to
  `ativo: true` (an `adotar` whose JSONL `from` / `to` shows `ativo`) — a
  re-activation of that doc, never a second one.

## ⛔ STOP on duplicates, non-canonical refs and shared docs

A conta reporting `duplicados` (more than one doc carries its canonical back-ref),
any non-canonical back-ref (a `nao-canonico` row — every `bloqueado-nao-canonico`
line has one, and so does a non-canonical twin beside a canonical doc), or a doc
it shares with another conta (a `compartilhado` row, below) **stops the whole
pass**: `--apply` refuses before its first write and before its first JSONL row,
and names every such conta, so a refused `--apply` leaves an empty
APPLY-named JSONL. Grep the dry-run JSONL for `"field":"duplicados"`,
`"field":"nao-canonico"` and `"field":"compartilhado"`.

Why the whole pass, and not just the other contas: adopting one twin patches its
`dataCadastro`, and the next lookup can then take the OTHER twin, so applying a
chosen twin is not idempotent.

The canonical back-ref is `contaAmazonContaFreteAmazonOuterRef:
documents/integracao/<integracaoId>`. The bare `integracao/<integracaoId>` form,
or one with stray slashes, names the same conta but is **not** adopted.

The doc AT `amz-<integracaoId>` is the one exception: the core takes it as the
conta's whatever its back-ref (its deterministic-id fallback), so the pass plans
it the same way, and on its own it stops nothing. For a live conta that plan is a
patch that rewrites the ref to canonical. For an orphan (conta gone or no longer
Amazon) it is a deactivation, which writes only `ativo`: a non-canonical ref
there stays as stored and is reported nowhere — acceptable, since no conta
remains to own it. Beside a doc that carries the canonical back-ref, an
`amz-<integracaoId>` doc whose ref names this conta in a non-canonical form is a
twin like any other and STOPs; one with a null or unreadable ref is reported as
`ref-ilegivel` only. The id is exact: `amazon-<id>` or `AMZ-<id>` is an ordinary
doc, never the fallback. A migrated doc's id is 64 hex digits, so it is never
that doc either.

A **shared** doc is one that two contas' lines both target. Every writer stamps
its own canonical ref at its own `amz-<integracaoId>`, so only tampered or
rehearsal data reaches it — e.g. `amz-<a>` carrying conta b's canonical back-ref
while conta a has no canonical doc: a's deterministic-id fallback and b's
canonical match both take it. Applied, the outcome would depend on the order, so
each such conta gets a `compartilhado` row naming the others, and the pass STOPs.
Resolve it by deciding which conta owns the doc: if it is the conta at its id,
rewrite its back-ref to that conta's canonical form; otherwise give the conta at
its id a doc of its own carrying its canonical back-ref, which that conta's
lookup then takes first. Never delete one.

A `nao-canonico` row whose doc IS the conta's (the only doc of that conta, with a
mis-spelled ref) is resolved by rewriting its ref to
`documents/integracao/<integracaoId>`.

### Resolving a `duplicados` STOP

Which twin the migrated pedidos keep is a **person's call**, made once per conta,
in this order:

1. **Find which twin the pedidos reference** — a one-off, read-only query run by
   a person, never part of the dry run. It rides the existing composite
   `pedidos (ehSaida ASC, integracaoPedidoOuterRef ASC, timestamp DESC)` by its
   equality prefix, so it reads that conta's pedidos only:
   `pedidos` where `ehSaida == true` and
   `integracaoPedidoOuterRef == 'documents/integracao/<integracaoId>'`, reading
   only `freteInicial.integracaoFreteOuterRef` (a field mask, when run from a
   script); tally how many name each candidate `documents/int_frete/<id>`.
   **Never** a scan of the whole `pedidos` collection: Enterprise bills data
   scanned.
2. **Choose the doc to keep:** the one the pedidos reference. If both are
   referenced, or neither is, keep the **lowest doc id**: the legacy readers
   took the first match with no `orderBy`, which on the legacy project's edition
   is the lowest document id, so that is the doc the legacy app was using.
   ⚠️ The dry run's `duplicados` row names an `escolhido` — the newest
   `dataCadastro`, the doc the core WOULD take. That is a report, **not** this
   decision.
3. **On every other twin, set `contaAmazonContaFreteAmazonOuterRef` to `null`
   AND `ativo` to `false`.** Delete none: migrated pedidos may reference any of
   them through `freteInicial.integracaoFreteOuterRef`, and a deleted doc would
   leave those refs dangling.
4. **Dry-run again.** Each nulled twin now appears only as a `ref-ilegivel` row,
   which stops nothing, on every later run too. The kept doc plans `adotar` (or
   `atualizar` / `inalterado`).

⚠️ **Two shortcuts do NOT clear the STOP:**

- **Deactivating a twin alone.** The pass counts every doc of tipo `amz` that
  carries the canonical back-ref, whatever its `ativo` — the same match the
  core's lookup makes.
- **Re-spelling a twin's back-ref** to another form of the same conta (for
  example the bare `integracao/<integracaoId>`). It is still that conta's ref,
  now non-canonical: the STOP stays, as `nao-canonico`.

And one step the pass cannot check for you: it reads a nulled twin's ref, never
its `ativo`, so a twin nulled but left active plans exactly like one resolved in
full. The `ativo: false` of step 3 is checked by **Verify** below, not by the
dry run.

**Orphan twins** — a conta that no longer exists, with two docs carrying its
canonical back-ref — STOP too (even when both are already inactive), and follow
the same steps; the kept doc then plans `desativar-orfao`, or `orfao-inativo` if
it is already inactive.

⚠️ **The `amazon` functions codebase does not deploy until a dry run reports zero
of all three.** Its trigger has no tolerant scan, so a conta's first save would
create `amz-<integracaoId>` beside a doc whose back-ref is not canonical.

## When

Inside the window (W12, a Phase 2 step of the #1208 runbook), in this order:

1. after the Phase 2 import;
2. after the index
   `int_frete (tipo, contaAmazonContaFreteAmazonOuterRef, ativo, dataCadastro DESC)`
   is **READY** (W9's index phase). The `--apply` lookup rides it, and without it
   every conta full-scans `int_frete` (Enterprise bills data scanned);
3. **before** the `amazon` functions deploy, which waits for the clean second dry
   run below.

Not earlier: until the switch, the legacy app is the sole live writer of these
docs on the SOURCE project, so an earlier run is superseded. The authoritative
run is the one inside the window.

## Running it

```bash
# 1. Counts per label and the STOP verdict. Writes nothing, logs no per-conta rows.
pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <project-id> --report-only

# 2. Dry run — one JSONL row per conta, plus the STOP and ref-ilegivel rows, to out/*-dryrun.jsonl
pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <project-id>

# 3. Apply — refused while any conta reports a duplicados, nao-canonico or compartilhado row
pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <project-id> --apply

# 4. ⚠️ The idempotence proof: this must report 0 contas com escrita planejada.
pnpm --filter @delfrance/migrations migrate:amazon-int-frete --project <project-id>
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
only: an `amz-<integracaoId>` doc whose `tipo` was altered is outside the
`tipo == amz` scan, so its conta's line plans `criar`, while the core reads that
doc by its id and patches it back (`atualizado`). The outcome is correct — one
doc, patched — and the second dry run shows it `inalterado`. A crash mid-apply
needs no repair: re-run; the pass is idempotent and the dry run shows what is
left.

A conta reported `incompleto` needs the conta fixed (its filial, nome or
dataCadastro), then a re-run.

## Verify

1. The second dry run (step 4) reports **0** contas with planned writes and no
   `duplicados`, `nao-canonico` or `compartilhado` row.
2. On the new project, `int_frete` where `tipo == 'amz'` holds:
   - exactly **one active** doc carrying each active Amazon conta's canonical
     back-ref, with that conta's `nome`, `ativo` and filial;
   - `ativo: false` on every orphan's doc;
   - `ativo: false` on every twin a person resolved (a `ref-ilegivel` row, null
     back-ref).

## Cost

Two unpaged equality scans over small populations (one doc per conta), each on
the `tipo` prefix of a composite declared before step 20 — `integracao` where
`tipo` is Amazon, masked to `tipo` plus the mirrored fields so no credential is
pulled into the process, and `int_frete` where `tipo` is `amz` (prefixes of
`integracao (tipo, …)` and `int_frete (tipo, nome)`) — plus, on `--apply`, one
transaction per executable conta (a conta get, the lookup query, and on a miss
the deterministic-id get). That lookup query is the one that needs step 20's
`int_frete` composite. With one Amazon conta (D8) the whole pass is a handful of
reads. No collection is walked by key, so nothing here belongs in
`key-walks.json`.

## Staging is a rehearsal

Contas connected through `/canais/amazon` exist on staging only. Rehearse there
— dry run, `--apply`, then a clean second dry run as the idempotence check — or
re-seed; staging data never needs to be preserved. Agents run it only when asked.

## Code

- `src/intFreteAdocao/plano.ts` — the plan, shared by every channel's pass:
  labels, the STOP verdict, the JSONL rows. Pure.
- `src/intFreteAdocao/executar.ts` — the two scans, the rows, and the `--apply`
  loop over the core. I/O only.
- `src/2026-10-amazon-int-frete/transform.ts` — binds that pass to the Amazon
  row (`syncAmazon`, equal to the trigger's binding); `backfill.ts` is the entry
  point. Unit-tested in `transform.test.ts`, which pins every label, every STOP
  reason and the duplicate resolution above through the Amazon binding.
- The decisions themselves: `packages/data/src/admin/frete/intFreteContaSync.ts`.

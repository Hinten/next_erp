# Backfill: `endereco.codigoMunicipio` (IBGE) — #785

Fills the IBGE município code (`cMun`) on existing endereços from their CEP,
using the offline CEP-range table vendored in `@delfrance/core/cep/cmun`.

## Why

The NF-e generator hard-requires `codigoMunicipio` in three places —
`enderDest.cMun`, `enderEmit.cMun` and `ide.cMunFG` — but nothing on any server
path produced it until #785. Every Mercado Livre-imported endereço carries
`null`, and so does any endereço a human created without pressing the web UI's
"Buscar CEP" button (the field is hidden from every address form). Those
endereços keep failing emission until they are backfilled.

## ⚠️ Prerequisites

1. **The table must be vendored first** —
   `pnpm --filter @delfrance/cmun-table vendor`. Against the unvendored
   placeholder every row resolves to nothing and the run is an expensive no-op.
2. Ship the import fix (#848) **before** running this, so the importer is not
   re-creating rows you just backfilled.

## Running it

```bash
pnpm --filter @delfrance/migrations migrate:endereco-cmun -- --project <id>
pnpm --filter @delfrance/migrations migrate:endereco-cmun -- --project <id> --apply
```

Dry-run by default; `--project` is required and never inferred; credentials are
service-account only (`tools/migrations/src/admin.ts`). Every intended change
and every skip is written to a timestamped JSONL under `out/`.

**Order:** dry-run staging → apply staging → dry-run prod → apply prod, reading
the JSONL between each step.

## What it touches

`enderecoSchema` is embedded in three places, all of which are swept:

| Path                      | Field                              | Why                                                           |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `filiais`                 | `sede.codigoMunicipio`             | Gates `ide.cMunFG` on **every** NF-e — the most important one |
| `int_frete`               | `enderecoDeOrigem.codigoMunicipio` | Keeps the three embed sites consistent                        |
| `clientes/{id}/enderecos` | `codigoMunicipio`                  | The bulk, including every ML-imported address                 |

Embedded endereços are patched through a **dotted leaf path**
(`sede.codigoMunicipio`), never by rewriting the whole map — `filiais` and
`int_frete` are human-managed config, and a whole-map write would clobber a
concurrent edit.

## Two decisions worth knowing about

**It walks `clientes` and descends per-cliente — deliberately not
`collectionGroup('enderecos')`.** On Firestore Enterprise a collection-group
scan ordered only by `__name__` cannot be indexed at all (index entries are real
field paths, and Enterprise omits the implicit trailing `__name__`), so it
silently full-scans and bills bytes scanned. That exact shape was 93% of staging
reads once already (PR #737). And narrowing it with
`where('codigoMunicipio','==',null)` would be _unsound_: Firestore's `== null`
matches explicit nulls but **not absent fields**, so it would silently skip the
oldest Flutter-written docs — precisely the ones needing the backfill.

Cost profile: one small extra query per cliente instead of one large scan.
Slower in wall-clock, but predictable, and on scan-based billing it reads only
what it needs. Size it on staging first and read the logged totals.

`docsScanned` counts **every document read** — each `filial`, each `int_frete`,
each `cliente`, and each `endereco` — so the number in the summary line is the
real read volume, not just the endereços that were candidates for a write.

**It is offline-only.** Ten thousand ViaCEP calls against a service that
rate-limits without documenting its limit is a self-inflicted outage. Rows the
table cannot resolve are logged as skips; the emission-time backstop
(`apps/nfe/lib/nfe/orchestrator/cmun.ts`) closes that residue one CEP at a time,
when a human is present to act on a failure.

## What it will not do

- **Never overwrites a stored código.** A stored value whose IBGE prefix
  contradicts the endereço's `estado` is a real conflict — one of the two fields
  is wrong and the migration cannot know which — so it is recorded as a skip for
  a human, not "fixed".
- **Never writes a value it can already tell is wrong.** If the table resolves a
  código whose UF disagrees with the endereço's `estado`, that is skipped too: a
  wrong código sails through the generator and earns SEFAZ rejection 273, which
  is worse than no código at all.
- Skips any endereço whose `cep` is missing or not exactly 8 digits.

## Idempotency

Re-running is a no-op: an endereço carrying a valid 7-digit código is classified
`ok` and never written. Pinned by a test in `transform.test.ts`.

## After the run

Grep the JSONL for `"kind":"skip"` to get the complete residue list. Those
endereços need either a manual `codigoMunicipio`, a corrected `cep`/`estado`, or
a wider CEP table — see `tools/cmun-table/README.md`'s gap-report section.

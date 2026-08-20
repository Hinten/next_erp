# @delfrance/cmun-table

Export the legacy `CMUN` table out of one Firebase project and import it into
another (#785).

## What `CMUN` is

The CEP-faixa → IBGE município (`cMun`) table. NF-e emission resolves `cMun`
from it (`resolveCodigoMunicipio` in `@delfrance/data/admin`), and — this is the
part that shapes everything else — **the table grows by itself**: a CEP no faixa
covers is resolved through ViaCEP _once_ and written back as a new row, so the
next emission is a local lookup.

That is why it is a Firestore collection and not a committed data file. Brazil
gets new CEPs constantly, ViaCEP rate-limits hard (HTTP 429), and a file cannot
learn.

The collection id is literally uppercase **`CMUN`** — the legacy Flutter wire
name. Production already holds this data under that id, and the migrated corpus
arrives under it, so the name is kept rather than modernised. (The legacy app
queries it too, but on its own project: there is no dual run — root `CLAUDE.md`
rule 8.)

## ⚠️ Production probably does not need the import

Prod already has `CMUN`. These scripts exist to (a) take a durable copy of a
dataset that currently lives in exactly one place, and (b) seed _other_ projects
— staging, a fresh environment — from it.

## 1. Export (human step — needs prod credentials)

```bash
pnpm --filter @delfrance/cmun-table dump -- --project <prod-project-id>
```

Read-only. Service account only, `--project` required and never inferred, and
the service account's own project must match it. Writes
`data/cmun-export-<date>.jsonl` sorted by `cepInicial`, so a future re-export
diffs line-wise instead of as one opaque blob.

## 2. Import into a target project

```bash
pnpm --filter @delfrance/cmun-table import -- --project <id>          # dry-run
pnpm --filter @delfrance/cmun-table import -- --project <id> --apply  # write
```

Validates first, prints the gap report, then writes in batches of 400.
**Idempotent**: the doc id is the zero-padded `cepInicial`, so a re-run
overwrites rather than duplicates — unlike the legacy seeder
(`.old/lib/clientes/etc.dart`), which used auto-ids and duplicated every row on
a second run.

## What the validator enforces

Every check is fatal and lists the offending rows, so one run tells you
everything wrong with an export:

| Check                                   | Why                                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cepInicial`/`cepFinal` are **numbers** | The legacy import ran `int.parse` and stored Firestore integers, so `01310100` is `1310100`. A string-typed row means the dump mixed types and every comparison downstream is void. |
| `cMun` matches `/^\d{7}$/`              | The wire format.                                                                                                                                                                    |
| `cMun.slice(0,2) === IBGE_UF_CODES[uf]` | **The check that catches a corrupt dump** — it cross-validates two independently imported columns.                                                                                  |
| Bounds; no inverted faixas              | Basic sanity.                                                                                                                                                                       |
| No overlapping faixas                   | The resolver's query assumes disjoint ascending faixas; overlaps make its result undefined.                                                                                         |
| Distinct códigos in `[5_000, 5_600]`    | **The real truncation guard** — Brazil has 5.570 municípios, a hard known number.                                                                                                   |
| Faixa count in `[5_570, 25_000]`        | Deliberately loose: faixas-per-município varies wildly, and a guard that cries wolf on a good export just gets disabled.                                                            |

Non-fatal warnings: exterior rows dropped (`uf: 'EX'` / `cMun: '9999999'` —
they describe no lookupable faixa), and municípios spelled differently across
their own faixas.

## Read the gap report

It counts CEPs falling between faixas. Those are the CEPs that will each cost
**one** ViaCEP call before the table learns them — so the report is a direct
estimate of post-deploy ViaCEP load, which matters because of the 429 ceiling.

A large number is not fatal, but it is worth knowing before rollout: if whole
regions are missing, seed them rather than discovering it in production.

# @delfrance/cmun-table

Vendors the CEP-range → IBGE município (`cMun`) table into
`packages/core/src/cep/cmun/ranges.data.ts` (#785).

This is a **one-off vendoring script, not a generator.** Nothing automated runs
it, it is not in `turbo.json`, and its output is reviewed like source — the same
arrangement as the `CCLASSTRIB_SEED` refresh routine in
`packages/schemas/src/imposto/cclasstrib.ts`. Root `CLAUDE.md` rule 3's "exactly
two generators" still holds.

## Why the table exists

The legacy Flutter app resolved `cMun` lazily in `Endereco.cMun`
(`.old/packages/clientes/lib/src/models.dart:1059-1087`): stored value → the
`TabelaoCmun` Firestore collection (`CMUN`) → ViaCEP. The TypeScript port kept
the _requirement_ — `parties.ts` and `ide.ts` both hard-require
`codigoMunicipio` — and dropped the _resolution_, so every Mercado
Livre-imported endereço failed NF-e emission.

It ships as a **static file rather than a Firestore collection** because
Firestore Enterprise bills data scanned and this lookup runs on every emission,
and because a file works in tests, in the emulator, and needs no rules, index or
deploy step.

## ⚠️ The data exists in exactly one place

Production Firestore, collection `CMUN`. There is **no CSV, JSON or seed file
anywhere in `.old/`** — the legacy seeder (`.old/lib/clientes/etc.dart`) read a
CSV picked from a file dialog that was never committed, and the dataset's
original provenance (Correios DNE? IBGE? a third-party dump?) is undocumented.

Treat the dump under `data/` as the primary artifact.

## Refresh runbook

### 1. Export production (human step — needs prod credentials)

```bash
pnpm --filter @delfrance/cmun-table dump -- --project <prod-project-id>
```

Read-only. Credentials follow the migrations contract
(`tools/migrations/src/admin.ts`): service account only, `--project` is required
and never inferred, and the service account's own project must match it. Writes
`data/cmun-export-<date>.jsonl`, sorted by `cepInicial` so a future re-export
diffs line-wise. Pass `--out <path>` to override.

### 2. Vendor the module

```bash
pnpm --filter @delfrance/cmun-table vendor
```

Picks up the newest `data/cmun-export-*.jsonl` (or `--in <file>`), validates it,
encodes it, round-trips the result through the **runtime** decoder, and writes
`packages/core/src/cep/cmun/ranges.data.ts`.

### 3. Check the output

```bash
pnpm --filter @delfrance/core test
pnpm format
```

Paste the script's **gap report** into the PR body — see below.

## What the validator enforces

Every check is fatal and lists the offending rows, so one run tells you
everything wrong with an export:

| Check                                   | Why                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cepInicial`/`cepFinal` are **numbers** | The legacy import ran `int.parse` and stored Firestore integers. A string-typed row means the dump mixed types, which voids the leading-zero assumption behind `Number(cep)`. |
| `cMun` matches `/^\d{7}$/`              | The wire format.                                                                                                                                                              |
| `cMun.slice(0,2) === IBGE_UF_CODES[uf]` | **The check that catches a corrupt dump** — it cross-validates two independently imported CSV columns.                                                                        |
| Bounds, no inverted faixas              | Basic sanity.                                                                                                                                                                 |
| No overlapping faixas                   | Binary search over overlapping ranges is undefined. Also structurally enforced by the gap encoding, but this gives a readable error.                                          |
| Distinct códigos in `[5_000, 5_600]`    | **The real truncation guard** — Brazil has 5.570 municípios, a hard known number, so a partial export shows up here.                                                          |
| Range count in `[5_570, 25_000]`        | Deliberately loose: faixas-per-município varies wildly (one for a small town, dozens for a capital), so a tighter guess would cry wolf on a good export and get disabled.     |

Non-fatal, reported as warnings: exterior rows dropped (`uf: 'EX'` /
`cMun: '9999999'` — they describe no lookupable CEP faixa), and municípios whose
`nomeMunicipio` differs across their own faixas.

## The gap report matters — read it before merging

Our lookup returns `null` for a CEP in a **gap** between faixas. The legacy
query returned the _next faixa above_ — a wrong município, silently, into the
signed XML — because it filtered on `cepFinal >= cep` with an inert `startAt`
cursor and had no `cepInicial <= cep` predicate at all.

Returning `null` is the correct direction, but it converts "silently wrong cMun"
into "one ViaCEP call", and if ViaCEP is down, into a hard emission failure. The
gap report quantifies that exposure **before** the table ships.

If the gaps turn out to be large, the mitigation is to extend each `cepFinal` to
`nextStart − 1` **within the same UF prefix only** — an explicit, reported,
reviewable transformation. Decide that after seeing the report, not before.

## Encoding

Three comma-separated base36 integer lists in string constants, decoded lazily
into `Uint32Array`s on first lookup. Measured on a realistic-scale synthetic
dump (8.586 faixas, 5.570 municípios): **103 KiB encoded, 3,5 ms one-time
decode, 0,30 µs/lookup** — so expect ~130 KiB at the real faixa count. A plain
`[number, number, string][]` literal would cost roughly 3× the bytes **and**
materialise one JS array per faixa on every cold start — the metric that matters
for App Hosting and the nested Cloud Functions codebases.

The `startGaps` column stores each faixa's start as a **non-negative gap from
the previous faixa's end**, which makes overlapping faixas structurally
unrepresentable: the encoder physically cannot emit a corrupt table.

The encoder, decoder and IBGE UF map are all imported from `@delfrance/core`
(via `src/deps.ts`) rather than reimplemented here, and the script round-trips
its output through the runtime decoder before writing — so encoder/decoder drift
is impossible by construction.

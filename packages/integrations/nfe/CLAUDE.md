# packages/integrations/nfe — CLAUDE.md

NF-e (Nota Fiscal Eletrônica) library — server-only, ships PEM keys
and a 3 MB WASM blob. The orchestrator + HTTP host live in
`apps/nfe`; this package is the typed, version-pinned library they
consume.

## MOC version pinning

NF-e is defined by SEFAZ's MOC (Manual de Orientação do Contribuinte).
Currently we target **MOC 7.0** with XSD layout **v4.00**. MOC and
XSD layout are different namespaces — MOC describes how NF-e works;
XSDs encode the wire layout the MOC references. Bumping the MOC may
or may not bump the XSDs.

### Layout

```
packages/integrations/nfe/
  generated/
    moc7.0/
      schemas/     # 20 XSDs (vendored from SEFAZ for MOC 7.0)
      types/       # codegen output (interfaces + META + Zod mirrors)
  src/
    types/
      nfe-schema.ts      # SHIM — re-exports generated/moc7.0/types/nfe-schema
      nfe-schema-zod.ts  # SHIM — re-exports generated/moc7.0/types/nfe-schema-zod
    codegen/generate.mjs # reads MOC_DIR/schemas, writes MOC_DIR/types
    xsd/index.ts         # reads MOC_DIR/schemas for validateXsd()
```

Internal consumers import `'../types/nfe-schema'` (the shim), never
the versioned path directly. Three places know the active MOC
literal (kept tiny on purpose — search-and-replace one constant per
file to bump):

1. `src/types/nfe-schema.ts` — shim's re-export path
2. `src/types/nfe-schema-zod.ts` — shim's re-export path
3. `src/codegen/generate.mjs` — `ACTIVE_MOC` constant
4. `src/xsd/index.ts` — `ACTIVE_MOC` constant

### Adding a new MOC version (SEFAZ ships MOC 8.0 with v4.10 XSDs)

1. `mkdir -p generated/moc8.0/{schemas,types}` and drop the new XSDs
   into `generated/moc8.0/schemas/`.
2. Bump `ACTIVE_MOC` in `src/codegen/generate.mjs` and
   `src/xsd/index.ts` to `'8.0'`.
3. Re-run `pnpm --filter @delfrance/integrations-nfe gen:nfe-types`
   to emit `generated/moc8.0/types/nfe-schema.ts` +
   `nfe-schema-zod.ts`.
4. Update both shims in `src/types/` to point at `moc8.0`.
5. Re-run `pnpm turbo run typecheck` + `pnpm --filter
   @delfrance/integrations-nfe test`. The codegen-emitted shapes may
   gain or rename fields; fix the consumer call sites the typechecker
   surfaces.
6. **Do not delete `generated/moc7.0/`.** Old MOC stays present so
   any future code that needs to read an old archived NF-e XML
   against its original schema can do so by switching the shim path
   to `moc7.0` in a feature branch. Old MOCs are append-only history.

### Tests

All tests live under `test/` mirroring `src/`. See PR #47 for the
relocation rationale. Vitest's include glob is `test/**/*.test.ts`.

### Generated-file hygiene

The two files under `generated/moc7.0/types/` are codegen output —
do NOT hand-edit. Always regenerate via `pnpm gen:nfe-types`. CI
runs the codegen + asserts no diff to catch out-of-sync states.

## Cert + chain

- A1 PFX certificate, loaded once at boot (see `src/cert/index.ts`).
- SEFAZ TLS chain vendored under `ca/sefaz-<uf>-<ambiente>.pem`,
  refreshed by `pnpm fetch:sefaz-ca`. Different concern from MOC
  versions — TLS chains don't need MOC pinning.

## SN-only tribute engine

Phase A is Simples Nacional only (`src/tribute/imposto.ts:75` throws
on CRT=3/4). Regime Normal (CST 00/10/20/…) is Phase D.

## Numeração

Per-Filial `nNF` + `idLote` counters via Firestore optimistic
transactions, with our own outer retry loop + jittered backoff to
beat the SDK's default 5-attempt budget at high contention. See
`src/numeracao/firestore-adapter.ts`.

# Consulta Cadastro (consCad) v2.00 XSDs

Schemas for **pre-send validation** of the SEFAZ Consulta Cadastro request
(`consCad`, layout 2.00), used by `validateConsCad` in `src/xsd/index.ts`.

They live here — **not** under `generated/moc7.0/schemas/` — on purpose: the
codegen (`gen:nfe-types`) scans `moc7.0/schemas/` and would renumber the v4.00
**emission** types' `choiceGroup`s if these v2.00 files were added there (see
issue #251). Keeping them in a separate dir lets `validateConsCad` mount them
for validation without touching the codegen.

## Files

| File | Source |
|---|---|
| `leiauteConsultaCadastro_v2.00.xsd` | Vendored verbatim from nfephp `schemes/NFe/PL_006u/`. Defines `TConsCad` / `infCons`. |
| `tiposBasico_v1.03.xsd` | The base types `leiauteConsultaCadastro_v2.00.xsd` `xs:include`s (TUfCons, TCnpjVar, …). Same file already vendored under `moc7.0/schemas/`. |
| `consCad-request_v2.00.xsd` | **Authored in-repo** (not a verbatim SEFAZ file). Declares the request root element `consCad` (lowercase) + includes the leiaute. The upstream nfephp `consCad_v2.00.xsd` declares the root as `ConsCad` (capital C) — a transcription error; SEFAZ's real request element is lowercase `consCad`. See the comment in the file. |

The XSDs are read at runtime via `readFileSync`; for esbuild-bundled consumers
that lose the dir layout, override with `NFE_CONSCAD_SCHEMA_DIR` (mirrors
`NFE_SCHEMA_DIR`).

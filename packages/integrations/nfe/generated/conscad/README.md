# Consulta Cadastro (consCad) v2.00 XSDs

Schemas for **pre-send validation** of the SEFAZ Consulta Cadastro request
(`consCad`, layout 2.00), used by `validateConsCad` in `src/xsd/index.ts`.

They live here — **not** under `generated/moc7.0/schemas/` — on purpose: the
codegen (`gen:nfe-types`) scans `moc7.0/schemas/` and would renumber the v4.00
**emission** types' `choiceGroup`s if these v2.00 files were added there (see
issue #251). Keeping them in a separate dir lets `validateConsCad` mount them
for validation without touching the codegen.

## ⚠️ The request root element is `ConsCad` with a CAPITAL C

A deliberate SEFAZ case asymmetry, specific to Consulta Cadastro, that trips
everyone up: the schema **file** is `consCad_v2.00.xsd` (lowercase), but the
root **element** it declares is `<xs:element name="ConsCad">` (capital C). So
the request XML must be `<ConsCad versao="2.00" …>`, NOT `<consCad …>`. Sending
lowercase is a `cStat 215 "Falha no schema XML"`. (Verified against the official
XSD byte-for-byte and the sped-nfe production builder `Tools.php::sefazCadastro`,
which emits `<ConsCad …>`. The response root, by contrast, is `retConsCad`.)

## Files

| File | Source |
|---|---|
| `consCad_v2.00.xsd` | Vendored verbatim from nfephp `schemes/NFe/PL_006u/`. Declares the request root `<xs:element name="ConsCad" type="TConsCad">` (capital C — see warning above) + `xs:include`s the leiaute. |
| `leiauteConsultaCadastro_v2.00.xsd` | Vendored verbatim from nfephp `schemes/NFe/PL_006u/`. Defines `TConsCad` / `infCons`. |
| `tiposBasico_v1.03.xsd` | The base types `leiauteConsultaCadastro_v2.00.xsd` `xs:include`s (TUfCons, TCnpjVar, …). Same file already vendored under `moc7.0/schemas/`. |

The XSDs are read at runtime via `readFileSync`; for esbuild-bundled consumers
that lose the dir layout, override with `NFE_CONSCAD_SCHEMA_DIR` (mirrors
`NFE_SCHEMA_DIR`).

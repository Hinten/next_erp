# Consulta Cadastro (consCad) layout 2.00 — XSDs + codegen pack

The SEFAZ Consulta Cadastro service speaks message layout **2.00**, a separate
pack from the v4.00 MOC. This directory holds its XSDs and is its **own codegen
pack**:

- `gen:nfe-types` runs `src/codegen/generate.mjs --pack conscad` over the `.xsd`
  files here and writes `types/conscad-schema.ts` (interfaces + `META` +
  `ROOTS`; no Zod mirror). `consultarCadastro` builds the request and reads the
  response through it (`serializeConsCad` / `parseConsCad` in `src/xml`).
- `src/xsd/index.ts` checks both directions: `validateConsCad` validates the
  request against `consCad_v2.00.xsd` before it is sent, and
  `validateRetConsCad` validates SEFAZ's response against `retConsCad_v2.00.xsd`
  before it is parsed (#1602 — a failure is a 500 at the route).

## ⚠️ Never move these XSDs into `generated/moc7.0/schemas/`

The generator keeps ONE registry of type names per run, and
`leiauteConsultaCadastro_v2.00.xsd` declares a `TEndereco` that the NF-e
`leiauteNFe_v4.00.xsd` declares too. In a shared run that name resolves to
whichever file sorts last, so either this layout's `ender` or the emission
`enderDest` silently takes the other's shape (issue #251). A separate pack,
generated in a separate process, keeps both.

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
| `consCad_v2.00.xsd` | Vendored verbatim from nfephp `schemes/NFe/PL_006u/` (byte-identical to `sped-nfe/schemes/PL_009_V4/`, checked 2026-09-14). Declares the request root `<xs:element name="ConsCad" type="TConsCad">` (capital C — see warning above) + `xs:include`s the leiaute. |
| `retConsCad_v2.00.xsd` | Vendored verbatim from nfephp `sped-nfe/schemes/PL_009_V4/` (2026-09-14). Declares the response root `<xs:element name="retConsCad" type="TRetConsCad">` + `xs:include`s the leiaute. Read by the codegen and by `validateRetConsCad`, which checks every SEFAZ reply before it is parsed (#1602). |
| `leiauteConsultaCadastro_v2.00.xsd` | Vendored verbatim from nfephp `schemes/NFe/PL_006u/` (byte-identical to `sped-nfe/schemes/PL_009_V4/`, checked 2026-09-14). Defines `TConsCad`, `TRetConsCad` and this layout's `TEndereco`. |
| `tiposBasico_v1.03.xsd` | The base types `leiauteConsultaCadastro_v2.00.xsd` `xs:include`s (TUf, TCnpjVar, …). Same file already vendored under `moc7.0/schemas/`. |
| `types/conscad-schema.ts` | **Generated** — never hand-edit; re-run `gen:nfe-types`. |

The XSDs are read at runtime via `readFileSync`; for esbuild-bundled consumers
that lose the dir layout, override with `NFE_CONSCAD_SCHEMA_DIR` (mirrors
`NFE_SCHEMA_DIR`).

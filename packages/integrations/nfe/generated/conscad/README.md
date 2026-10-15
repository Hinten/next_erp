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
  before it is parsed (#1602 — a failure is a 500 at the route). The response is
  whitespace-trimmed per element first: real SEFAZ-SP data pads values (a
  trailing space in `xNome`) that the `TString` pattern would otherwise reject.

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
| `tiposBasico_v1.03.xsd` | The base types `leiauteConsultaCadastro_v2.00.xsd` `xs:include`s (TUf, TCnpjVar, …). ⚠️ **No longer the same file as `moc7.0/schemas/tiposBasico_v1.03.xsd`** — this copy is taken from `PL_010d_v1.03/CadConsultaCadastro/`, that one from `PL_010d_v1.03/Evento/`, and SEFAZ ships them with real divergences (a 9-line header, `TStat` `[0-9]{3}` here vs `[0-9]{3,4}` there, and a `TCnpjVar` doc string). Take each pack's own copy; never cross-vendor them. |
| `types/conscad-schema.ts` | **Generated** — never hand-edit; re-run `gen:nfe-types`. |

The XSDs are read at runtime via `readFileSync`; for esbuild-bundled consumers
that lose the dir layout, override with `NFE_CONSCAD_SCHEMA_DIR` (mirrors
`NFE_SCHEMA_DIR`).

## Provenance update — NT 2026.004 (CNPJ Alfanumérico)

`tiposBasico_v1.03.xsd` and `retConsCad_v2.00.xsd` were re-vendored from
**`PL_010d_v1.03/CadConsultaCadastro/`**; `consCad_v2.00.xsd` and
`leiauteConsultaCadastro_v2.00.xsd` are byte-identical in that pack and were left
as they were. This supersedes the nfephp-sourced rows above for those two files.

⚠️ **`TCnpjVar` narrowed from `[0-9]{3,14}` to `[0-9A-Z]{12}[0-9]{2}`.** That is
SEFAZ's own change in the pack, not a local edit — the request `<CNPJ>` and both
response `<CNPJ>` elements of the Consulta Cadastro layout use this type, so a
response carrying a CNPJ of any other length now fails `validateRetConsCad` and
500s the route. If that ever happens it is the same class as the trailing-space
bug in #1602, where SEFAZ's own registry data did not satisfy SEFAZ's own schema:
handle it tolerantly at the reader, **never by hand-editing a vendored XSD.**

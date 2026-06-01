# XSD → TypeScript codegen — re-run procedure

SEFAZ publishes new XSD packs (Notas Técnicas) regularly, so the generated
types must be regenerated periodically. This file is the procedure; the
SEFAZ update-watch routine automates it.

- **Generator**: `packages/integrations/nfe/src/codegen/generate.mjs` —
  zero-dependency (built-in minimal XML parser). See ADR 0004.
- **Script**: `pnpm --filter @delfrance/integrations-nfe gen:nfe-types`.
- **Input**: `packages/integrations/nfe/schemas/*.xsd` (vendored).
- **Output**: `packages/integrations/nfe/src/types/nfe-schema.ts` (committed).
- **Provenance**: `packages/integrations/nfe/schemas/MANIFEST.json`.

## When to re-run

When SEFAZ publishes a new **Pacote de Liberação** or NT that changes the
schemas. The schema list page:
`https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=BMPFMBoln3w=`

## Procedure

1. **Reach the portal.** It redirects in a loop for non-browser clients —
   break it by accepting cookies (`curl -b jar -c jar`; the
   `AspxAutoDetectCookieSupport` cookie resolves it). Download links are
   `exibirArquivo.aspx?conteudo=<base64>`; the base64 `conteudo` uses `+`,
   which may render as a space — re-encode space → `+` (`%2B`).
2. **Identify the pack.** A "Pacote de Liberação" may be a **full pack**
   (all web-service envelope schemas + leiaute) or a **leiaute delta** (only
   `leiauteNFe`/`nfe`/`tiposBasico`/`DFeTiposBasicos`). Check the file count
   after unzipping.
3. **Re-vendor `schemas/`.** A full pack replaces the base set; a leiaute
   delta overlays its files on top of the current base (newer leiaute wins).
   The current set = `PL_009i` base + `PL_010c` leiaute overlay (20 files).
4. **Verify imports resolve** — every `xs:include`/`xs:import`
   `schemaLocation` must point at a file present in `schemas/`.
5. **Update `MANIFEST.json`** — pack name, NT, publish date, URL, role.
6. **Run** `gen:nfe-types`.
7. **Typecheck and review** the `src/types/nfe-schema.ts` diff — a new NT
   usually adds/renames fields; check nothing the generator can't express
   slipped in (see below).
8. Commit; the change rides through `ci-nfe.yml` (homologação round-trip).

## Generator design & gotchas

- **`xmldsig-core-schema` is excluded** — the `<Signature>` element is
  injected by the signing library, so it is a `#raw` opaque-XML field, not a
  generated type. **Any `xs:any`-content complexType is likewise opaque**: the
  generator emits an empty field list, then a post-pass remaps every field
  that references it to `#raw` (a pre-built XML string the caller supplies, in
  sequence order) and drops the empty type. That is how the generic event
  leiaute's `<detEvento>` works — its real shape is the tpEvento-specific
  schema (`e110111`), serialized on its own and fed into the `#raw` slot.
- **All leaf values are typed `string`** — NF-e needs exact decimal control
  on the wire; never `number`. Enumerations become string-literal unions.
- **`xs:choice` members are flattened**, marked optional, and tagged with a
  `choiceGroup` id (members of a group are mutually exclusive).
- **Same-named elements are deduped.** `xs:choice` branches can declare the
  same element name twice (e.g. `IPI` in the `imposto` choice). The generator
  keeps the **first occurrence's position** — which yields the correct NF-e
  element order — and unions differing types.
- **Inline anonymous `complexType`s** are synthesised into named interfaces
  (`<ownerType>_<elementName>`). A **top-level** element with an inline
  `complexType` (no `type=` ref — e.g. the event-payload schemas like
  `e110111`'s `<detEvento>`) is synthesised under the element's own name and
  registered as a serializable root.
- **Constructs handled**: `complexType`, `simpleType`, `element`, `sequence`,
  `choice`, `attribute`. **Not handled** (the NF-e XSDs do not use them):
  `extension`, `group`, `union`, `list`, `complexContent`, `simpleContent`.
  **If a future NT introduces any of these, the generator must be extended** —
  it will silently fall back to `string`/empty rather than erroring, so watch
  the output diff.
- Output is committed and regenerated only on demand — never wired into
  `turbo build`.

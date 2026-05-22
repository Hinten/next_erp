# infNFe leiaute & XML formatting

The full field definitions are in MOC **Anexo I — Leiaute e Regras de Validação
da NF-e e da NFC-e**. This file maps the structure and the formatting rules
that bite during generation; consult the Anexo I XSD for exact field types,
sizes and validation rules.

## Root structure

```
NFe
└─ infNFe  (Id="NFe<chave>", versao="4.00")   ← the signed element
   ├─ ide        Group B   identification
   ├─ emit       Group C   issuer
   ├─ dest       Group E   recipient
   ├─ det (1-N)  Group H   one per line item
   │   ├─ prod   Group I   product/service
   │   └─ imposto Group M  taxes (ICMS/IPI/II/PIS/COFINS/ISSQN)
   ├─ total      Group W   NF-e totals
   ├─ transp     Group X   freight
   ├─ cobr       Group Y   billing / duplicatas
   ├─ pag        Group YA  payments
   └─ infAdic    Group Z   additional info
└─ Signature                                  ← sibling, after infNFe
```

## Field groups (Anexo I)

| Group | Content |
|---|---|
| A | Dados da NF-e (root `infNFe`) |
| B | `ide` — identification (cUF, natureza, mod, série, nNF, dhEmi, tpNF, idDest, cMunFG, tpImp, tpEmis, cDV, tpAmb, finNFe, indFinal, indPres, procEmi) |
| BA | `NFref` — referenced fiscal documents |
| C | `emit` — issuer (CNPJ/CPF, xNome, IE, CRT, enderEmit) |
| D | `avulsa` — fisco-issued NFA-e only |
| E | `dest` — recipient (CNPJ/CPF/idEstrangeiro, xNome, indIEDest, IE, enderDest) |
| F / G | `retirada` / `entrega` — pickup / delivery addresses |
| H | `det` — line item wrapper (attribute `nItem`) |
| I | `prod` — product (cProd, cEAN, xProd, NCM, CFOP, uCom, qCom, vUnCom, vProd…) |
| I01/I03/I05/I07/I80 | import declaration / export / purchase order / misc / traceability |
| J–LB | vehicle / medicine / weapon / fuel / immune-paper specifics |
| M–U | `imposto` — ICMS (N), IPI (O), II (P), PIS (Q/R), COFINS (S/T), ISSQN (U) |
| N02–N10h | ICMS sub-groups by CST/CSOSN |
| V | `infAdProd` — per-item additional info |
| W | `total` — `ICMSTot`, `ISSQNtot`, `retTrib` |
| X | `transp` — transport mode, transporter, volumes |
| Y | `cobr` — `fat` + `dup` (duplicatas) |
| YA | `pag` — `detPag` payment methods + `vTroco` |
| YB | `infIntermed` — transaction intermediary |
| Z | `infAdic` — `infCpl`, `infAdFisco`, `obsCont`, `procRef` |
| ZA–ZD | comércio exterior / compras / cana / responsável técnico |

## XML formatting rules (Anexo I §4.2 / MOC §4.2.1)

- **One** `<?xml version="1.0" encoding="UTF-8"?>` declaration; in a lote the
  inner `<NFe>` elements carry none.
- **Single namespace** `http://www.portalfiscal.inf.br/nfe` on the root, **no
  prefix**. The `<Signature>` declares its own `xmlns`.
- **Omit optional empty tags** — never emit a tag with `0` (numeric) or empty
  (text) content for a non-mandatory field. Emit conditional fields only when
  the rule/legislation applies.
- **No formatting whitespace** — no line-feed, carriage-return, tab, or spaces
  between tags. No comments, no `annotation`/`documentation`.
- **Numbers**: integers with no thousands separator and no leading zeros;
  decimals use a `.` separator with the exact decimal places the schema
  defines (e.g. `13v2` = 13 integer digits + 2 decimals). No trailing spaces.
- **Validate against the XSD** before sending — schema failure is rejection
  215 (message) / 225 (lote).

## Special-character handling (MOC §4.2.1.5)

XML-significant characters in free text (xNome, addresses, infCpl…) must be
escaped — and these escape sequences count as **one character** for length
validation:

| Char | Escape |
|---|---|
| `<` | `&lt;` |
| `>` | `&gt;` |
| `&` | `&amp;` |
| `"` | `&quot;` |
| `'` | `&#39;` |

Beyond escaping, the old ERP applied two passes (port them — see
`.old/docs/nfe-character-sanitization.md` and `.old/packages/nfe_client`):

1. **`removerAcentos`** — strip diacritics (`ç`→`c`, `ã`→`a`, …).
2. **`removerCharRestrito`** — escape `< > & " '` and drop symbols SEFAZ
   rejects (`@#%*$£§ªº©®™`, brackets, operators, control chars U+0000–U+001F),
   keeping letters, digits, spaces and basic punctuation `.,-/;:()`.

Apply `removerAcentos` **first**, then `removerCharRestrito`.

## Generation notes

- `cNF` must be random, 8 digits, `≠ nNF`.
- `dhEmi` / `dhSaiEnt` are UTC with timezone offset (`AAAA-MM-DDThh:mm:ss-03:00`).
- Element order within each group follows the XSD `sequence` exactly — XSD-typed
  codegen preserves it (ADR 0004); never reorder by hand.
- The chave's `cUF`, `mod`, `serie`, `nNF`, `tpEmis`, `cNF`, `cDV`, and the
  `AAMM` from `dhEmi` must all match the corresponding `ide` fields — the chave
  is recomputed and cross-checked by SEFAZ.

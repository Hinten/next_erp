# Chave de Acesso (44-character access key)

The chave de acesso uniquely identifies an NF-e. It is **44 characters**, formed
by concatenating fields already present in the NF-e layout. Because it is fully
derived from the NF-e's own data, it can be computed **before** the NF-e is sent
to SEFAZ — making it the anchor for loss recovery.

⚠️ **Not 44 digits.** Since NT 2026.004 (RFB IN 2.229/2024, CNPJ alfanumérico)
positions **6–17** — the emitente CNPJ's 12-character body — may carry `A-Z`.
The CNPJ's own two check digits and every other field stay numeric, which is
exactly the shape of `CHAVE_NFE_REGEX` in `@delfrance/schemas`:

```
/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/
```

It mirrors the XSD's `TChNFe` facet. Never write a local `\d{44}`, and never
`[0-9A-Z]{44}` either. Because the alfa window is the WHOLE CNPJ minus its DVs,
`chave.slice(6, 20)` remains the correct way to cut the emitente CNPJ back out —
the five consumers that do so needed no change.

## Composition (layout 4.00)

| Pos | Field | Digits | Source (id) |
|----:|---|---:|---|
| 1 | `cUF` — IBGE code of the issuer's state | 2 | B02 |
| 2 | `AAMM` — year+month of emission | 4 | from B09 (`dhEmi`) |
| 3 | `CNPJ`/`CPF` of the issuer | 14 | C02 / C02a |
| 4 | `mod` — document model (`55`) | 2 | B06 |
| 5 | `serie` | 3 | B07 |
| 6 | `nNF` — NF-e number | 9 | B08 |
| 7 | `tpEmis` — emission type | 1 | B22 |
| 8 | `cNF` — random numeric code | 8 | B03 |
| 9 | `cDV` — check digit | 1 | B23 |

Total: 2+4+14+2+3+9+1+8+1 = **44**.

- A **CPF** issuer is left-padded with zeros to 14 digits. CPF issuers use a
  reserved série range (920–969) and sign with an **e-CPF** certificate.
- `cNF` (8 digits) **must be a fully random sequence**. It is the only part not
  publicly derivable; a predictable `cNF` is a security flaw. `cNF` must not
  equal `nNF` (validation rule rejects it).
- `tpEmis` is part of the key (since layout 2.00) so the same natural key can
  coexist across normal and contingency environments without colliding keys.

## Check digit (`cDV`) — módulo 11

Computed over the **first 43 characters**:

1. Apply weights `2,3,4,5,6,7,8,9` cycling, **right to left**.
2. Convert each character to **`ASCII − 48`** and multiply by its weight.
3. `resto = soma mod 11`.
4. `DV = 11 - resto`. **If `resto` is 0 or 1, `DV = 0`.**

⚠️ **Step 2 is `ASCII − 48`, not `Number(c)`** — the NT 2026.004 rule, the same
weighting `validateCNPJ` in `@delfrance/core/documents` uses. `'0'-'9'` map to
`0-9` and `'A'-'Z'` to `17-42`, so for a numeric chave the two are identical and
every DV computed before the alfa era is unchanged.

⚠️ `Number('A')` is `NaN`, and `NaN` propagates: `soma` becomes `NaN`,
`resto <= 1` is false, `11 - NaN` is `NaN`, and `cDV.toString()` is the literal
string `'NaN'`. The chave then comes out **46 characters** carrying
`<cDV>NaN</cDV>` and *nothing throws* — it is simply persisted as the document's
anti-loss anchor. Before #1619 the digits-only guard was the only thing
preventing that, which is why the DV had to be corrected **before** the guard
was widened, never after.

```ts
function calcDV(chave43: string): number {
  let soma = 0, peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += (chave43.charCodeAt(i) - 48) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto <= 1 ? 0 : 11 - resto;
}
```

## Chave Natural

A **subset** of the key — `UF + CNPJ/CPF + modelo + série + número` (plus
`tpEmis` for NFC-e) — is the *natural key*. SEFAZ rejects a new authorization
request when an NF-e with the same natural key already exists. This is the root
cause of the **duplicidade** rejections (see `cstat-rejeicoes.md`): resending an
NF-e (even after a lost response) collides on the natural key.

## Use in the XML

- `<infNFe Id="NFe<44-char-chave>" versao="4.00">` — the `Id` attribute is the
  literal `NFe` + the chave.
- The signature `<Reference URI="#NFe<chave>">` points at that `Id`.

# Chave de Acesso (44-digit access key)

The chave de acesso uniquely identifies an NF-e. It is **44 numeric digits**,
formed by concatenating fields already present in the NF-e layout. Because it is
fully derived from the NF-e's own data, it can be computed **before** the NF-e
is sent to SEFAZ — making it the anchor for loss recovery.

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

Computed over the **first 43 digits**:

1. Apply weights `2,3,4,5,6,7,8,9` cycling, **right to left**.
2. Sum each digit × its weight.
3. `resto = soma mod 11`.
4. `DV = 11 - resto`. **If `resto` is 0 or 1, `DV = 0`.**

```ts
function calcDV(chave43: string): number {
  let soma = 0, peso = 2;
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso;
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

- `<infNFe Id="NFe<44-digit-chave>" versao="4.00">` — the `Id` attribute is the
  literal `NFe` + the chave.
- The signature `<Reference URI="#NFe<chave>">` points at that `Id`.

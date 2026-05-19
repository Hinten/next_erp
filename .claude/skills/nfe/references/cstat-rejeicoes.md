# cStat codes & rejection recovery

`cStat` is a 3-digit status code in every SEFAZ response, paired with `xMotivo`
(human-readable). The authoritative list is MOC Anexo I §4.4; the codes below
are the ones the autorização flow must handle.

## Success / processing

| cStat | Meaning | Action |
|---|---|---|
| 100 | Autorizado o uso da NF-e | Authorized — assemble procNFe |
| 150 | Autorizado, autorização fora de prazo | Authorized (treat as 100) |
| 103 | Lote recebido com sucesso | Async accepted — store `nRec`, poll |
| 104 | Lote processado | Read the `protNFe` array |
| 105 | Lote em processamento | Wait ≥ 15 s, poll again (bounded retry) |
| 106 | Lote não localizado | Lote lost — recover each NF-e via `consSitNFe` |
| 107 | Serviço em Operação | Service up |
| 108 / 109 | Serviço paralisado (momentâneo / sem previsão) | Consider contingency |

## Denial (NF-e is stored, but unusable)

| cStat | Meaning |
|---|---|
| 110 | Uso Denegado |
| 301 | Denegada — irregularidade fiscal do emitente |
| 302 | Denegada — irregularidade fiscal do destinatário |

A denegada NF-e is recorded by SEFAZ; the operation cannot proceed. Do not
resend the same number — it is consumed.

## Duplicidade — the recovery-critical codes

These mean "an NF-e with this natural key already reached SEFAZ". They happen
constantly after communication failures. **They are recoverable, not fatal.**

| cStat | Meaning | Marker in `xMotivo` |
|---|---|---|
| 204 | Duplicidade de NF-e | `[nRec:999999999999999]` |
| 205 | NF-e denegada na base da SEFAZ | `[nRec:...]` |
| 218 | NF-e já está cancelada na base da SEFAZ | `[nRec:...]` |
| 539 | Duplicidade de NF-e com diferença na Chave de Acesso | `[chNFe:44digits][nRec:...]` |
| 635 | NF-e com mesmo número/série já transmitida, aguardando processamento | — |

Extraction regexes (match the old Flutter implementation):

```ts
const RE_NREC  = /nRec:(\d+)/;       // 204, 205, 218, 539
const RE_CHNFE = /chNFe:(\d+)/;      // 539 — the key SEFAZ actually has
```

### Recovery procedure

On 204 / 205 / 218 / 539:

1. **Do not resend.** Resending re-triggers the duplicidade (or `656`).
2. Call **`consSitNFe(chave)`** for the NF-e's chave.
   - If it returns a `protNFe` with `cStat=100` → the NF-e *was* authorized;
     adopt that protocol, mark the NF-e authorized. The earlier "failure" was
     just a lost response.
   - `cStat=101`/cancelada → mark cancelada.
   - denegada → mark denegada.
3. For **539**, the key SEFAZ holds differs in `cNF`/DV — query with the
   `chNFe` from `xMotivo`, not the locally computed one.
4. Note (NT 2018.005): if the resent NF-e's `DigestValue` matches the stored
   one, some UFs return the authorization protocol directly on the 204.
5. `635` → the lote is still queued; wait and poll, do not resend.

This is why the chave must be persisted **before** sending: recovery always has
something to query.

## Lote / message rejections

| cStat | Meaning |
|---|---|
| 215 | Falha no schema XML da mensagem |
| 225 | Falha no schema XML do lote |
| 252 | Ambiente informado diverge do ambiente de recebimento |
| 280 / 281 / 286 | Certificado de transmissão inválido / vencido / sem cadeia |
| 290–298 | Certificado/assinatura de assinatura inválidos |
| 416 | Falha na descompactação da área de dados (Zip) |
| 656 | Consumo Indevido — caller is looping; back off |

`297`/`298` and similar are signature/cert problems — fix the certificate or
the signing, then resend with a fresh number is **not** needed (the NF-e was
never stored). Plain rejections (schema, business rules) → fix and resend with
the **same** number (the NF-e was discarded, not stored).

## Resend rule of thumb

- **Rejected** (not 100/150, not duplicidade, not denegada) → NF-e was *not*
  stored → fix and resend, **same número/série**.
- **Duplicidade** → NF-e *may be* stored → `consSitNFe`, never blind-resend.
- **Authorized but response lost** → `consSitNFe` recovers the protocol.
- **Normal-emission NF-e pendente de retorno** that you give up on → it needs a
  **new número** if reissued (contingency rules differ — see `contingencia.md`).

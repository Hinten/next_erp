# cStat codes & rejection recovery

`cStat` is a status code in every SEFAZ response, paired with `xMotivo`
(human-readable). The authoritative list is MOC Anexo I §4.4 plus every NT
that adds new codes (consolidated below).

**Width: 3 or 4 digits.** Pré-NT 2025.002 todos os cStats eram 3 dígitos;
NT 2025.002 §5.1 estendeu o campo para 4 dígitos para abrir espaço às
rejeições exclusivas dos novos tributos (IBS/CBS/IS). Parsers devem aceitar
`^[0-9]{3,4}$`. Códigos novos da NT 2025.001 (452, 853, 797, etc.) ainda
são 3 dígitos.

## Success / processing

| cStat     | Meaning                                        | Action                                                                                  |
| --------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| 100       | Autorizado o uso da NF-e                       | Authorized — assemble procNFe                                                           |
| 150       | Autorizado, autorização fora de prazo          | Authorized (treat as 100). Janela mudou para >7 dias (NT 2025.001); ≤7 dias retorna 100 |
| 103       | Lote recebido com sucesso                      | Async accepted — store `nRec`, poll                                                     |
| 104       | Lote processado                                | Read the `protNFe` array (sync mode → inline; async → after polling)                    |
| 105       | Lote em processamento                          | Wait ≥ 15 s, poll again (bounded retry)                                                 |
| 106       | Lote não localizado                            | Lote lost — recover each NF-e via `consSitNFe`                                          |
| 107       | Serviço em Operação                            | Service up                                                                              |
| 108 / 109 | Serviço paralisado (momentâneo / sem previsão) | Consider contingency                                                                    |

## Denial (NF-e is stored, but unusable)

| cStat | Meaning                                          |
| ----- | ------------------------------------------------ |
| 110   | Uso Denegado                                     |
| 301   | Denegada — irregularidade fiscal do emitente     |
| 302   | Denegada — irregularidade fiscal do destinatário |

A denegada NF-e is recorded by SEFAZ; the operation cannot proceed. Do not
resend the same number — it is consumed.

## Duplicidade — the recovery-critical codes

These mean "an NF-e with this natural key already reached SEFAZ". They happen
constantly after communication failures. **They are recoverable, not fatal.**

| cStat | Meaning                                                              | Marker in `xMotivo`          |
| ----- | -------------------------------------------------------------------- | ---------------------------- |
| 204   | Duplicidade de NF-e                                                  | `[nRec:999999999999999]`     |
| 205   | NF-e denegada na base da SEFAZ                                       | `[nRec:...]`                 |
| 218   | NF-e já está cancelada na base da SEFAZ                              | `[nRec:...]`                 |
| 539   | Duplicidade de NF-e com diferença na Chave de Acesso                 | `[chNFe:44digits][nRec:...]` |
| 635   | NF-e com mesmo número/série já transmitida, aguardando processamento | —                            |

Extraction regexes (match the old Flutter implementation):

```ts
const RE_NREC = /nRec:(\d+)/; // 204, 205, 218, 539
const RE_CHNFE = /chNFe:(\d+)/; // 539 — the key SEFAZ actually has
```

### Recovery procedure

On 204 / 205 / 218 / 539:

1. **Do not resend.** Resending re-triggers the duplicidade (or `656`).
2. Call **`consSitNFe(chave)`** for the NF-e's chave.
   - If it returns a `protNFe` with `cStat=100` → the NF-e _was_ authorized;
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

| cStat           | Meaning                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 215             | Falha no schema XML da mensagem                                                                                                |
| 225             | Falha no schema XML do lote                                                                                                    |
| 252             | Ambiente informado diverge do ambiente de recebimento                                                                          |
| 280 / 281 / 286 | Certificado de transmissão inválido / vencido / sem cadeia                                                                     |
| 290–298         | Certificado/assinatura de assinatura inválidos                                                                                 |
| 416             | Falha na descompactação da área de dados (Zip)                                                                                 |
| **452**         | **Rejeição: Solicitada resposta assíncrona para Lote com somente 1 (uma) NF-e** (NT 2025.001 RV GAP03a-3, produção 13/10/2025) |
| 656             | Consumo Indevido — **ban path, see below**                                                                                     |

### 452 — async com lote de 1 NF-e (NT 2025.001)

Desde 13/10/2025 (homologação) e 03/11/2025 (produção), enviar `indSinc=0`
com lote de exatamente 1 NF-e é rejeitado. A nova regra: lote=1 sempre
`indSinc=1`. Vide `sincrono-vs-assincrono.md` para o fluxo completo.
Implementação no helper `autorizarLote` deve inferir `indSinc` a partir
do tamanho do array de NF-e, não recebê-lo do caller.

### 656 — Consumo Indevido (treat as the ban precursor)

`656` does **not** just mean "back off." It is SEFAZ's signal that the
caller is misbehaving — looping the same request, or repeatedly sending
schema-invalid payloads, or otherwise generating noise. Continued 656s
escalate to **throttling**, then to a **CNPJ / certificate ban**. A banned
cert means the issuer cannot send NF-e at all until the ban is lifted (a
slow administrative process).

**Therefore: never let a schema-invalid request reach SEFAZ.** Validate
locally against the canonical XSD pack first. In this repo, that gate is
`packages/integrations/nfe/src/xsd/` — `validateXsd(rootKey, xml)` runs
`xmllint-wasm` (the same `libxml2` engine SEFAZ uses) against the
vendored XSDs. Every SOAP operation in `src/soap/` calls it pre-POST and
on the inbound response; the gate is non-bypassable from public callers.

When you see 656 in a real response:

1. Stop immediately. Do not retry on the same condition.
2. Inspect logs for what was being looped or what schema mistake slipped
   past the local XSD gate (it shouldn't — if a 656 ever fires, that's a
   bug in our pre-send validation).
3. Wait before the next call — minutes at minimum, ideally back off
   exponentially. Document the incident.

`297`/`298` and similar are signature/cert problems — fix the certificate or
the signing, then resend with a fresh number is **not** needed (the NF-e was
never stored). Plain rejections (schema, business rules) → fix and resend with
the **same** number (the NF-e was discarded, not stored).

## cStats novos por NT (consolidado)

### NT 2025.001 (simplificação operacional, set/2025)

| cStat   | Mensagem                                                                                 | RV           |
| ------- | ---------------------------------------------------------------------------------------- | ------------ |
| 300     | Tipo da IE do Destinatário difere de Não Contribuinte no cadastro da UF                  | 5E17-12      |
| 391     | Não informados os dados do cartão de crédito / débito nas Formas de Pagamento            | YA04-10      |
| 392     | Não informados os dados da operação de pagamento por cartão                              | YA05-10      |
| 437     | CNPJ da instituição de pagamento inválido                                                | YA05-20      |
| 443     | Código da bandeira de cartão de crédito/débito inexistente                               | YA06-10      |
| **452** | **Solicitada resposta assíncrona para Lote com somente 1 (uma) NF-e**                    | **GAP03a-3** |
| 797     | Data de vencimento da parcela superior a 10 anos da data atual                           | Y09-50       |
| 853     | Dados de cobrança não devem ser informados para pagamento à vista                        | Y09-40       |
| 865     | Total dos pagamentos menor que o total da nota                                           | YA03-10      |
| 866     | Ausência de troco quando o valor dos pagamentos informados for maior que o total da nota | YA03-20      |
| 904     | Informado indevidamente campo valor de pagamento                                         | YA03-30      |

NFC-e específicos da mesma NT (não relevantes para este skill NF-e-only):
407, 444, 445, 474, 583 — todos ligados ao QR Code v3.

### NT 2025.002 (Reforma Tributária, v1.40 mai/2026)

cStats novos têm 4 dígitos. Os mais "afiados" (rejeição instantânea quando
RTC entra em vigor — 03/08/2026 para CRT=3):

| cStat              | Mensagem                                                           | RV                |
| ------------------ | ------------------------------------------------------------------ | ----------------- |
| **1115**           | **IBS/CBS não informado** (item sem Grupo UB12 quando obrigatório) | UB12-10           |
| 1020               | CST do IBS/CBS informado inexistente                               | UB13-10           |
| 1021               | Grupo IBS/CBS informado indevidamente (CST não permite)            | UB13-20           |
| 1022               | Grupo IBS/CBS não informado (CST exige)                            | UB13-30           |
| 1023               | Classificação Tributária do IBS/CBS inexistente                    | UB14-10           |
| 1024               | cClassTrib incompatível com CST                                    | UB14-20           |
| 1026               | Alíquota do IBS UF inválida para o ano                             | UB18-10           |
| 1037               | Alíquota CBS inválida (0,9% em 2025-2026)                          | UB56-10           |
| 1104               | Valor da BC do IBS/CBS difere do somatório                         | UB16-10           |
| 1115               | IBS/CBS não informado                                              | UB12-10           |
| 1118 / 1119        | Total IBSCBSTot informado indevidamente / não informado            | W34-10 / W34-20   |
| 1145               | NF-e de Crédito tipo 2 (ZFM) só permitida a partir de 2029         | B25.2-30          |
| 1153–1157          | Erros em dPrevEntrega (data prevista de entrega)                   | B10a-10 a B10a-50 |
| 1200 / 1201 / 1202 | cClassTrib incompatível com tpNFDebito / tpNFCredito / nota        | UB14-70/80/60     |

Lista completa em `rtc-ibs-cbs-is.md` e nos PDFs originais sob
`references/sources/nt/2025/NT_2025.002_v1.40_*.pdf`.

## Resend rule of thumb

- **Rejected** (not 100/150, not duplicidade, not denegada) → NF-e was _not_
  stored → fix and resend, **same número/série**.
- **Duplicidade** → NF-e _may be_ stored → `consSitNFe`, never blind-resend.
- **Authorized but response lost** → `consSitNFe` recovers the protocol.
- **Normal-emission NF-e pendente de retorno** that you give up on → it needs a
  **new número** if reissued (contingency rules differ — see `contingencia.md`).

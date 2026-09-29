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

| cStat | Meaning | Action |
|---|---|---|
| 100 | Autorizado o uso da NF-e | Authorized — assemble procNFe |
| 150 | Autorizado, autorização fora de prazo | Authorized (treat as 100). Janela mudou para >7 dias (NT 2025.001); ≤7 dias retorna 100 |
| 103 | Lote recebido com sucesso | Async accepted — store `nRec`, poll |
| 104 | Lote processado | Read the `protNFe` array (sync mode → inline; async → after polling) |
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
| **452** | **Rejeição: Solicitada resposta assíncrona para Lote com somente 1 (uma) NF-e** (NT 2025.001 RV GAP03a-3, produção 13/10/2025) |
| 656 | Consumo Indevido — **ban path, see below** |

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

## Faixa 178–186 — cadastro LCC-RFB (NT 2026.007)

⚠️ **Estes códigos não aparecem em NENHUMA tabela pública de cStat.** As três
cópias independentes (`nfephp-org/sped-nfe` `docs/cStat.md` e `storage/cstat.json`,
`mazinsw/nfe-api`) saltam de 152 direto para 200, e o MOC 7.0 Anexo I vendorado
em `sources/moc7/` também não os traz — são posteriores a essa linha de base. É
por isso que um `181` chega parecendo código inválido ou de middleware. A fonte é
a NT, vendorada em `sources/nt/2026/NT_2026.007_v1.00_EmissaoSemIE_RV_LCC.pdf`.

A **LCC-RFB** (Lista Centralizada de Contribuintes da RFB) é uma réplica nacional
do cadastro CNPJ da Receita Federal sincronizada com cada SEFAZ autorizadora. A
NT 2026.007 §5.10 ("Banco de Dados: Validação Cadastro LCC-RFB") passou a exigir
que **todo CNPJ citado no documento exista na lista e esteja `02-Ativa`**. Todas
as regras abaixo são `Obrig.` e valem "para todas as SEFAZ Autorizadoras".

**Cronograma: implantação teste 01/09/2026 · implantação produção 03/11/2026.**

| RV | cStat | Rejeição |
|---|---|---|
| 12C02-10 | **178** | CNPJ `[XX.XXX.XXX/XXXX-DV]` do emitente não cadastrado na Receita Federal |
| 12C02-20 | 179 | CNPJ `[…]` do emitente com situação irregular na Receita Federal |
| 12C21-20 | 180 | Código Regime Tributário do emitente diverge do cadastro na Receita Federal |
| **12E02-10** | **181** | **CNPJ `[…]` do destinatário não cadastrado na Receita Federal** |
| 12E02-20 | 182 | CNPJ `[…]` do Destinatário com situação irregular na Receita Federal |
| 12F02-10 | 183 | CNPJ `[…]` do Local de Retirada não cadastrado na Receita Federal |
| 12F02-20 | 184 | CNPJ `[…]` do Local de Retirada com situação irregular na Receita Federal |
| 12G02-10 | 185 | CNPJ `[…]` do Local de Entrega não cadastrado na Receita Federal |
| 12G02-20 | 186 | CNPJ `[…]` do Local de Entrega com situação irregular na Receita Federal |
| 1P10-30 / 1P10-32 | — | Autor de Evento — não cadastrado / situação irregular na Receita Federal |

Cada regra lê *"Acessar LCC-RFB (Chave: UF do X, CNPJ do X. **Desconsiderar
LCC.cSitCNPJ = 99 - Exclusão Lógica**)"*, e as variantes `-20` disparam quando
`cSitCNPJ ≠ 02-Ativa`. A mesma NT **removeu a RV 5E17-70** ("CNPJ Destinatário
não cadastrado") em favor destas.

⚠️ **Campos cobertos: emit `C02`, dest `E02`, retirada `F02`, entrega `G02` e o
autor do evento — e MAIS NENHUM.** `transporta`, o CNPJ da instituição de
pagamento (`card/CNPJ`) e `infIntermed/CNPJ` **não** passam pela LCC-RFB, então
um CNPJ de teste nessas posições continua válido. Não saia trocando os quatro.

⚠️ **A RV só dispara "se informado CNPJ" — um destinatário PESSOA FÍSICA (tag
`E03`, CPF) está fora do escopo de 181/182.** Isso é o que explica dois
comportamentos que parecem contraditórios em CI: os suites que usam
`buildHomologacaoFixture` (destinatário PJ) são rejeitados, enquanto
`orchestrator.homologacao` e `epec.homologacao`, que montam um destinatário PF,
continuam autorizando.

### Recuperação

Rejeição cadastral **não é retentável com o mesmo dado** — a NF-e não é
armazenada, e reenviar o mesmo CNPJ só repete o código. Corrija o participante e
reenvie com o **mesmo número/série**. `classifyCStat` (`src/state/index.ts`) cai
no bucket padrão `'rejeitada'` → `ESTADO_NFE.rejeitada`, que é o tratamento
correto; não crie ramo próprio.

⚠️ **Em homologação isso colide com a rejeição 597** ("NF-e emitida em ambiente
de homologação com CNPJ do destinatário diferente de 99999999000191"): 597 exige
um CNPJ que a LCC-RFB rejeita, porque `99999999000191` é um placeholder que não
consta no cadastro da Receita.

⚠️ **Nem os CNPJs de teste OFICIAIS resolvem**, e isso foi MEDIDO: a SEFAZ
publica uma tabela "CNPJs alfa cadastrados no CCC de homologação" (material da
NT 2026.004), e emitir para `PC3D315K000193` voltou 181 igual
([run 35605049930](https://github.com/Hinten/next_erp/actions/runs/35605049930),
2026-09-21). O **CCC** é o cadastro dos estados; a RV consulta a **LCC-RFB**,
a réplica federal — uma linha num não implica linha no outro. **Não gaste quota
tentando outro CNPJ.** A única saída conhecida é um destinatário **CPF** (tag
`E03`), fora do escopo da regra. Detalhes em `homologacao.md`.

## cStats novos por NT (consolidado)

### NT 2025.001 (simplificação operacional, set/2025)

| cStat | Mensagem | RV |
|---|---|---|
| 300 | Tipo da IE do Destinatário difere de Não Contribuinte no cadastro da UF | 5E17-12 |
| 391 | Não informados os dados do cartão de crédito / débito nas Formas de Pagamento | YA04-10 |
| 392 | Não informados os dados da operação de pagamento por cartão | YA05-10 |
| 437 | CNPJ da instituição de pagamento inválido | YA05-20 |
| 443 | Código da bandeira de cartão de crédito/débito inexistente | YA06-10 |
| **452** | **Solicitada resposta assíncrona para Lote com somente 1 (uma) NF-e** | **GAP03a-3** |
| 797 | Data de vencimento da parcela superior a 10 anos da data atual | Y09-50 |
| 853 | Dados de cobrança não devem ser informados para pagamento à vista | Y09-40 |
| 865 | Total dos pagamentos menor que o total da nota | YA03-10 |
| 866 | Ausência de troco quando o valor dos pagamentos informados for maior que o total da nota | YA03-20 |
| 904 | Informado indevidamente campo valor de pagamento | YA03-30 |

NFC-e específicos da mesma NT (não relevantes para este skill NF-e-only):
407, 444, 445, 474, 583 — todos ligados ao QR Code v3.

**RVs alteradas (cStat pré-existente).** A NT também reescreveu RVs de códigos
que já existiam no MOC 7.0 — o código não muda, o que muda é quando ele
dispara:

| cStat | Mensagem | RV |
|---|---|---|
| 805 | A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição Estadual | `E16a-30` (Obrig., `idDest` 1 ou 2, 17 UFs) e `E16a-35` (Facult., `idDest=1`) |

No MOC 7.0 a `E16a-30` era só interestadual, com outra lista de UFs. Histórico,
exceções, a armadilha da 696 e onde o app orienta o operador: seção "`indIEDest`
mais rigoroso" em `sincrono-vs-assincrono.md`.

### NT 2025.002 (Reforma Tributária, v1.40 mai/2026)

cStats novos têm 4 dígitos. Os mais "afiados" (rejeição instantânea quando
RTC entra em vigor — 03/08/2026 para CRT=3):

| cStat | Mensagem | RV |
|---|---|---|
| **1115** | **IBS/CBS não informado** (item sem Grupo UB12 quando obrigatório) | UB12-10 |
| 1020 | CST do IBS/CBS informado inexistente | UB13-10 |
| 1021 | Grupo IBS/CBS informado indevidamente (CST não permite) | UB13-20 |
| 1022 | Grupo IBS/CBS não informado (CST exige) | UB13-30 |
| 1023 | Classificação Tributária do IBS/CBS inexistente | UB14-10 |
| 1024 | cClassTrib incompatível com CST | UB14-20 |
| 1026 | Alíquota do IBS UF inválida para o ano | UB18-10 |
| 1037 | Alíquota CBS inválida (0,9% em 2025-2026) | UB56-10 |
| 1104 | Valor da BC do IBS/CBS difere do somatório | UB16-10 |
| 1115 | IBS/CBS não informado | UB12-10 |
| 1118 / 1119 | Total IBSCBSTot informado indevidamente / não informado | W34-10 / W34-20 |
| 1145 | NF-e de Crédito tipo 2 (ZFM) só permitida a partir de 2029 | B25.2-30 |
| 1153–1157 | Erros em dPrevEntrega (data prevista de entrega) | B10a-10 a B10a-50 |
| 1200 / 1201 / 1202 | cClassTrib incompatível com tpNFDebito / tpNFCredito / nota | UB14-70/80/60 |

Lista completa em `rtc-ibs-cbs-is.md` e nos PDFs originais sob
`references/sources/nt/2025/NT_2025.002_v1.40_*.pdf`.

## Resend rule of thumb

- **Rejected** (not 100/150, not duplicidade, not denegada) → NF-e was *not*
  stored → fix and resend, **same número/série**.
- **Duplicidade** → NF-e *may be* stored → `consSitNFe`, never blind-resend.
- **Authorized but response lost** → `consSitNFe` recovers the protocol.
- **Normal-emission NF-e pendente de retorno** that you give up on → it needs a
  **new número** if reissued (contingency rules differ — see `contingencia.md`).

# Events: cancelamento, carta de correção, inutilização

## RecepcaoEvento (events)

All NF-e events go through the `RecepcaoEvento4` web service. The request is an
`<envEvento>` lote of `<evento>` elements; each `<evento>` has an `<infEvento>`
that is **signed individually** (see `assinatura.md`).

`infEvento.Id` = `ID` + `tpEvento` (6) + `chNFe` (44) + `nSeqEvento` (2).

| tpEvento | Event |
|---|---|
| 110110 | Carta de Correção (CC-e) |
| 110111 | Cancelamento |
| 110112 | Cancelamento por substituição (NFC-e) |
| 110140 | EPEC |
| 210200 | Confirmação da Operação (manifestação destinatário) |
| 210210 | Ciência da Operação |
| 210220 | Desconhecimento da Operação |
| 210240 | Operação não Realizada |

Response: `retEnvEvento` → `retEvento` → `infEvento` with `cStat`:
- `135` — evento registrado e vinculado à NF-e (success).
- `136` — evento registrado mas **não** vinculado à NF-e.
- `155` — cancelamento homologado fora de prazo.
- otherwise — rejected.

The authorized event document is `procEventoNFe` (the signed evento +
`retEvento`).

## Cancelamento (tpEvento=110111)

- Requires the NF-e to be **authorized** (`cStat=100`).
- `detEvento` carries `nProt` (the authorization protocol) and `xJust`
  (justification, **15–255 chars**).
- Legal deadline: within **24 h** of authorization (after that some UFs still
  accept it as `155`, fora de prazo). Past the UF limit → rejected.
- A cancelled NF-e cannot be reused; its número is consumed.

## Carta de Correção — CC-e (tpEvento=110110)

- `detEvento` carries `xCorrecao` (the correction text) and `xCondUso` (fixed
  legal text).
- `nSeqEvento` increments per correction (1, 2, 3, …); the latest supersedes.
- SEFAZ keeps `(chNFe, tpEvento, nSeqEvento)` unique — a resend at a sequence it
  already holds is **573** (MOC 3P15-10), whatever the text. To learn WHAT it
  registered there, read the event back from a consSit:
  `extrairEventosNFe(retConsSitXml, TP_EVENTO_CCE)` over
  `consultarSituacaoNFeComXml` gives each event's `nSeqEvento`, `xCorrecao`,
  `nProt`, `dhRegEvento` and its signed `procEventoNFe` (standalone, verifiable),
  which `parseCceRetorno` / the DANFE-CC-e accept in place of a `retEnvEvento`.
- A CC-e **cannot** correct: values/tax variables (base, alíquota, quantities),
  data that changes issuer or recipient, or the emission/exit date. Those
  require cancelamento + reissue.

## Inutilização (NfeInutilizacao4)

Used to "burn" a range of NF-e numbers that will never be used (e.g. a gap left
by NF-e pendentes de retorno that were never authorized).

- Request `<inutNFe>` → `<infInut>` (signed). `infInut.Id` =
  `ID` + cUF(2) + ano(2) + CNPJ(14) + mod(2) + serie(3) + nNFIni(9) + nNFFin(9).
- Fields: `tpAmb`, `xServ=INUTILIZAR`, `cUF`, `ano`, `CNPJ`, `mod`, `serie`,
  `nNFIni`, `nNFFin`, `xJust` (15–255).
- Synchronous. Response `retInutNFe` → `infInut`; `cStat=102` "Inutilização de
  número homologado" → success, with `nProt`.
- Inutilização is **not** for numbers that were actually authorized — for those
  use cancelamento.

## Phase mapping

The vertical slice (Phase A) implements **autorização only**. Cancelamento and
inutilização are Phase B; CC-e is Phase C. This file is the reference for those
later phases — and for the recovery loop, which must *inutilizar* truly-unused
numbers it finds while reconciling pendentes de retorno. ⛔ Except in AC, BA and
SP from 01/11/2026 (Ajuste SINIEF nº 40/2026): there a truly-unused número is
left as a gap, with nothing to send. The Ajuste is a waiver; no other event
replaces the pedido. Precedent: when CT-e lost inutilização (Ajuste SINIEF
31/2022), SEFAZ-SP answered that a gap needs no additional procedure as long
as the documents before and after it keep the sequence (RC 28386/2023,
RC 28214/2023). An AUTHORIZED NF-e still needs cancelamento. One pure rule decides it —
`inutilizacaoSeAplica(uf, instanteMs)` in `@delfrance/schemas` — and both
`apps/nfe`'s `inutilizarNumeracao` (refuses before any SEFAZ call, HTTP 422
`INUTILIZACAO_NAO_SE_APLICA`) and the `apps/web` inutilização screen read it.
No code path inutilizes automatically today; the only caller is the operator's
`POST /api/nfe/inutilizar`.

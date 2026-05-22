---
name: nfe
description: >-
  Domain reference for Brazilian NF-e (Nota Fiscal Eletrônica, model 55, layout
  4.00), distilled from SEFAZ MOC 7.0 (Visão Geral + Anexo I Leiaute + Anexo III
  Contingência). Use when implementing, debugging, or reviewing NF-e generation,
  XML digital signing, SEFAZ SOAP transmission, response processing, the NF-e
  state machine, contingency, cancelamento / inutilização / carta de correção,
  the chave de acesso, or DANFE. Triggers on work in `apps/nfe` or
  `packages/integrations/nfe`, and on terms like infNFe, enviNFe, retEnviNFe,
  consReciNFe, consSitNFe, SEFAZ, cStat, nRec, duplicidade, protNFe, procNFe,
  tpEmis, certificado A1, ICP-Brasil.
---

# NF-e — Nota Fiscal Eletrônica (model 55, layout 4.00)

The NF-e is a digitally-signed XML fiscal document. It is only valid once SEFAZ
(the state tax authority) grants an **Autorização de Uso**. This skill distills
the SEFAZ **MOC 7.0** (Manual de Orientação ao Contribuinte) so NF-e code can be
written without re-reading hundreds of PDF pages.

Source manuals (MOC 7.0, Nov/2020) live on the SEFAZ portal:
`https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=ndIjl+iEFdE=`

## The lifecycle (happy path)

```
1. GENERATE   build infNFe XML from order data; compute the 44-digit chave
2. SIGN       enveloped XMLDSig over <infNFe> with the A1 certificate
3. SEND       SOAP to NfeAutorizacao — enviNFe lote (1–50 NF-e)
4. POLL       async: consReciNFe by nRec until cStat=104 (sync: protNFe inline)
5. PROCESS    read protNFe; cStat=100 → authorized; assemble procNFe
6. STATE      persist estado + protocolo; on rejection, fix and resend
```

## Critical facts (do not get these wrong)

- **Layout version `4.00`**; namespace `http://www.portalfiscal.inf.br/nfe`,
  declared once on the root, **no prefixes**, UTF-8, single `<?xml?>`.
- **Sign `<infNFe>`**, not `<NFe>`: enveloped XMLDSig, C14N + RSA-SHA1 + SHA-1.
  The `<Signature>` is a sibling placed **after** `<infNFe>` inside `<NFe>`.
- **The chave de acesso is computable before sending** — it is the anti-loss
  anchor. Persist the NF-e with its chave and a "sending" state *before* the
  SOAP call so a lost response is always recoverable.
- **SEFAZ loses NF-e** on communication failures and frequently returns
  **duplicidade** rejections (204 / 539 / 218 / 205 / 635). These are not
  fatal — they mean "consult the NF-e you already sent". Recovery is mandatory,
  not optional. See `references/cstat-rejeicoes.md`.
- **Never loop** resending the same rejected request — SEFAZ rejects abusive
  callers with `656 — Consumo Indevido`.
- Homologação requires `tpAmb=2` and a mandatory fake recipient name. See
  `references/homologacao.md`.

## Reference files

| File | Use for |
|---|---|
| `references/chave-acesso.md` | 44-digit key composition + módulo-11 DV |
| `references/assinatura.md` | XMLDSig signing rules, certificate, A1/A3 |
| `references/webservices.md` | SOAP services, sync/async lote flow, leiautes |
| `references/cstat-rejeicoes.md` | cStat codes, duplicidade & recovery rules |
| `references/contingencia.md` | tpEmis modes, EPEC, SVC, pendentes de retorno |
| `references/eventos.md` | cancelamento, carta de correção, inutilização |
| `references/homologacao.md` | homologação (tpAmb=2) testing rules |
| `references/leiaute.md` | infNFe field groups + XML formatting rules |
| `references/codegen.md` | re-running the XSD → TypeScript generator |

When implementing, read the specific reference for the layer you are building.
Keep these files current with the SEFAZ update-watch routine (a new NT can
change codes, schemas, or rules).

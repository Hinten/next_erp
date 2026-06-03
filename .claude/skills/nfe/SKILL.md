---
name: nfe
description: >-
  Domain reference for Brazilian NF-e (Nota Fiscal Eletrônica, model 55, layout
  4.00) on **MOC 7.0** as amended by Notas Técnicas through **NT 2025.001**
  (sync mode when lote=1) and **NT 2025.002** (Reforma Tributária — IBS/CBS/IS,
  mandatory in produção since 03/08/2026). Use when implementing, debugging or
  reviewing NF-e generation, XML digital signing, SEFAZ SOAP transmission,
  síncrono vs assíncrono response handling, the NF-e state machine,
  contingency, cancelamento / inutilização / carta de correção, the chave de
  acesso, the new RTC tax groups (IBS, CBS, IS), or DANFE. Triggers on work
  in `apps/nfe` or `packages/integrations/nfe`, and on terms like infNFe,
  enviNFe, retEnviNFe, consReciNFe, consSitNFe, indSinc, SEFAZ, cStat, nRec,
  duplicidade, protNFe, procNFe, tpEmis, certificado A1, ICP-Brasil, IBS, CBS,
  IS, RTC, Reforma Tributária, gIBSCBS, cClassTrib, NT 2025.001, NT 2025.002.
---

# NF-e — Nota Fiscal Eletrônica (modelo 55, layout 4.00)

The NF-e is a digitally-signed XML fiscal document. It is only valid once SEFAZ
(the state tax authority) grants an **Autorização de Uso**. This skill distills
the SEFAZ **MOC 7.0** baseline and the Notas Técnicas that amended it through
**NT 2025.001** (sync mode) and **NT 2025.002 v1.40** (Reforma Tributária),
so NF-e code can be written without re-reading thousands of PDF pages.

Original SEFAZ PDFs are committed under `references/sources/` for provenance
(the agent sandbox blocks `*.fazenda.gov.br`; in-tree copies are the only
re-readable source).

## The lifecycle (happy path)

```
1. GENERATE   build infNFe XML from order data; compute the 44-digit chave
2. SIGN       enveloped XMLDSig over <infNFe> with the A1 certificate
3. SEND       SOAP to NfeAutorizacao — enviNFe lote (1–50 NF-e)
                 lote = 1  → indSinc=1 (mandatory since 03/11/2025; NT 2025.001)
                 lote ≥ 2  → indSinc=0 (async, returns nRec)
4. PARSE      sync: <protNFe> inline. async: <infRec>/nRec, then poll
              consReciNFe by nRec until cStat=104
5. PROCESS    read protNFe; cStat=100 → authorized; assemble procNFe
6. STATE      persist estado + protocolo; on rejection, fix and resend
```

## Critical facts (do not get these wrong)

- **Layout `4.00`**; namespace `http://www.portalfiscal.inf.br/nfe`, declared
  once on the root, **no prefixes**, UTF-8, single `<?xml?>`.
- **Build request XML with the generated serializer — never hand-concatenate
  element strings.** `serialize` / `serializeFragment`
  (`packages/integrations/nfe/src/xml/index.ts`) walk the codegen `META`
  (derived from the XSDs) to emit every element in exact `xs:sequence` order
  with correct escaping; the generator, eventos and inutilização all build
  this way. The **only** sanctioned hand-assembly is (a) the thin
  namespace/`versao` wrapper, and (b) wrapping/extracting an **already-signed**
  payload (`buildEnvEvento`, `buildProcEventoNFe`, `autorizarLote`) — there
  re-serialization would break the XMLDSig digest. Opaque `xs:any` content
  (e.g. `detEvento`) is a `#raw` slot fed a pre-built, itself-serialized
  fragment (built from the tpEvento-specific schema, e.g. `e110111`), not a
  raw template string. See `references/codegen.md`.
- **Sign `<infNFe>`**, not `<NFe>`: enveloped XMLDSig, C14N + RSA-SHA1 + SHA-1.
  The `<Signature>` is a sibling placed **after** `<infNFe>` inside `<NFe>`.
- **The chave de acesso is computable before sending** — it is the anti-loss
  anchor. Persist `{chave, estado:'enviando'}` *before* the SOAP call so a
  lost response is always recoverable via `consSitNFe`.
- **Lote de 1 NF-e exige `indSinc=1`** (NT 2025.001, RV GAP03a-3). Enviar
  `indSinc=0` com lote de 1 retorna **cStat=452** — rejeição. Cliente precisa
  parsear ambos os envelopes de resposta (sync com `protNFe` inline vs async
  com `infRec/nRec`). See `references/sincrono-vs-assincrono.md`.
- **`cStat` agora é 3-4 dígitos** (NT 2025.002 §5.1). Os códigos novos da
  RTC ocupam a faixa de 4 dígitos. Regex de parsing precisa aceitar ambos
  os tamanhos. `nProt` foi para 15 ou 17 dígitos (NFC-e em algumas UFs).
- **RTC (IBS/CBS/IS) é obrigatório em produção desde 03/08/2026** para
  CRT=3 (Regime Normal). Sem `Grupo UB` no item nem `Grupo W03` no total
  → cStat 1115. Vide `references/rtc-ibs-cbs-is.md` para a estrutura
  completa e o cronograma para outros CRTs.
- **SEFAZ perde NF-e** em falhas de comunicação e frequentemente retorna
  **duplicidade** (204 / 539 / 218 / 205 / 635). Não são fatais — significam
  "consulte a NF-e que você já mandou". Recovery é obrigatório, não opcional.
  Vide `references/cstat-rejeicoes.md`.
- **Nunca looping** de reenvios — SEFAZ rejeita clientes abusivos com
  **cStat=656 (Consumo Indevido)** e escala para throttling/ban de
  certificado.
- **Atraso na emissão**: NF-e dentro de 7 dias → cStat=100; entre 7-30 dias →
  cStat=150 (autorizado fora de prazo); mais de 30 dias → só aceito em
  contingência (`tpEmis=2,4,5`). NT 2025.001 reduziu de 30 para 7 dias.
- Homologação requer `tpAmb=2` e nome fictício obrigatório do destinatário.
  Vide `references/homologacao.md`.

## Reference files

| File | Use for |
|---|---|
| `references/chave-acesso.md` | 44-digit key composition + módulo-11 DV |
| `references/assinatura.md` | XMLDSig signing rules, certificate, A1/A3 |
| `references/webservices.md` | SOAP services, sync/async lote flow, leiautes |
| `references/sincrono-vs-assincrono.md` | NT 2025.001 sync-when-lote-1 in depth |
| `references/cstat-rejeicoes.md` | cStat codes, duplicidade & recovery rules |
| `references/contingencia.md` | tpEmis modes, EPEC, SVC, pendentes de retorno |
| `references/eventos.md` | cancelamento, carta de correção, inutilização |
| `references/rtc-ibs-cbs-is.md` | RTC: Grupo UB, W03, cClassTrib, novos eventos |
| `references/homologacao.md` | homologação (tpAmb=2) testing rules |
| `references/leiaute.md` | infNFe field groups + XML formatting rules |
| `references/codegen.md` | re-running the XSD → TypeScript generator |
| `references/notas-tecnicas-historico.md` | NT changelog since MOC 7.0 |
| `references/gargalos-e-problemas.md` | production failure modes & pitfalls |
| `references/sources/` | original SEFAZ PDFs (MOC 7.0 + NTs vigentes) |

When implementing, read the specific reference for the layer you are building.
Keep these files current with the SEFAZ update-watch routine — when a new NT
ships, add its PDF under `references/sources/nt/<year>/` and update the
relevant `.md` references plus `notas-tecnicas-historico.md`.

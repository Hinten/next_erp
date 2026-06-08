# Notas Técnicas — chronological NT changelog (NF-e modelo 55)

This is the index of every NT relevant to NF-e modelo 55 layout 4.00 still in
effect, with one-line summary, production date and which skill files each
amends. Use it to triage: "is NT XXXX.YYY relevant to the change I'm
making?"

Source PDFs live under `references/sources/nt/<year>/`. **In-tree, not
downloaded at runtime** (sandbox blocks `*.fazenda.gov.br`).

Coverage: NT 2011 onwards. Pre-2011 NTs (layout 1.x/2.x) were pruned —
the MOC 7.0 baseline already subsumes them and the layouts they amended
are obsolete.

Where a row says "details: PDF", read the original NT from
`references/sources/nt/<year>/`; the one-liner here is a triage hint, not a
substitute.

## 2026 (in progress)

| NT | Production | Topic | Skill impact |
|---|---|---|---|
| `2026.004 v1.00` | — | Altera schema NFC-e/NF-e — **CNPJ Alfanumérico** | Schema regen needed (codegen.md). Affects chave structure if alfanumérico estende-se a NF-e. |
| `2026.003 v1.00` | — | DANFE Simplificado Tipo 2 | Out of scope — **NFC-e** (model 65) layout. Our model-55 DANFE render is in scope (`references/danfe.md`); this Tipo 2 simplificado is not. |
| `2026.002 v1.00` | — | (details: PDF) | tbd — see PDF |
| `2026.001 v1.00` | — | PAA — Pagamento Antecipado de Adquirente | New flow related to RTC; cross-reference with `rtc-ibs-cbs-is.md` (gPagAntecipado Grupo BC). |

> **CNPJ Alfanumérico**: a separate companion document
> `DFe NTCJ 2025.001 CNPJ Alfa v1.00` (under `nt/2025/`) introduces the
> alphanumeric CNPJ format. Production for CNPJ alfa starts mid-2026; the
> NFe schemas were updated by NT 2026.004. If the project uses CNPJ
> validation regex anywhere, audit for `[0-9]{14}` patterns that need to
> become `[0-9A-Z]{14}`.

## 2025 — the big year

| NT | Production | Topic | Skill impact |
|---|---|---|---|
| **`2025.002 v1.40`** | **03/08/2026 (CRT=3)** | **Reforma Tributária — IBS/CBS/IS** | **MAJOR.** Full new tax layer (Grupo UB item-level, Grupo W03 totals), new finalities (Crédito/Débito), cClassTrib, new events 112110-412130, cStat ampliado a 4 dígitos, nProt a 15/17. Dedicated reference: `rtc-ibs-cbs-is.md`. |
| **`2025.001 v1.03`** | **03/11/2025** | **Simplificação Operacional** | **MAJOR.** Síncrono mandatório para lote=1 (cStat 452); atraso na emissão reduzido de 30→7 dias; novas RVs em cobrança/pagamento; NFC-e QR Code v3. Dedicated reference: `sincrono-vs-assincrono.md`. cstat-rejeicoes.md atualizado. |

## 2024

| NT | Topic | Skill impact |
|---|---|---|
| `2024.003 v1.10` | Produtos AGRO NF-e (detalhamento de campos agro) | Item-level fields para produtos agropecuários — schemas/nfe.ts pode precisar de ajustes para emitentes do agronegócio. |
| `2024.002 v1.00` | eConf — confirmação eletrônica | Novo evento. Em homologação no momento da prune (mai/2026). Verificar status em produção antes de implementar. |
| `2024.001 v1.20` | Detalhes técnicos diversos (details: PDF) | Minor — consultar PDF. |

## 2023

| NT | Topic | Skill impact |
|---|---|---|
| `2023.005 v1.02` | Evento Insucesso na Entrega NF-e | Novo evento (código 110131 ou similar). Relevante para `eventos.md` se a aplicação suportar manifestação do transportador. |
| `2023.004 v1.20` | Campos e Regras — atualizações gerais | Detalhamentos no leiaute (consultar PDF). Provavelmente já refletidos no XSD vendorado. |
| `2023.001 v1.60` | Tributação monofásica dos combustíveis | Novo regime para combustíveis: CST-Mono, novos campos. Afeta itens com `cProdANP`. Cross-ref RTC: NT 2025.002 mantém vínculo com tributação monofásica (cClassTrib 620xxx). |

## 2022

| NT | Topic | Skill impact |
|---|---|---|
| `2022.005 v1.11` | DIFAL — diferencial de alíquota interestadual | Sub-campos de partilha ICMS em operações interestaduais. Reflete LC 190/22. |
| `2022.004 v1.10` | Regras de Validação ISSQN | Novas RVs para itens de serviço (Grupo U). |
| `2022.003 v1.11` | Referenciamento (consSitNFe) | Aprimoramento da consulta por chave; relevante para `recovery` flow. |
| `2022.002 v1.30a` | Equiparação Exportação e outras alterações | Operações equiparadas a exportação ganham campos específicos. |
| `2022.001 v1.00` | **WS Consulta GTIN** — novo serviço | Novo endpoint `NfeConsultaGTIN` — validação de GTIN contra o cadastro nacional. Wire em `webservices.md`/`src/operations/` se precisar antes do envio. |

## 2021

| NT | Topic | Skill impact |
|---|---|---|
| `2021.004 v1.35` | Novos Campos e Regras | Ajustes diversos (consultar PDF). |
| `2021.003 v1.40` | Validação GTIN Grupo IV | Item-level GTIN passou a ser validado em mais classificações. RVs específicas. |
| `2021.002 v1.12` | Nota Fiscal Fácil (NFF) | Modelo simplificado para emissão por MEI/pequeno produtor. Pode ou não estar em escopo. |
| `2021.001 v1.01` | Evento Comprovante de Entrega NF-e | Novo evento. Relevante para `eventos.md` em apps que precisem registrar entrega. |

## 2020 (post-MOC 7.0)

| NT | Topic | Skill impact |
|---|---|---|
| `2020.007 v1.40` | Evento Ator do NF-e Transportador | Permite o transportador atualizar/manifestar sobre uma NF-e. |
| `2020.006 v1.31` | Intermediador e Marketplace (`indIntermed`, `infIntermed`) | Novo grupo YB no leiaute para operações via marketplace. Implementado no XSD MOC 7.0. |
| `2020.005 v1.21` | Regras de Validação — atualizações | Detalhamentos diversos. |
| `2020.003 v1.00` | NF-e de Energia Elétrica | Campos específicos para distribuidoras. |
| `2020.002 v1.01` | Específica para IPI | Detalhamentos no Grupo O (IPI). |
| `2020.001 v1.60` | Manifestação do Destinatário | Eventos 210200-210220. Já maduro; relevante para `eventos.md`. |

## 2019

| NT | Topic | Skill impact |
|---|---|---|
| `2019.001 v1.70` | Regras de Validação — pacote consolidado | Várias RVs reescritas. Mantido como provenance; conteúdo já está em MOC 7.0. |

## 2018

| NT | Topic | Skill impact |
|---|---|---|
| `2018.005 v1.52` | Alteração de leiaute NF-e / NFC-e (campos auxiliares) | **Importante para recovery**: introduziu cMsg/xMsg em retConsReciNFe (Sequência XML PR13–PR15). Vide `consultarLote` parsing. |
| `2018.002 v1.00` | (details: PDF) | Minor. |
| `2018.001 v1.10` | Emitente CPF | Possibilita emitente Pessoa Física (Produtor Rural CPF). RVs no Grupo C. |

## 2017

| NT | Topic | Skill impact |
|---|---|---|
| `2017.001 v1.50` | Ajustes diversos no leiaute | Detalhamentos no Grupo I/M/W. |

## 2016 (layout 4.00 baseline)

| NT | Topic | Skill impact |
|---|---|---|
| **`2016.002 v1.61`** | **Layout 4.00 — a NT-mãe deste leiaute** | Define o formato 4.00 que o skill todo trata. Referência histórica essencial. |
| `2016.001 v1.40` | Tabela de Unidades de Medida Tributáveis | Tabela de uTrib. Operacional. |

## 2015 (NFC-e infrastructure & qrCode foundations)

| NT | Topic | Skill impact |
|---|---|---|
| `2015.003 v1.94` | Ajustes NFC-e (out of scope NF-e-only mas mantém RVs compartilhadas) | RVs referenciadas pelo modelo 55 também. |
| `2015.002 v1.41` | Layout 4.00 — base original | Precursora de NT 2016.002. Mantida por provenance. |
| `2015.001 v1.30` | Ajustes pré-4.00 | Histórico. |

## 2014 (services & EPEC)

| NT | Topic | Skill impact |
|---|---|---|
| `2014.003 v1.02` | Ajustes diversos | Minor. |
| `2014.002 v1.30` | **WS NFeDistribuicaoDFe** | Define o serviço para baixar DF-e de interesse (compras feitas, NF-e contra o CNPJ). Crítico para fluxo de "manifestação do destinatário". |
| `2014.001 v1.30` | **Evento EPEC** | Evento Prévio de Emissão em Contingência. Define `tpEmis=4`. Vide `contingencia.md`. |

## 2013 (events & SVC foundations)

| NT | Topic | Skill impact |
|---|---|---|
| `2013.008 v1.00` | **Cancelamento de NF-e via Evento** (substitui o antigo NfeCancelamento) | Atual mecanismo de cancelamento (Evento 110111). Vide `eventos.md`. |
| `2013.007 v1.03` | **SVC — SEFAZ Virtual de Contingência** | Define a infraestrutura SVC-AN e SVC-RS, `tpEmis=6/7`. Vide `contingencia.md`. |
| `2013.006 v1.00` | Resolução 13 + FCI (Ficha Conteúdo de Importação) | Campos para apuração de conteúdo importado em operações interestaduais. |
| `2013.005 v1.22` | Ajustes no leiaute | Várias correções menores. |
| `2013.004 v1.00` | Resolução 13 — continuação | vBC e alíquota específicas. |
| `2013.003 v1.00a` | **Lei da Transparência** (`vTotTrib`) | Campo de tributos totais — informativo ao consumidor. Obrigatório em Z02. |
| `2013.002 v1.00b` | B2B (manifestação automática) | Histórico. |

## 2012 (only foundational kept)

| NT | Topic | Skill impact |
|---|---|---|
| `2012.005c` | Resolução SF 13 — alíquota 4% interestadual para bens importados | Mantido como provenance para cálculos de ICMS interestadual em produtos importados. |

## 2011 (only foundational kept)

| NT | Topic | Skill impact |
|---|---|---|
| `2011.006c` | **Evento Cancelamento — origem** | Primeira NT a definir Cancelamento como Evento. Foi consolidada pela NT 2013.008 mas a `tpEvento=110111` foi criada aqui. |

## Pre-2011

Layouts 1.x/2.x. Removidos do `sources/` durante a prune — superados pelo
layout 4.00 e pela MOC 7.0. Se algum dia precisar consultar uma NT 2007/2008/2009/2010,
ela está no portal SEFAZ:
`https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?tipoConteudo=04BIflQt1aY=`
(o sandbox bloqueia esse domínio — precisa baixar manualmente).

## Quando uma nova NT for publicada (workflow)

1. Baixar PDF para `references/sources/nt/<year>/` (manualmente — sandbox
   bloqueado).
2. Ler Resumo + Histórico de Alterações + Cronograma (geralmente as primeiras
   3-5 páginas).
3. Adicionar uma linha aqui com NT/data/tópico/impacto.
4. Se o impacto for grande (como NT 2025.001/002), criar reference dedicada
   em `references/<tema>.md` e atualizar `SKILL.md`.
5. Se o impacto for pequeno (correção de RV, novo CFOP), atualizar apenas
   `cstat-rejeicoes.md` ou o reference correspondente.
6. Commit no formato:
   `nfe skill: incorporate NT XXXX.YYY <topic>`

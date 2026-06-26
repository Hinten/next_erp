# Reforma Tributária do Consumo (RTC) — IBS / CBS / IS

Source of truth: **NT 2025.002 v1.40** (May/2026), `references/sources/nt/2025/`.
Legal basis: **Lei Complementar 214/2025** + **EC 132/2023**, regulated by
**Ajuste SINIEF 49/2025**. This NT supersedes RT NT 2024.002.

## What changed and when

Three new taxes enter the NF-e layout 4.00 at the item level and totals:

| Tributo | Federal? | Detalhes |
|---|---|---|
| **IBS** — Imposto sobre Bens e Serviços | State + municipal (split UF / Município) | Replaces ICMS + ISS (long transition) |
| **CBS** — Contribuição sobre Bens e Serviços | Federal | Replaces PIS + COFINS |
| **IS**  — Imposto Seletivo | Federal | "Sin tax" on health/environment-harmful goods |

### Cronograma (CRT=3 — Regime Normal)

| Phase | What |
|---|---|
| **Jul/2025** | Campos IBS/CBS facultativos em homologação; em produção **erro de schema se enviados**. |
| **Out/2025** | Facultativos em ambos; **sem valor jurídico**. |
| **01/01/2026** | **Valor jurídico** quando preenchidos. Ainda facultativos por RV. |
| **01/07/2026** | **Obrigatórios em homologação** (RV UB12-10 começa a rejeitar ausência). |
| **03/08/2026** | **Obrigatórios em produção** (RV UB12-10). Esta é a data-limite real. |
| **2027+** | Alíquotas reduzidas (pIBSUF/pIBSMun de 0,1% → 0,05% para 2027-2028); referência publicada para anos posteriores. |
| **04/01/2027** | Obrigatoriedade estende-se a CRT=1 (Simples), CRT=2 (Simples-Excesso), CRT=4 (MEI) e Tributação Monofásica de Combustíveis — quando NT futura publicar as regras. |

**Until 03/08/2026 the skill should default to NOT emitting RTC groups in
production** unless the implementing project has explicitly opted in. After
03/08/2026 (CRT=3) the groups become mandatory and an NF-e without them is
rejected by RV UB12-10 (`cStat=1115`).

## XML groups — item level (Grupo UB)

NT 2025.002 introduces a single new item-level wrapper, `Grupo UB`, that
sits parallel to `Grupo M` (ICMS) under `det/imposto`. Schema:
`DFeTiposBasicos_v1.00.xsd` (referenced from `nfe_v4.00.xsd` from 2026).

```
det/imposto/
├── ICMS         ← legacy, still required during transition
├── II           ← legacy
├── IPI          ← legacy
├── PIS / PISST  ← legacy (replaced by CBS, but still emitted in transition)
├── COFINS / COFINSST  ← legacy
├── ISSQN        ← legacy
└── IBSCBS       ← NEW (Grupo UB12)
    ├── CST                     UB13  3 dígitos
    ├── cClassTrib              UB14  6 dígitos (vide tabela)
    ├── gIBSCBS (1-1)           UB15  group de info IBS+CBS
    │   ├── vBC                 UB16  base de cálculo
    │   ├── gIBSUF (1-1)        UB17  group IBS da UF
    │   │   ├── pIBSUF          UB18  alíquota
    │   │   ├── gDif (0-1)      UB21  diferimento
    │   │   ├── gDevTrib (0-1)  UB24  devolução cashback
    │   │   ├── gRed (0-1)      UB26  redução de alíquota
    │   │   └── vIBSUF          UB35  valor
    │   ├── gIBSMun (1-1)       UB36  group IBS do Município
    │   │   ├── pIBSMun         UB37
    │   │   ├── gDif (0-1)      UB40
    │   │   ├── gDevTrib (0-1)  UB43
    │   │   ├── gRed (0-1)      UB45
    │   │   └── vIBSMun         UB54
    │   ├── vIBS                UB54a  soma vIBSUF + vIBSMun
    │   ├── gCBS (1-1)          UB55  group CBS
    │   │   ├── pCBS            UB56
    │   │   ├── gDif (0-1)      UB59
    │   │   ├── gDevTrib (0-1)  UB62
    │   │   ├── gRed (0-1)      UB64
    │   │   ├── gALCZFMCBS (0-1) UB66a  alíquota zero em ZFM/ALC
    │   │   └── vCBS            UB67
    │   ├── gTribRegular (0-1)  UB68  "tributação que seria sem suspensão"
    │   ├── gTribCompraGov (0-1) UB82a  compras governamentais
    │   ├── gIBSCBSMono (0-1)   UB84  monofásica combustíveis
    │   ├── gTransfCred (0-1)   UB106 transferência de crédito
    │   ├── gAjusteCompet (0-1) UB112 ajuste de competência
    │   ├── gEstornoCred (0-1)  UB116 estorno de crédito
    │   └── gCredPresOper (0-1) UB120 crédito presumido
    │       ├── vBCCredPres     UB121
    │       ├── cCredPres       UB122 (vide Anexo IV)
    │       ├── gIBSCredPres    UB123
    │       ├── gCBSCredPres    UB127
    │       └── gCredPresIBSZFM UB131 ZFM-específico
    └── IS (0-1)                UB01  Imposto Seletivo (futuro)
        ├── CSTIS               UB02
        ├── cClassTribIS        UB03
        ├── vBCIS               UB05
        ├── pIS                 UB06
        ├── pISEspec            UB07  alíquota por unidade
        ├── uTrib / qTrib       UB09/10  unidade tributável
        └── vIS                 UB11
```

## XML groups — total level (Grupo W03)

```
total/
├── ICMSTot      ← legacy, mantido na transição
├── ISSQNtot     ← legacy
└── (novos campos no nível total da NF-e)
    ├── ISTot (0-1)               W31   group total do IS
    │   └── vIS                   W33
    ├── IBSCBSTot (0-1)           W34   group total IBS+CBS
    │   ├── vBCIBSCBS             W35
    │   ├── gIBS                  W36
    │   │   ├── gIBSUF (W37)      vDif, vDevTrib, vIBSUF
    │   │   ├── gIBSMun (W42)     vDif, vDevTrib, vIBSMun
    │   │   ├── vIBS              W47
    │   │   ├── vCredPres         W48
    │   │   └── vCredPresCondSus  W49
    │   ├── gCBS (W50)            vDif, vDevTrib, vCBS, vCredPres, vCredPresCondSus
    │   ├── gMono (W57)           vIBSMono, vCBSMono, retenções, anteriores
    │   └── gEstornoCred (W59e)   vIBSEstCred, vCBSEstCred
└── vNFTot (W60)                  valor total da NF-e com IBS + CBS + IS
```

**Key principle**: IS, IBS, CBS são **"por fora"** (added on top, not
embedded). The total NF value (`vNF` em `ICMSTot`) **soma** vIBS + vCBS +
vIS (regra VB01-10).

## CST + cClassTrib model

The traditional `CST` (3 dígitos) classifies tax situation. **NT 2025.002
adds `cClassTrib` (6 dígitos)** — Código de Classificação Tributária — that
links the CST to **specific articles of LC 214/2025** and drives RV
behavior dynamically.

- CST tables (IBS/CBS, IS) live in the Portal Nacional NF-e, aba
  Documentos → Diversos. Not in this skill.
- cClassTrib table (Anexo III of the NT) also lives na aba Diversos.
- Dynamic indicators per cClassTrib row determine if each subgroup (`gDif`,
  `gRed`, `gTribRegular`, `gCredPresOper`, `gTransfCred`, `gIBSCBSMono`,
  etc.) is **vedado** (forbidden), **permitido** (optional), or
  **exigido** (required). Reading the table is mandatory before emitting
  the corresponding subgroup; sending a forbidden subgroup → rejection.

Common cClassTrib examples (from validation tables):
- `410030` — Estorno de crédito por perda (tpNFDebito=07)
- `800001` — Transferência de crédito do associado (cooperativa)
- `800002` — Fusão/cisão/incorporação
- `810001` — Crédito presumido IBS ZFM (tpNFCredito=02)
- `811001` — Anulação Crédito por Saída Imune/Isenta (tpNFDebito=02)
- `811002` — Débito de NF não processada na apuração (tpNFDebito=03)
- `811003` — Desenquadramento Simples Nacional (tpNFDebito=08)
- `620004` — Monofasia com pBio inferior ao obrigatório (finNFe=5)
- `620005` — Monofasia com pBio superior ao obrigatório

## Notas de Débito and Notas de Crédito (new finalities)

NT 2025.002 cria **finalidades** novas em `finNFe` (B25):

```
finNFe = 1 — NF-e normal
finNFe = 2 — NF-e complementar
finNFe = 3 — NF-e de ajuste
finNFe = 4 — Devolução de mercadoria
finNFe = 5 — Nota de crédito       ← NOVO
finNFe = 6 — Nota de débito        ← NOVO
```

Com sub-campos obrigatórios `tpNFDebito` (B25.1) ou `tpNFCredito` (B25.2),
conforme a finalidade.

**`tpNFDebito` valores:**
1. Transferência de créditos para Cooperativas
2. Anulação de Crédito por Saídas Imunes/Isentas
3. Débitos de notas fiscais não processadas na apuração
4. Multa e juros
5. Transferência de crédito na sucessão
6. Pagamento antecipado
7. Perda em estoque (Perecimento, Perda, Furto, Roubo)
8. Desenquadramento do SN

**`tpNFCredito` valores:**
1. Multa e Juros
2. Apropriação de crédito presumido de IBS sobre o saldo devedor na ZFM
   (art. 450, § 1º, LC 214/25)
3. Retorno por recusa total na entrega ou por não localização do destinatário
   na tentativa de entrega
4. Redução de valores
5. Transferência de crédito na sucessão
6. Retorno por recusa parcial na entrega

Cada `tpNFDebito`/`tpNFCredito` tem um cClassTrib obrigatório (validado em
UB14-70 e UB14-80). Em particular, **NF-e de Crédito tipo 2 (ZFM)** só pode
ser emitida a partir de **janeiro/2029** (RV B25.2-30).

## Grupo BB — Compras Governamentais

NT 2025.002 **renomeou Grupo BB** (era "antecipação de pagamento", que
migrou para o novo Grupo BC). Agora `BB01` = `gCompraGov`:

```
gCompraGov (0-1)            BB01
├── tpEnteGov               BB02   1=União, 2=Estado, 3=DF, 4=Município,
│                                  5=Consórcio Público, 6=Comitê Gestor IBS
├── pRedutor                BB03   percentual de redução (art. 472/370 LC 214/25)
├── tpOperGov               BB04   1=fornecimento c/ pagamento posterior
│                                  2=recebimento do pagamento c/ fornecimento já realizado
│                                  3=fornecimento c/ pagamento já realizado
│                                  4=recebimento do pagamento c/ fornecimento posterior
└── refDFeAnt (0-99)        BB05   chave de acesso do DFe anterior (44 dígitos)
                                   obrigatório para tpOperGov 2 e 4
```

## Grupo BC — Antecipação de Pagamento

Novo grupo, contém o que era o antigo BB:

```
gPagAntecipado (0-1)        BC01
└── refNFe (1-99)           BC02   chaves de NF-e (modelo 55) emitidas anteriormente
                                   para abater parcelas de antecipação
```

RV `11BC01-10`/`20`/`30`: validações que vinculam tpNFDebito=06 (Pagamento
antecipado) a referenciamento via gPagAntecipado.

## Outras inclusões no Grupo B (Identificação)

| Campo | ID | Descrição |
|---|---|---|
| `dPrevEntrega` | B10a | Data prevista de entrega/disponibilização. Obrigatório calcular para frete CIF (modFrete=0, 1) e finNFe=1 ou 4. Limites: até 3 meses após `dhSaiEnt`; nunca anterior. Atualizável via Evento 112150. |
| `cMunFGIBS` | B12a | Município de consumo (fato gerador IBS/CBS). Só preenchido quando `indPres=5` (operação presencial fora do estabelecimento) e nem endereço dest nem local de entrega informados. |
| `cIndOp` | B25d | Código indicador do local da operação. Obrigatório quando: `010104` = leilão judicial / licitação pública; `010105` = constatação de irregularidade por fiscalização. |

## Outras inclusões no Grupo C (Emitente)

| Campo | ID | Descrição |
|---|---|---|
| `ISUFEmit` | C22 | Inscrição SUFRAMA do emitente. Obrigatório quando operação se beneficia de alíquota zero CBS em ZFM/ALC (arts. 451 e 466 LC 214/25). 8-9 dígitos. Verificador DV validado em C22-20. |

## Eventos novos da RTC (todos para NF-e modelo 55)

| Código | Evento | Autor |
|---|---|---|
| `112110` | Informação de efetivo pagamento integral (libera crédito presumido) | Emitente |
| `112120` | Importação em ALC/ZFM não convertida em isenção | Emitente |
| `112130` | Perecimento/perda/roubo/furto em transporte CIF | Emitente |
| `112140` | Fornecimento não realizado com pagamento antecipado | Emitente |
| `112150` | Atualização da Data de Previsão de Entrega | Emitente |
| `211110` | Solicitação de Apropriação de crédito presumido | Emitente ou Destinatário |
| `211124` | Perecimento em transporte FOB (autor adquirente) | Destinatário |
| `211128` | Aceite de débito na apuração por emissão de nota de crédito | Destinatário |
| `211130` | Imobilização de Item (ativo imobilizado) | Destinatário |
| `211140` | Solicitação de Apropriação de Crédito de Combustível | Destinatário |
| `211150` | Solicitação de Apropriação de Crédito (depende da atividade do adquirente) | Destinatário |
| `212110` | Manifestação sobre Pedido de Transferência de Crédito de IBS em Sucessão | Sucessora |
| `212120` | Idem CBS | Sucessora |
| `412120` | Manifestação do Fisco sobre Pedido de Transferência IBS Sucessão | Fisco |
| `412130` | Idem CBS | Fisco |
| `110001` | **Cancelamento genérico de qualquer evento** acima | Mesmo autor do evento cancelado |

> **Lote de eventos**: o WS de eventos historicamente aceita até 20 eventos
> em uma requisição, mas a NT **orienta explicitamente** que para esses
> novos eventos da RTC sejam enviados **individualmente** (lote de 1)
> para evitar perda de controle em rejeições parciais. Sugere que **futuramente
> o uso de lote para eventos será eliminado**.

Evento **`211120` (Destinação para consumo pessoal) foi removido** —
revogado pela LC 227/2026.

## Resposta da SEFAZ — cStat agora tem 4 dígitos

NT 2025.002 §5.1 alterou o schema:

- **`cStat` aumentado de 3 → 4 dígitos** (tipo `3-4` no leiaute novo).
  A nova faixa numérica destina-se às rejeições exclusivas dos novos
  impostos. Códigos legados continuam com 3 dígitos.
- **`nProt` aumentado para 15 ou 17 dígitos** (NFC-e em algumas UFs
  estava perto do esgotamento da numeração).
- Schemas afetados: `retEnviNFe_v2.00.xsd`, `retConsReciNFe_v4.00.xsd`,
  `retInutNFe_v4.00.xsd`, `retEnvEvento_v1.00.xsd`.

**Implicação para o código**: parsers de cStat precisam aceitar 3 **ou** 4
dígitos. Validar com regex `^[0-9]{3,4}$`, não `^[0-9]{3}$`.

## Principais novas RVs (rejeições)

Categorização por área. Lista completa no PDF (~150 RVs novas).

### Identificação e finalidades

| RV | cStat | Quando rejeita |
|---|---|---|
| `B10a-10` | 1153 | NFC-e com dPrevEntrega informado |
| `B10a-20` | 1154 | dPrevEntrega > 3 meses após dhSaiEnt |
| `B10a-30` | 1155 | dPrevEntrega anterior a dhSaiEnt |
| `B10a-40` | 1156 | dPrevEntrega informado para finNFe ≠ 1 (normal) ou 4 (devolução) |
| `B25-30` a `B25-50` | 254/255/269 | NF-e referenciada ausente/duplicada/CNPJ divergente para finNFe=2/5/6 |
| `B25-80` | 1001 | Crédito/Débito com ICMS/ISSQN/PIS/COFINS informado (deveria só ter IBS/CBS) |
| `B25-100` | 1003 | NF-e de Crédito referenciando modelo ≠ 55 |
| `B25.2-30` | 1145 | NF-e de Crédito tipo 2 (ZFM) com ano emissão < 2029 |

### IBS/CBS — Item

| RV | cStat | Quando rejeita |
|---|---|---|
| `UB12-10` | 1115 | **IBS/CBS não informado** (obrigatório CRT=3 desde 03/08/2026; CRT=1/2/4 desde 04/01/2027). Exceções: NF-e devolução/complementar referenciando NF-e pré-2026; combustíveis na tabela monofásica. |
| `UB13-10` | 1020 | CST IBS/CBS inexistente |
| `UB13-20` | 1021 | gIBSCBS informado quando CST não permite |
| `UB13-30` | 1022 | gIBSCBS ausente quando CST exige |
| `UB14-10` | 1023 | cClassTrib inexistente |
| `UB14-20` | 1024 | cClassTrib incompatível com CST |
| `UB14-60` | 1202 | cClassTrib incompatível com tpNFDebito/Credito |
| `UB16-10` | 1104 | Base de cálculo IBS/CBS difere do somatório |
| `UB18-10` | 1026 | pIBSUF inválida para o ano (0,1% em 2025-2026, 0,05% em 2027-2028) |
| `UB35-10` | 1041 | vIBSUF difere do calculado |
| `UB56-10` | 1037 | pCBS inválida (0,9% em 2025-2026; alíquota efetiva após 2027) |
| `UB66a-10/20` | 1190/1191 | gALCZFMCBS sem ISUFEmit OU produto fora da lista permitida em ZFM |

### Total

| RV | cStat | Quando rejeita |
|---|---|---|
| `W07-10` | 564 | Total dos itens difere do somatório (incluindo IBS/CBS/IS via indTot=1) |
| `W34-10/20` | 1118/1119 | Total IBSCBSTot informado/ausente incorretamente |
| `W47-10` | 1085 | Total IBS difere da soma dos vIBS dos itens |
| `W56-10` | 1091 | Total CBS difere da soma dos vCBS |
| `W60-10` | 1094 | vNFTot difere da soma dos vItem |

## Notas para implementação

1. **`indTot` matters**. O total geral W07 considera apenas itens com
   `prod/indTot=1`. Pareça que muda nada, mas com IBS/CBS o cálculo do
   item agora inclui esses tributos no `vItem`.
2. **`pAliqEfet` é calculada**, não informada por mão. Fórmula em UB28-10:
   - Sem compra governamental: `pAliqEfet = pIBSUF × (1 - pRedAliq/100)`
   - Com compra gov: `pAliqEfet = pIBSUF × (1 - pRedAliq/100) × (1 - pRedutor/100)`
   - 4 casas decimais, arredondamento na última.
3. **Crédito presumido em condição suspensiva** (`vCredPresCondSus`) só
   pode ser usado a partir de **2033** (UB126-10 / UB130-10).
4. **Cashback** (`gDevTrib`): valor de devolução de tributo aplicável a
   energia elétrica, água, esgoto, gás natural — conforme arts. 117/118
   LC 214/25.
5. **Eventos não devem ser enviados em lote** para a RTC; a NT orienta
   explicitamente envio individual.
6. **Não somar vIBS/vCBS/vIS em 2025 e 2026** ao `vItem` para garantir
   compatibilidade durante a transição (Exceção 1 das RVs VB01-10/20).

## Schemas

| Arquivo | Propósito |
|---|---|
| `DFeTiposBasicos_v1.00.xsd` | Tipos básicos compartilhados (CST, cClassTrib, etc.) |
| `nfe_v4.00.xsd` | Layout da NF-e atualizado |
| `envEventoNFe_v9.99.xsd` | Wrapper genérico de envio de eventos |
| `e112110_v1.00.xsd` … `e412130_v1.00.xsd` | Schemas específicos por evento (um por código de evento listado acima) |
| `retEnviNFe_v2.00.xsd` | Retorno enviNFe com cStat de 4 dígitos e nProt de 15/17 |

Quando este projeto regenerar tipos TypeScript a partir dos XSDs (vide
`codegen.md`), incluir esses schemas — eles ainda não estão sob
`packages/integrations/nfe/generated/`.

## Anexos do NT 2025.002

- **Anexo I** — NCM do Imposto Seletivo (lista de NCMs sujeitos a IS).
  Tabela publicada separadamente no Portal Nacional NF-e.
- **Anexo II** — Tabela cClassTribIS (códigos de classificação do IS).
- **Anexo III** — Tabela cClassTrib (códigos de classificação do IBS/CBS).
  Publicada em `aba Documentos → Diversos` do Portal NF-e.
- **Anexo IV** — Tabela cCredPres (códigos de crédito presumido). Idem.

Estas tabelas **não são versionadas neste skill** — são dados operacionais
que mudam fora do ciclo de NT. Consultar o Portal antes de implementar
mapeamento.

## Implementation status in this repo (#313)

The RTC **infrastructure** is built for **Simples Nacional**, gated **off by
default** (PR #313). What exists:

- **Wire types already in codegen.** `generated/moc7.0/types/nfe-schema.ts`
  carries `TTribNFe` (item `IBSCBS`), `TCIBS`, `TIS`, `TIBSCBSMonoTot`
  (`IBSCBSTot`), and the `total` slots. The serializer is META-driven —
  **no XSD regen** was needed for the core layout.
- **Builders** in `packages/integrations/nfe/src/tribute/rtc.ts`:
  `buildIBSCBS` (item Grupo UB), `buildIS` (item IS), `computeRtcItemValues`
  (shared item↔total math), `parseRtcConfig` (strict build-time validation).
  Only the **"tributação integral"** shape is modelled (CST + cClassTrib +
  IBS-UF/Mun + CBS); diferimento / redução / monofásica / crédito presumido
  are follow-ups.
- **Input schema** `configuracaoIBSCBSSchema` in `tribute/schemas.ts`. On
  `impostoSchema` it is stored **leniently** (`z.unknown`) so a half-filled
  registration never breaks the resolver (which falls through on parse
  failure); the strict shape is enforced only at emit time by `parseRtcConfig`.
- **The 2025–2026 transition rule is honored**: `ICMSTot.vNF` is **never**
  changed; the RTC tributes ride "por fora" in `IBSCBSTot` / `ISTot` /
  `vNFTot` (RV VB01-10 Exceção 1).
- **Gate**: per-filial `nfeConfig.emitirReformaTributaria` (default `false`),
  toggled in the filial NF-e config screen, threaded as `{ emitRtc }` from the
  orchestrator into `buildImpostoXml` / `aggregateTotals`. Flag **off ⇒ emitted
  XML byte-identical to pre-RTC**.
- **Registration UI**: produto `ImpostoManager` has a "Reforma Tributária"
  section (CST, cClassTrib, IBS-UF/Mun + CBS alíquotas). The **categoria**
  registration view is a follow-up (#318).
- **Codes are registerable free-text** — the Anexo III/IV `cClassTrib` / CST
  tables are Portal-published and **not vendored**; the operator (or a future
  NT-driven table import) supplies them.
- **Live homologação proof**: `test/operations/rtc.homologacao.test.ts` (serie
  4) emits a CRT=1 NF-e with the RTC groups against SEFAZ-SP homologação and
  asserts `cStat=100` — advisory in `ci-nfe.yml`'s `nfe-live` job, fatal on
  `workflow_dispatch`. The fixture codes are best-guess; refine
  `impostoCsosn102ComRtc` from the logged `cStat`+`xMotivo` on a first-run
  rejection.

**Deferred (tracked follow-ups):** the categoria RTC view; 4-digit `cStat` /
15-17-digit `nProt` response parsing; `finNFe` 5/6 (nota de crédito/débito);
Grupo BB/BC + the Grupo B additions; the new RTC events (112110…412130);
importing the Anexo III/IV code tables; and RTC activation for CRT=3 (Phase D,
#312). **Simples Nacional RTC stays off in produção** until SEFAZ publishes the
Simples rules (mandatory only 2027-01-04).

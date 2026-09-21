# Homologação (SEFAZ test environment)

SEFAZ keeps two environments. **Homologação** (`tpAmb=2`) is for testing;
**Produção** (`tpAmb=1`) issues legally valid documents. Homologação is always
available for every UF, including the SVC environments.

## Rules that differ in homologação

- **`tpAmb=2`** on every message (`enviNFe`, `consReciNFe`, `consSitNFe`,
  events, `inutNFe`). A mismatch between the NF-e's `tpAmb` and the service's
  environment is rejection **252**.
- **Mandatory recipient name** — in homologação the destinatário's `xNome`
  **must** be exactly:

  ```
  NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL
  ```

  (The DANFE also carries a "sem valor fiscal" watermark.) Issuing a homologação
  NF-e with a real recipient name is rejected.
- NF-e issued here have **no fiscal value** — they are throwaway test data and
  the issuer may generate them freely. ⚠️ That freedom does **not** extend to the
  participants' CNPJs any more — see "Identificação do destinatário" below.
- The certificate is real (a valid ICP-Brasil A1/A3); only the *environment*
  is test. The CI uses a dedicated homologação test certificate stored as the
  `NFE_CERT_BASE64` / `NFE_CERT_PASSWORD` secrets (with the `E` — runtime env
  vars, `.env.local`, and GitHub Actions secrets all use the same names).

## Identificação do destinatário — mudou em 01/09/2026

⚠️ **Um CNPJ de destinatário inventado, ainda que com DV válido, não passa mais
em homologação.** A **NT 2026.007 §5.10** (RV **12E02-10**, cStat **181**) obriga
o CNPJ do destinatário a constar na **LCC-RFB** — a réplica nacional do cadastro
CNPJ da Receita Federal — e a estar `02-Ativa`. A regra consulta o cadastro real,
então não existe placeholder que funcione. Implantação em homologação
**01/09/2026**, produção **03/11/2026**. A família completa (178–186, incluindo o
gêmeo do emitente) está em `cstat-rejeicoes.md`.

⚠️ **Isso contradiz a rejeição 597** — "NF-e emitida em ambiente de homologação
com CNPJ do destinatário diferente de `99999999000191`" (NT 2011.002, opcional
por UF), que torna `99999999000191` o CNPJ *sancionado* para testes. Ele não
consta na Receita, então 597 exige exatamente o que 12E02-10 rejeita. Conciliar
as duas é da SEFAZ. ⚠️ **Mas isso NÃO quer dizer que não haja CNPJ de
destinatário utilizável** — uma revisão anterior desta página afirmava isso e
estava errada: a saída são os CNPJs de teste que a própria SEFAZ publica, logo
abaixo.

⚠️ **A SEFAZ publica CNPJs de teste OFICIAIS, e é essa a saída.** A tabela
*"CNPJs alfa cadastrados no CCC de homologação"* (portal da NF-e, no material da
**NT 2026.004 — CNPJ Alfanumérico**) lista CNPJs registrados no **CCC** de
homologação, um por UF. Seis deles estão fixados em
`packages/integrations/nfe/test/xsd/cnpj-alfanumerico.test.ts`:

| CNPJ | UF |
|---|---|
| `PC3D315K000193` | RS |
| `MMH9SKDL539Y64` | MG |
| `UGVG75BM000152` | GO |
| `MBS1MDGN000111` | AM |
| `RHXHP3ET000108` | ES |
| `A0021382000161` | SC |

⚠️ **Todos são ALFANUMÉRICOS** (IN RFB 2.229/2024: `[0-9A-Z]{12}[0-9]{2}` — os
dois DV continuam numéricos). Por isso usá-los exigiu antes o pacote de XSD
`PL_010d_v1.03`: com o `TCnpj` antigo, `[0-9]{14}`, o documento morria em
`validateXsd` **localmente**, que é o comportamento correto — um XML
schema-inválido nunca deve chegar à SEFAZ (alimenta o caminho de banimento 656).

⚠️ **Usar um desses CNPJs é um pacote, não uma linha.** Eles são
**contribuintes** registrados, então:

- a `cliente.ie` tem de ser a IE real da linha do CCC, não
  `IE_SENTINELA.naoContribuinte` — o sentinel carimba `indIEDest='9'` e atrai a
  cStat **300** (NT 2025.001, "tipo da IE difere de Não Contribuinte");
- com IE real, `parties.ts` carimba `indIEDest='1'` e emite `<IE>` sozinho, e
  `ide.ts` vira `idDest='2'` sozinho a partir de `destUF !== filialUF`;
- a operação passa a ser revenda interestadual: **CFOP `6102`** e
  `ehConsumidorFinal: false` (`indFinal='0'`). Deixar `true` ao lado de uma IE
  real afirma que um contribuinte comprou como consumidor final;
- o endereço do destinatário tem de ser da MESMA UF da IE.

⚠️ **O CFOP que o gerador lê é `item.CFOP`** (`det.ts`). O par
`operacao.cfop` / `cfopInterestadual` é consultado só pelo orquestrador
(`generator-input.ts`), então trocar só esses dois não muda nada no XML.

⚠️ **CCC ≠ LCC-RFB.** A tabela é do **CCC**, o cadastro compartilhado dos
estados; a RV 12E02-10 consulta a **LCC-RFB**, a réplica do cadastro federal.
Nenhum documento afirma que uma linha no CCC implica uma linha na LCC-RFB — só
uma emissão ao vivo resolve. Se voltar 181 mesmo assim, é essa a explicação.

A saída alternativa, se a oficial não bastar:

- **Destinatário pessoa física (CPF, tag `E03`).** A RV é condicionada a *"se
  informado CNPJ do Destinatário (tag: E02)"*, então um CPF fica fora do escopo
  de 181/182. É o que `apps/nfe/test/lib/nfe/{orchestrator,epec}.homologacao.test.ts`
  fazem (`tipo: '0'`, CPF `12345678909`, com `ehConsumidorFinal: true` para
  limpar a rejeição 696 de `indIEDest='9'`) — e é por isso que esses suites
  continuaram passando quando os de CNPJ quebraram. O custo é perder a cobertura
  viva do ramo `pessoaJuridica` de `buildDest`.
- **Um CNPJ real de terceiro** foi descartado: amarra o CI à situação cadastral
  de outra empresa (RV 12E02-20, cStat 182, derruba a suíte quando ela sai de
  `02-Ativa`) e este repositório é público.

⚠️ O que **não** mudou: `transporta`, o CNPJ da instituição de pagamento
(`card/CNPJ`) e `infIntermed/CNPJ` **não** passam pela LCC-RFB. CNPJ de teste
nessas posições segue válido — não troque os quatro de uma vez.

Estado atual no repo: `emission.homologacao` e `rtc.homologacao` voltaram a rodar
— `buildHomologacaoFixture` usa o CNPJ oficial do CCC de **RS**
(`PC3D315K000193`) com a IE da linha, endereço em Porto Alegre, CFOP `6102` e
`ehConsumidorFinal: false`. O helper `lcc-rfb-bloqueio.ts`, que suspendia as duas
suítes, **foi removido** (#1612).

A emissão do `svc.homologacao` continua suspensa desde 03/09/2026 pelo **178**
(RV 12C02-10) em #1471, e a correção acima **não a alcança**: 12C02-10 lê o
**emitente** (tag C02), ou seja o CNPJ do nosso próprio certificado, que nenhuma
troca de fixture muda. Os dois são gêmeos na NT e não têm nada em comum no que
custa resolver. O skip do SVC segue condicionado a `!isFatalRun` de propósito:
178 já voltou a `100` sozinho (réplica LCC-RFB dessincronizada), então ainda vale
sondar.

## Endpoints

- Homologação web-service list:
  `http://hom.nfe.fazenda.gov.br/portal/webServices.aspx`
- Produção web-service list:
  `https://www.nfe.fazenda.gov.br/portal/webServices.aspx`
- The WSDL of any service is its URL + `?WSDL`.
- The endpoint set differs per UF and per `tpEmis` (normal vs SVC). Keep
  homologação and produção URL tables separate (mirror the old Flutter
  `enderecos.dart` / `enderecos_homologacao.dart`).

## Testing discipline

- A homologação round-trip is a real network call to SEFAZ — keep it out of the
  fast unit suite. Run it in the dedicated `ci-nfe.yml` `nfe-homologacao` job,
  in env-gated `*.homologacao.test.ts` files.
- Respect rate limits even in homologação — looping a request still triggers
  `656 Consumo Indevido`.
- A good homologação smoke sequence: `consStatServ` (assert 107) → emit one
  fixture NF-e → poll → assert `cStat=100` → emit the *same* NF-e again →
  assert the duplicidade recovery resolves to the original protocol.

## RTC (NT 2025.002) — cronograma de homologação

A obrigatoriedade dos campos IBS/CBS é faseada por ambiente:

| Data | Homologação | Produção |
|---|---|---|
| Out/2025–Jun/2026 | IBS/CBS facultativos. Se preenchidos, RVs aplicadas. | IBS/CBS facultativos; sem valor jurídico até 01/01/2026; com valor jurídico depois. |
| **01/07/2026** | **IBS/CBS obrigatórios** em todos os emitentes CRT=3. RV UB12-10 entra em vigor. | Ainda facultativos. |
| **03/08/2026** | Obrigatórios desde 01/07. | **IBS/CBS obrigatórios** (CRT=3). RV UB12-10 em produção. |
| **04/01/2027** | Obrigatoriedade estende-se a CRT=1/2/4 e Tributação Monofásica de Combustíveis. | Mesma data. |

Implicação para os testes em homologação:

- **Antes de 01/07/2026** os fixtures podem omitir o Grupo UB sem rejeição.
- **A partir de 01/07/2026** os fixtures precisam emitir Grupo UB + W03,
  ou usar uma cClassTrib que dispense (raras), ou ser de devolução
  referenciando NF-e pré-2026.
- O ambiente de homologação **antecipa em 1 mês** o que vai para
  produção, então é seguro usá-lo para validar prontidão antes da
  data-limite de produção.

Para fixtures de teste de RTC, consultar `rtc-ibs-cbs-is.md §"Notas para
implementação"` e a tabela cClassTrib (Anexo III do NT) no Portal Nacional.

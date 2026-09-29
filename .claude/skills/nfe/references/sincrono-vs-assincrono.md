# Síncrono vs Assíncrono — autorização da NF-e

Fonte: **NT 2025.001 v1.03** (Set/2025), `references/sources/nt/2025/`.
Aplicação obrigatória em produção desde **03/11/2025** (RV GAP03a-3,
cStat 452).

## O que mudou

Desde o início do projeto NF-e (2008+), o envelope `enviNFe` aceita
`<indSinc>` com dois valores:

- `indSinc=0` — assíncrono. Lote vai pra fila; resposta imediata só
  carrega `<infRec>/nRec` e o cliente consulta depois.
- `indSinc=1` — síncrono. Resposta imediata carrega o `<protNFe>` da NF-e
  autorizada (ou a rejeição), sem necessidade de poll.

Historicamente o modo síncrono era **opcional** e algumas UFs nem
implementavam. NT 2025.001 §02.3 inverteu o jogo:

> **Quando o lote tem exatamente 1 NF-e, `indSinc=1` é obrigatório.**
> Enviar `indSinc=0` para lote de 1 NF-e é rejeitado com **cStat 452**
> (RV `GAP03a-3`, em produção desde 13/10/2025).

A RV antiga `GAP03a-2` ("UF não disponibiliza síncrono") foi **eliminada**
no mesmo NT — todas as UFs autorizadoras agora obrigatoriamente implementam
o modo síncrono.

## A regra prática (decisão na hora de montar enviNFe)

```
if (NFes.length === 1) {
    indSinc = 1;   // mandatório — cStat 452 se enviar 0
} else if (NFes.length >= 2 && NFes.length <= 50) {
    indSinc = 0;   // assíncrono é o normal para lote > 1
    // (indSinc=1 com lote > 1 cai em cStat=776 — UF não disponibiliza,
    //  vide observação abaixo)
}
```

A NT não tornou `indSinc=1` obrigatório para lote ≥ 2 — para lotes
maiores o caminho assíncrono permanece o único viável.

## Formato da resposta (retEnviNFe)

A resposta **muda conforme `indSinc`**, e o cliente precisa lidar com os
dois envelopes:

### Assíncrono (`indSinc=0`, lote ≥ 2)

```xml
<retEnviNFe versao="4.00">
  <tpAmb>2</tpAmb>
  <verAplic>SVRS202xxxxxxxx</verAplic>
  <cStat>103</cStat>                 <!-- Lote recebido com sucesso -->
  <xMotivo>Lote recebido com sucesso</xMotivo>
  <cUF>43</cUF>
  <dhRecbto>2026-05-26T10:30:00-03:00</dhRecbto>
  <infRec>
    <nRec>123456789012345</nRec>     <!-- 15-dígitos; usado em consReciNFe -->
    <tMed>2</tMed>                   <!-- segundos de espera médios -->
  </infRec>
</retEnviNFe>
```

Cliente deve esperar `tMed` segundos (mínimo 15s pela MOC) e então chamar
`NFeRetAutorizacao4` com o `nRec`. Voltará `<retConsReciNFe>` com `cStat=104`
+ array de `<protNFe>`, ou `cStat=105` (em processamento, repetir) ou
`cStat=106` (lote não localizado, partir para recovery via `consSitNFe`).

### Síncrono (`indSinc=1`, lote = 1)

```xml
<retEnviNFe versao="4.00">
  <tpAmb>2</tpAmb>
  <verAplic>SVRS202xxxxxxxx</verAplic>
  <cStat>104</cStat>                 <!-- Lote processado -->
  <xMotivo>Lote processado</xMotivo>
  <cUF>43</cUF>
  <dhRecbto>2026-05-26T10:30:00-03:00</dhRecbto>
  <protNFe versao="4.00">             <!-- INLINE, sem nRec -->
    <infProt Id="ID...">
      <tpAmb>2</tpAmb>
      <verAplic>SVRS202xxxxxxxx</verAplic>
      <chNFe>43...</chNFe>
      <dhRecbto>2026-05-26T10:30:00-03:00</dhRecbto>
      <nProt>143xxxxxxxx</nProt>     <!-- 15 ou 17 dígitos pós NT 2025.002 -->
      <digVal>...</digVal>
      <cStat>100</cStat>             <!-- Autorizado o uso da NF-e -->
      <xMotivo>Autorizado o uso da NF-e</xMotivo>
    </infProt>
  </protNFe>
</retEnviNFe>
```

`<infRec>` é **omitido**. O cliente recebe o protocolo imediatamente e já
pode montar o `<nfeProc>` (envelope para arquivamento e DANFE).

## Implementação no projeto

O helper `autorizarLote` em `packages/integrations/nfe/src/operations/`
deve:

1. **Inferir `indSinc` automaticamente** a partir de `NFe.length`:
   - `1` → `indSinc=1`
   - `2..50` → `indSinc=0`
   - `0` ou `>50` → erro de input (não chega ao SOAP)
2. **Parsear ambos os envelopes** na resposta:
   - Se `cStat=103` + `infRec` → fluxo async, retornar `{ status: 'async',
     nRec, tMed }`.
   - Se `cStat=104` + `protNFe` inline → fluxo sync, retornar
     `{ status: 'sync', protNFe }` (consumível diretamente, sem poll).
3. **Persistir o estado da NF-e** antes do POST. A `chave de acesso` é
   computável antes do envio; persistir `{ chave, estado: 'enviando' }` é
   a única âncora anti-perda. Vide `recovery` em `cstat-rejeicoes.md`.

## cStats novos (NT 2025.001)

| cStat | Mensagem | Quando |
|---|---|---|
| **452** | Rejeição: Solicitada resposta assíncrona para Lote com somente 1 NF-e | Cliente mandou `indSinc=0` com `NFe.length=1`. **Crítico** — exige fix no cliente. |
| ~~776~~ | (anteriormente "UF não disponibiliza síncrono") | RV GAP03a-2 removida — não deveria mais aparecer em produção. |

Para a lista completa de cStats novos das duas NTs, vide `cstat-rejeicoes.md`.

## Migração: código que assume sempre async

Sintomas de código pré-NT 2025.001:

- Sempre envia `<indSinc>0</indSinc>`, mesmo com lote de 1.
  → Vai pegar `cStat=452` para 100% das emissões de 1 NF-e a partir de
  Out/2025. **Quebra silenciosamente** — a NF-e nunca é autorizada.

- Parser do retorno só procura `<infRec>/nRec`.
  → Vai falhar quando a resposta vier com `<protNFe>` inline (síncrono).
  Pode produzir falsos negativos ("lote rejeitado, nRec ausente") quando
  na verdade o protocolo já chegou.

Checklist do fix:

- [ ] Recalcular `indSinc` no momento do envio com base no tamanho do lote.
- [ ] Parser detecta `cStat=104` + `<protNFe>` inline → não tentar poll.
- [ ] Parser detecta `cStat=103` + `<infRec>/nRec` → fluxo async tradicional.
- [ ] Teste de integração em homologação para o caminho síncrono.

## Outras mudanças menores no fluxo (também NT 2025.001)

### Atraso na data de emissão

Anteriormente NF-e podia ser emitida com até **30 dias** de atraso e SEFAZ
autorizava com `cStat=150` (Autorizado fora de prazo). NT 2025.001 §02.4
reduziu o limite:

| Atraso (dhEmi vs. dhAutorização) | cStat |
|---|---|
| 0–7 dias | **100** (Autorizado o uso da NF-e) |
| 7–30 dias | **150** (Autorizado fora de prazo) |
| >30 dias | **Rejeitado** salvo se emitido em contingência (`tpEmis=2, 4, 5`); aí ainda aceita com cStat=150. |

RV `B09-20` (cStat 228 — "Data de Emissão muito atrasada") reescrita
em NT 2025.001 v1.00 para refletir essa janela.

### Cobrança e Pagamento — novas validações

- **`Y07/dup`** não pode ser preenchido se `indPag=0` (à vista) (RV
  `Y09-40`, cStat 853). `dVenc` ≤ 10 anos a partir de hoje (RV `Y09-50`,
  cStat 797).
- **`YA03-10/30, YA05-20, YA06-10`** — várias validações antes opcionais
  por UF agora **obrigatórias nacional**. Inclui validação de bandeira
  de cartão contra a tabela do Portal Nacional NF-e (cStat 443).

### `indIEDest` mais rigoroso (cStat 805)

`indIEDest=2` ("Contribuinte isento de Inscrição no Cadastro de Contribuintes
da UF do Destinatário") é a única entrada que dispara a cStat **805** —
"A SEFAZ do destinatário não permite Contribuinte Isento de Inscrição
Estadual". A 805 **não é nova** (não está nos códigos da §90.1 da NT): já
constava do MOC 7.0 em duas RVs. A NT 2025.001 (§03.3, p. 9–10) alargou a
primeira e republica a segunda com o mesmo escopo. Motivo declarado na §02.5
(p. 7): "praticamente todas as UF concedem IE para MEI", então sobram poucas
UFs que aceitam o "Contribuinte Isento de Inscrição".

| RV | MOC 7.0 — Anexo I, p. 86 | NT 2025.001 v1.03 — p. 9–10 |
|---|---|---|
| `E16a-30` | **Obrig.** — só interestadual (`idDest=2`), nas UFs AM, BA, CE, GO, MG, MS, MT, PA, PE, RN, SE, SP | **Obrig.** — interna **e** interestadual (`idDest=1 ou 2`), nas UFs AL, AM, BA, CE, DF, ES, GO, MG, MS, MT, PB, PE, RJ, RN, RS, SE, SP |
| `E16a-35` | **Facult.** — interna (`idDest=1`), em UF que não permite a situação | **Mesmo escopo** (Facult., `idDest=1`) |

⚠️ As duas listas **divergem**: a NT acrescenta AL, DF, ES, PB, RJ e RS e
**não lista mais PA**. E a lista não é a regra — a Observação 1 da `E16a-30`
diz que ela segue a "configuração da UF do Destinatário (permite ou não
permite Contribuinte Isento de Inscrição Estadual)". Não trate nenhuma das
duas como fonte de verdade em runtime.

Histórico da `E16a-30` dentro da própria NT (Histórico de Alterações, p. 2–3):

- **v1.01** (jun/2025) — "Alterada RV E16a-30, incluindo a lista de UF".
- **v1.02** (set/2025) — elimina RJ e ES da lista (vigência imediata, "ou a RV
  deverá ser desativada enquanto a eliminação das UF não estiver
  implementada") e estende a RV às **operações internas**, com produção em
  **13/10/25** (repetido na Observação 2 da RV).
- **v1.03** (set/2025) — reinclui ES e RJ. Cronograma da versão: teste até
  20/10/2025, produção 03/11/2025.

Exceções — as mesmas quatro nas duas RVs, no MOC 7.0 e na NT:

1. destaque de ICMS-ST (`vICMSST`) em pelo menos um item;
2. ICMS-ST retido anteriormente (`vICMSSTRet`) em pelo menos um item;
3. em produção, NF com data de emissão anterior a 01/07/2016;
4. operação isenta (CST 40, CSOSN 103), imune ou não tributada (CST 41,
   CSOSN 300, CSOSN 400).

**As duas saídas, e a armadilha da segunda.** Ou o destinatário passa a ter a
IE informada (`indIEDest=1` + `<IE>`), ou é declarado não contribuinte
(`indIEDest=9`). A segunda esbarra na RV `E16a-40` (Obrig., cStat **696**,
NT 2019.001 v1.00; MOC 7.0 Anexo I p. 86): `indIEDest=9` com `indFinal≠1`
numa saída (`tpNF=1`) que não é exterior (`idDest≠3`) é rejeitada —
"Operação com não contribuinte deve indicar operação com consumidor final".
Venda a não contribuinte, portanto, só como operação de consumidor final. (A
`5E17-12`, cStat 300 — IE informada com `indIEDest=9` e tipo de IE ≠ 3 no CCC
— está como "Implementação futura" na v1.03, p. 13, e exige a IE no XML.)

**No app:**

- O operador não escolhe `indIEDest`: ele sai da escada de `buildDest`
  (`packages/integrations/nfe/src/generator/parties.ts`). Exterior e pessoa
  física/estrangeiro → `9`. Pessoa jurídica: `ie` que normaliza para
  `IE_SENTINELA.isento` (`ISENTO`) → `2`, o único caminho até ele; em branco
  ou `NAO CONTRIBUINTE` → `9`; qualquer outro valor → `1`, o único que emite
  `<IE>`.
- A orientação ao operador para a 805 mora em `apps/web/lib/nfe/errors.ts`
  (`orientacaoRejeicaoNFe`) — o único lugar que mapeia cStat → texto. Ela lê
  `idDest`, `indIEDest` e `enderDest/UF` do `xml_assinado` rejeitado
  (`apps/web/lib/nfe/destinatarioNFe.ts`), orienta para `idDest` 1 e 2 (3 ou
  desconhecido → texto genérico) e oferece as duas saídas acima — informar a
  IE (o botão "Buscar dados do CNPJ" do cadastro tenta obtê-la) ou
  `NAO CONTRIBUINTE`, com a ressalva do consumidor final. Se o cadastro já não
  declara `ISENTO`, o texto vira só "emita a NF-e novamente".
- Nenhuma lista de UF é hard-coded: a UF vem do XML, pelos motivos acima.

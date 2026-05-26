# Gargalos e problemas reais — NF-e em produção

The happy path is well-documented in the MOC and NTs. This file is for
**what actually breaks in production**, distilled from the SEFAZ docs,
SEFAZ FAQs, the failure-mode notes embedded in the contingency manual,
and the lessons baked into the recovery code in
`packages/integrations/nfe/src/recovery/`.

Anytime you debug a real-world NF-e issue, start here before opening the
MOC.

## 1. SEFAZ perde NF-e — duplicidade é parte do contrato

A documentação do MOC é explícita:

> "Caso a falha tenha ocorrido na SEFAZ origem, ao retornar à operação
> normal, é possível que as NF-e em processamento sejam perdidas."

Tradução: **mensagens enviadas podem desaparecer**. O cliente que reenvia
recebe uma destas:

- **`cStat=204`** — Duplicidade de NF-e (mesma chave já existe)
- **`cStat=539`** — Duplicidade com diferença na chave de acesso
- **`cStat=218`** — Já cancelada
- **`cStat=205`** — Denegada
- **`cStat=635`** — Mesmo número/série já transmitido, aguardando processamento

**Não são erros fatais — são instruções para consultar.** Vide
`cstat-rejeicoes.md §"Recovery procedure"`.

### O que causa duplicidade na vida real

| Causa | Sintoma | Prevenção |
|---|---|---|
| Cliente reenvia após timeout TCP sem confirmar se SEFAZ recebeu | 204 / 539 | Persistir `{chave, estado:'enviando'}` **antes** do POST. Se timeout, próxima ação é `consSitNFe(chave)`, não reenvio. |
| Cliente reusa `cNF` (Código Numérico) sem regerar | 539 (chave divergente) | `cNF` deve ser **aleatório a cada NF-e**, nunca igual a `nNF`. SEFAZ armazena pela chave (com cDV), não por número. |
| Dois nós/threads emitem a mesma numeração simultaneamente | 204 | Serializar a alocação de `nNF` por (emitente, série). Lock distribuído ou contador único atomicamente incrementado. |
| Banco local foi perdido mas SEFAZ ainda tem | 204 ao tentar reusar números | Pull de DF-e via `NFeDistribuicaoDFe` para reconciliar. |

### A âncora anti-perda: persistir chave **antes** do envio

Padrão obrigatório (já implementado em `src/recovery/`):

```
1. compute chave
2. INSERT  {chave, série, número, estado: 'enviando', xml: signed_bytes}
3. POST    enviNFe
4. on response:
   - 100/150 → UPDATE {estado: 'autorizada', protocolo}
   - 104 sync inline → UPDATE igual
   - 103 async → UPDATE {estado: 'enviada', nRec}; agendar poll
   - 204/539/218/205 → UPDATE {estado: 'duplicidade'}; agendar consSitNFe
   - outras rejeições → UPDATE {estado: 'rejeitada', motivo}
   - timeout/conn-error → estado fica 'enviando'; recovery job vai
     varrer essas e chamar consSitNFe
```

A regra de ouro: **toda chave de NF-e enviada tem que estar
recuperável**. Se quebrar essa invariante, eventualmente uma NF-e fica
"em limbo" — autorizada na SEFAZ mas não na base local — e a próxima
emissão com a mesma numeração gera duplicidade insolúvel.

## 2. `cStat=656` — Consumo Indevido (caminho para o ban)

Não é um erro normal. É o sinal de que o cliente está abusando do
serviço:

- Loops reenviando a mesma mensagem rejeitada.
- Repetidas falhas de schema (cStat 215/225) — alguém está mandando XML
  inválido em volume.
- Polling `consStatServ` em loop.
- `consReciNFe` antes do `tMed` mínimo (15 s).

**Escalada**: 656 → throttling → ban de CNPJ/certificado. Ban significa
que o emissor **não consegue emitir NF-e nenhuma** até desbloqueio
administrativo (lento).

Defesa em camadas (já implementadas neste repo):

1. **XSD validation pré-POST** (`src/xsd/`). Falha de schema **nunca**
   pode chegar à SEFAZ.
2. **Sem retry automático em rejeições de negócio.** Rejeição → corrigir
   e reenviar **explicitamente** com a mesma chave (ou nova, conforme o
   caso). Nunca em loop.
3. **Backoff exponencial** em erros transitórios (timeout, 5xx, conn
   reset). Iniciar em 2s, dobrar até 60s, parar após N tentativas.
4. **Rate limiting** local em `consStatServ` — no máximo 1 chamada por
   `cUF` por minuto.

Se 656 aparecer **uma única vez** em prod, **parar tudo** e investigar.
Existe um bug no pre-send validation.

## 3. `cStat=215`/`225` (schema) ≠ `cStat=460`+ (validação de negócio)

**Schema validation** roda no parser XML antes da regra de negócio:

- `215` — schema da `<NFe>` (mensagem)
- `225` — schema do lote (`<enviNFe>`)

**Regras de validação (RVs)** rodam server-side, depois do parse. **Muito
mais rejeições.** A lista oficial vai de 200 a 1218+ (com gaps).

Implicação para teste:

- Passar no `xmllint --noout --schema enviNFe_v4.00.xsd nfe.xml` **não
  garante autorização**. Garante apenas que a SEFAZ vai processar a
  mensagem, não que vai aceitar.
- Cobertura real de teste exige homologação ou um simulador que valide
  as ~600 RVs.

## 4. Certificado A1 — armadilhas reais

### Expiração

A1 vence em 1 ano. Renovação **silenciosa** é o pesadelo: SEFAZ rejeita
com `cStat=280-298` quando o cert expirou ontem. Monitorar:

- `valid_to` do PFX. Alertar 30 dias antes.
- CRL (Certificate Revocation List) de ICP-Brasil. Cert pode estar
  revogado mesmo dentro do `valid_to`.

Se aplicação não tem warning > 30d, em algum momento prod cai por cert
expirado. O custo é horas/dias até nova A1 emitida.

### Cadeia ICP-Brasil

PFX traz apenas o cert do emissor. Para TLS mútuo e para validação da
assinatura SEFAZ, precisa da **cadeia completa** (raiz ICP-Brasil + AC
intermediária + AC do emissor). Quando a cadeia muda — e muda — a
aplicação precisa atualizar.

No repo: `pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca`
baixa/atualiza o bundle. CI deve rodar isso periodicamente.

### Formato PFX vs PEM

A SEFAZ aceita A1 em PFX (PKCS#12). Node aceita PFX direto no
`https.Agent`, mas algumas libs querem PEM (cert + key separados).
Conversão: `openssl pkcs12 -in cert.pfx -out cert.pem -nodes`.

`-nodes` (no DES) deixa a chave sem senha. Em CI/staging ok; em prod,
prefira manter o PFX cifrado e fornecer a senha via secret manager.

### Relógio do servidor

XMLDSig usa timestamp implícito (UTC do `dhEmi`). Se o relógio do
servidor estiver **mais de ~5 min** fora, SEFAZ pode rejeitar com
`cStat=703-708` ou aceitar a NF-e com `dhEmi` futura — que vira "fora de
prazo" automaticamente (cStat=150). Sincronizar com NTP é
**obrigatório**, não opcional.

## 5. Atraso na emissão (NT 2025.001 mudou o limite)

| Atraso (dhEmi → dhAutorização) | cStat |
|---|---|
| 0–7 dias | 100 — Autorizado |
| 7–30 dias | **150** — Autorizado **fora de prazo** |
| > 30 dias | Rejeitado **salvo** `tpEmis=2,4,5` (contingência) |

Anteriormente: 30 dias era o limite. **Mudou para 7** com NT 2025.001 em
produção desde 03/11/2025. Sistemas que faziam carga batch de NF-e
antiga agora pegam cStat=150 (não-fatal, mas marca a NF-e como "fora de
prazo" e pode chamar atenção do fisco).

Aplicação tem 7 dias entre `dhEmi` e o envio para autorização. Beyond
that, ou emitir como contingência (`tpEmis=4` EPEC ou 6/7 SVC, com
justificativa real), ou aceitar o cStat=150.

## 6. Contingência — quando ativar e como sair

Disparadores típicos para `tpEmis ≠ 1`:

- SEFAZ origem `consStatServ` retorna `108`/`109` (paralisado).
- `enviNFe` retorna `cStat=999` ou TCP timeout consistente.
- Latência > 5s em > N% das requisições.

Modos (vide `contingencia.md` para detalhes):

| Modo | `tpEmis` | Quando faz sentido |
|---|---:|---|
| FS-DA (formulário de segurança) | 5 | Legacy. Só se houver estoque de FS-DA pré-impresso. |
| EPEC | 4 | Operação alta-frequência B2B. Requer ambiente nacional disponível. |
| SVC-AN / SVC-RS | 6 / 7 | Default moderno. UF da emitente determina qual (COTEPE 39/2012). |

**Saída**: quando SEFAZ origem volta, NF-e emitidas em contingência
**precisam ser transmitidas para SEFAZ origem** (exceto SVC: já estão
autorizadas, replicadas via AN). Esquecer essa etapa é causa comum de
auditoria fiscal apontando "NF-e em contingência sem regularização".

## 7. Numeração — gaps, inutilização vs cancelamento

| Cenário | Ação correta |
|---|---|
| Erro antes do envio (validação local falhou) | **Reusar o número** — a NF-e não existe em SEFAZ. |
| Rejeição em SEFAZ (não-duplicidade) | **Reusar o número** — SEFAZ rejeitou, não armazenou. |
| NF-e autorizada e a operação caiu/cancelou no business | **Cancelamento por Evento** (110111). Limite: até 24h após autorização. |
| NF-e autorizada >24h e operação caiu | **Não cancela. Estorno fiscal.** Emitir NF-e de devolução/ajuste. |
| Número pulado por bug (gap) | **Inutilização do range** (NfeInutilizacao4). Documenta para o fisco que o número não será usado. |
| NF-e em contingência rejeitada após retorno do normal | Para `tpEmis=1` (normal): **novo número**. Para contingência: mesmo número/série. |

A regra **mais errada na prática**: cancelar NF-e fora do prazo (24h).
SEFAZ rejeita com erro de prazo; muitos sistemas tratam como "falha
transitória" e fazem retry, gerando 656.

## 8. RTC (NT 2025.002) — armadilhas novas

A partir de 03/08/2026 (CRT=3) a NF-e sem Grupo UB no item ou sem
Grupo W03 nos totais → `cStat=1115`. Específicas:

| Erro | Sintoma | Correção |
|---|---|---|
| Esquecer `cClassTrib` | cStat 1023 (inexistente) ou 1024 (incompatível) | Consultar tabela cClassTrib (Anexo III da NT) por cada CST. |
| Enviar Grupo UB para CST que não permite | cStat 1021 | Cada CST tem indicadores `ind_gIBSCBS`, `ind_gDif`, `ind_gRed`, etc. Consultar Tabela de Indicadores. |
| Soma errada do BC (UB16) | cStat 1104 | Fórmula em `rtc-ibs-cbs-is.md §"Notas para implementação"`. |
| Alíquota pIBSUF/pCBS fora do ano | cStat 1026 / 1037 | 0,1% IBS e 0,9% CBS para 2025-2026; 0,05% e referencial para 2027-2028. |
| Não somar IBS/CBS/IS no `vNFTot` | cStat 1094 | Sim em 2026+; **não** em 2025-2026 (Exceção 1 das RVs VB01-10/20). |
| Não considerar `gALCZFMCBS` para ZFM | cStat 1191 | Operação em ALC/ZFM exige `ISUFEmit` (C22) + grupo gALCZFMCBS. |
| Enviar evento RTC em lote | Risco de rejeição parcial difícil de tratar | NT 2025.002 §8.2 orienta **envio individual** dos novos eventos. |

## 9. `cStat=452` — Síncrono mandatório para lote=1 (NT 2025.001)

A partir de 03/11/2025, **qualquer** `enviNFe` com lote de 1 NF-e e
`indSinc=0` é rejeitado.

Sintoma em código pré-NT 2025.001:
- Aplicação que sempre manda `indSinc=0` "para depois consultar via nRec"
  pega cStat=452 em 100% das emissões de 1 NF-e a partir de Out/2025.
- Aplicação que sempre envia lote=1 e nunca implementou parser do
  protNFe inline → mesmo problema.

Fix em `autorizarLote`: **inferir indSinc do tamanho do lote**, e o
parser tem que aceitar ambos os envelopes de resposta. Vide
`sincrono-vs-assincrono.md §"Migração"`.

## 10. Sanitização de texto (problema antigo e silencioso)

Campos free-text (`xNome`, `infCpl`, `obsCont`, endereços) frequentemente
contêm caracteres que a SEFAZ rejeita:

- Acentos? OK em UTF-8, mas algumas UFs ainda têm problemas com
  combinações específicas (decomposed vs precomposed).
- Símbolos: `@`, `#`, `%`, `*`, `$`, `£`, `§`, `ª`, `º`, `©`, `®`, `™` →
  rejeição.
- Caracteres de controle (U+0000–U+001F): rejeição.
- `<`, `>`, `&`, `"`, `'` → precisam ser escapados (`&lt;` etc.), **e
  contam como 1 caractere** para validação de tamanho.

Pipeline no repo (em `src/sanitize/`):

1. **`removerAcentos`** primeiro — `ç`→`c`, `ã`→`a`, etc.
2. **`removerCharRestrito`** depois — escapa `< > & " '`, descarta
   símbolos proibidos, mantém alfanumérico + espaço + pontuação básica
   `.,-/;:()`.

Esquecer essa etapa → rejeição esporádica, difícil de reproduzir (depende
do conteúdo do pedido).

## 11. Ban e desbloqueio

Se um CNPJ/certificado for banido (após múltiplos 656), o caminho de volta:

1. Identificar **qual** SEFAZ baniu (UF da emitente, ou ambiente nacional).
2. Abrir chamado via Portal Nacional → escolher "Comunicar problemas
   técnicos".
3. Anexar logs do incidente e plano de mitigação.
4. Aguardar resposta (horas a dias).

Prevenção é muito mais barata que cura.

## 12. Mudanças de URL/Endpoint SEFAZ (raras mas pegam de surpresa)

Endpoints SEFAZ mudam ocasionalmente (migração de infra, mudança de
data-center). Listas oficiais:

- Produção: `https://www.nfe.fazenda.gov.br/portal/webServices.aspx`
- Homologação: `http://hom.nfe.fazenda.gov.br/portal/webServices.aspx`

(O sandbox bloqueia esses hosts; consultar manualmente quando precisar.)

Quando uma UF muda WSDL, o WSDL antigo costuma redirecionar por algumas
semanas, depois retorna 404. Cliente que cachear WSDL agressivamente
quebra. Estratégia: cache com TTL curto (1h) e fallback para WSDL
hardcoded só em ambiente de teste.

## 13. NT vigentes não significam "aplicáveis ao seu caso"

O Portal SEFAZ marca como "vigente" toda NT cujo conteúdo ainda tem
efeito em algum modelo (NF-e, NFC-e, MDF-e, NF3e, etc.). Várias NTs
"vigentes" são NFC-e-only ou DANFE-only e **não se aplicam ao escopo
deste skill** (NF-e modelo 55 backend).

Antes de incorporar uma NT, ler o título e a Resumo:
- "NFC-e" ou "Modelo 65" → fora de escopo deste skill.
- "DANFE" ou "Documento Auxiliar" → fora de escopo (DANFE é apresentação).
- "Tabela NCM / CFOP / Países / Unidades" → dados operacionais, não
  protocolo; raramente justifica mudança no skill.

## 14. Schema regen — quando e como

XSDs sob `packages/integrations/nfe/schemas/` foram gerados na linha
MOC 7.0. NTs subsequentes (2025.001, 2025.002, 2026.004) **publicaram
novos schemas** que ainda não foram incorporados.

Quando regenerar (vide `codegen.md`):

- NT introduz novos grupos XML obrigatórios (NT 2025.002 — Grupo UB/W03).
- NT muda tipos básicos (NT 2025.002 — `DFeTiposBasicos_v1.00.xsd`).
- NT muda envelopes de resposta (`retEnviNFe_v2.00.xsd`).
- NT adiciona novos eventos (`envEventoNFe_v9.99.xsd`, e2*.xsd).

Após regenerar:

1. Diff dos types gerados em `generated/`.
2. Atualizar `XSD_BY_ROOT` em `src/xsd/index.ts`.
3. Atualizar mapeadores em `src/operations/`.
4. Atualizar tests.
5. Commit. Geralmente PR separada deste skill update.

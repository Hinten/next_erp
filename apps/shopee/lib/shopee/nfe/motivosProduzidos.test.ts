/**
 * O backstop do vocabulário da NF-e (#1522, passo 14): **todo membro de
 * `MotivoNfeShopee` tem um PRODUTOR**, e nenhum produtor soletra um motivo por
 * fora do const — o mutante 38 da reconciliação.
 *
 * O mecanismo é o de `../precos/motivosProduzidos.test.ts` (passo 13), que é o
 * de `../estoque/motivosProduzidos.test.ts` (passo 12), portado. A lição é a
 * mesma: um motivo declarado que ninguém produz é uma promessa que a tela e o
 * aviso renderizam e o código nunca cumpre. Ele compila (a `satisfies` prova
 * que todo VALOR do const é membro, jamais que todo membro é usado), passa no
 * teste de totalidade de `FRASE_DO_MOTIVO_NFE` e no pareamento chave↔slug, e só
 * aparece quando um operador pergunta por que aquele veredicto nunca sai. As
 * ondas 1–3 deram produtor a cada um dos 57 de então (56 desde a revisão 1, que
 * tirou `frete-de-outra-integradora`); este teste chega depois delas pelo
 * mesmo motivo que o do preço chegou depois das suas.
 *
 * ## Três diferenças do porte, cada uma de propósito
 *
 * 1. **Produtor é SÓ a grafia `MOTIVO_NFE_SHOPEE.<chave>`.** O passo 13 aceita
 *    também o slug entre aspas; aqui não. Nesta pasta moram, ao lado dos
 *    motivos, DOIS outros vocabulários kebab (`MotivoCarimbo` em
 *    `carimboFreteNfe.ts`, `CasoJaAnexada` em `classificarNfe.ts`), e um literal
 *    de um deles que um dia coincidisse com um membro viraria, em silêncio, o
 *    produtor desse membro. E a convenção já é essa: o docblock de
 *    `errosNfe.ts` diz que o código NOMEIA o membro em vez de soletrar o slug, e
 *    os relatórios das ondas 1–3 confirmam que todo produtor usa a grafia do
 *    const. Um produtor que soletrasse o slug é apontado como órfão — a direção
 *    segura, e a mensagem manda trocar pela grafia do const.
 * 2. **A posição de motivo inclui a COMPARAÇÃO** (`motivo === '…'`), não só a
 *    atribuição (`motivo: '…'`), e nela TODO literal é apontado, membro ou não:
 *    um membro soletrado ali é uma decisão inline que contorna o const (e que o
 *    backstop de produtor não enxerga), e um não-membro é grafia errada ou um
 *    vocabulário alheio — que entra por NOME em {@link VOCABULARIOS_ALHEIOS},
 *    com a união declarada fixada contra o texto do arquivo que a declara.
 * 3. **O texto é lido com CRLF normalizado para LF.** O checkout do Windows é
 *    CRLF, o do CI é LF, e esta pasta tem os dois hoje; as exceções abaixo são
 *    trechos de várias linhas e precisam casar nos dois.
 *
 * ⚠️ O universo é TEXTO CRU, e tem de ser — um `import` não mostraria o membro
 * (o módulo importa o objeto inteiro) e a checagem de tipos menos ainda. O
 * limite aceito é o dos passos 12/13: uma menção num comentário conta como
 * produtor, e a posição de tipo também (`typeof MOTIVO_NFE_SHOPEE.semNfeAprovada`
 * em `pedidoNfe.ts`). Tirar comentários por regex foi medido e rejeitado lá.
 *
 * ⚠️ Os quatro motivos do predicado compartilhado (`apagada`, `nao-aprovada`,
 * `xml-ausente`, `tpamb-homologacao`) são PRODUZIDOS por
 * `decideNfeUploadDispatch` em `@delfrance/schemas` e atravessam
 * `processarNfe.ts` sem conversão (`paradaPor(pronta.reason)`); dentro da pasta
 * quem os nomeia é a tabela de profundidade de `pedidoNfe.ts`, e é essa menção
 * que conta aqui. O tipo garante a travessia; este teste, a menção.
 *
 * ⚠️ O arquivo que DECLARA fica FORA do universo do produtor, senão a asserção
 * é vácua: a união, o const, a tabela de frases e os três conjuntos soletram
 * cada slug em `errosNfe.ts`. Nos detectores de grafia ele ENTRA.
 *
 * ⚠️ Nenhum relógio, nenhum emulador: roda na suíte comum
 * (`pnpm --filter @delfrance/shopee-app test`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MOTIVO_NFE_SHOPEE } from './errosNfe';

/** A pasta do seam — todos os módulos da NF-e moram aqui. */
const RAIZ_NFE = new URL('./', import.meta.url);

/** Onde moram as rotas do canal; a pasta de rota da NF-e será filha dela. */
const RAIZ_DAS_ROTAS = new URL('../../../app/api/marketplace/shopee/', import.meta.url);

/**
 * As pastas de rota da NF-e, e se cada uma EXISTE neste PR.
 *
 * ⚠️ Fixado, nunca "lida se existir": uma pasta ausente lida em silêncio é
 * exatamente como um produtor real some do universo sem ninguém notar (um nome
 * digitado errado aqui teria o mesmo efeito). `enviar-nfe` é a rota do SEGUNDO
 * PR: a pasta chegou com ele, a âncora abaixo obrigou a trocar o `false` por
 * `true`, e desde então os produtores dela contam — a frase do 404
 * (`nfe-nao-encontrada`) e o portão de venda do `nfeId` explícito
 * (`nfe-nao-e-de-venda`); as demais recusas 409 ela repassa das decisões de
 * `pedidoNfe.ts` sem soletrá-las. A espera do SERPRO ali é um ATRASO, nunca uma
 * recusa, então a rota não produz `aguardando-serpro`. O mesmo caminho que
 * `atualizar-precos` fez no passo 13.
 */
const PASTAS_DE_ROTA: Readonly<Record<string, boolean>> = {
  'enviar-nfe': true,
};

/** O texto de um arquivo, com CRLF normalizado para LF (diferença 3). */
function lerTexto(url: URL): string {
  return readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
}

/** Todo `*.ts` não-teste sob `dir`, recursivo, com o nome relativo a `prefixo`. */
function lerPastaDeRota(dir: URL, prefixo: string, fontes: Map<string, string>): void {
  for (const nome of readdirSync(dir)) {
    const url = new URL(nome, dir);
    if (statSync(url).isDirectory()) {
      lerPastaDeRota(new URL(`${nome}/`, dir), `${prefixo}${nome}/`, fontes);
      continue;
    }
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    fontes.set(`${prefixo}${nome}`, lerTexto(url));
  }
}

/**
 * Todo `*.ts` não-teste da pasta, mais as pastas de rota presentes, menos o que
 * o chamador excluir.
 *
 * `*.test.ts` fica fora porque um teste MENCIONA todo membro por construção —
 * incluí-los faria este arquivo se auto-satisfazer na primeira linha. O script
 * `scripts/enviar-nfe.ts` também fica fora: ele só re-renderiza o que
 * `enviarNfeCli.ts` — que está na pasta — já decidiu.
 */
function fontesQuePodemProduzir(excluir: readonly string[]): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const nome of readdirSync(RAIZ_NFE)) {
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    if (excluir.includes(nome)) continue;
    fontes.set(nome, lerTexto(new URL(nome, RAIZ_NFE)));
  }
  for (const [pasta, existe] of Object.entries(PASTAS_DE_ROTA)) {
    if (!existe) continue;
    lerPastaDeRota(new URL(`${pasta}/`, RAIZ_DAS_ROTAS), `${pasta}/`, fontes);
  }
  return fontes;
}

/** Um vocabulário: chave camelCase → slug. */
type Vocabulario = Readonly<Record<string, string>>;

/**
 * A ÚNICA grafia que conta como produtor: `MOTIVO_NFE_SHOPEE.<chave>`, com
 * fronteira de palavra (diferença 1).
 *
 * ⚠️ A fronteira existe porque `includes` puro contaria
 * `MOTIVO_NFE_SHOPEE.nfeValidada` dentro de um `MOTIVO_NFE_SHOPEE.nfeValidadaX`
 * — uma chave que é prefixo de outra herdaria o produtor da vizinha. E o nome do
 * const faz parte do padrão: `reauth`, `cotaDiaria` e outras chaves existem
 * também em `MOTIVO_PRECO_SHOPEE` e `MOTIVO_ESTOQUE_SHOPEE`, e o produtor de um
 * vocabulário vizinho não é produtor deste.
 */
function temProdutor(fontes: ReadonlyMap<string, string>, chave: string): boolean {
  const pelaChave = new RegExp(`\\bMOTIVO_NFE_SHOPEE\\.${chave}\\b`);
  return [...fontes.values()].some((fonte) => pelaChave.test(fonte));
}

/** Os membros sem produtor nenhum que NÃO estão autorizados, como `chave (slug)`. */
function membrosSemProdutor(
  vocabulario: Vocabulario,
  fontes: ReadonlyMap<string, string>,
  autorizados: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(vocabulario)
    .filter(([chave]) => !temProdutor(fontes, chave) && !(chave in autorizados))
    .map(([chave, slug]) => `${chave} (${slug})`);
}

/** Os autorizados que JÁ ganharam produtor — a metade que mantém a lista honesta. */
function autorizadosJaProduzidos(
  vocabulario: Vocabulario,
  fontes: ReadonlyMap<string, string>,
  autorizados: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(autorizados).filter(
    (chave) => chave in vocabulario && temProdutor(fontes, chave),
  );
}

/**
 * Os órfãos POR PROJETO, cada um com a razão de uma linha que o autoriza.
 *
 * ⚠️ VAZIA, e vazia de propósito: os 56 membros têm produtor. A reconciliação
 * (§2.4) atribuiu um produtor a cada linha da tabela antes de declará-la, e as
 * ondas 1–3 entregaram cada um; um membro que perdesse o seu é o mutante 38, e
 * a correção é dar-lhe produtor ou tirá-lo da união — nunca uma linha aqui sem
 * que a revisão a veja (o conteúdo da lista está fixado no teste).
 */
const ORFAOS_AUTORIZADOS: Readonly<Record<string, string>> = {};

describe('todo motivo da NF-e declarado tem um PRODUTOR fora de errosNfe.ts', () => {
  it('as âncoras do universo: a pasta, os produtores das três ondas, e o declarante FORA', () => {
    // Se a leitura falhar ou mudar de forma, as asserções de baixo passariam
    // sozinhas — um universo vazio não tem órfão nenhum.
    const fontes = fontesQuePodemProduzir(['errosNfe.ts']);
    expect(fontes.size).toBeGreaterThanOrEqual(11);
    for (const produtor of [
      'pedidoNfe.ts',
      'notaNaShopee.ts',
      'classificarNfe.ts',
      'processarNfe.ts',
      'reverificacaoNfe.ts',
    ]) {
      expect(fontes.has(produtor), produtor).toBe(true);
    }
    expect(fontes.has('errosNfe.ts')).toBe(false);
    // Nenhum teste entra — nem o da rota —, e a pasta de rota entra INTEIRA:
    // exatamente o `route.ts` dela, agora que o mapa diz `true`.
    expect([...fontes.keys()].filter((nome) => nome.endsWith('.test.ts'))).toEqual([]);
    expect([...fontes.keys()].filter((nome) => nome.includes('/'))).toEqual([
      'enviar-nfe/route.ts',
    ]);
  });

  it('as pastas de rota estão no estado FIXADO: `enviar-nfe` (PR 2) existe', () => {
    for (const [pasta, existe] of Object.entries(PASTAS_DE_ROTA)) {
      expect(
        existsSync(new URL(`${pasta}/`, RAIZ_DAS_ROTAS)),
        `a pasta de rota ${pasta} — ao criá-la (ou apagá-la), corrija PASTAS_DE_ROTA`,
      ).toBe(existe);
    }
    // A raiz das rotas em si existe: sem isto, um caminho errado acima faria
    // toda pasta "não existir" e o teste passaria pelo motivo errado.
    expect(existsSync(new URL('enviar-precos/', RAIZ_DAS_ROTAS))).toBe(true);
  });

  it('os 56 motivos: cada um é NOMEADO por algum outro arquivo (ou está na lista autorizada com razão)', () => {
    const fontes = fontesQuePodemProduzir(['errosNfe.ts']);
    expect(
      membrosSemProdutor(MOTIVO_NFE_SHOPEE, fontes, ORFAOS_AUTORIZADOS),
      'motivos declarados que NINGUÉM produz como `MOTIVO_NFE_SHOPEE.<chave>` e que não estão autorizados',
    ).toEqual([]);
    expect(Object.keys(MOTIVO_NFE_SHOPEE)).toHaveLength(56);
  });

  it('a lista de órfãos autorizados está VAZIA e não guarda um membro que já ganhou produtor', () => {
    // ⚠️ O CONTEÚDO da lista, fixado: sem esta linha uma autorização nova entra
    // sem que ninguém a note na revisão.
    expect(Object.keys(ORFAOS_AUTORIZADOS)).toEqual([]);
    const fontes = fontesQuePodemProduzir(['errosNfe.ts']);
    expect(
      autorizadosJaProduzidos(MOTIVO_NFE_SHOPEE, fontes, ORFAOS_AUTORIZADOS),
      'órfãos autorizados que agora TÊM produtor — tire-os da lista',
    ).toEqual([]);
  });
});

describe('o detector de produtor, sobre fontes SINTÉTICAS (nenhum arquivo do repositório é tocado)', () => {
  // ⚠️ A prova de que as asserções acima não são vácuas. Elas correm sobre um
  // corpus em que todo membro tem produtor — e um corpus assim é exatamente o
  // que um detector quebrado (que responde "tem produtor" para tudo) também
  // produziria. Aqui o vocabulário é um recorte do real e as fontes, inventadas.
  const recorte: Vocabulario = {
    reauth: MOTIVO_NFE_SHOPEE.reauth,
    nfeValidada: MOTIVO_NFE_SHOPEE.nfeValidada,
  };

  it.each([
    ['a chave do const numa chamada', 'pararCom(alvo, paradaPor(MOTIVO_NFE_SHOPEE.nfeValidada));'],
    ['a chave do const como chave computada', '[MOTIVO_NFE_SHOPEE.nfeValidada]: 0,'],
    ['a chave do const em posição de tipo', '| typeof MOTIVO_NFE_SHOPEE.nfeValidada'],
  ])('PAR: %s conta como produtor', (_rotulo, texto) => {
    const fontes = new Map([['sintetico.ts', texto]]);
    expect(temProdutor(fontes, 'nfeValidada')).toBe(true);
  });

  it.each([
    [
      'o slug entre aspas simples (a grafia que o passo 13 aceita)',
      `motivo: '${MOTIVO_NFE_SHOPEE.nfeValidada}'`,
    ],
    ['o slug entre aspas duplas', `motivo: "${MOTIVO_NFE_SHOPEE.nfeValidada}"`],
    ['uma chave que só COMEÇA com a do membro', 'MOTIVO_NFE_SHOPEE.nfeValidadaParcial'],
    [
      'o acesso por colchete — o detector exige o ponto, e aponta um produtor assim',
      "MOTIVO_NFE_SHOPEE['nfeValidada']",
    ],
    ['a chave sem o const na frente', 'const nfeValidada = 1;'],
  ])('QUASE-MISS: %s NÃO conta como produtor', (_rotulo, texto) => {
    const fontes = new Map([['sintetico.ts', texto]]);
    expect(temProdutor(fontes, 'nfeValidada')).toBe(false);
  });

  it('QUASE-MISS: a MESMA chave num vocabulário vizinho (`MOTIVO_PRECO_SHOPEE.reauth`) não produz o da NF-e', () => {
    // `reauth` é chave dos três vocabulários (estoque, preço, NF-e); o produtor
    // de um não é produtor de outro — o nome do const faz parte do padrão.
    const vizinho = new Map([['sintetico.ts', 'return MOTIVO_PRECO_SHOPEE.reauth;']]);
    expect(temProdutor(vizinho, 'reauth')).toBe(false);
    const proprio = new Map([['sintetico.ts', 'return MOTIVO_NFE_SHOPEE.reauth;']]);
    expect(temProdutor(proprio, 'reauth')).toBe(true);
  });

  it('um membro sem produtor é APONTADO; o mesmo membro autorizado com razão não é', () => {
    const fontes = new Map([['sintetico.ts', 'return MOTIVO_NFE_SHOPEE.reauth;']]);
    expect(membrosSemProdutor(recorte, fontes, {})).toEqual([
      `nfeValidada (${MOTIVO_NFE_SHOPEE.nfeValidada})`,
    ]);
    expect(membrosSemProdutor(recorte, fontes, { nfeValidada: 'uma razão qualquer' })).toEqual([]);
  });

  it('um autorizado que GANHOU produtor é apontado — o teste falha no dia em que isso acontecer', () => {
    const autorizados = { nfeValidada: 'sem produtor no v1, por uma razão de uma linha.' };
    const semProdutor = new Map([['sintetico.ts', 'return MOTIVO_NFE_SHOPEE.reauth;']]);
    expect(autorizadosJaProduzidos(recorte, semProdutor, autorizados)).toEqual([]);

    const comProdutor = new Map([
      ['sintetico.ts', 'return MOTIVO_NFE_SHOPEE.reauth;'],
      ['novo.ts', 'return MOTIVO_NFE_SHOPEE.nfeValidada;'],
    ]);
    expect(autorizadosJaProduzidos(recorte, comProdutor, autorizados)).toEqual(['nfeValidada']);
  });
});

/* -------------------------------------------------------------------------- */
/*  o inverso — nenhum produtor soletra um QUASE-membro                        */
/* -------------------------------------------------------------------------- */

/**
 * A dobra do detector: minúsculas, e fora tudo que não é letra ou dígito.
 *
 * ⚠️ Ela existe para achar a **grafia errada de um membro**, não para comparar
 * motivos. Um motivo digitado errado numa POSIÇÃO TIPADA é erro de compilação
 * pela união; o mesmo erro dentro de um log, de uma tabela solta ou de um
 * envelope tipado frouxo é uma string que compila e nunca casa com nada. A
 * dobra iguala separadores e maiúsculas e NADA além disso.
 */
function dobraDeSlug(texto: string): string {
  return texto.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Todo literal `'...'` de uma linha só, que é o formato de um slug. */
const LITERAL_DE_UMA_LINHA = /'([^'\\\r\n]{3,60})'/g;

/**
 * O piso do detector: literais que dobram para menos que isto não são
 * examinados — evita casar siglas e códigos curtos por acaso. É o comprimento
 * dobrado do MENOR membro (`reauth`), e um teste o fixa: um membro mais curto
 * que chegasse teria os quase-membros dele ignorados em silêncio.
 */
const PISO_DA_DOBRA = 6;

/** Os 56 slugs do vocabulário, que é o universo dos detectores. */
function todosOsSlugs(): Set<string> {
  return new Set<string>(Object.values(MOTIVO_NFE_SHOPEE));
}

/**
 * Um trecho EXATO que dobra para um membro sem ser um motivo — dispensado do
 * detector de quase-membros, com a razão.
 */
interface ExcecaoDeTrecho {
  readonly arquivo: string;
  readonly trecho: string;
  readonly razao: string;
}

/**
 * As exceções do detector de quase-membros, cada uma um TRECHO exato de um
 * arquivo — nunca o literal sozinho, para que o MESMO literal em qualquer outro
 * ponto do arquivo continue sendo apontado.
 *
 * ⚠️ A colisão é estrutural, não acidental: a dobra apaga os hífens, e as
 * chaves do const são o camelCase dos slugs — então uma CHAVE entre aspas dobra
 * igual ao membro. Nos três trechos abaixo (os que o relatório B1 da onda 2
 * listou) as chaves estão num tipo de acesso indexado sobre o próprio const,
 * `(typeof MOTIVO_NFE_SHOPEE)[…]`, onde o compilador as confere como CHAVES —
 * uma chave errada ali não compila. O inverso é o erro real que o detector
 * pega: um `motivo: 'pedidoNaoBr'` (a chave no lugar do slug) nunca casaria
 * com nada.
 */
const EXCECOES_DE_DOBRA: readonly ExcecaoDeTrecho[] = [
  {
    arquivo: 'notaNaShopee.ts',
    trecho: [
      'MotivoDoPortao = (typeof MOTIVO_NFE_SHOPEE)[',
      "  | 'pedidoNaoBr'",
      "  | 'pedidoFbs'",
      "  | 'lojaCrossBorder'",
      "  | 'pedidoExportacao'",
      "  | 'pedidoCancelado'];",
    ].join('\n'),
    razao:
      'as cinco CHAVES do portão do pedido num tipo indexado sobre o próprio const — o compilador as confere como chaves; não são slugs soletrados.',
  },
  {
    arquivo: 'classificarNfe.ts',
    trecho: [
      'MotivoRecusaNfe = (typeof MOTIVO_NFE_SHOPEE)[',
      "  | 'emissorShopee'",
      "  | 'cnpjDivergente'",
      "  | 'ufDivergente'",
      "  | 'ieDivergente'",
      "  | 'nfeCancelada'",
      "  | 'dataDeEmissaoInvalida'",
      "  | 'modeloNao55'",
      "  | 'cfopNaoAceito'",
      "  | 'xmlRecusado'",
      "  | 'chaveInvalida'",
      "  | 'requisicaoInvalida'",
      "  | 'ipNaoDeclarado'",
      "  | 'recusaDesconhecida'];",
    ].join('\n'),
    razao:
      'as treze CHAVES que uma linha `recusar` da tabela responde, num tipo indexado sobre o próprio const — conferidas pelo compilador como chaves.',
  },
  {
    arquivo: 'classificarNfe.ts',
    trecho: "MotivoIgnorarNfe = (typeof MOTIVO_NFE_SHOPEE)['semSuporteANfe' | 'pedidoCancelado'];",
    razao:
      'as duas CHAVES da leitura do caso 11 (N3), num tipo indexado sobre o próprio const — conferidas pelo compilador como chaves.',
  },
];

/**
 * Literais que dobram para um membro sem SEREM o membro — a grafia errada.
 *
 * ⚠️ Recebe as fontes e as exceções por parâmetro, e não as lê, exatamente para
 * que o teste do próprio detector possa alimentá-lo com um arquivo sintético.
 * Um detector que só roda sobre um corpus limpo nunca mostra que detecta.
 */
function quaseMembros(
  fontes: ReadonlyMap<string, string>,
  slugs: ReadonlySet<string>,
  excecoes: readonly ExcecaoDeTrecho[],
): string[] {
  const porDobra = new Map([...slugs].map((s) => [dobraDeSlug(s), s]));
  const suspeitos: string[] = [];
  for (const [nome, fonteCrua] of fontes) {
    let fonte = fonteCrua;
    for (const excecao of excecoes) {
      if (excecao.arquivo === nome) fonte = fonte.replaceAll(excecao.trecho, '');
    }
    for (const achado of fonte.matchAll(LITERAL_DE_UMA_LINHA)) {
      const literal = achado[1] ?? '';
      if (slugs.has(literal)) continue;
      const dobrado = dobraDeSlug(literal);
      if (dobrado.length < PISO_DA_DOBRA) continue;
      const membro = porDobra.get(dobrado);
      if (membro !== undefined) suspeitos.push(`${nome}: '${literal}' ≈ '${membro}'`);
    }
  }
  return suspeitos;
}

/* -------------------------------------------------------------------------- */
/*  a posição de motivo — atribuição E comparação (diferença 2)                */
/* -------------------------------------------------------------------------- */

/**
 * Um vocabulário kebab que NÃO é o de motivos, mas mora num campo chamado
 * `motivo` — dispensado por NOME, com a união fixada contra o texto que a
 * declara.
 */
interface VocabularioAlheio {
  /** O nome da união declarada (`type <tipo> = …;`). */
  readonly tipo: string;
  /** O arquivo da pasta que declara a união. */
  readonly declaradoEm: string;
  /** Os literais da união, na ordem declarada — fixados contra o texto. */
  readonly literais: readonly string[];
  /** Os arquivos onde um literal dela numa posição de motivo é legítimo. */
  readonly aplicaEm: readonly string[];
  readonly razao: string;
}

/**
 * Os dois vocabulários alheios da pasta — exatamente os que os relatórios das
 * ondas 1 (A4) e 2 (B2) anunciaram.
 *
 * ⚠️ `aplicaEm` é onde a dispensa VALE, e é mínimo: `CasoJaAnexada` é
 * declarado em `classificarNfe.ts`, mas lá só aparece na união e no const (o
 * campo `motivo` de `ClasseNfe` é tipado, sem literal); o único literal dele em
 * posição de motivo é a comparação `classe.motivo === 'chave-duplicada'` de
 * `processarNfe.ts`. Um teste abaixo exige que cada arquivo de `aplicaEm` use a
 * dispensa de fato — uma dispensa que não dispensa nada é tirada.
 */
const VOCABULARIOS_ALHEIOS: readonly VocabularioAlheio[] = [
  {
    tipo: 'MotivoCarimbo',
    declaradoEm: 'carimboFreteNfe.ts',
    literais: [
      'carimbado',
      'sem-pedido',
      'sem-frete',
      'outra-integradora',
      'ja-carimbado',
      'estado-ilegivel',
      'fora-do-escopo',
    ],
    aplicaEm: ['carimboFreteNfe.ts'],
    razao:
      'o desfecho da TRANSAÇÃO do carimbo (o que uma tentativa de gravar `freteInicial.estado = error` fez), que vai para o log de conclusão — não é um motivo do envio e nunca chega a `aviso.motivo`.',
  },
  {
    tipo: 'CasoJaAnexada',
    declaradoEm: 'classificarNfe.ts',
    literais: ['chave-duplicada', 'chave-ja-enviada'],
    aplicaEm: ['processarNfe.ts'],
    razao:
      'QUAL resposta "já anexada" casou (N1: a chave está em outro pedido; N2: o reenvio ao mesmo pedido) — a releitura a transforma num motivo (R-f(1)); ela mesma não é membro do vocabulário.',
  },
];

/** Todo literal numa posição de motivo: `motivo: '…'`, `motivo === '…'`, `motivo !== '…'`. */
const POSICAO_DE_MOTIVO = /\bmotivo\s*(:|===|!==)\s*'([^'\r\n]*)'/g;

/**
 * Literais soletrados numa posição de motivo, fora de um vocabulário alheio
 * dispensado para aquele arquivo.
 *
 * Na ATRIBUIÇÃO só o não-membro é apontado (a regra do passo 13 — a posição que
 * a união já protegeria, e que por isso é a mais fácil de contornar com um
 * `Record<string, unknown>` pelo meio). Na COMPARAÇÃO todo literal é apontado:
 * um membro soletrado ali é uma decisão inline que contorna o const — e, se
 * decide aviso ou carimbo, contorna também os conjuntos de `errosNfe.ts`, que
 * são a ÚNICA fonte desses dois efeitos (lente 10 da reconciliação).
 */
function motivosSoletrados(
  fontes: ReadonlyMap<string, string>,
  slugs: ReadonlySet<string>,
  alheios: readonly VocabularioAlheio[],
): string[] {
  const apontados: string[] = [];
  for (const [nome, fonte] of fontes) {
    const dispensados = new Set(
      alheios.filter((v) => v.aplicaEm.includes(nome)).flatMap((v) => v.literais),
    );
    for (const achado of fonte.matchAll(POSICAO_DE_MOTIVO)) {
      const operador = achado[1] ?? '';
      const literal = achado[2] ?? '';
      if (dispensados.has(literal)) continue;
      if (operador === ':' && slugs.has(literal)) continue;
      apontados.push(`${nome}: motivo ${operador} '${literal}'`);
    }
  }
  return apontados;
}

/** Os literais de `type <tipo> = …;` no texto, na ordem — `null` se a união sumiu. */
function literaisDaUniao(fonte: string, tipo: string): string[] | null {
  const bloco = new RegExp(`\\btype ${tipo} =([^;]*);`).exec(fonte);
  if (bloco === null) return null;
  return [...(bloco[1] ?? '').matchAll(/'([^'\n]*)'/g)].map((m) => m[1] ?? '');
}

describe('a dobra de slug: o que ela trata como IGUAL e o que precisa continuar DISTINTO', () => {
  it('PAR igual: `nfe_validada`, `NFe-Validada` e `nfevalidada` dobram todos para `nfe-validada`', () => {
    const alvo = dobraDeSlug(MOTIVO_NFE_SHOPEE.nfeValidada);
    expect(dobraDeSlug('nfe_validada')).toBe(alvo);
    expect(dobraDeSlug('NFe-Validada')).toBe(alvo);
    expect(dobraDeSlug('nfevalidada')).toBe(alvo);
  });

  it('QUASE-MISS distinto: `nfe-validadas`, `nfe-invalida` e `validada` não dobram para `nfe-validada`', () => {
    const alvo = dobraDeSlug(MOTIVO_NFE_SHOPEE.nfeValidada);
    // Uma letra a mais, a menos ou trocada é outro motivo (ou outro
    // vocabulário: `validada` é um DESFECHO), não a mesma coisa escrita diferente.
    expect(dobraDeSlug('nfe-validadas')).not.toBe(alvo);
    expect(dobraDeSlug(MOTIVO_NFE_SHOPEE.nfeInvalida)).not.toBe(alvo);
    expect(dobraDeSlug('validada')).not.toBe(alvo);
  });

  it('os 56 slugs dobram para 56 formas distintas, e o MENOR dobra para exatamente o piso', () => {
    // Se dois membros colidissem sob a dobra, o detector apontaria o membro
    // errado numa mensagem de falha — e este é o único lugar que checa isso.
    const slugs = todosOsSlugs();
    const dobras = [...slugs].map(dobraDeSlug);
    expect(slugs.size).toBe(56);
    expect(new Set(dobras).size).toBe(slugs.size);
    expect(Math.min(...dobras.map((d) => d.length))).toBe(PISO_DA_DOBRA);
  });

  it('o detector DETECTA: sobre uma fonte sintética, acha o quase-membro e ignora o membro certo', () => {
    const slugs = todosOsSlugs();
    const sintetica = new Map([
      [
        'sintetico.ts',
        [
          `const certo = '${MOTIVO_NFE_SHOPEE.nfeValidada}';`,
          "const errado = 'nfe_validada';",
          "const aChave = 'pedidoNaoBr';",
          "const outro = 'nfe-pendente';",
          "const curto = 'Reauth';",
        ].join('\n'),
      ],
    ]);

    // Pega a grafia errada — inclusive a CHAVE usada no lugar do slug, e um
    // membro no piso exato (`reauth`, 6) com a caixa trocada.
    expect(quaseMembros(sintetica, slugs, [])).toEqual([
      `sintetico.ts: 'nfe_validada' ≈ '${MOTIVO_NFE_SHOPEE.nfeValidada}'`,
      `sintetico.ts: 'pedidoNaoBr' ≈ '${MOTIVO_NFE_SHOPEE.pedidoNaoBr}'`,
      `sintetico.ts: 'Reauth' ≈ '${MOTIVO_NFE_SHOPEE.reauth}'`,
    ]);
  });

  it('PAR/QUASE-MISS da exceção: dispensa o TRECHO exato, e o mesmo literal fora dele continua apontado', () => {
    const slugs = todosOsSlugs();
    const excecao: ExcecaoDeTrecho = {
      arquivo: 'sintetico.ts',
      trecho: "T = (typeof MOTIVO_NFE_SHOPEE)['pedidoNaoBr'];",
      razao: 'uma chave num tipo indexado, só para o teste.',
    };
    const soOTrecho = new Map([
      ['sintetico.ts', "type T = (typeof MOTIVO_NFE_SHOPEE)['pedidoNaoBr'];"],
    ]);
    expect(quaseMembros(soOTrecho, slugs, [excecao])).toEqual([]);

    const trechoEForaDele = new Map([
      [
        'sintetico.ts',
        "type T = (typeof MOTIVO_NFE_SHOPEE)['pedidoNaoBr'];\nconst m = { motivo: 'pedidoNaoBr' };",
      ],
    ]);
    expect(quaseMembros(trechoEForaDele, slugs, [excecao])).toEqual([
      `sintetico.ts: 'pedidoNaoBr' ≈ '${MOTIVO_NFE_SHOPEE.pedidoNaoBr}'`,
    ]);
    // A exceção vale só para o SEU arquivo.
    const outroArquivo = new Map([
      ['outro.ts', "type T = (typeof MOTIVO_NFE_SHOPEE)['pedidoNaoBr'];"],
    ]);
    expect(quaseMembros(outroArquivo, slugs, [excecao])).toHaveLength(1);
  });
});

describe('a posição de motivo, sobre fontes SINTÉTICAS', () => {
  const slugs = todosOsSlugs();
  const alheio: VocabularioAlheio = {
    tipo: 'Sintetico',
    declaradoEm: 'sintetico.ts',
    literais: ['chave-duplicada'],
    aplicaEm: ['usa.ts'],
    razao: 'um vocabulário alheio, só para o teste.',
  };

  it.each([
    ['a atribuição de um MEMBRO', `return { motivo: '${MOTIVO_NFE_SHOPEE.reauth}' };`],
    ['o literal alheio no arquivo onde a dispensa VALE', "if (c.motivo === 'chave-duplicada') {"],
  ])('PAR (passa): %s', (_rotulo, texto) => {
    expect(motivosSoletrados(new Map([['usa.ts', texto]]), slugs, [alheio])).toEqual([]);
  });

  it.each([
    [
      'a atribuição de um NÃO-membro',
      "return { motivo: 'motivo-que-nao-existe' };",
      "usa.ts: motivo : 'motivo-que-nao-existe'",
    ],
    [
      'a comparação com um MEMBRO soletrado (decisão inline, fora do const e dos conjuntos)',
      `if (d.motivo === '${MOTIVO_NFE_SHOPEE.reauth}') {`,
      `usa.ts: motivo === '${MOTIVO_NFE_SHOPEE.reauth}'`,
    ],
    [
      'a desigualdade com um membro soletrado',
      `if (d.motivo !== '${MOTIVO_NFE_SHOPEE.sefazPendente}') {`,
      `usa.ts: motivo !== '${MOTIVO_NFE_SHOPEE.sefazPendente}'`,
    ],
    [
      'um literal do vocabulário alheio que NÃO está na lista dele',
      "if (c.motivo === 'chave-triplicada') {",
      "usa.ts: motivo === 'chave-triplicada'",
    ],
  ])('QUASE-MISS (apontado): %s', (_rotulo, texto, esperado) => {
    expect(motivosSoletrados(new Map([['usa.ts', texto]]), slugs, [alheio])).toEqual([esperado]);
  });

  it('QUASE-MISS: o literal alheio num arquivo FORA de `aplicaEm` é apontado', () => {
    const fontes = new Map([['outro.ts', "if (c.motivo === 'chave-duplicada') {"]]);
    expect(motivosSoletrados(fontes, slugs, [alheio])).toEqual([
      "outro.ts: motivo === 'chave-duplicada'",
    ]);
  });

  it('QUASE-MISS: um campo que só COMEÇA com `motivo` não é posição de motivo', () => {
    const fontes = new Map([
      ['usa.ts', "const r = { motivoPendente: 'texto qualquer', motivos: 'x' };"],
    ]);
    expect(motivosSoletrados(fontes, slugs, [alheio])).toEqual([]);
  });

  it('a leitura da união declarada: acha os literais na ordem, e `null` quando ela sumiu', () => {
    const texto = "export type T =\n  | 'a-b'\n  | 'c-d';\nconst x = 'e';";
    expect(literaisDaUniao(texto, 'T')).toEqual(['a-b', 'c-d']);
    expect(literaisDaUniao(texto, 'U')).toBeNull();
    // `TT` não é `T`: a fronteira de palavra vale para o nome do tipo também.
    expect(literaisDaUniao("type TT = 'x';", 'T')).toBeNull();
  });
});

describe('nenhum produtor soletra um slug que NÃO é membro, nem decide por um slug soletrado', () => {
  it('as exceções da dobra estão FIXADAS, têm razão, e cada trecho ainda existe no seu arquivo', () => {
    // A exceção que perdeu o seu trecho é uma dispensa apontando para o nada —
    // e a próxima pessoa a lê como se ainda protegesse alguma coisa.
    expect(EXCECOES_DE_DOBRA.map((e) => `${e.arquivo}: ${e.trecho.split('\n')[0]}`)).toEqual([
      'notaNaShopee.ts: MotivoDoPortao = (typeof MOTIVO_NFE_SHOPEE)[',
      'classificarNfe.ts: MotivoRecusaNfe = (typeof MOTIVO_NFE_SHOPEE)[',
      "classificarNfe.ts: MotivoIgnorarNfe = (typeof MOTIVO_NFE_SHOPEE)['semSuporteANfe' | 'pedidoCancelado'];",
    ]);
    const fontes = fontesQuePodemProduzir([]);
    for (const excecao of EXCECOES_DE_DOBRA) {
      expect(
        excecao.razao.length,
        `a exceção de ${excecao.arquivo} precisa de uma razão`,
      ).toBeGreaterThan(20);
      expect(
        fontes.get(excecao.arquivo)?.includes(excecao.trecho),
        `${excecao.arquivo} não contém mais o trecho exato — tire (ou refaça) a exceção`,
      ).toBe(true);
      // E ela é NECESSÁRIA: sem ela, o próprio trecho acusa um quase-membro.
      expect(
        quaseMembros(new Map([[excecao.arquivo, excecao.trecho]]), todosOsSlugs(), []).length,
        `a exceção de ${excecao.arquivo} não dispensa nada — tire-a`,
      ).toBeGreaterThan(0);
    }
  });

  it('os vocabulários alheios estão FIXADOS contra a união que o arquivo declara, disjuntos dos motivos', () => {
    expect(VOCABULARIOS_ALHEIOS.map((v) => `${v.declaradoEm}: ${v.tipo}`)).toEqual([
      'carimboFreteNfe.ts: MotivoCarimbo',
      'classificarNfe.ts: CasoJaAnexada',
    ]);
    const fontes = fontesQuePodemProduzir([]);
    const slugs = todosOsSlugs();
    for (const v of VOCABULARIOS_ALHEIOS) {
      expect(v.razao.length, `${v.tipo} precisa de uma razão`).toBeGreaterThan(20);
      // A lista É a união declarada — um membro novo lá obriga a vir aqui.
      expect(
        literaisDaUniao(fontes.get(v.declaradoEm) ?? '', v.tipo),
        `a união ${v.tipo} de ${v.declaradoEm} mudou — corrija VOCABULARIOS_ALHEIOS`,
      ).toEqual(v.literais);
      // Disjunta dos motivos, e sem quase-membro: um literal alheio que
      // coincidisse com um motivo confundiria o operador e o log.
      expect(
        v.literais.filter((l) => slugs.has(l)),
        v.tipo,
      ).toEqual([]);
      expect(
        quaseMembros(
          new Map([[v.declaradoEm, v.literais.map((l) => `'${l}'`).join('\n')]]),
          slugs,
          [],
        ),
        v.tipo,
      ).toEqual([]);
      // Cada arquivo de `aplicaEm` usa a dispensa de fato.
      for (const arquivo of v.aplicaEm) {
        const semDispensa = motivosSoletrados(
          new Map([[arquivo, fontes.get(arquivo) ?? '']]),
          slugs,
          [],
        );
        expect(
          semDispensa.length,
          `${v.tipo} não dispensa nada em ${arquivo} — tire-o de aplicaEm`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('nenhum literal de uma linha é um quase-membro do vocabulário', () => {
    const fontes = fontesQuePodemProduzir([]);
    expect(fontes.size).toBeGreaterThanOrEqual(12);
    expect(fontes.has('errosNfe.ts')).toBe(true);

    expect(
      quaseMembros(fontes, todosOsSlugs(), EXCECOES_DE_DOBRA),
      'literais que são a grafia ERRADA de um motivo — nenhum leitor vai casá-los',
    ).toEqual([]);
  });

  it('nenhuma posição de motivo soletra um não-membro, nem COMPARA com um slug soletrado', () => {
    // A atribuição de um não-membro é a regra do passo 13; a comparação com
    // qualquer literal é a diferença 2 — um motivo se nomeia pelo const, e um
    // efeito (aviso, carimbo) se decide pelos conjuntos de `errosNfe.ts`.
    const fontes = fontesQuePodemProduzir([]);
    expect(
      motivosSoletrados(fontes, todosOsSlugs(), VOCABULARIOS_ALHEIOS),
      'literais em posição de motivo que não são membros, ou comparações com um slug soletrado',
    ).toEqual([]);
  });
});

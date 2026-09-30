/**
 * O backstop do vocabulário de PREÇO (#1521, passo 13): **todo membro de
 * `MotivoPrecoShopee` tem um PRODUTOR**, e nenhum produtor soletra um
 * quase-membro.
 *
 * O mecanismo é o de `../estoque/motivosProduzidos.test.ts` (passo 12),
 * portado — que por sua vez é o `O7` de `../anuncios/errosPublicacao.test.ts`.
 * A lição é a mesma: um motivo declarado que ninguém produz é uma promessa que a
 * tela renderiza e o código nunca cumpre. Ele compila, passa em todo teste de
 * pareamento chave↔slug e em todo teste de totalidade da tabela de mensagens, e
 * só aparece quando um operador pergunta por que aquele veredicto nunca sai.
 * `errosPreco.ts` declara os 44 membros do primeiro PR; as ondas 3 e 4 deram
 * produtor a cada um, e este teste chega depois delas pelo mesmo motivo que o
 * do estoque chegou depois das suas: antes, ele era impossível de passar.
 *
 * ⚠️ O universo é TEXTO CRU, e tem de ser. O que se quer pegar é um membro sem
 * NENHUMA menção; um `import` não o mostraria (um módulo importa o objeto
 * inteiro, não cada chave) e a checagem de tipos menos ainda (`as const
 * satisfies Record<string, MotivoPrecoShopee>` prova que todo VALOR é um
 * membro, jamais que todo membro é usado). O limite aceito é o do passo 12: uma
 * menção num comentário conta como produtor. Tirar os comentários por regex foi
 * MEDIDO e rejeitado — um `precos/*` dentro de um comentário de linha abre um
 * falso bloco e come código real, e os 44 membros viraram "sem produtor".
 *
 * ⚠️ O arquivo que DECLARA fica FORA do universo, senão a asserção é vácua: a
 * união de tipos, o const, a tabela de mensagens e `MOTIVOS_QUE_CARIMBAM`
 * soletram os slugs em `errosPreco.ts`. Só ele sai — `classificarPreco.ts`,
 * `regiaoPreco.ts` e os demais são produtores legítimos.
 *
 * ⚠️ As pastas de ROTA entram (reconcile C-m): a rota do envio manual produz
 * motivos por conta própria (`sem-tabela-normal`, `conta-pausada`), e deixá-la
 * de fora transformaria um produtor real em órfão. O script
 * `scripts/enviar-precos.ts` NÃO entra: ele só re-renderiza o que
 * `enviarPrecoCli.ts` — que está na pasta — já decidiu.
 *
 * ⚠️ Este arquivo não lê relógio nenhum e não sobe emulador: ele roda na suíte
 * comum (`pnpm --filter @delfrance/shopee-app test`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MOTIVO_PRECO_SHOPEE } from './errosPreco';

/** A pasta do seam — todos os módulos de preço moram aqui. */
const RAIZ_PRECOS = new URL('./', import.meta.url);

/** Onde moram as rotas do canal; cada pasta de rota do preço é filha dela. */
const RAIZ_DAS_ROTAS = new URL('../../../app/api/marketplace/shopee/', import.meta.url);

/**
 * As pastas de rota do preço, e se cada uma EXISTE neste PR.
 *
 * ⚠️ Fixado, nunca "lida se existir": uma pasta ausente lida em silêncio é
 * exatamente como um produtor real some do universo sem ninguém notar (um nome
 * digitado errado aqui teria o mesmo efeito). `atualizar-precos` é o job do
 * SEGUNDO PR: a pasta chegou com ele, a âncora abaixo obrigou a trocar o
 * `false` por `true`, e desde então os produtores `job-*` dela contam (a rota
 * de início escreve `job-interrompido` quando o primeiro enfileiramento falha).
 */
const PASTAS_DE_ROTA: Readonly<Record<string, boolean>> = {
  'enviar-precos': true,
  'atualizar-precos': true,
};

/** Todo `*.ts` não-teste sob `dir`, recursivo, com o nome relativo a `prefixo`. */
function lerPastaDeRota(dir: URL, prefixo: string, fontes: Map<string, string>): void {
  for (const nome of readdirSync(dir)) {
    const url = new URL(nome, dir);
    if (statSync(url).isDirectory()) {
      lerPastaDeRota(new URL(`${nome}/`, dir), `${prefixo}${nome}/`, fontes);
      continue;
    }
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    fontes.set(`${prefixo}${nome}`, readFileSync(url, 'utf8'));
  }
}

/**
 * Todo `*.ts` não-teste da pasta, mais as pastas de rota presentes, menos o que
 * o chamador excluir.
 *
 * `*.test.ts` fica fora porque um teste MENCIONA todo membro por construção —
 * incluí-los faria este arquivo se auto-satisfazer na primeira linha.
 */
function fontesQuePodemProduzir(excluir: readonly string[]): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const nome of readdirSync(RAIZ_PRECOS)) {
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    if (excluir.includes(nome)) continue;
    fontes.set(nome, readFileSync(new URL(nome, RAIZ_PRECOS), 'utf8'));
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
 * As três grafias com que um produtor pode escrever um membro.
 *
 * ⚠️ A grafia pela chave tem FRONTEIRA de palavra: `includes` puro contaria
 * `MOTIVO_PRECO_SHOPEE.precoIgual` como produtor dentro de um
 * `MOTIVO_PRECO_SHOPEE.precoIgualAnterior` — e uma chave que é prefixo de outra
 * herdaria o produtor da vizinha. Hoje nenhuma chave é prefixo de outra; a
 * fronteira existe para que isso nunca precise ser verdade.
 */
function temProdutor(fontes: ReadonlyMap<string, string>, chave: string, slug: string): boolean {
  const pelaChave = new RegExp(`\\bMOTIVO_PRECO_SHOPEE\\.${chave}\\b`);
  return [...fontes.values()].some(
    (fonte) => fonte.includes(`'${slug}'`) || fonte.includes(`"${slug}"`) || pelaChave.test(fonte),
  );
}

/** Os membros sem produtor nenhum que NÃO estão autorizados, como `chave (slug)`. */
function membrosSemProdutor(
  vocabulario: Vocabulario,
  fontes: ReadonlyMap<string, string>,
  autorizados: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(vocabulario)
    .filter(([chave, slug]) => !temProdutor(fontes, chave, slug) && !(chave in autorizados))
    .map(([chave, slug]) => `${chave} (${slug})`);
}

/** Os autorizados que JÁ ganharam produtor — a metade que mantém a lista honesta. */
function autorizadosJaProduzidos(
  vocabulario: Vocabulario,
  fontes: ReadonlyMap<string, string>,
  autorizados: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(autorizados).filter((chave) => {
    const slug = vocabulario[chave];
    return slug !== undefined && temProdutor(fontes, chave, slug);
  });
}

/**
 * Os órfãos POR PROJETO, cada um com a razão de uma linha que o autoriza.
 *
 * ⚠️ VAZIA, e vazia de propósito: os 46 membros têm produtor (44 no primeiro PR,
 * mais `job-interrompido` e `job-cancelado`, produzidos pelo job do segundo). O
 * passo 12 precisou de uma linha (`pisoAcimaDaBanda`, uma banda que não viaja
 * na tarefa); o preço não tem equivalente — a reconciliação CORTOU os nomes que
 * nada produziria (`status-desconhecido`, `familia-nao-encontrada`, a pausa
 * como motivo de linha) em vez de declará-los e autorizá-los aqui.
 *
 * ⚠️ Uma lista explícita, nunca um `skip` silencioso: a diferença entre "este
 * membro não tem produtor e nós sabemos por quê" e "este membro não tem produtor
 * e ninguém notou" é toda a diferença que este teste existe para marcar. Um
 * membro que ganhar um produtor deve SAIR daqui — {@link autorizadosJaProduzidos}
 * é o que obriga isso, e o teste sintético abaixo prova que ele obriga.
 */
const ORFAOS_AUTORIZADOS: Readonly<Record<string, string>> = {};

describe('todo motivo de preço declarado tem um PRODUTOR fora de errosPreco.ts', () => {
  it('as âncoras do universo: a pasta, a rota do envio manual, e o declarante FORA', () => {
    // Se a leitura falhar ou mudar de forma, as asserções de baixo passariam
    // sozinhas — um universo vazio não tem órfão nenhum.
    const fontes = fontesQuePodemProduzir(['errosPreco.ts']);
    expect(fontes.size).toBeGreaterThan(10);
    expect(fontes.has('enviar-precos/route.ts')).toBe(true);
    expect(fontes.has('enviarPreco.ts')).toBe(true);
    expect(fontes.has('enviarPrecoManual.ts')).toBe(true);
    expect(fontes.has('classificarPreco.ts')).toBe(true);
    expect(fontes.has('errosPreco.ts')).toBe(false);
    // Nenhum teste entra, nem da pasta nem das rotas.
    expect([...fontes.keys()].filter((nome) => nome.endsWith('.test.ts'))).toEqual([]);
  });

  it('as pastas de rota estão no estado FIXADO: `enviar-precos` e `atualizar-precos` (PR 2) existem', () => {
    for (const [pasta, existe] of Object.entries(PASTAS_DE_ROTA)) {
      expect(
        existsSync(new URL(`${pasta}/`, RAIZ_DAS_ROTAS)),
        `a pasta de rota ${pasta} — ao criá-la (ou apagá-la), corrija PASTAS_DE_ROTA`,
      ).toBe(existe);
    }
  });

  it('os 46 motivos: cada um é escrito por ALGUM outro arquivo (ou está na lista autorizada com razão)', () => {
    const fontes = fontesQuePodemProduzir(['errosPreco.ts']);
    expect(
      membrosSemProdutor(MOTIVO_PRECO_SHOPEE, fontes, ORFAOS_AUTORIZADOS),
      'motivos declarados que NINGUÉM produz e que não estão autorizados',
    ).toEqual([]);
    expect(Object.keys(MOTIVO_PRECO_SHOPEE)).toHaveLength(46);
  });

  it('a lista de órfãos autorizados está VAZIA e não guarda um membro que já ganhou produtor', () => {
    // ⚠️ O CONTEÚDO da lista, fixado: sem esta linha uma autorização nova entra
    // sem que ninguém a note na revisão.
    expect(Object.keys(ORFAOS_AUTORIZADOS)).toEqual([]);
    const fontes = fontesQuePodemProduzir(['errosPreco.ts']);
    expect(
      autorizadosJaProduzidos(MOTIVO_PRECO_SHOPEE, fontes, ORFAOS_AUTORIZADOS),
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
    precoIgual: MOTIVO_PRECO_SHOPEE.precoIgual,
    semLink: MOTIVO_PRECO_SHOPEE.semLink,
  };

  it.each([
    ['o slug entre aspas simples', `motivo: '${MOTIVO_PRECO_SHOPEE.precoIgual}'`],
    ['o slug entre aspas duplas', `motivo: "${MOTIVO_PRECO_SHOPEE.precoIgual}"`],
    ['a chave do const', 'pular(MOTIVO_PRECO_SHOPEE.precoIgual);'],
  ])('PAR: %s conta como produtor', (_rotulo, texto) => {
    const fontes = new Map([['sintetico.ts', texto]]);
    expect(temProdutor(fontes, 'precoIgual', MOTIVO_PRECO_SHOPEE.precoIgual)).toBe(true);
  });

  it.each([
    ['a grafia com sublinhado', "motivo: 'preco_igual'"],
    ['o slug SEM aspas (prosa)', 'o motivo preco-igual aparece só no texto'],
    ['uma chave que só COMEÇA com a do membro', 'MOTIVO_PRECO_SHOPEE.precoIgualAnterior'],
    ['a chave sem o const na frente', 'const precoIgual = 1;'],
  ])('QUASE-MISS: %s NÃO conta como produtor', (_rotulo, texto) => {
    const fontes = new Map([['sintetico.ts', texto]]);
    expect(temProdutor(fontes, 'precoIgual', MOTIVO_PRECO_SHOPEE.precoIgual)).toBe(false);
  });

  it('um membro sem produtor é APONTADO; o mesmo membro autorizado com razão não é', () => {
    const fontes = new Map([['sintetico.ts', 'pular(MOTIVO_PRECO_SHOPEE.precoIgual);']]);
    expect(membrosSemProdutor(recorte, fontes, {})).toEqual([
      `semLink (${MOTIVO_PRECO_SHOPEE.semLink})`,
    ]);
    expect(membrosSemProdutor(recorte, fontes, { semLink: 'uma razão qualquer' })).toEqual([]);
  });

  it('um autorizado que GANHOU produtor é apontado — o teste falha no dia em que isso acontecer', () => {
    const autorizados = { semLink: 'sem produtor no v1, por uma razão de uma linha.' };
    const semProdutor = new Map([['sintetico.ts', 'pular(MOTIVO_PRECO_SHOPEE.precoIgual);']]);
    expect(autorizadosJaProduzidos(recorte, semProdutor, autorizados)).toEqual([]);

    const comProdutor = new Map([
      ['sintetico.ts', 'pular(MOTIVO_PRECO_SHOPEE.precoIgual);'],
      ['novo.ts', 'pular(MOTIVO_PRECO_SHOPEE.semLink);'],
    ]);
    expect(autorizadosJaProduzidos(recorte, comProdutor, autorizados)).toEqual(['semLink']);
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
 * envelope de resposta tipado frouxo é uma string que compila e nunca casa com
 * nada. A dobra iguala separadores e maiúsculas e NADA além disso.
 */
function dobraDeSlug(texto: string): string {
  return texto.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Todo literal `'...'` de uma linha só, que é o formato de um slug. */
const LITERAL_DE_UMA_LINHA = /'([^'\\\r\n]{3,60})'/g;

/** Os 44 slugs do vocabulário, que é o universo do detector. */
function todosOsSlugs(): Set<string> {
  return new Set<string>(Object.values(MOTIVO_PRECO_SHOPEE));
}

/**
 * Um trecho EXATO que dobra para um membro sem ser um motivo — dispensado do
 * detector de quase-membros, com a razão.
 */
interface ExcecaoDeDobra {
  readonly arquivo: string;
  readonly trecho: string;
  readonly razao: string;
}

/**
 * As exceções do detector, cada uma um TRECHO exato de um arquivo — nunca o
 * literal sozinho, para que o MESMO literal em qualquer outro ponto do arquivo
 * continue sendo apontado.
 *
 * ⚠️ A colisão é estrutural, não acidental: a dobra apaga os hífens, e as
 * chaves do const e os campos dos tipos são o camelCase dos slugs — então um
 * NOME de campo entre aspas (um `Pick<>`) dobra igual ao membro. O inverso é o
 * erro real que o detector pega: um `motivo: 'semModelos'` (a chave no lugar
 * do slug) nunca casaria com nada.
 */
const EXCECOES_DE_DOBRA: readonly ExcecaoDeDobra[] = [
  {
    arquivo: 'decisaoPreco.ts',
    trecho: "Pick<ItemDePreco, 'semModelos'>",
    razao:
      'o NOME do campo `semModelos` de `ItemDePreco` num tipo `Pick<>` — uma propriedade do plano, não um motivo.',
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
  excecoes: readonly ExcecaoDeDobra[],
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
      // O piso de 6 caracteres evita casar siglas e códigos curtos por acaso; o
      // menor membro (`reauth`) tem exatamente 6.
      if (dobrado.length < 6) continue;
      const membro = porDobra.get(dobrado);
      if (membro !== undefined) suspeitos.push(`${nome}: '${literal}' ≈ '${membro}'`);
    }
  }
  return suspeitos;
}

/** Literais em posição de `motivo:` que não são membros. */
function motivosForasteiros(
  fontes: ReadonlyMap<string, string>,
  slugs: ReadonlySet<string>,
): string[] {
  const forasteiros: string[] = [];
  for (const [nome, fonte] of fontes) {
    for (const achado of fonte.matchAll(/\bmotivo\s*:\s*'([^'\r\n]*)'/g)) {
      const literal = achado[1] ?? '';
      if (!slugs.has(literal)) forasteiros.push(`${nome}: motivo: '${literal}'`);
    }
  }
  return forasteiros;
}

describe('a dobra de slug: o que ela trata como IGUAL e o que precisa continuar DISTINTO', () => {
  it('PAR igual: `preco_igual`, `Preco-Igual` e `precoigual` dobram todos para `preco-igual`', () => {
    const alvo = dobraDeSlug(MOTIVO_PRECO_SHOPEE.precoIgual);
    expect(dobraDeSlug('preco_igual')).toBe(alvo);
    expect(dobraDeSlug('Preco-Igual')).toBe(alvo);
    expect(dobraDeSlug('precoigual')).toBe(alvo);
  });

  it('QUASE-MISS distinto: `preco-iguais`, `precos-igual` e `preco-invalido` não dobram para `preco-igual`', () => {
    const alvo = dobraDeSlug(MOTIVO_PRECO_SHOPEE.precoIgual);
    // Uma letra a mais é outro motivo, não a mesma coisa escrita diferente.
    expect(dobraDeSlug('preco-iguais')).not.toBe(alvo);
    expect(dobraDeSlug('precos-igual')).not.toBe(alvo);
    expect(dobraDeSlug(MOTIVO_PRECO_SHOPEE.precoInvalido)).not.toBe(alvo);
  });

  it('os 46 slugs dobram para 46 formas distintas', () => {
    // Se dois membros colidissem sob a dobra, o detector apontaria o membro
    // errado numa mensagem de falha — e este é o único lugar que checa isso.
    const slugs = todosOsSlugs();
    const dobras = new Set([...slugs].map(dobraDeSlug));
    expect(slugs.size).toBe(46);
    expect(dobras.size).toBe(slugs.size);
  });

  it('o detector DETECTA: sobre uma fonte sintética, acha o quase-membro e ignora o membro certo', () => {
    const slugs = todosOsSlugs();
    const sintetica = new Map([
      [
        'sintetico.ts',
        [
          `const certo = '${MOTIVO_PRECO_SHOPEE.precoIgual}';`,
          "const errado = 'preco_igual';",
          "const aChave = 'semModelos';",
          "const outro = 'sem-preco';",
          "return { motivo: 'motivo-que-nao-existe' };",
        ].join('\n'),
      ],
    ]);

    // Pega a grafia errada — inclusive a CHAVE usada no lugar do slug…
    expect(quaseMembros(sintetica, slugs, [])).toEqual([
      `sintetico.ts: 'preco_igual' ≈ '${MOTIVO_PRECO_SHOPEE.precoIgual}'`,
      `sintetico.ts: 'semModelos' ≈ '${MOTIVO_PRECO_SHOPEE.semModelos}'`,
    ]);
    // …e a posição tipada frouxa, que é outro mecanismo.
    expect(motivosForasteiros(sintetica, slugs)).toEqual([
      "sintetico.ts: motivo: 'motivo-que-nao-existe'",
    ]);
  });

  it('PAR/QUASE-MISS da exceção: dispensa o TRECHO exato, e o mesmo literal fora dele continua apontado', () => {
    const slugs = todosOsSlugs();
    const excecao: ExcecaoDeDobra = {
      arquivo: 'sintetico.ts',
      trecho: "Pick<X, 'semModelos'>",
      razao: 'um nome de campo num tipo Pick<>, só para o teste.',
    };
    const soOTrecho = new Map([['sintetico.ts', "type T = Pick<X, 'semModelos'>;"]]);
    expect(quaseMembros(soOTrecho, slugs, [excecao])).toEqual([]);

    const trechoEForaDele = new Map([
      ['sintetico.ts', "type T = Pick<X, 'semModelos'>;\nconst m = { motivo: 'semModelos' };"],
    ]);
    expect(quaseMembros(trechoEForaDele, slugs, [excecao])).toEqual([
      `sintetico.ts: 'semModelos' ≈ '${MOTIVO_PRECO_SHOPEE.semModelos}'`,
    ]);
    // A exceção vale só para o SEU arquivo.
    const outroArquivo = new Map([['outro.ts', "type T = Pick<X, 'semModelos'>;"]]);
    expect(quaseMembros(outroArquivo, slugs, [excecao])).toHaveLength(1);
  });
});

describe('nenhum produtor soletra um slug que NÃO é membro', () => {
  it('as exceções da dobra estão FIXADAS, têm razão, e cada trecho ainda existe no seu arquivo', () => {
    // A exceção que perdeu o seu trecho é uma dispensa apontando para o nada —
    // e a próxima pessoa a lê como se ainda protegesse alguma coisa.
    expect(EXCECOES_DE_DOBRA.map((e) => `${e.arquivo}: ${e.trecho}`)).toEqual([
      "decisaoPreco.ts: Pick<ItemDePreco, 'semModelos'>",
    ]);
    const fontes = fontesQuePodemProduzir([]);
    for (const excecao of EXCECOES_DE_DOBRA) {
      expect(
        excecao.razao.length,
        `a exceção ${excecao.trecho} precisa de uma razão`,
      ).toBeGreaterThan(20);
      expect(
        fontes.get(excecao.arquivo)?.includes(excecao.trecho),
        `${excecao.arquivo} não contém mais ${excecao.trecho} — tire a exceção`,
      ).toBe(true);
    }
  });

  it('nenhum literal de uma linha é um quase-membro do vocabulário', () => {
    const fontes = fontesQuePodemProduzir([]);
    expect(fontes.size).toBeGreaterThan(10);
    expect(fontes.has('errosPreco.ts')).toBe(true);

    expect(
      quaseMembros(fontes, todosOsSlugs(), EXCECOES_DE_DOBRA),
      'literais que são a grafia ERRADA de um motivo — nenhum leitor vai casá-los',
    ).toEqual([]);
  });

  it('todo literal em posição de `motivo:` é um membro', () => {
    // A posição em que a união JÁ protegeria — e que por isso é a mais fácil de
    // contornar sem querer, com um `Record<string, unknown>` ou um envelope de
    // resposta tipado frouxo pelo meio.
    const fontes = fontesQuePodemProduzir([]);
    expect(
      motivosForasteiros(fontes, todosOsSlugs()),
      'literais em posição de motivo que não são membros',
    ).toEqual([]);
  });
});

/**
 * O backstop que a onda 3 não pôde escrever: **todo membro do vocabulário de
 * estoque tem um PRODUTOR**, e nenhum produtor soletra um quase-membro.
 *
 * O mecanismo é o `O7` de `../anuncios/errosPublicacao.test.ts`, portado. A
 * lição que ele mecaniza é a mesma: um motivo declarado que ninguém produz é
 * uma promessa que a tela renderiza e o código nunca cumpre — ele compila,
 * passa em todo teste de pareamento chave↔slug, e só aparece quando um operador
 * pergunta por que aquele veredicto nunca sai. `MOTIVO_ESTOQUE_SHOPEE` nasceu
 * com 47 membros e 46 deles sem produtor nenhum (a onda 3 declarou o
 * vocabulário inteiro antes de existir uma única arma que o escrevesse), então
 * este teste era impossível de passar até as ondas 4–6 pousarem. É por isso que
 * ele chega agora e não junto com a declaração.
 *
 * ⚠️ O universo é TEXTO CRU, e tem de ser. O que se quer pegar é um membro sem
 * NENHUMA menção; um `import` não o mostraria (um módulo importa o objeto
 * inteiro, não cada chave) e a checagem de tipos menos ainda (`as const
 * satisfies Record<string, MotivoEstoqueShopee>` prova que todo VALOR é um
 * membro, jamais que todo membro é usado).
 *
 * ⚠️ O arquivo que DECLARA fica FORA do universo, senão a asserção é vácua: a
 * própria união de tipos e a tabela `MENSAGEM_POR_MOTIVO` soletram os 47 slugs
 * em `errosEstoque.ts`, e `MOTIVOS_DE_PAUSA` soletra os 4 em
 * `constantesEstoque.ts`. Cada vocabulário exclui o SEU declarante e mais
 * nenhum — `constantesEstoque.ts` é um produtor legítimo de motivos de estoque,
 * e `errosEstoque.ts`, de motivos de pausa.
 *
 * ⚠️ Este arquivo não lê relógio nenhum e não sobe emulador: ele roda na suíte
 * comum (`pnpm --filter @delfrance/shopee-app test`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MOTIVOS_DE_PAUSA } from './constantesEstoque';
import { MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';

/** A pasta do seam — todos os módulos de estoque moram aqui. */
const RAIZ_ESTOQUE = new URL('./', import.meta.url);

/**
 * A ÚNICA superfície de estoque fora da pasta: a rota do envio manual.
 *
 * Ela produz motivos por conta própria (as duas recusas de guarda e a seleção
 * inválida), então deixá-la de fora transformaria um produtor real em órfão.
 * O script `scripts/enviar-estoque.ts` NÃO entra: ele só re-renderiza o que
 * `enviarEstoqueCli.ts` — que está na pasta — já decidiu.
 */
const ROTA_DO_ENVIO_MANUAL = '../../../app/api/marketplace/shopee/enviar-estoque/route.ts';

/**
 * Todo `*.ts` não-teste da pasta, mais a rota, menos o que o chamador excluir.
 *
 * `*.test.ts` fica fora porque um teste MENCIONA todo membro por construção —
 * incluí-los faria este arquivo se auto-satisfazer na primeira linha.
 */
function fontesQuePodemProduzir(excluir: readonly string[]): Map<string, string> {
  const fontes = new Map<string, string>();
  for (const nome of readdirSync(RAIZ_ESTOQUE)) {
    if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue;
    if (excluir.includes(nome)) continue;
    fontes.set(nome, readFileSync(new URL(nome, RAIZ_ESTOQUE), 'utf8'));
  }
  fontes.set(
    ROTA_DO_ENVIO_MANUAL,
    readFileSync(new URL(ROTA_DO_ENVIO_MANUAL, RAIZ_ESTOQUE), 'utf8'),
  );
  return fontes;
}

/** As três grafias com que um produtor pode escrever um membro. */
function grafiasDe(objeto: string, chave: string, slug: string): readonly string[] {
  return [`'${slug}'`, `"${slug}"`, `${objeto}.${chave}`];
}

/**
 * Os órfãos POR PROJETO, cada um com a razão de uma linha que o autoriza.
 *
 * ⚠️ Uma lista explícita, nunca um `skip` silencioso: a diferença entre "este
 * membro não tem produtor e nós sabemos por quê" e "este membro não tem produtor
 * e ninguém notou" é toda a diferença que este teste existe para marcar. Um
 * membro que ganhar um produtor deve SAIR daqui — a segunda asserção abaixo é o
 * que obriga isso, porque um membro produzido E liberado faz o teste falhar.
 */
const ORFAOS_AUTORIZADOS: Readonly<Record<string, string>> = {
  // Nenhuma banda de categoria viaja no payload v1 da tarefa, então o remetente
  // não importa este motivo em lugar nenhum (um import não usado é erro nos dois
  // portões); um envio genuinamente acima da banda cai no braço K com o código
  // cru da Shopee, como evidência. Documentado em `enviarEstoque.ts`.
  pisoAcimaDaBanda:
    'sem produtor no v1: nenhuma banda viaja na tarefa, e um excesso real vira braço K.',
  // `ShopeeContaNotConfiguredError` não estende `ShopeeError`, então a recusa de
  // `loadShopeeContext` no passo 3 do remetente SOBE da função e é a escada da
  // fila que a reprocessa — ela nunca é arquivada como recusa DO ANÚNCIO. O
  // membro existe para a tela renderizar uma linha que outra superfície venha a
  // escrever. ⚠️ Registrado como achado no relatório da onda 7, não como projeto.
  contaNaoConfigurada:
    'sem produtor: a recusa de contexto sobe da função em vez de virar recusa do anúncio.',
};

describe('todo motivo de estoque declarado tem um PRODUTOR fora de errosEstoque.ts', () => {
  it('os 47 motivos: cada um é escrito por ALGUM outro arquivo (ou está na lista autorizada com razão)', () => {
    const fontes = fontesQuePodemProduzir(['errosEstoque.ts']);
    // Âncoras: se a leitura da pasta falhar, o teste passaria sozinho.
    expect(fontes.size).toBeGreaterThan(10);
    expect(fontes.has(ROTA_DO_ENVIO_MANUAL)).toBe(true);
    expect(fontes.has('enviarEstoque.ts')).toBe(true);
    expect(fontes.has('errosEstoque.ts')).toBe(false);

    const orfaos: string[] = [];
    for (const [chave, slug] of Object.entries(MOTIVO_ESTOQUE_SHOPEE)) {
      const grafias = grafiasDe('MOTIVO_ESTOQUE_SHOPEE', chave, slug);
      const temProdutor = [...fontes.values()].some((fonte) =>
        grafias.some((g) => fonte.includes(g)),
      );
      if (!temProdutor && !(chave in ORFAOS_AUTORIZADOS)) orfaos.push(`${chave} (${slug})`);
    }

    expect(orfaos, 'motivos declarados que NINGUÉM produz e que não estão autorizados').toEqual([]);
    expect(Object.keys(MOTIVO_ESTOQUE_SHOPEE)).toHaveLength(47);
  });

  it('a lista de órfãos autorizados não guarda um membro que JÁ ganhou produtor', () => {
    // ⚠️ A metade que mantém a lista honesta. Sem ela, uma autorização escrita
    // hoje sobrevive para sempre e o membro que finalmente ganhou um produtor
    // continua dispensado de tê-lo — o teste volta a ser um comentário.
    const fontes = fontesQuePodemProduzir(['errosEstoque.ts']);
    const jaProduzidos: string[] = [];
    for (const [chave, razao] of Object.entries(ORFAOS_AUTORIZADOS)) {
      expect(razao.length, `a autorização de ${chave} precisa de uma razão`).toBeGreaterThan(20);
      const slug = MOTIVO_ESTOQUE_SHOPEE[chave as keyof typeof MOTIVO_ESTOQUE_SHOPEE];
      // Uma chave que nem é membro é uma autorização apontando para o nada.
      expect(slug, `${chave} não é membro de MOTIVO_ESTOQUE_SHOPEE`).toBeDefined();
      const grafias = grafiasDe('MOTIVO_ESTOQUE_SHOPEE', chave, slug);
      if ([...fontes.values()].some((fonte) => grafias.some((g) => fonte.includes(g)))) {
        jaProduzidos.push(chave);
      }
    }
    expect(jaProduzidos, 'órfãos autorizados que agora TÊM produtor — tire-os da lista').toEqual(
      [],
    );
  });

  it('os 4 motivos de pausa: cada um é escrito fora de constantesEstoque.ts', () => {
    // ⚠️ Assimetria deliberada com o teste acima: aqui o excluído é
    // `constantesEstoque.ts`, e `errosEstoque.ts` ENTRA no universo. Os dois
    // vocabulários compartilham duas grafias de propósito (`cota-diaria`,
    // `loja-em-ferias`), então excluir o declarante errado deixaria este teste
    // passar pela tabela de mensagens do outro.
    const fontes = fontesQuePodemProduzir(['constantesEstoque.ts']);
    expect(fontes.has('estadoEstoque.ts')).toBe(true);
    expect(fontes.has('constantesEstoque.ts')).toBe(false);

    const orfaos: string[] = [];
    for (const [chave, slug] of Object.entries(MOTIVOS_DE_PAUSA)) {
      const grafias = grafiasDe('MOTIVOS_DE_PAUSA', chave, slug);
      const temProdutor = [...fontes.values()].some((fonte) =>
        grafias.some((g) => fonte.includes(g)),
      );
      if (!temProdutor) orfaos.push(`${chave} (${slug})`);
    }

    expect(orfaos, 'motivos de pausa declarados que NINGUÉM produz').toEqual([]);
    expect(Object.keys(MOTIVOS_DE_PAUSA)).toHaveLength(4);
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
 * pela união; um mesmo erro dentro de uma tabela de mensagens, de um log ou de
 * um envelope de resposta é uma string solta que compila e nunca casa com nada.
 */
function dobraDeSlug(texto: string): string {
  return texto.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Todo literal `'...'` de uma linha só, que é o formato de um slug. */
const LITERAL_DE_UMA_LINHA = /'([^'\\\r\n]{3,60})'/g;

/** Os 49 slugs dos dois vocabulários, que é o universo do detector. */
function todosOsSlugs(): Set<string> {
  return new Set<string>([
    ...Object.values(MOTIVO_ESTOQUE_SHOPEE),
    ...Object.values(MOTIVOS_DE_PAUSA),
  ]);
}

/**
 * Literais que dobram para um membro sem SEREM o membro — a grafia errada.
 *
 * ⚠️ Recebe as fontes por parâmetro, e não as lê, exatamente para que o teste
 * do próprio detector possa alimentá-lo com um arquivo sintético. Um detector
 * que só roda sobre um corpus limpo nunca mostra que detecta.
 */
function quaseMembros(fontes: ReadonlyMap<string, string>, slugs: ReadonlySet<string>): string[] {
  const porDobra = new Map([...slugs].map((s) => [dobraDeSlug(s), s]));
  const suspeitos: string[] = [];
  for (const [nome, fonte] of fontes) {
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

/** Literais em posição de `motivo:` / `pausaMotivo:` que não são membros. */
function motivosForasteiros(
  fontes: ReadonlyMap<string, string>,
  slugs: ReadonlySet<string>,
): string[] {
  const forasteiros: string[] = [];
  for (const [nome, fonte] of fontes) {
    for (const achado of fonte.matchAll(/\b(motivo|pausaMotivo)\s*:\s*'([^'\r\n]*)'/g)) {
      const literal = achado[2] ?? '';
      if (!slugs.has(literal)) forasteiros.push(`${nome}: ${achado[1] ?? '?'}: '${literal}'`);
    }
  }
  return forasteiros;
}

describe('a dobra de slug: o que ela trata como IGUAL e o que precisa continuar DISTINTO', () => {
  it('PAR igual: `conta_pausada`, `Conta-Pausada` e `contapausada` dobram todos para `conta-pausada`', () => {
    const alvo = dobraDeSlug(MOTIVO_ESTOQUE_SHOPEE.contaPausada);
    expect(dobraDeSlug('conta_pausada')).toBe(alvo);
    expect(dobraDeSlug('Conta-Pausada')).toBe(alvo);
    expect(dobraDeSlug('contapausada')).toBe(alvo);
  });

  it('QUASE-MISS distinto: `conta-pausadas`, `contas-pausada` e `sem-link` não dobram para `conta-pausada`', () => {
    const alvo = dobraDeSlug(MOTIVO_ESTOQUE_SHOPEE.contaPausada);
    // Uma letra a mais é outro motivo, não a mesma coisa escrita diferente — a
    // dobra some com separadores e maiúsculas, e com NADA além disso.
    expect(dobraDeSlug('conta-pausadas')).not.toBe(alvo);
    expect(dobraDeSlug('contas-pausada')).not.toBe(alvo);
    expect(dobraDeSlug(MOTIVO_ESTOQUE_SHOPEE.semLink)).not.toBe(alvo);
  });

  it('os 49 slugs dos dois vocabulários dobram para 49 formas distintas', () => {
    // Se dois membros colidissem sob a dobra, o detector abaixo apontaria o
    // membro errado numa mensagem de falha — e este é o único lugar em que essa
    // premissa é checada.
    const slugs = todosOsSlugs();
    const dobras = new Set([...slugs].map(dobraDeSlug));
    expect(slugs.size).toBe(49);
    expect(dobras.size).toBe(slugs.size);
  });

  it('o detector DETECTA: sobre uma fonte sintética, acha o quase-membro e ignora o membro certo', () => {
    // ⚠️ A prova de que as duas asserções seguintes não são vácuas. Elas correm
    // sobre um corpus limpo, e um corpus limpo é exatamente o que um detector
    // quebrado também produz. Aqui o detector recebe um arquivo inventado —
    // nenhum arquivo do repositório é tocado — com as três formas de uma vez.
    const slugs = todosOsSlugs();
    const sintetica = new Map([
      [
        'sintetico.ts',
        [
          `const certo = '${MOTIVO_ESTOQUE_SHOPEE.contaPausada}';`,
          "const errado = 'conta_pausada';",
          "const outro = 'sem-conta';",
          "return { motivo: 'motivo-que-nao-existe' };",
        ].join('\n'),
      ],
    ]);

    // Pega a grafia errada…
    expect(quaseMembros(sintetica, slugs)).toEqual([
      `sintetico.ts: 'conta_pausada' ≈ '${MOTIVO_ESTOQUE_SHOPEE.contaPausada}'`,
    ]);
    // …e a posição tipada frouxa, que é outro mecanismo.
    expect(motivosForasteiros(sintetica, slugs)).toEqual([
      "sintetico.ts: motivo: 'motivo-que-nao-existe'",
    ]);
  });
});

describe('nenhum produtor soletra um slug que NÃO é membro', () => {
  it('nenhum literal de uma linha é um quase-membro dos dois vocabulários', () => {
    const fontes = fontesQuePodemProduzir([]);
    expect(fontes.size).toBeGreaterThan(10);

    expect(
      quaseMembros(fontes, todosOsSlugs()),
      'literais que são a grafia ERRADA de um motivo — nenhum leitor vai casá-los',
    ).toEqual([]);
  });

  it('todo literal em posição de `motivo:` / `pausaMotivo:` é um membro', () => {
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

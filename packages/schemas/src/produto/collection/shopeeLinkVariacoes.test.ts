import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Importado pelo BARREL de propósito: a prova de que a linha `export *` em
// `produto/index.ts` (e, por ela, a raiz `src/index.ts`) alcança o schema novo.
import {
  camposRecusados,
  chaveDaEntradaShopee,
  ehEntradaShopeeDaChave,
  grupoDeVariacoesSchema,
  idDoRef,
  linkVariacaoOpcaoShopeeSchema,
  linkVariacoesShopeeSchema,
  nomeDeTierShopee,
  resolverEntradaShopeeDoGrupo,
  type LinkVariacoesShopee,
  type ResolucaoEntradaShopeeDoGrupo,
} from '../../index';

/**
 * O elemento legado, verbatim do formulário Flutter
 * (`.old/packages/produtos/lib/src/models.dart:5190-5263`): `variation_id` e
 * `variation_group_list` ZERO (tudo custom fora de Fashion, `faq 288`), o
 * `integracaoShopeeId` como id NU, e duas opções com `arakene_variation_id`
 * como LISTA.
 */
const ELEMENTO_LEGADO = {
  name: 'Roupas',
  category_id: 100015,
  variation_id: 0,
  variation_group_list: 0,
  integracaoShopeeId: 'int-1',
  variationOptions: [
    { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: ['v1', 'v2'] },
    { shopee_option_id: 0, shopee_option_name: 'Vermelho', arakene_variation_id: ['v3'] },
  ],
};

describe('linkVariacoesShopeeSchema', () => {
  it('faz round-trip byte a byte de um elemento no formato legado', () => {
    const parsed = linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO);
    expect(parsed).toEqual(ELEMENTO_LEGADO);
  });

  it('aceita ids não-zero em todos os níveis', () => {
    const naoZero = {
      ...ELEMENTO_LEGADO,
      variation_id: 100015,
      variation_group_list: 200030,
      variationOptions: [
        { shopee_option_id: 300045, shopee_option_name: 'Azul', arakene_variation_id: ['v1'] },
      ],
    };
    expect(linkVariacoesShopeeSchema.parse(naoZero)).toEqual(naoZero);
  });

  it('⛔ NEAR-MISS: variation_group_list como ARRAY é recusado (o plural mente — é escalar)', () => {
    expect(
      linkVariacoesShopeeSchema.safeParse({ ...ELEMENTO_LEGADO, variation_group_list: [0] })
        .success,
    ).toBe(false);
    expect(
      linkVariacoesShopeeSchema.safeParse({ ...ELEMENTO_LEGADO, variation_group_list: [1, 2] })
        .success,
    ).toBe(false);
    // e o escalar zero continua sendo um VALOR aceito
    expect(linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO).variation_group_list).toBe(0);
  });

  it('integracaoShopeeId em branco é recusado', () => {
    expect(
      linkVariacoesShopeeSchema.safeParse({ ...ELEMENTO_LEGADO, integracaoShopeeId: '' }).success,
    ).toBe(false);
  });

  it('integracaoShopeeId com prefixo documents/ é ACEITO e guardado como veio (nunca normalizado)', () => {
    // Trap 2 fixado nos dois sentidos: o campo é um id NU no corpus legado, mas
    // normalizar (ou recusar) um valor já gravado com caminho orfanaria a entrada
    // que o operador escreveu. O schema só guarda a string.
    const comCaminho = { ...ELEMENTO_LEGADO, integracaoShopeeId: 'documents/integracao/int-1' };
    const parsed = linkVariacoesShopeeSchema.parse(comCaminho);
    expect(parsed.integracaoShopeeId).toBe('documents/integracao/int-1');
    expect(linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO).integracaoShopeeId).toBe('int-1');
  });

  it('⛔ NEAR-MISS: arakene_variation_id como string solta é recusado (é uma LISTA)', () => {
    expect(
      linkVariacaoOpcaoShopeeSchema.safeParse({
        shopee_option_id: 0,
        shopee_option_name: 'Azul',
        arakene_variation_id: 'v1',
      }).success,
    ).toBe(false);
    expect(
      linkVariacaoOpcaoShopeeSchema.parse({
        shopee_option_id: 0,
        shopee_option_name: 'Azul',
        arakene_variation_id: ['v1'],
      }).arakene_variation_id,
    ).toEqual(['v1']);
  });

  it('recusa uma chave desconhecida no elemento e na opção', () => {
    expect(
      linkVariacoesShopeeSchema.safeParse({
        ...ELEMENTO_LEGADO,
        _campoFuturo: 'x',
      }).success,
    ).toBe(false);
    expect(
      linkVariacoesShopeeSchema.safeParse({
        ...ELEMENTO_LEGADO,
        variationOptions: [
          {
            shopee_option_id: 0,
            shopee_option_name: 'Azul',
            arakene_variation_id: ['v1'],
            _extraDaOpcao: 'y',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('variationOptions ausente vira lista vazia', () => {
    const { variationOptions: _ignorado, ...semOpcoes } = ELEMENTO_LEGADO;
    expect(linkVariacoesShopeeSchema.parse(semOpcoes).variationOptions).toEqual([]);
  });

  it('o tipo inferido descreve o elemento legado', () => {
    const tipado: LinkVariacoesShopee = linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO);
    expect(tipado.variationOptions[0]?.arakene_variation_id).toEqual(['v1', 'v2']);
  });
});

describe('grupoDeVariacoesSchema.linksVariacoesShopee', () => {
  it('usa o schema Shopee tipado e estrito', () => {
    const parsed = grupoDeVariacoesSchema.parse({
      nome: 'Cor',
      linksVariacoesShopee: [ELEMENTO_LEGADO],
    });
    expect(parsed.linksVariacoesShopee).toEqual([ELEMENTO_LEGADO]);
    expect(
      grupoDeVariacoesSchema.safeParse({
        nome: 'Cor',
        linksVariacoesShopee: [{ ...ELEMENTO_LEGADO, lixo: true }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A chave do vínculo (#1911, D12): UM predicado, três chamadores (o publicador
// em `tiersPublicacao.ts`, o merge do import em `taxonomiaShopeeCore.ts` e o
// editor de vínculos do `/variacoes`). Cada dobra é fixada dos DOIS lados: o
// par que tem de casar e o quase-igual que tem de continuar distinto.
// ---------------------------------------------------------------------------

const CONTA = 'int-1';
const CATEGORIA = 100015;

/** Um elemento LEGÍVEL da chave (CONTA, CATEGORIA), padronizado (ids não-zero). */
function entradaDaChave(sobre: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...ELEMENTO_LEGADO, variation_id: 77, variation_group_list: 42, ...sobre };
}

/** O mesmo elemento, RECUSADO pelo schema (o caso fixado em `tiersPublicacao.test.ts`). */
function recusadoDaChave(sobre: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...entradaDaChave(sobre), variation_group_list: [1, 2] };
}

const PERSONALIZADA: ResolucaoEntradaShopeeDoGrupo = { tipo: 'personalizada-implicita' };

describe('ehEntradaShopeeDaChave — a dobra da conta e da categoria', () => {
  it('IGUAIS: o id nu e toda forma de caminho cujo último segmento é a conta', () => {
    for (const integracaoShopeeId of [
      'int-1',
      'documents/integracao/int-1',
      'integracao/int-1',
      'int-1/',
      '/documents/integracao/int-1/',
    ]) {
      expect(
        ehEntradaShopeeDaChave({ category_id: CATEGORIA, integracaoShopeeId }, CONTA, CATEGORIA),
        integracaoShopeeId,
      ).toBe(true);
    }
  });

  it('⛔ NEAR-MISS: int-12 NÃO é int-1, nos dois sentidos — segmento inteiro, nunca prefixo, sufixo ou substring', () => {
    for (const integracaoShopeeId of [
      'int-12',
      'documents/integracao/int-12',
      'xint-1',
      'int-1x',
      'documents/integracao/int-1/modelo',
    ]) {
      expect(
        ehEntradaShopeeDaChave({ category_id: CATEGORIA, integracaoShopeeId }, CONTA, CATEGORIA),
        integracaoShopeeId,
      ).toBe(false);
    }
    // o sentido inverso: a conta pedida é mais longa, ou um pedaço da armazenada
    for (const integracaoId of ['int-12', 'int', 'nt-1', 'int-']) {
      expect(
        ehEntradaShopeeDaChave(
          { category_id: CATEGORIA, integracaoShopeeId: 'int-1' },
          integracaoId,
          CATEGORIA,
        ),
        integracaoId,
      ).toBe(false);
    }
    // e o par exato continua casando
    expect(
      ehEntradaShopeeDaChave(
        { category_id: CATEGORIA, integracaoShopeeId: 'int-12' },
        'int-12',
        CATEGORIA,
      ),
    ).toBe(true);
  });

  it('⛔ NEAR-MISS: caixa e espaço NÃO dobram (idDoRef preserva os dois)', () => {
    for (const integracaoShopeeId of [
      ' int-1',
      'int-1 ',
      'INT-1',
      'Int-1',
      'documents/integracao/ int-1',
    ]) {
      expect(
        ehEntradaShopeeDaChave({ category_id: CATEGORIA, integracaoShopeeId }, CONTA, CATEGORIA),
        JSON.stringify(integracaoShopeeId),
      ).toBe(false);
    }
  });

  it('⛔ NEAR-MISS: um id em branco, ausente ou que não é string não nomeia conta nenhuma', () => {
    for (const integracaoShopeeId of [
      '',
      '/',
      'documents',
      undefined,
      null,
      1,
      ['int-1'],
      { id: 'int-1' },
    ]) {
      expect(
        ehEntradaShopeeDaChave({ category_id: CATEGORIA, integracaoShopeeId }, CONTA, CATEGORIA),
        JSON.stringify(integracaoShopeeId),
      ).toBe(false);
    }
    expect(ehEntradaShopeeDaChave({ category_id: CATEGORIA }, CONTA, CATEGORIA)).toBe(false);
    // um integracaoId vazio não casa nada — nem um armazenado vazio
    expect(
      ehEntradaShopeeDaChave({ category_id: CATEGORIA, integracaoShopeeId: '' }, '', CATEGORIA),
    ).toBe(false);
    expect(
      ehEntradaShopeeDaChave(
        { category_id: CATEGORIA, integracaoShopeeId: 'int-1' },
        '',
        CATEGORIA,
      ),
    ).toBe(false);
  });

  it('só o lado ARMAZENADO dobra: um integracaoId em forma de caminho não casa (o chamador passa o id nu)', () => {
    expect(
      ehEntradaShopeeDaChave(
        { category_id: CATEGORIA, integracaoShopeeId: 'int-1' },
        'documents/integracao/int-1',
        CATEGORIA,
      ),
    ).toBe(false);
    expect(
      ehEntradaShopeeDaChave(
        { category_id: CATEGORIA, integracaoShopeeId: 'documents/integracao/int-1' },
        'documents/integracao/int-1',
        CATEGORIA,
      ),
    ).toBe(false);
  });

  it('⛔ NEAR-MISS: a categoria é comparada EXATA — outro número, string numérica ou ausência não casam', () => {
    expect(
      ehEntradaShopeeDaChave(
        { category_id: CATEGORIA, integracaoShopeeId: CONTA },
        CONTA,
        CATEGORIA,
      ),
    ).toBe(true);
    for (const category_id of [100016, 10001, '100015', null, undefined, [100015]]) {
      expect(
        ehEntradaShopeeDaChave({ category_id, integracaoShopeeId: CONTA }, CONTA, CATEGORIA),
        JSON.stringify(category_id),
      ).toBe(false);
    }
  });

  it('lê o elemento PARSEADO e o cru do mesmo jeito', () => {
    const parseado: LinkVariacoesShopee = linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO);
    expect(ehEntradaShopeeDaChave(parseado, CONTA, CATEGORIA)).toBe(true);
    expect(ehEntradaShopeeDaChave(ELEMENTO_LEGADO, CONTA, CATEGORIA)).toBe(true);
    expect(ehEntradaShopeeDaChave(recusadoDaChave(), CONTA, CATEGORIA)).toBe(true);
  });
});

/** The key of a stored conta spelling and a stored category, read off an otherwise empty element. */
function chaveDe(integracaoShopeeId: unknown, category_id: unknown = CATEGORIA) {
  return chaveDaEntradaShopee({ category_id, integracaoShopeeId });
}

describe('chaveDaEntradaShopee — a chave (conta, categoria) que o elemento nomeia', () => {
  it('o id nu: a conta como veio e a categoria exata, e nada mais', () => {
    expect(chaveDe('int-1')).toEqual({ integracaoId: 'int-1', categoryId: CATEGORIA });
  });

  it('IGUAIS: toda forma de caminho dobra para o último segmento — a MESMA chave do id nu, inclusive em JSON', () => {
    const doIdNu = chaveDe('int-1');
    for (const integracaoShopeeId of [
      'documents/integracao/int-1',
      'integracao/int-1',
      'int-1/',
      '/documents/integracao/int-1/',
    ]) {
      const chave = chaveDe(integracaoShopeeId);
      expect(chave, integracaoShopeeId).toEqual(doIdNu);
      // The web editor keys its entries by this JSON, so one key must be one string.
      expect(JSON.stringify(chave), integracaoShopeeId).toBe(JSON.stringify(doIdNu));
    }
  });

  it('⛔ NEAR-MISS: int-12 NÃO é int-1, nos dois sentidos — segmento inteiro, nunca prefixo, sufixo ou substring', () => {
    for (const [integracaoShopeeId, conta] of [
      ['int-12', 'int-12'],
      ['documents/integracao/int-12', 'int-12'],
      ['xint-1', 'xint-1'],
      ['int-1x', 'int-1x'],
      // The recorded widening: only the last segment is read.
      ['documents/integracao/int-1/modelo', 'modelo'],
    ] as const) {
      expect(chaveDe(integracaoShopeeId), integracaoShopeeId).toEqual({
        integracaoId: conta,
        categoryId: CATEGORIA,
      });
    }
    expect(chaveDe('int-12')).not.toEqual(chaveDe('int-1'));
    expect(chaveDe('int-1')).not.toEqual(chaveDe('documents/integracao/int-12'));
  });

  it('⛔ NEAR-MISS: caixa e espaço NÃO dobram — cada grafia é outra conta, e só espaço não é "em branco"', () => {
    for (const [integracaoShopeeId, conta] of [
      [' int-1', ' int-1'],
      ['int-1 ', 'int-1 '],
      ['INT-1', 'INT-1'],
      ['Int-1', 'Int-1'],
      ['documents/integracao/ int-1', ' int-1'],
      ['   ', '   '],
    ] as const) {
      const chave = chaveDe(integracaoShopeeId);
      expect(chave, JSON.stringify(integracaoShopeeId)).toEqual({
        integracaoId: conta,
        categoryId: CATEGORIA,
      });
      expect(chave, JSON.stringify(integracaoShopeeId)).not.toEqual(chaveDe('int-1'));
    }
  });

  it('⛔ NEAR-MISS: conta em branco, ausente ou que não é string ⇒ null', () => {
    for (const integracaoShopeeId of [
      '',
      '/',
      '//',
      'documents',
      'documents/',
      undefined,
      null,
      1,
      ['int-1'],
      { id: 'int-1' },
    ]) {
      expect(chaveDe(integracaoShopeeId), JSON.stringify(integracaoShopeeId)).toBeNull();
    }
    expect(chaveDaEntradaShopee({ category_id: CATEGORIA })).toBeNull();
    expect(chaveDaEntradaShopee({})).toBeNull();
  });

  it('⛔ NEAR-MISS: categoria 100352 é chave ⟷ a string 100352, ou a ausência, é null — nunca coagida', () => {
    expect(chaveDe('int-1', 100352)).toEqual({ integracaoId: 'int-1', categoryId: 100352 });
    expect(chaveDe('int-1', 100353)).not.toEqual(chaveDe('int-1', 100352));
    for (const category_id of ['100352', '', null, [100352], { id: 100352 }, true]) {
      expect(chaveDe('int-1', category_id), JSON.stringify(category_id)).toBeNull();
    }
    expect(chaveDaEntradaShopee({ integracaoShopeeId: 'int-1' })).toBeNull();
  });

  it('0 é um VALOR, nunca uma ausência; um número quebrado que o schema recusa ainda nomeia a categoria', () => {
    expect(chaveDe('int-1', 0)).toEqual({ integracaoId: 'int-1', categoryId: 0 });
    // The refused element must stay attributable, or the publisher would read it as no binding at all.
    expect(chaveDe('int-1', 1.5)).toEqual({ integracaoId: 'int-1', categoryId: 1.5 });
    expect(
      resolverEntradaShopeeDoGrupo([entradaDaChave({ category_id: 1.5 })], CONTA, 1.5).tipo,
    ).toBe('ilegivel');
  });

  it('⛔ NEAR-MISS: NaN e ±Infinity têm typeof number e não nomeiam categoria (em JSON, os três seriam o mesmo null)', () => {
    for (const category_id of [NaN, Infinity, -Infinity]) {
      expect(chaveDe('int-1', category_id), String(category_id)).toBeNull();
      expect(
        ehEntradaShopeeDaChave({ category_id, integracaoShopeeId: 'int-1' }, CONTA, category_id),
        String(category_id),
      ).toBe(false);
    }
  });

  it('lê o elemento PARSEADO, o cru e o RECUSADO do mesmo jeito, e não muta nenhum', () => {
    const esperada = { integracaoId: CONTA, categoryId: CATEGORIA };
    const parseado: LinkVariacoesShopee = linkVariacoesShopeeSchema.parse(ELEMENTO_LEGADO);
    expect(chaveDaEntradaShopee(parseado)).toEqual(esperada);
    expect(chaveDaEntradaShopee(Object.freeze({ ...ELEMENTO_LEGADO }))).toEqual(esperada);
    expect(chaveDaEntradaShopee(Object.freeze(recusadoDaChave()))).toEqual(esperada);
    // The stored value keeps its spelling: only the key is folded (trap 2).
    const comCaminho = recusadoDaChave({ integracaoShopeeId: 'documents/integracao/int-1' });
    expect(chaveDaEntradaShopee(comCaminho)).toEqual(esperada);
    expect(comCaminho['integracaoShopeeId']).toBe('documents/integracao/int-1');
  });

  // Every stored spelling the suite above pins, crossed with every pair a caller might ask about.
  const CONTAS_ARMAZENADAS: readonly unknown[] = [
    'int-1',
    'documents/integracao/int-1',
    'integracao/int-1',
    'int-1/',
    '/documents/integracao/int-1/',
    'int-12',
    'documents/integracao/int-12',
    'xint-1',
    'int-1x',
    'documents/integracao/int-1/modelo',
    ' int-1',
    'int-1 ',
    'INT-1',
    'Int-1',
    'documents/integracao/ int-1',
    '',
    '/',
    'documents',
    undefined,
    null,
    1,
    ['int-1'],
    { id: 'int-1' },
  ];
  const CATEGORIAS_ARMAZENADAS: readonly unknown[] = [
    CATEGORIA,
    100016,
    10001,
    0,
    1.5,
    '100015',
    null,
    undefined,
    [CATEGORIA],
    NaN,
    Infinity,
    -Infinity,
  ];
  const CONTAS_PEDIDAS: readonly string[] = [
    'int-1',
    'int-12',
    'int',
    'nt-1',
    'int-',
    '',
    'documents/integracao/int-1',
    'INT-1',
    ' int-1',
    'modelo',
  ];
  const CATEGORIAS_PEDIDAS: readonly number[] = [CATEGORIA, 100016, 10001, 0, 1.5, NaN];

  it('A MATRIZ: ehEntradaShopeeDaChave(e, c, k) ⇔ a chave de e é {c, k}, célula a célula, e a grafia que o P14 substituiu (#1911 P7) responde o mesmo', () => {
    const divergencias: string[] = [];
    let casamentos = 0;
    for (const base of [ELEMENTO_LEGADO, entradaDaChave(), recusadoDaChave()]) {
      for (const integracaoShopeeId of CONTAS_ARMAZENADAS) {
        for (const category_id of CATEGORIAS_ARMAZENADAS) {
          const e = { ...base, integracaoShopeeId, category_id };
          const chave = chaveDaEntradaShopee(e);
          // A key always answers for itself, including a pair the lists below never ask about.
          if (chave !== null && !ehEntradaShopeeDaChave(e, chave.integracaoId, chave.categoryId)) {
            divergencias.push(`a chave não casa consigo: ${JSON.stringify(chave)}`);
          }
          for (const conta of CONTAS_PEDIDAS) {
            for (const categoria of CATEGORIAS_PEDIDAS) {
              const responde = ehEntradaShopeeDaChave(e, conta, categoria);
              const chaveIgual =
                chave !== null && chave.integracaoId === conta && chave.categoryId === categoria;
              // The spelling this function replaced, kept as the neutrality oracle for apps/shopee.
              const grafiaAnterior =
                category_id === categoria && idDoRef(integracaoShopeeId) === conta;
              if (responde !== chaveIgual || responde !== grafiaAnterior) {
                divergencias.push(
                  JSON.stringify({
                    conta: integracaoShopeeId,
                    categoria: String(category_id),
                    pedido: [conta, String(categoria)],
                    responde,
                    chaveIgual,
                    grafiaAnterior,
                  }),
                );
              }
              if (responde) casamentos += 1;
            }
          }
        }
      }
    }
    expect(divergencias).toEqual([]);
    // 3 bases × 11 (stored conta, asked conta) pairs × 5 (stored category, asked category) pairs.
    // Pinned so the matrix cannot pass by never matching at all.
    expect(casamentos).toBe(165);
  });
});

describe('resolverEntradaShopeeDoGrupo — armazenada | ilegivel | personalizada-implicita', () => {
  it('sem lista, lista vazia ou um valor que não é lista ⇒ personalizada-implicita', () => {
    // Os dois leitores (publicarAnuncio.ts e o lerGrupo do import) já leem uma
    // não-lista como `null`; esta função responde o mesmo que eles entregam.
    for (const links of [undefined, null, [], {}, 'int-1', 0, { 0: ELEMENTO_LEGADO, length: 1 }]) {
      expect(resolverEntradaShopeeDoGrupo(links, CONTA, CATEGORIA), JSON.stringify(links)).toEqual(
        PERSONALIZADA,
      );
    }
  });

  it('armazenada: o elemento legível da chave, com o índice e o dado PARSEADO', () => {
    const { variationOptions: _ignorado, ...semOpcoes } = entradaDaChave();
    const outraConta = entradaDaChave({ integracaoShopeeId: 'int-2' });
    const r = resolverEntradaShopeeDoGrupo([outraConta, semOpcoes], CONTA, CATEGORIA);
    expect(r).toEqual({
      tipo: 'armazenada',
      indice: 1,
      entrada: { ...semOpcoes, variationOptions: [] },
    });
  });

  it('armazenada: o PRIMEIRO legível da chave vence — um gêmeo mais abaixo nunca é lido', () => {
    const primeiro = entradaDaChave({ variation_id: 77 });
    const gemeo = entradaDaChave({
      variation_id: 88,
      integracaoShopeeId: 'documents/integracao/int-1',
    });
    const r = resolverEntradaShopeeDoGrupo([primeiro, gemeo], CONTA, CATEGORIA);
    expect(r.tipo === 'armazenada' && [r.indice, r.entrada.variation_id]).toEqual([0, 77]);
    // invertida a ordem, o gêmeo em forma de caminho É a entrada
    const inv = resolverEntradaShopeeDoGrupo([gemeo, primeiro], CONTA, CATEGORIA);
    expect(inv.tipo === 'armazenada' && [inv.indice, inv.entrada.variation_id]).toEqual([0, 88]);
  });

  it('⛔ NEAR-MISS: a entrada de OUTRA conta para a mesma categoria ⇒ personalizada (int-12 ≠ int-1)', () => {
    expect(
      resolverEntradaShopeeDoGrupo(
        [entradaDaChave({ integracaoShopeeId: 'int-12' })],
        CONTA,
        CATEGORIA,
      ),
    ).toEqual(PERSONALIZADA);
    expect(
      resolverEntradaShopeeDoGrupo(
        [entradaDaChave({ integracaoShopeeId: 'documents/integracao/int-12' })],
        CONTA,
        CATEGORIA,
      ),
    ).toEqual(PERSONALIZADA);
  });

  it('…⟷ documents/integracao/int-1 ≡ int-1 ⇒ armazenada', () => {
    const comCaminho = entradaDaChave({ integracaoShopeeId: 'documents/integracao/int-1' });
    const r = resolverEntradaShopeeDoGrupo([comCaminho], CONTA, CATEGORIA);
    expect(r.tipo).toBe('armazenada');
    // o valor armazenado é devolvido como veio — nunca normalizado (trap 2)
    expect(r.tipo === 'armazenada' && r.entrada.integracaoShopeeId).toBe(
      'documents/integracao/int-1',
    );
  });

  it('⛔ NEAR-MISS: a entrada da MESMA conta para OUTRA categoria ⇒ personalizada', () => {
    const outraCategoria = entradaDaChave({ category_id: 100016 });
    expect(resolverEntradaShopeeDoGrupo([outraCategoria], CONTA, CATEGORIA)).toEqual(PERSONALIZADA);
    expect(resolverEntradaShopeeDoGrupo([outraCategoria], CONTA, 100016).tipo).toBe('armazenada');
  });

  it('uma entrada ARMAZENADA com variation_id 0 (o legado, ou o que o import escreve) é armazenada — nunca personalizada-implicita', () => {
    // Q2 (Round 3): o guarda do tier personalizado não pareado lê as DUAS formas,
    // então o resolvedor não pode fundi-las — quem decide é o publicador.
    const r = resolverEntradaShopeeDoGrupo([ELEMENTO_LEGADO], CONTA, CATEGORIA);
    expect(r).toEqual({ tipo: 'armazenada', indice: 0, entrada: ELEMENTO_LEGADO });
    expect(r.tipo === 'armazenada' && r.entrada.variation_id).toBe(0);
  });

  it('ilegivel: um elemento RECUSADO que nomeia a chave ⇒ ilegivel, NUNCA o fallback personalizado (DB F3)', () => {
    expect(resolverEntradaShopeeDoGrupo([recusadoDaChave()], CONTA, CATEGORIA)).toEqual({
      tipo: 'ilegivel',
      indice: 0,
      campos: ['variation_group_list'],
    });
  });

  it('…⟷ o MESMO elemento recusado, de outra conta ou de outra categoria ⇒ personalizada', () => {
    expect(
      resolverEntradaShopeeDoGrupo(
        [recusadoDaChave({ integracaoShopeeId: 'int-12' })],
        CONTA,
        CATEGORIA,
      ),
    ).toEqual(PERSONALIZADA);
    expect(
      resolverEntradaShopeeDoGrupo([recusadoDaChave({ category_id: 100016 })], CONTA, CATEGORIA),
    ).toEqual(PERSONALIZADA);
  });

  it('ilegivel: a dobra vale também no elemento cru (caminho com documents/)', () => {
    const r = resolverEntradaShopeeDoGrupo(
      [recusadoDaChave({ integracaoShopeeId: 'documents/integracao/int-1' })],
      CONTA,
      CATEGORIA,
    );
    expect(r).toEqual({ tipo: 'ilegivel', indice: 0, campos: ['variation_group_list'] });
  });

  it('a ORDEM: um recusado ANTES de um legível da chave não esconde o legível', () => {
    const legivel = entradaDaChave();
    const antes = resolverEntradaShopeeDoGrupo([recusadoDaChave(), legivel], CONTA, CATEGORIA);
    expect(antes.tipo === 'armazenada' && antes.indice).toBe(1);
    const depois = resolverEntradaShopeeDoGrupo([legivel, recusadoDaChave()], CONTA, CATEGORIA);
    expect(depois.tipo === 'armazenada' && depois.indice).toBe(0);
  });

  it('dois recusados da chave ⇒ ilegivel com o índice e os campos do PRIMEIRO', () => {
    const comLixo = { ...entradaDaChave(), lixo: true };
    const r = resolverEntradaShopeeDoGrupo(
      [entradaDaChave({ integracaoShopeeId: 'int-2' }), comLixo, recusadoDaChave()],
      CONTA,
      CATEGORIA,
    );
    expect(r).toEqual({ tipo: 'ilegivel', indice: 1, campos: ['lixo'] });
  });

  it('campos: cada campo recusado como caminho pontuado, na ordem do zod; a chave desconhecida é nomeada por si', () => {
    const quebrado = {
      ...entradaDaChave(),
      variation_id: 'x',
      variation_group_list: [1],
      lixo: true,
      outroLixo: 1,
      variationOptions: [
        { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: ['v1'] },
        {
          shopee_option_id: 0,
          shopee_option_name: 'Vermelho',
          arakene_variation_id: 'v3',
          extraDaOpcao: 1,
        },
      ],
    };
    const r = resolverEntradaShopeeDoGrupo([quebrado], CONTA, CATEGORIA);
    expect(r.tipo).toBe('ilegivel');
    expect(r.tipo === 'ilegivel' && r.campos).toEqual([
      'variation_id',
      'variation_group_list',
      'variationOptions.1.arakene_variation_id',
      'variationOptions.1.extraDaOpcao',
      'lixo',
      'outroLixo',
    ]);
  });

  it('elementos que não são objeto, ou que não nomeiam conta (id ausente ou em branco), nunca são ilegivel', () => {
    const { integracaoShopeeId: _semConta, ...semConta } = recusadoDaChave();
    const links = [
      null,
      'int-1',
      42,
      [ELEMENTO_LEGADO],
      semConta,
      { ...entradaDaChave(), integracaoShopeeId: '' },
      { ...recusadoDaChave(), integracaoShopeeId: 'documents' },
    ];
    expect(resolverEntradaShopeeDoGrupo(links, CONTA, CATEGORIA)).toEqual(PERSONALIZADA);
  });

  it('⛔ NEAR-MISS: um category_id STRING (100015 entre aspas) não nomeia a categoria — o mesmo predicado do elemento legível', () => {
    expect(
      resolverEntradaShopeeDoGrupo(
        [{ ...entradaDaChave(), category_id: '100015' }],
        CONTA,
        CATEGORIA,
      ),
    ).toEqual(PERSONALIZADA);
    expect(
      resolverEntradaShopeeDoGrupo(
        [{ ...recusadoDaChave(), category_id: '100015' }],
        CONTA,
        CATEGORIA,
      ),
    ).toEqual(PERSONALIZADA);
  });

  it('não muta o array nem os elementos', () => {
    const elementos = [
      Object.freeze(recusadoDaChave()),
      Object.freeze({ ...ELEMENTO_LEGADO, variationOptions: Object.freeze([]) }),
    ];
    const links = Object.freeze(elementos);
    const antes = JSON.stringify(links);
    expect(resolverEntradaShopeeDoGrupo(links, CONTA, CATEGORIA).tipo).toBe('armazenada');
    expect(JSON.stringify(links)).toBe(antes);
  });

  it('aceita a lista do grupo PARSEADO e o union estreita por tipo', () => {
    const grupo = grupoDeVariacoesSchema.parse({
      nome: 'Cor',
      linksVariacoesShopee: [ELEMENTO_LEGADO],
    });
    const rotulo = (r: ResolucaoEntradaShopeeDoGrupo): string => {
      switch (r.tipo) {
        case 'armazenada':
          return `armazenada:${r.indice}:${r.entrada.variation_id}`;
        case 'ilegivel':
          return `ilegivel:${r.indice}:${r.campos.join(',')}`;
        case 'personalizada-implicita':
          return 'personalizada-implicita';
      }
    };
    expect(rotulo(resolverEntradaShopeeDoGrupo(grupo.linksVariacoesShopee, CONTA, CATEGORIA))).toBe(
      'armazenada:0:0',
    );
    expect(
      rotulo(resolverEntradaShopeeDoGrupo(grupo.linksVariacoesShopee, 'int-2', CATEGORIA)),
    ).toBe('personalizada-implicita');
    expect(rotulo(resolverEntradaShopeeDoGrupo([recusadoDaChave()], CONTA, CATEGORIA))).toBe(
      'ilegivel:0:variation_group_list',
    );
  });
});

describe('camposRecusados — os campos de um parse recusado, numa grafia só (#1369)', () => {
  const recusa = (bruto: unknown): z.ZodError => {
    const lido = linkVariacoesShopeeSchema.safeParse(bruto);
    if (lido.success) throw new TypeError('esperava uma recusa do schema');
    return lido.error;
  };

  it('IGUAL: é a lista do ilegivel do resolvedor, para o mesmo elemento', () => {
    const quebrado = {
      ...entradaDaChave(),
      variation_id: 'x',
      lixo: true,
      variationOptions: [
        { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: 'v1', extra: 1 },
      ],
    };
    const r = resolverEntradaShopeeDoGrupo([quebrado], CONTA, CATEGORIA);
    expect(r.tipo).toBe('ilegivel');
    expect(camposRecusados(recusa(quebrado))).toHaveLength(4);
    expect(r.tipo === 'ilegivel' && r.campos).toEqual(camposRecusados(recusa(quebrado)));
  });

  it('um valor recusado POR INTEIRO (não é objeto) não nomeia campo nenhum — nunca um campo em branco', () => {
    for (const bruto of ['lixo', null, 42, [ELEMENTO_LEGADO]]) {
      const erro = recusa(bruto);
      expect(
        erro.issues.map((i) => i.path.length),
        JSON.stringify(bruto),
      ).toEqual([0]);
      expect(camposRecusados(erro), JSON.stringify(bruto)).toEqual([]);
    }
  });

  it('⛔ QUASE: uma chave desconhecida da RAIZ tem caminho vazio e mesmo assim é nomeada por si', () => {
    expect(camposRecusados(recusa({ ...ELEMENTO_LEGADO, lixo: 1 }))).toEqual(['lixo']);
  });

  it('o mesmo caminho recusado duas vezes aparece UMA vez, na posição da primeira ⟷ ⛔ QUASE: o mesmo campo em duas opções são DOIS caminhos (o índice fica)', () => {
    const duasRegras = z.strictObject({
      a: z
        .string()
        .refine(() => false)
        .refine(() => false),
      b: z.number(),
      o: z.array(z.strictObject({ x: z.number() })),
    });
    const lido = duasRegras.safeParse({
      a: 'x',
      b: 'y',
      o: [
        { x: 1, e: 1 },
        { x: 2, e: 2 },
      ],
      z: 1,
    });
    if (lido.success) throw new TypeError('esperava uma recusa');
    // The precondition: zod reports `a` twice.
    expect(lido.error.issues.filter((i) => i.path.join('.') === 'a')).toHaveLength(2);
    expect(camposRecusados(lido.error)).toEqual(['a', 'b', 'o.0.e', 'o.1.e', 'z']);
  });
});

/*
 * The tier/option NAME fold, defined here since #1911 P14b (it moved from the
 * import's pure core, which re-exports it): the publisher, the import and the
 * web's binding editor decide "the same name" with this one function.
 */
describe('nomeDeTierShopee — a dobra de NOME de tier/opção, definida aqui (#1911 P14b: a publicação, a importação e o editor de vínculos)', () => {
  it.each(['Azul', 'Azul ', ' Azul', '\tAzul\n', '\u00a0Azul\u00a0', '\r\n Azul \r\n'])(
    '⚠️ PAR: %j dobra para "Azul" — só as pontas saem (espaço, tab, quebra de linha, NBSP)',
    (nome) => {
      expect(nomeDeTierShopee(nome)).toBe('Azul');
    },
  );

  it.each([
    ['azul', 'a caixa'],
    ['AZUL', 'a caixa'],
    ['Azul  Claro', 'o espaço de DENTRO'],
    ['\u200bAzul', 'o espaço de largura zero (U+200B não é espaço para o trim)'],
  ])('⛔ QUASE: %j NÃO dobra para "Azul" — %s fica', (nome) => {
    expect(nomeDeTierShopee(nome)).not.toBe('Azul');
    expect(nomeDeTierShopee(nome)).toBe(nome);
  });

  it('⛔ QUASE: o espaço de dentro é mantido mesmo quando as pontas saem', () => {
    expect(nomeDeTierShopee(' Azul  Claro ')).toBe('Azul  Claro');
    expect(nomeDeTierShopee(' Azul  Claro ')).not.toBe(nomeDeTierShopee('Azul Claro'));
  });

  it('ausente, nulo, não-string e só espaço são o nome em BRANCO', () => {
    for (const nada of [null, undefined, 42 as never, '', '   ', '\u00a0\t']) {
      expect(nomeDeTierShopee(nada), JSON.stringify(nada)).toBe('');
    }
  });
});

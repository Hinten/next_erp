import { describe, expect, it } from 'vitest';

// Importado pelo BARREL de propósito: a prova de que a linha `export *` em
// `produto/index.ts` (e, por ela, a raiz `src/index.ts`) alcança o schema novo.
import {
  ehEntradaShopeeDaChave,
  grupoDeVariacoesSchema,
  linkVariacaoOpcaoShopeeSchema,
  linkVariacoesShopeeSchema,
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

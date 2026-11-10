import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';

import {
  respostaVariacoesShopeeSchema,
  type RespostaVariacoesShopee,
  type VariacaoDto,
  type VariacaoGrupoDto,
} from './wire';

/**
 * The Shopee tab's read of a variation tree. Every fixture is hand-written in the
 * shape of the public `get_variation_tree.br-*` captures (a web test cannot import
 * `apps/shopee`'s fixtures): public taxonomy where it is named below, invented
 * (the `9xxxxx` ids) everywhere else.
 *
 * Each rule has a pair and a near miss: a test that the rule APPLIES cannot show
 * where it STOPS. Only the hook over the backend client is faked; the error
 * classes and `createShopeeClient` are the REAL ones.
 */

const h = vi.hoisted(() => ({ semCliente: false, variacoes: vi.fn() }));

vi.mock('./client', async (importActual) => {
  const actual = await importActual<typeof import('./client')>();
  const { shopeeClientFalso } = await import('@/lib/testing/shopeeClientFalso');
  const client = shopeeClientFalso({ variacoes: h.variacoes });
  return { ...actual, useShopeeClient: () => (h.semCliente ? null : client) };
});

const {
  MENSAGEM_VARIACOES_SHOPEE_BACKEND_DESATUALIZADO,
  MENSAGEM_VARIACOES_SHOPEE_CATEGORIA_DESCONHECIDA,
  MENSAGEM_VARIACOES_SHOPEE_GENERICA,
  VARIACOES_SHOPEE_STALE_MS,
  chaveVariacoesShopee,
  descreverFalhaVariacoesShopee,
  grupoAutomaticoShopee,
  gruposEscolhiveisShopee,
  opcoesDoGrupoShopee,
  rotuloShopee,
  useVariacoesShopee,
  variacoesVinculaveisShopee,
} = await import('./variacoes');
const {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  createShopeeClient,
} = await import('./client');

const GRUPO_INT = 841350766059029;
const GRUPO_BR = 844758844060204;

/** Two levels: the size `M` is 6270 in one group and 6933 in the other. */
const TAMANHO: VariacaoDto = {
  variationId: 101056,
  variationName: 'Tamanho',
  variationGroupList: [
    {
      variationGroupId: GRUPO_INT,
      variationGroupName: 'Tamanho (INT)',
      variationOptionList: [{ variationOptionId: 6270, variationOptionName: 'M' }],
    },
    {
      variationGroupId: GRUPO_BR,
      variationGroupName: 'Tamanho (BR)',
      variationOptionList: [
        { variationOptionId: 6857, variationOptionName: 'P' },
        { variationOptionId: 6933, variationOptionName: 'M' },
      ],
    },
  ],
};

/** Single level: the sentinel group `{0, ""}`, and two options that both read `Preto`. */
const COR: VariacaoDto = {
  variationId: 101054,
  variationName: 'Cor',
  variationGroupList: [
    {
      variationGroupId: 0,
      variationGroupName: '',
      variationOptionList: [
        { variationOptionId: 6258, variationOptionName: 'Preto' },
        { variationOptionId: 9585, variationOptionName: 'Preto' },
        { variationOptionId: 9632, variationOptionName: 'Azul Turquesa' },
      ],
    },
  ],
};

/** Names as Shopee sends them, with their spaces. */
const ESTAMPA: VariacaoDto = {
  variationId: 900001,
  variationName: ' Estampa',
  variationGroupList: [
    {
      variationGroupId: 0,
      variationGroupName: '',
      variationOptionList: [{ variationOptionId: 900101, variationOptionName: ' Azul ' }],
    },
  ],
};

/** The capture's option-less shape: no group at all. */
const ESTILO: VariacaoDto = {
  variationId: 103236,
  variationName: 'Estilo',
  variationGroupList: [],
};

/** Not in the captures, and the reason "option-less" is not "group-less". */
const CAPACIDADE_GRUPO_VAZIO: VariacaoDto = {
  variationId: 102870,
  variationName: 'Capacidade',
  variationGroupList: [{ variationGroupId: 0, variationGroupName: '', variationOptionList: [] }],
};

const CAMINHO = '/api/v2/product/get_variation_tree';

/** A Fashion leaf: INT and BR, two `Preto`, and option-less variations beside them. */
const MODA: RespostaVariacoesShopee = {
  leaf: true,
  categoryId: 100244,
  standardiseVariationList: [TAMANHO, ESTILO, COR, ESTAMPA, CAPACIDADE_GRUPO_VAZIO],
  pathUsed: CAMINHO,
};

/** A mug: six variations and not one option. */
const CANECA: RespostaVariacoesShopee = {
  leaf: true,
  categoryId: 900100,
  standardiseVariationList: [
    { variationId: 101054, variationName: 'Cor', variationGroupList: [] },
    ESTILO,
    { variationId: 900001, variationName: ' Estampa', variationGroupList: [] },
    { variationId: 102870, variationName: 'Capacidade', variationGroupList: [] },
    { variationId: 900002, variationName: 'Variação inventada 1', variationGroupList: [] },
    { variationId: 900003, variationName: 'Variação inventada 2', variationGroupList: [] },
  ],
  pathUsed: CAMINHO,
};

const NAO_FOLHA: RespostaVariacoesShopee = {
  leaf: false,
  categoryId: 900200,
  standardiseVariationList: [],
  pathUsed: CAMINHO,
};

const COPIA_404 =
  'A Shopee não reconheceu a consulta de variações (HTTP 404): o backend da Shopee está desatualizado. Os vínculos guardados continuam aqui e podem ser removidos; para escolher opções novas, o backend precisa ser atualizado.';
const COPIA_CATEGORIA =
  'Esta categoria não existe mais na árvore desta conta — remova o vínculo ou recrie-o em outra categoria.';
const COPIA_GENERICA = 'Não foi possível carregar as variações da Shopee.';

const http = (
  status: number,
  code: string | null,
  shopeeCode: string | null = null,
  kind: string | null = null,
) => new ShopeeClientHttpError('frase do backend', status, code, shopeeCode, kind);

/** The app's defaults with no back-off: a retry the hook allows shows at once. */
function novoQc(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULT_OPTIONS.queries, retryDelay: 0 } },
  });
}

function host(qc: QueryClient) {
  return function Host({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

/** One turn of the event loop: long enough for a read that WOULD start to start. */
const umaVolta = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.semCliente = false;
  h.variacoes.mockReset().mockResolvedValue(MODA);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('as fixturas', () => {
  it.each([
    ['moda', MODA],
    ['caneca', CANECA],
    ['não-folha', NAO_FOLHA],
  ])('%s passa pelo schema que a rota usa', (_n, resposta) => {
    expect(respostaVariacoesShopeeSchema.parse(resposta)).toEqual(resposta);
  });
});

describe('variacoesVinculaveisShopee — «não é preciso vincular»', () => {
  it('⭐ caneca: 6 variações e nenhuma opção ⇒ nada a vincular', () => {
    expect(CANECA.standardiseVariationList).toHaveLength(6);

    expect(variacoesVinculaveisShopee(CANECA)).toEqual([]);
  });

  it('⭐ NEAR-MISS: UMA variação com opção ⇒ só ela, as sem opção escondidas', () => {
    const umaSo: RespostaVariacoesShopee = {
      ...CANECA,
      standardiseVariationList: [ESTILO, COR, CAPACIDADE_GRUPO_VAZIO],
    };

    expect(variacoesVinculaveisShopee(umaSo)).toEqual([COR]);
  });

  it('⭐ NEAR-MISS: ter grupo não basta — um grupo sem opção não torna a variação vinculável', () => {
    const soGrupoVazio: RespostaVariacoesShopee = {
      ...CANECA,
      standardiseVariationList: [CAPACIDADE_GRUPO_VAZIO],
    };

    expect(variacoesVinculaveisShopee(soGrupoVazio)).toEqual([]);
  });

  it('mantém a ordem da Shopee e devolve a própria variação, com todos os seus grupos', () => {
    const lista = variacoesVinculaveisShopee(MODA);

    expect(lista.map((v) => v.variationId)).toEqual([101056, 101054, 900001]);
    expect(lista[0]).toBe(TAMANHO);
  });

  it('não-folha também vem vazia: é `leaf` que separa as duas frases', () => {
    expect(variacoesVinculaveisShopee(NAO_FOLHA)).toEqual([]);
    expect(NAO_FOLHA.leaf).toBe(false);
    expect(CANECA.leaf).toBe(true);
  });
});

describe('gruposEscolhiveisShopee', () => {
  it('só os grupos com opção, e o grupo `0` é um deles', () => {
    expect(gruposEscolhiveisShopee(COR).map((g) => g.variationGroupId)).toEqual([0]);
    expect(gruposEscolhiveisShopee(TAMANHO).map((g) => g.variationGroupId)).toEqual([
      GRUPO_INT,
      GRUPO_BR,
    ]);
  });

  it('NEAR-MISS: um grupo vazio ao lado de um cheio some', () => {
    const [int, br] = TAMANHO.variationGroupList as [VariacaoGrupoDto, VariacaoGrupoDto];
    const v: VariacaoDto = {
      ...TAMANHO,
      variationGroupList: [{ ...int, variationOptionList: [] }, br],
    };

    expect(gruposEscolhiveisShopee(v)).toEqual([br]);
    expect(gruposEscolhiveisShopee(ESTILO)).toEqual([]);
  });

  it('a opção de id `0` é um valor, não uma ausência: o grupo continua com opção', () => {
    const v: VariacaoDto = {
      ...ESTILO,
      variationGroupList: [
        {
          variationGroupId: 0,
          variationGroupName: '',
          variationOptionList: [{ variationOptionId: 0, variationOptionName: 'Opção inventada 1' }],
        },
      ],
    };

    expect(gruposEscolhiveisShopee(v)).toHaveLength(1);
    expect(grupoAutomaticoShopee(v)).toBe(0);
    expect(opcoesDoGrupoShopee(v, 0).map((o) => o.variationOptionId)).toEqual([0]);
  });
});

describe('grupoAutomaticoShopee — nível único', () => {
  it('⭐ um grupo {0, ""} ⇒ ninguém escolhe, e o que se grava é `0`', () => {
    expect(grupoAutomaticoShopee(COR)).toBe(0);
  });

  it('⭐ NEAR-MISS: dois grupos com opção ⇒ `null`, a escolha é obrigatória', () => {
    expect(grupoAutomaticoShopee(TAMANHO)).toBeNull();
  });

  it('⭐ o que se escolhe nos dois grupos é o número exato, de 15 dígitos', () => {
    const ids = gruposEscolhiveisShopee(TAMANHO).map((g) => g.variationGroupId);

    expect(ids).toEqual([841350766059029, 844758844060204]);
    expect(ids.every((id) => Number.isSafeInteger(id))).toBe(true);
  });

  it('um grupo real com opção, ao lado de um vazio ⇒ o id dele', () => {
    const [int, br] = TAMANHO.variationGroupList as [VariacaoGrupoDto, VariacaoGrupoDto];
    const v: VariacaoDto = {
      ...TAMANHO,
      variationGroupList: [{ ...int, variationOptionList: [] }, br],
    };

    expect(grupoAutomaticoShopee(v)).toBe(GRUPO_BR);
  });

  it('o sentinela com opção, ao lado de um grupo real vazio ⇒ `0`', () => {
    const [sentinela] = COR.variationGroupList as [VariacaoGrupoDto];
    const v: VariacaoDto = {
      ...COR,
      variationGroupList: [
        { variationGroupId: GRUPO_BR, variationGroupName: 'Vazio', variationOptionList: [] },
        sentinela,
      ],
    };

    expect(grupoAutomaticoShopee(v)).toBe(0);
  });

  it.each([
    ['sem grupo', ESTILO],
    ['com um grupo vazio', CAPACIDADE_GRUPO_VAZIO],
  ])('variação %s ⇒ `null`, nunca `0`', (_n, v) => {
    expect(grupoAutomaticoShopee(v)).toBeNull();
  });
});

describe('opcoesDoGrupoShopee — só o grupo escolhido', () => {
  const ids = (grupo: number) =>
    opcoesDoGrupoShopee(TAMANHO, grupo).map((o) => o.variationOptionId);

  it('⭐ BR escolhido ⇒ o `M` do BR (6933) é oferecido', () => {
    expect(ids(GRUPO_BR)).toContain(6933);
  });

  it('⭐ NEAR-MISS: BR escolhido ⇒ o `M` do INT (6270) NÃO é oferecido', () => {
    expect(ids(GRUPO_BR)).not.toContain(6270);
    expect(ids(GRUPO_BR)).toEqual([6857, 6933]);
  });

  it('e o inverso: INT escolhido ⇒ só o `M` do INT', () => {
    expect(ids(GRUPO_INT)).toEqual([6270]);
  });

  it('⭐ dois «Preto» são dois itens, cada um com o seu id', () => {
    const opcoes = opcoesDoGrupoShopee(COR, 0);

    expect(opcoes.map((o) => o.variationOptionId)).toEqual([6258, 9585, 9632]);
    expect(opcoes.filter((o) => o.variationOptionName === 'Preto')).toHaveLength(2);
  });

  it('um grupo que a árvore não tem ⇒ nenhuma opção: o `0` guardado numa variação de dois grupos', () => {
    expect(opcoesDoGrupoShopee(TAMANHO, 0)).toEqual([]);
    expect(opcoesDoGrupoShopee(COR, GRUPO_BR)).toEqual([]);
    expect(opcoesDoGrupoShopee(ESTILO, 0)).toEqual([]);
  });

  it('⭐ o nome volta como a Shopee mandou, sem aparar', () => {
    expect(opcoesDoGrupoShopee(ESTAMPA, 0)[0]?.variationOptionName).toBe(' Azul ');
  });
});

describe('rotuloShopee — o que se mostra', () => {
  it('⭐ o nome aparece aparado, com o id', () => {
    expect(rotuloShopee(' Estampa', 900001)).toBe('Estampa (900001)');
    expect(rotuloShopee(' Azul ', 900101)).toBe('Azul (900101)');
  });

  it('⭐ NEAR-MISS: rotular não muda o valor guardado', () => {
    const opcao = opcoesDoGrupoShopee(ESTAMPA, 0)[0];

    expect(rotuloShopee(opcao?.variationOptionName ?? null, 900101)).toBe('Azul (900101)');
    expect(opcao?.variationOptionName).toBe(' Azul ');
    expect(ESTAMPA.variationName).toBe(' Estampa');
  });

  it.each([
    ['nulo', null],
    ['vazio', ''],
    ['só espaços', '   '],
  ])('nome %s ⇒ «Sem nome (id)»', (_n, nome) => {
    expect(rotuloShopee(nome, 900002)).toBe('Sem nome (900002)');
  });

  it('o sentinela sem nome também tem rótulo: `0` é um id', () => {
    expect(rotuloShopee('', 0)).toBe('Sem nome (0)');
  });

  it('dois «Preto» têm dois rótulos', () => {
    expect(rotuloShopee('Preto', 6258)).toBe('Preto (6258)');
    expect(rotuloShopee('Preto', 9585)).toBe('Preto (9585)');
  });

  it('NEAR-MISS: só as pontas são aparadas, e nome longo não é cortado', () => {
    expect(rotuloShopee('Azul Turquesa', 9632)).toBe('Azul Turquesa (9632)');
    expect(rotuloShopee('Sola De Borracha Anti-Derrapante', 900300)).toBe(
      'Sola De Borracha Anti-Derrapante (900300)',
    );
  });

  it('um id de 15 dígitos sai por extenso', () => {
    expect(rotuloShopee('Tamanho (BR)', GRUPO_BR)).toBe('Tamanho (BR) (844758844060204)');
  });
});

describe('descreverFalhaVariacoesShopee — o backend desatualizado', () => {
  it('⭐ 502 + SHOPEE_HTTP_ERROR + `error_not_found` ⇒ a frase do 404, sem «Tentar de novo»', () => {
    expect(
      descreverFalhaVariacoesShopee(http(502, 'SHOPEE_HTTP_ERROR', 'error_not_found', 'other')),
    ).toEqual({ mensagem: COPIA_404, repetivel: false });
  });

  it('⭐ o corpo real da rota, pelo cliente real, chega à mesma frase', async () => {
    const client = createShopeeClient({
      baseUrl: 'http://localhost:3009',
      getAuthToken: async () => 'token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: 'Shopee: error_not_found',
            code: 'SHOPEE_HTTP_ERROR',
            upstreamStatus: 404,
            shopeeCode: 'error_not_found',
            kind: 'other',
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ),
    });

    const err = await client
      .variacoes({ integracaoId: 'int-1', categoryId: 100244 })
      .catch((e: unknown) => e);

    expect(descreverFalhaVariacoesShopee(err).mensagem).toBe(COPIA_404);
  });

  it.each<[string, number, string | null, string | null]>([
    ['outro código da Shopee', 502, 'SHOPEE_HTTP_ERROR', 'error_param'],
    ['sem código da Shopee', 502, 'SHOPEE_HTTP_ERROR', null],
    ['outro código do backend', 502, 'SHOPEE_BAD_RESPONSE', 'error_not_found'],
    ['sem código do backend', 502, null, 'error_not_found'],
    ['outro status: 404', 404, 'SHOPEE_HTTP_ERROR', 'error_not_found'],
    ['outro status: 500', 500, 'SHOPEE_HTTP_ERROR', 'error_not_found'],
    ['outra caixa', 502, 'SHOPEE_HTTP_ERROR', 'ERROR_NOT_FOUND'],
    ['com espaço', 502, 'SHOPEE_HTTP_ERROR', ' error_not_found'],
    ['com prefixo de módulo', 502, 'SHOPEE_HTTP_ERROR', 'product.error_not_found'],
  ])(
    '⭐ NEAR-MISS: %s cai no caminho comum, com a frase do backend',
    (_n, status, code, shopee) => {
      const { mensagem } = descreverFalhaVariacoesShopee(http(status, code, shopee));

      expect(mensagem).toBe('frase do backend');
    },
  );
});

describe('descreverFalhaVariacoesShopee — a categoria que não existe mais', () => {
  it('⭐ a frase desta aba, sem «Tentar de novo»', () => {
    expect(descreverFalhaVariacoesShopee(http(404, 'SHOPEE_CATEGORIA_DESCONHECIDA'))).toEqual({
      mensagem: COPIA_CATEGORIA,
      repetivel: false,
    });
  });

  it('NEAR-MISS: outro 404 não é a categoria — um backend sem a rota fica na frase dele', () => {
    expect(descreverFalhaVariacoesShopee(http(404, null)).mensagem).toBe('frase do backend');
  });
});

describe('descreverFalhaVariacoesShopee — o caminho comum', () => {
  it('⭐ um erro que não é do cliente da Shopee recebe a frase genérica, sem repetir', () => {
    expect(descreverFalhaVariacoesShopee(new TypeError('x'))).toEqual({
      mensagem: COPIA_GENERICA,
      repetivel: false,
    });
    expect(descreverFalhaVariacoesShopee('nada').mensagem).toBe(COPIA_GENERICA);
  });

  it('um erro de rede oferece «Tentar de novo»', () => {
    expect(descreverFalhaVariacoesShopee(new ShopeeClientNetworkError('falhou'))).toEqual({
      mensagem: 'Não foi possível contatar a integração com a Shopee.',
      repetivel: true,
    });
  });

  it('NEAR-MISS: um 503 oferece, e um 502 qualquer não', () => {
    expect(descreverFalhaVariacoesShopee(http(503, 'SHOPEE_NETWORK_ERROR')).repetivel).toBe(true);
    expect(
      descreverFalhaVariacoesShopee(http(502, 'SHOPEE_HTTP_ERROR', 'error_param', 'other'))
        .repetivel,
    ).toBe(false);
  });

  it('o limite da Shopee diz para esperar, sem repetir', () => {
    expect(
      descreverFalhaVariacoesShopee(http(502, 'SHOPEE_HTTP_ERROR', 'error_busy', 'burst')),
    ).toEqual({
      mensagem: 'A Shopee limitou as consultas — tente em alguns minutos.',
      repetivel: false,
    });
  });

  it('uma conta sem autorização pede para reconectar', () => {
    expect(descreverFalhaVariacoesShopee(http(409, 'SHOPEE_REAUTH_REQUIRED')).mensagem).toBe(
      'Reconecte a conta Shopee em Canais de venda.',
    );
  });

  it('um 200 fora do formato mantém a frase que manda fazer o deploy, sem repetir', () => {
    const err = new ShopeeClientRespostaInvalidaError('faça o deploy', 200, ['pathUsed']);

    expect(descreverFalhaVariacoesShopee(err)).toEqual({
      mensagem: 'faça o deploy',
      repetivel: false,
    });
  });
});

describe('as frases exportadas', () => {
  it('são as frases da aba, palavra por palavra', () => {
    expect(MENSAGEM_VARIACOES_SHOPEE_BACKEND_DESATUALIZADO).toBe(COPIA_404);
    expect(MENSAGEM_VARIACOES_SHOPEE_CATEGORIA_DESCONHECIDA).toBe(COPIA_CATEGORIA);
    expect(MENSAGEM_VARIACOES_SHOPEE_GENERICA).toBe(COPIA_GENERICA);
  });
});

describe('chaveVariacoesShopee', () => {
  it('uma árvore por conta e categoria', () => {
    expect(chaveVariacoesShopee('int-1', 100244)).toEqual(['shopee', 'variacoes', 'int-1', 100244]);
  });

  it('NEAR-MISS: outra conta e outra categoria são outras chaves', () => {
    const chave = JSON.stringify(chaveVariacoesShopee('int-1', 100244));

    expect(JSON.stringify(chaveVariacoesShopee('int-12', 100244))).not.toBe(chave);
    expect(JSON.stringify(chaveVariacoesShopee('int-1', 100352))).not.toBe(chave);
  });
});

describe('useVariacoesShopee — quando se lê', () => {
  it('⭐ nada enquanto a aba não está ativa; ao ativar, uma leitura de (conta, categoria)', async () => {
    const { result, rerender } = renderHook(
      ({ ativo }: { ativo: boolean }) => useVariacoesShopee('int-1', 100244, { enabled: ativo }),
      { wrapper: host(novoQc()), initialProps: { ativo: false } },
    );
    await umaVolta();
    expect(h.variacoes).not.toHaveBeenCalled();

    rerender({ ativo: true });
    await waitFor(() => expect(result.current.data).toEqual(MODA));

    expect(h.variacoes).toHaveBeenCalledOnce();
    expect(h.variacoes).toHaveBeenCalledWith({ integracaoId: 'int-1', categoryId: 100244 });
  });

  it('`enabled` ausente lê', async () => {
    const { result } = renderHook(() => useVariacoesShopee('int-1', 100244), {
      wrapper: host(novoQc()),
    });

    await waitFor(() => expect(result.current.data).toEqual(MODA));
  });

  it('⭐ sem categoria não lê; ao escolher a categoria, lê', async () => {
    const { result, rerender } = renderHook(
      ({ categoria }: { categoria: number | null }) => useVariacoesShopee('int-1', categoria),
      { wrapper: host(novoQc()), initialProps: { categoria: null as number | null } },
    );
    await umaVolta();
    expect(h.variacoes).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();

    rerender({ categoria: 100244 });
    await waitFor(() => expect(result.current.data).toEqual(MODA));

    expect(h.variacoes).toHaveBeenCalledOnce();
  });

  it('NEAR-MISS: a categoria `0` é um valor e é lida (a rota é que recusa)', async () => {
    const { result } = renderHook(() => useVariacoesShopee('int-1', 0), {
      wrapper: host(novoQc()),
    });

    await waitFor(() => expect(result.current.data).toEqual(MODA));
    expect(h.variacoes).toHaveBeenCalledWith({ integracaoId: 'int-1', categoryId: 0 });
  });

  it('sem cliente (deslogado) não lê', async () => {
    h.semCliente = true;
    const { result } = renderHook(() => useVariacoesShopee('int-1', 100244), {
      wrapper: host(novoQc()),
    });
    await umaVolta();

    expect(h.variacoes).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('⭐ a mesma conta e categoria são lidas uma vez por 15 minutos', async () => {
    const qc = novoQc();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const montar = async () => {
      const { result, unmount } = renderHook(() => useVariacoesShopee('int-1', 100244), {
        wrapper: host(qc),
      });
      await waitFor(() => expect(result.current.data).toEqual(MODA));
      await umaVolta();
      unmount();
    };

    await montar();
    relogio.mockReturnValue(agora + VARIACOES_SHOPEE_STALE_MS - 1);
    await montar();
    expect(h.variacoes).toHaveBeenCalledOnce();

    // NEAR-MISS: one millisecond past the backend's own TTL is a new read.
    relogio.mockReturnValue(agora + VARIACOES_SHOPEE_STALE_MS + 1);
    await montar();
    expect(h.variacoes).toHaveBeenCalledTimes(2);
  });

  it('15 minutos, nem mais nem menos: o TTL do backend', () => {
    expect(VARIACOES_SHOPEE_STALE_MS).toBe(900_000);
  });

  it('⭐ NEAR-MISS: outra categoria e outra conta são outras leituras', async () => {
    const qc = novoQc();
    const { result, rerender } = renderHook(
      ({ conta, categoria }: { conta: string; categoria: number }) =>
        useVariacoesShopee(conta, categoria),
      { wrapper: host(qc), initialProps: { conta: 'int-1', categoria: 100244 } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ conta: 'int-1', categoria: 100352 });
    await waitFor(() => expect(h.variacoes).toHaveBeenCalledTimes(2));
    rerender({ conta: 'int-2', categoria: 100352 });
    await waitFor(() => expect(h.variacoes).toHaveBeenCalledTimes(3));

    expect(h.variacoes.mock.calls.map(([input]: unknown[]) => input)).toEqual([
      { integracaoId: 'int-1', categoryId: 100244 },
      { integracaoId: 'int-1', categoryId: 100352 },
      { integracaoId: 'int-2', categoryId: 100352 },
    ]);
  });
});

describe('useVariacoesShopee — quando se repete', () => {
  it('⭐ um 502 nunca se repete sozinho, nem com o `retry: 1` do app', async () => {
    h.variacoes.mockRejectedValue(http(502, 'SHOPEE_HTTP_ERROR', 'error_not_found', 'other'));
    const { result } = renderHook(() => useVariacoesShopee('int-1', 100244), {
      wrapper: host(novoQc()),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await umaVolta();

    expect(h.variacoes).toHaveBeenCalledOnce();
    expect(descreverFalhaVariacoesShopee(result.current.error).mensagem).toBe(COPIA_404);
  });

  it('⭐ NEAR-MISS: um 503 sara sozinho', async () => {
    h.variacoes.mockReset();
    h.variacoes
      .mockRejectedValueOnce(http(503, 'SHOPEE_NETWORK_ERROR'))
      .mockResolvedValueOnce(MODA);
    const { result } = renderHook(() => useVariacoesShopee('int-1', 100244), {
      wrapper: host(novoQc()),
    });

    await waitFor(() => expect(result.current.data).toEqual(MODA));

    expect(h.variacoes).toHaveBeenCalledTimes(2);
  });

  it('`refetch` é o «Tentar de novo»: lê de novo depois de uma falha', async () => {
    h.variacoes.mockReset();
    h.variacoes
      .mockRejectedValueOnce(http(502, 'SHOPEE_HTTP_ERROR', 'error_busy', 'transient'))
      .mockResolvedValueOnce(MODA);
    const { result } = renderHook(() => useVariacoesShopee('int-1', 100244), {
      wrapper: host(novoQc()),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.data).toEqual(MODA));
    expect(h.variacoes).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  shopeeItemBaseInfoPayloadSchema,
  type GetItemBaseInfoParams,
  type ShopeeClient,
  type ShopeeErrorKind,
  type ShopeeItemBaseInfo,
} from '@delfrance/integrations-shopee';

import { ShopeeRefreshEmAndamentoError } from '../core/tokenStore';
import { criarLeitorDeBaseEmLote } from './leitorDeBase';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const ITEM = 2_500_139_861;
const CAMINHO = '/api/v2/product/get_item_base_info';

/** `n` consecutive fixture ids starting at {@link ITEM}. */
function ids(n: number): number[] {
  return Array.from({ length: n }, (_, i) => ITEM + i);
}

/** A raw row as the wire would carry it; `item_name` marks WHOSE row it is. */
function linhaCrua(itemId: number): Record<string, unknown> {
  return { item_id: itemId, item_name: `anuncio-${String(itemId)}`, item_status: 'NORMAL' };
}

/** The parsed payload, exactly as the client would hand it over. */
function payload(linhas: readonly unknown[]): ShopeeItemBaseInfo {
  return shopeeItemBaseInfoPayloadSchema.parse({ item_list: linhas });
}

/** Answers one row per asked id, in the asked order. */
function ecoDeTodos(itemIds: readonly number[]): ShopeeItemBaseInfo {
  return payload(itemIds.map(linhaCrua));
}

function apiError(code: string, kind: ShopeeErrorKind = SHOPEE_ERROR_KIND.other): ShopeeApiError {
  return new ShopeeApiError(`erro ${code}`, { code, kind, httpStatus: 200, path: CAMINHO });
}

function burst(): ShopeeRateLimitError {
  return new ShopeeRateLimitError('limite de rajada', {
    code: 'error_rate_limit',
    kind: SHOPEE_ERROR_KIND.burst,
    httpStatus: 429,
    path: CAMINHO,
    retryAfterSeconds: null,
  });
}

function cotaDiaria(): ShopeeRateLimitError {
  return new ShopeeRateLimitError('cota diária', {
    code: 'error_daily_quota',
    kind: SHOPEE_ERROR_KIND.daily,
    httpStatus: 429,
    path: CAMINHO,
    retryAfterSeconds: null,
  });
}

function reauth(): ShopeeReauthRequiredError {
  return new ShopeeReauthRequiredError('reautorize', {
    code: 'error_auth',
    kind: SHOPEE_ERROR_KIND.reauth,
    httpStatus: 200,
    path: CAMINHO,
  });
}

/** A client double whose `getItemBaseInfo` answers through `responder`. */
function cliente(
  responder: (itemIds: readonly number[]) => Promise<ShopeeItemBaseInfo> = async (i) =>
    ecoDeTodos(i),
) {
  const getItemBaseInfo = vi.fn(async (p: GetItemBaseInfoParams) => responder(p.itemIds));
  const getModelList = vi.fn(async () => {
    throw new Error('o leitor de base nunca chama get_model_list');
  });
  return {
    client: { getItemBaseInfo, getModelList } as unknown as ShopeeClient,
    getItemBaseInfo,
    getModelList,
    /** The `itemIds` of every call, in call order. */
    pedidos: () => getItemBaseInfo.mock.calls.map(([p]) => [...p.itemIds]),
  };
}

/** A promise the test settles by hand — to hold a call IN FLIGHT. */
function adiado<T>() {
  let resolver!: (v: T) => void;
  let rejeitar!: (e: unknown) => void;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

let aviso: MockInstance<typeof console.warn>;
beforeEach(() => {
  aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  aviso.mockRestore();
});

/* -------------------------------------------------------------------------- */
/*                               one call per chunk                            */
/* -------------------------------------------------------------------------- */

describe('criarLeitorDeBaseEmLote — uma chamada por lote de até 50', () => {
  it('1 — construir o leitor não chama NADA', () => {
    const c = cliente();
    criarLeitorDeBaseEmLote(c.client, ids(30));
    expect(c.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('2 — ⚠️ PAR (M49): 30 itens ⇒ UMA get_item_base_info com os 30 ids, e cada id lê a SUA linha', async () => {
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(30));
    for (const id of ids(30)) {
      expect((await lerBase(id))?.item_name).toBe(`anuncio-${String(id)}`);
    }
    expect(c.pedidos()).toEqual([ids(30)]);
  });

  it('3 — PAR: exatamente o teto do wire (50) ainda é UMA chamada', async () => {
    expect(SHOPEE_ITEM_BASE_INFO_MAX_IDS).toBe(50);
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(50));
    await Promise.all(ids(50).map((id) => lerBase(id)));
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
  });

  it('4 — ⚠️ QUASE-IGUAL (M49): 51 itens ⇒ DUAS chamadas, 50 + 1, na ordem dada', async () => {
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(51));
    for (const id of ids(51)) await lerBase(id);
    expect(c.pedidos()).toEqual([ids(50), [ITEM + 50]]);
  });

  it('5 — preguiçoso POR LOTE: ler só o 1º de 51 custa UMA chamada; o 2º lote só quando um id dele é lido', async () => {
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(51));
    await lerBase(ITEM);
    await lerBase(ITEM + 49);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
    await lerBase(ITEM + 50);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(2);
    // …and a later read of either chunk is the memo.
    await lerBase(ITEM + 7);
    await lerBase(ITEM + 50);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(2);
  });

  it('6 — PAR: 51 entradas com UMA repetida são 50 ids distintos ⇒ UMA chamada (a repetição não abre lote)', async () => {
    const c = cliente();
    const comRepetido = [...ids(50), ITEM + 3];
    const lerBase = criarLeitorDeBaseEmLote(c.client, comRepetido);
    await Promise.all(comRepetido.map((id) => lerBase(id)));
    expect(c.pedidos()).toEqual([ids(50)]);
  });

  it('7 — ⚠️ leituras CONCORRENTES do mesmo lote dividem a MESMA chamada em voo (memo da PROMESSA)', async () => {
    const emVoo = adiado<ShopeeItemBaseInfo>();
    const c = cliente(() => emVoo.promessa);
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(3));
    const leituras = [lerBase(ITEM), lerBase(ITEM + 1), lerBase(ITEM + 2)];
    // Three readers are waiting and ONE call is in flight.
    await Promise.resolve();
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
    emVoo.resolver(ecoDeTodos(ids(3)));
    const linhas = await Promise.all(leituras);
    expect(linhas.map((l) => l?.item_id)).toEqual(ids(3));
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                         reconciled by item_id                               */
/* -------------------------------------------------------------------------- */

describe('criarLeitorDeBaseEmLote — reconciliado por item_id, nunca por posição', () => {
  it('8 — ⚠️ (M50) linhas EMBARALHADAS e com um BURACO: cada id lê a SUA linha, o que faltou lê null', async () => {
    const [a, b, cId] = ids(3) as [number, number, number];
    // Asked [a, b, c]; Shopee answers [c, a] — fewer rows, another order.
    const c = cliente(async () => payload([linhaCrua(cId), linhaCrua(a)]));
    const lerBase = criarLeitorDeBaseEmLote(c.client, [a, b, cId]);
    expect((await lerBase(a))?.item_name).toBe(`anuncio-${String(a)}`);
    expect(await lerBase(b)).toBeNull();
    expect((await lerBase(cId))?.item_name).toBe(`anuncio-${String(cId)}`);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
  });

  it('9 — QUASE-IGUAL: duas linhas com o MESMO item_id — a PRIMEIRA vence (a regra do montarItemLido)', async () => {
    const c = cliente(async () =>
      payload([
        { item_id: ITEM, item_name: 'primeira', item_status: 'NORMAL' },
        { item_id: ITEM, item_name: 'segunda', item_status: 'BANNED' },
      ]),
    );
    const lerBase = criarLeitorDeBaseEmLote(c.client, [ITEM]);
    const linha = await lerBase(ITEM);
    expect(linha?.item_name).toBe('primeira');
    expect(linha?.item_status).toBe('NORMAL');
  });

  it('10 — uma linha ILEGÍVEL (a sentinela null do schema) ⇒ esse id lê null, os outros a sua linha, e UM console.warn conta o buraco', async () => {
    const [a, b] = ids(2) as [number, number];
    const corpo = payload([linhaCrua(a), { item_id: 'nao-e-numero', item_name: 'x' }]);
    // The fixture really is a hole — the per-element tolerance turned it into `null`.
    expect(corpo.item_list).toHaveLength(2);
    expect(corpo.item_list[1]).toBeNull();
    const c = cliente(async () => corpo);
    const lerBase = criarLeitorDeBaseEmLote(c.client, [a, b]);
    expect((await lerBase(a))?.item_id).toBe(a);
    expect(await lerBase(b)).toBeNull();
    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso.mock.calls[0]?.[1]).toEqual({ ilegiveis: 1, pedidos: 2, legiveis: 1 });
  });

  it('11 — QUASE-IGUAL: sem buraco nenhum ⇒ nenhum console.warn (a linha que só FALTA não é ilegível)', async () => {
    const [a, b] = ids(2) as [number, number];
    const c = cliente(async () => payload([linhaCrua(a)]));
    const lerBase = criarLeitorDeBaseEmLote(c.client, [a, b]);
    expect(await lerBase(b)).toBeNull();
    expect(aviso).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                         failures: verdict, sticky, forgotten                 */
/* -------------------------------------------------------------------------- */

describe('criarLeitorDeBaseEmLote — falhas', () => {
  it.each(['error_item_not_found', 'product.error_item_not_found'])(
    '12 — ⚠️ PAR: `%s` é o veredito do lote — todo id lê null, e o veredito fica memoizado (UMA chamada)',
    async (codigo) => {
      const c = cliente(async () => {
        throw apiError(codigo);
      });
      const lerBase = criarLeitorDeBaseEmLote(c.client, ids(3));
      for (const id of ids(3)) expect(await lerBase(id)).toBeNull();
      expect(await lerBase(ITEM)).toBeNull();
      expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
    },
  );

  it('13 — ⚠️ QUASE-IGUAL: `error_item_not_belong_shop` NÃO é "ausente" — rejeita com a MESMA instância e fica memoizado', async () => {
    const recusa = apiError('error_item_not_belong_shop');
    const c = cliente(async () => {
      throw recusa;
    });
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(2));
    await expect(lerBase(ITEM)).rejects.toBe(recusa);
    await expect(lerBase(ITEM + 1)).rejects.toBe(recusa);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
  });

  it('14 — QUASE-IGUAL: um código que só CONTÉM o do veredito (`a.b.error_item_not_found`, dois prefixos) não é o veredito', async () => {
    const recusa = apiError('a.b.error_item_not_found');
    const c = cliente(async () => {
      throw recusa;
    });
    const lerBase = criarLeitorDeBaseEmLote(c.client, [ITEM]);
    await expect(lerBase(ITEM)).rejects.toBe(recusa);
  });

  it('15 — ⚠️ limite de rajada com leitores CONCORRENTES: UMA chamada, os dois recebem a MESMA instância, e a próxima leitura NÃO reemite', async () => {
    const erro = burst();
    const emVoo = adiado<ShopeeItemBaseInfo>();
    const c = cliente(() => emVoo.promessa);
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(2));
    const primeira = lerBase(ITEM);
    const segunda = lerBase(ITEM + 1);
    emVoo.rejeitar(erro);
    await expect(primeira).rejects.toBe(erro);
    await expect(segunda).rejects.toBe(erro);
    await expect(lerBase(ITEM)).rejects.toBe(erro);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
  });

  const reemitiveis: readonly [string, () => unknown][] = [
    ['rede', () => new ShopeeNetworkError('conexão reiniciada')],
    ['HTTP 503 sem envelope', () => new ShopeeHttpError('503', { httpStatus: 503, path: CAMINHO })],
    // ⚠️ PAR da borda: o 5xx COMEÇA no 500 — o seu QUASE-IGUAL (499) está em `memorizadas`.
    [
      'HTTP 500 sem envelope (a borda do 5xx)',
      () => new ShopeeHttpError('500', { httpStatus: 500, path: CAMINHO }),
    ],
    [
      'erro Shopee de kind transient',
      () => apiError('error_system_busy', SHOPEE_ERROR_KIND.transient),
    ],
    ['refresh de token em andamento', () => new ShopeeRefreshEmAndamentoError('lease ocupada', 1)],
  ];

  it.each(reemitiveis)(
    '16 — PAR: %s é uma falha que outra tentativa pode mudar — a leitura em voo a recebe, e a PRÓXIMA reemite e lê a linha',
    async (_nome, fabricar) => {
      const erro = fabricar();
      let tentativas = 0;
      const c = cliente(async (itemIds) => {
        tentativas += 1;
        if (tentativas === 1) throw erro;
        return ecoDeTodos(itemIds);
      });
      const lerBase = criarLeitorDeBaseEmLote(c.client, ids(2));
      await expect(lerBase(ITEM)).rejects.toBe(erro);
      expect((await lerBase(ITEM))?.item_id).toBe(ITEM);
      expect((await lerBase(ITEM + 1))?.item_id).toBe(ITEM + 1);
      expect(c.getItemBaseInfo).toHaveBeenCalledTimes(2);
    },
  );

  const memorizadas: readonly [string, () => unknown][] = [
    ['HTTP 429 sem envelope', () => new ShopeeHttpError('429', { httpStatus: 429, path: CAMINHO })],
    ['HTTP 403 sem envelope', () => new ShopeeHttpError('403', { httpStatus: 403, path: CAMINHO })],
    // ⚠️ QUASE-IGUAL da borda: um abaixo do 500 ainda NÃO é 5xx — o PAR (500) está em `reemitiveis`.
    [
      'HTTP 499 sem envelope (um abaixo da borda do 5xx)',
      () => new ShopeeHttpError('499', { httpStatus: 499, path: CAMINHO }),
    ],
    ['cota diária', cotaDiaria],
    ['autorização revogada', reauth],
    ['recusa determinística (kind other)', () => apiError('error_param')],
    [
      'schema',
      () =>
        new ShopeeSchemaError('corpo inválido', {
          campos: ['response'],
          httpStatus: 200,
          path: CAMINHO,
        }),
    ],
    ['erro desconhecido', () => new Error('bug')],
  ];

  it.each(memorizadas)(
    '17 — ⚠️ QUASE-IGUAL: %s FICA memoizado — reemitir por item gastaria uma chamada por item para ouvir a mesma resposta',
    async (_nome, fabricar) => {
      const erro = fabricar();
      const c = cliente(async () => {
        throw erro;
      });
      const lerBase = criarLeitorDeBaseEmLote(c.client, ids(2));
      await expect(lerBase(ITEM)).rejects.toBe(erro);
      await expect(lerBase(ITEM)).rejects.toBe(erro);
      await expect(lerBase(ITEM + 1)).rejects.toBe(erro);
      expect(c.getItemBaseInfo).toHaveBeenCalledTimes(1);
    },
  );

  it('18 — a falha de UM lote não contamina o OUTRO: com 51 ids, o 2º lote recusado e o 1º lê normalmente', async () => {
    const recusa = apiError('error_param');
    const c = cliente(async (itemIds) => {
      if (itemIds.includes(ITEM + 50)) throw recusa;
      return ecoDeTodos(itemIds);
    });
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(51));
    await expect(lerBase(ITEM + 50)).rejects.toBe(recusa);
    expect((await lerBase(ITEM))?.item_id).toBe(ITEM);
    expect(c.getItemBaseInfo).toHaveBeenCalledTimes(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  caller bugs                                */
/* -------------------------------------------------------------------------- */

describe('criarLeitorDeBaseEmLote — bug de quem chama', () => {
  it('19 — um id FORA do conjunto ⇒ ShopeeConfigError, e NENHUMA chamada', async () => {
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(2));
    await expect(lerBase(ITEM + 99)).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(c.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])(
    '20 — id inválido na construção (%s) ⇒ ShopeeConfigError ANTES de qualquer chamada',
    (invalido) => {
      const c = cliente();
      expect(() => criarLeitorDeBaseEmLote(c.client, [ITEM, invalido])).toThrow(ShopeeConfigError);
      expect(c.getItemBaseInfo).not.toHaveBeenCalled();
    },
  );

  it('21 — conjunto VAZIO: nada é chamado, e qualquer leitura é ShopeeConfigError', async () => {
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, []);
    await expect(lerBase(ITEM)).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(c.getItemBaseInfo).not.toHaveBeenCalled();
  });

  it('22 — o leitor de base nunca toca get_model_list', async () => {
    const c = cliente();
    const lerBase = criarLeitorDeBaseEmLote(c.client, ids(2));
    await lerBase(ITEM);
    expect(c.getModelList).not.toHaveBeenCalled();
  });
});

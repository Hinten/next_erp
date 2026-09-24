import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SHOPEE_HOLIDAY_MODE_TYPE,
  SHOPEE_SHOP_STATUS,
  type ShopeeClient,
  type ShopeeShopHolidayMode,
  type ShopeeShopInfo,
  type ShopeeWarehouseDetail,
} from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  __resetCachesDeContaEstoqueForTests,
  avaliarContaParaEstoque,
  lerInfoDaLojaShopee,
  type ContaParaEstoque,
  type DepsDeConta,
} from './contaEstoque';

/**
 * `lerInfoDaLojaShopee` — the shop-info read promoted out of
 * `avaliarContaParaEstoque` for step 13 (#1521, C-i). `contaEstoque.test.ts`
 * stays byte-unedited as the proof that the stock gate did not move; THIS file
 * pins what the promotion is FOR: the stock gate and the price verdict read the
 * ONE shop-info cache, so one conta inside one window costs ONE `get_shop_info`.
 */

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const OUTRA_INT = 'int-2';
const SHOP = 987654;
const AGORA = 1_760_000_000_000;
/** `READ_CACHE_TTL.config`, spelled from its factors so no literal is copied. */
const TTL_CONFIG_MS = 15 * 60 * 1000;

function conta(over: Partial<ContaParaEstoque> = {}): ContaParaEstoque {
  return { integracaoId: INT, shopId: SHOP, depositoOuterRef: 'documents/deposito/dep-1', ...over };
}

function lojaInfo(over: Record<string, unknown> = {}): ShopeeShopInfo {
  return {
    shop_name: 'Loja de Teste',
    region: 'BR',
    status: SHOPEE_SHOP_STATUS.normal,
    is_cb: false,
    auth_time: 1_700_000_000,
    expire_time: 1_800_000_000,
    merchant_id: null,
    is_sip: null,
    shop_fulfillment_flag: null,
    is_upgraded_cbsc: null,
    is_mart_shop: null,
    is_outlet_shop: null,
    mart_outlet_structure_type: null,
    ...over,
  } as unknown as ShopeeShopInfo;
}

interface ClienteFake {
  readonly ops: string[];
  readonly criacoes: () => number;
  readonly deps: (nowMs?: number) => DepsDeConta;
}

/** A client answering the stock gate's three reads; the shop is a healthy BR one. */
function clienteFake(loja: () => ShopeeShopInfo = () => lojaInfo()): ClienteFake {
  const ops: string[] = [];
  let criacoes = 0;
  const client = {
    getShopInfo: () => {
      ops.push('get_shop_info');
      return Promise.resolve(loja());
    },
    getShopHolidayMode: () => {
      ops.push('get_shop_holiday_mode');
      return Promise.resolve({
        holiday_mode_on: false,
        holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.total,
      } as unknown as ShopeeShopHolidayMode);
    },
    getWarehouseDetail: () => {
      ops.push('get_warehouse_detail');
      return Promise.resolve({
        kind: 'sem-multi-armazem',
        code: 'warehouse.error_not_in_whitelist',
      } as ShopeeWarehouseDetail);
    },
  } as unknown as ShopeeClient;
  return {
    ops,
    criacoes: () => criacoes,
    deps: (nowMs = AGORA) => ({
      clientFor: () => {
        criacoes += 1;
        return Promise.resolve(client);
      },
      nowMs,
    }),
  };
}

function lidas(cli: ClienteFake): number {
  return cli.ops.filter((o) => o === 'get_shop_info').length;
}

beforeEach(() => {
  __resetCachesDeContaEstoqueForTests();
});

afterEach(() => {
  __resetCachesDeContaEstoqueForTests();
});

describe('lerInfoDaLojaShopee — UM cache de loja para estoque e preço', () => {
  it('⚠️ PAR (M22) — estoque e depois preço na MESMA janela ⇒ UMA get_shop_info', async () => {
    const cli = clienteFake();

    const veredito = await avaliarContaParaEstoque(asDb(new FakeDb()), conta(), cli.deps());
    const loja = await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps(AGORA + 1_000));

    expect(veredito).toEqual({ ok: true });
    expect(loja.region).toBe('BR');
    expect(lidas(cli)).toBe(1);
  });

  it('PAR — na ordem inversa (preço primeiro) o portão de estoque também não relê', async () => {
    const cli = clienteFake();

    await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps());
    await avaliarContaParaEstoque(asDb(new FakeDb()), conta(), cli.deps(AGORA + 1_000));

    expect(lidas(cli)).toBe(1);
  });

  it('QUASE-IGUAL — OUTRA integração com o MESMO shop_id lê de novo (a chave é o integracaoId)', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(new FakeDb()), conta(), cli.deps());
    await lerInfoDaLojaShopee(asDb(new FakeDb()), OUTRA_INT, cli.deps());

    expect(lidas(cli)).toBe(2);
  });

  it('QUASE-IGUAL — passado o TTL de 15 min, o preço relê o que o estoque tinha lido', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(new FakeDb()), conta(), cli.deps(AGORA));
    await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps(AGORA + TTL_CONFIG_MS + 1));

    expect(lidas(cli)).toBe(2);
  });

  it('uma leitura quente não pede cliente nenhum ao seam', async () => {
    const cli = clienteFake();

    await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps());
    const depois = cli.criacoes();
    await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps());

    expect(depois).toBe(1);
    expect(cli.criacoes()).toBe(1);
  });

  it('o portão de estoque frio ainda constrói UM cliente para as três leituras', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(new FakeDb()), conta(), cli.deps());

    expect(cli.ops).toEqual(['get_shop_info', 'get_shop_holiday_mode', 'get_warehouse_detail']);
    expect(cli.criacoes()).toBe(1);
  });

  it('o preço lê o MESMO objeto que o portão de estoque julgou', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'SG', is_cb: true }));

    await avaliarContaParaEstoque(asDb(new FakeDb()), conta(), cli.deps());
    const loja = await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps());

    expect(loja.region).toBe('SG');
    expect(loja.is_cb).toBe(true);
  });

  it('uma falha PROPAGA e não é cacheada — a leitura seguinte tenta de novo', async () => {
    let tentativas = 0;
    const cli = clienteFake(() => {
      tentativas += 1;
      if (tentativas === 1) throw new TypeError('fetch failed');
      return lojaInfo();
    });

    await expect(lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps())).rejects.toThrow(
      'fetch failed',
    );
    const loja = await lerInfoDaLojaShopee(asDb(new FakeDb()), INT, cli.deps());

    expect(loja.status).toBe(SHOPEE_SHOP_STATUS.normal);
    expect(tentativas).toBe(2);
  });
});

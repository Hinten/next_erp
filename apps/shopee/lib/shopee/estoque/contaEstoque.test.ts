import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  SHOPEE_HOLIDAY_MODE_TYPE,
  SHOPEE_SHOP_STATUS,
  ShopeeApiError,
  ShopeeRateLimitError,
  type ShopeeClient,
  type ShopeeShopHolidayMode,
  type ShopeeShopInfo,
  type ShopeeWarehouseDetail,
} from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  __resetCachesDeContaEstoqueForTests,
  avaliarContaParaEstoque,
  contaAceitaEstoqueShopee,
  type ContaParaEstoque,
  type DepsDeConta,
} from './contaEstoque';
import { MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const OUTRA_INT = 'int-2';
const SHOP = 987654;
const DEPOSITO = 'documents/deposito/dep-1';
const AGORA = 1_760_000_000_000;

/** `READ_CACHE_TTL.config`, spelled from its factors so no literal is copied. */
const TTL_CONFIG_MS = 15 * 60 * 1000;
/** `READ_CACHE_TTL.volatile`. */
const TTL_VOLATIL_MS = 60 * 1000;

function conta(over: Partial<ContaParaEstoque> = {}): ContaParaEstoque {
  return { integracaoId: INT, shopId: SHOP, depositoOuterRef: DEPOSITO, ...over };
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

function feriasInfo(over: Record<string, unknown> = {}): ShopeeShopHolidayMode {
  return {
    holiday_mode_on: false,
    holiday_mode_mtime: null,
    // ⚠️ The value probe P2 measured beside `holiday_mode_on: false`: 0 IS the
    // FULL type, so the default fixture already carries the trap.
    holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.total,
    holiday_mode_start_time: null,
    holiday_mode_end_time: null,
    holiday_mode_description: null,
    debug_msg: null,
    ...over,
  } as unknown as ShopeeShopHolidayMode;
}

const SEM_MULTI_ARMAZEM: ShopeeWarehouseDetail = {
  kind: 'sem-multi-armazem',
  code: 'warehouse.error_not_in_whitelist',
};

function listaDeArmazens(quantos: number): ShopeeWarehouseDetail {
  return {
    kind: 'lista',
    armazens: Array.from({ length: quantos }, (_unused, i) => ({
      warehouse_id: 9000 + i,
      warehouse_name: `Armazém ${String(i)}`,
      warehouse_type: 1,
      location_id: i === 0 ? 'IDZ' : 'SGZ',
      address_id: null,
      region: 'BR',
      holiday_mode_state: 0,
    })),
  } as unknown as ShopeeWarehouseDetail;
}

interface OpcoesCliente {
  readonly loja?: () => ShopeeShopInfo | Promise<ShopeeShopInfo>;
  readonly ferias?: () => ShopeeShopHolidayMode | Promise<ShopeeShopHolidayMode>;
  readonly armazens?: () => ShopeeWarehouseDetail | Promise<ShopeeWarehouseDetail>;
}

interface ClienteFake {
  readonly client: ShopeeClient;
  /** Every operation called, in order — "never called X" needs no spy. */
  readonly ops: string[];
  /** How many times the SEAM was asked for a client. */
  readonly criacoes: () => number;
  readonly deps: (nowMs?: number) => DepsDeConta;
}

/**
 * A `ShopeeClient` answering only this module's three reads. The default
 * answers are the healthy BR shop; a case overrides one leg.
 */
function clienteFake(op: OpcoesCliente = {}): ClienteFake {
  const ops: string[] = [];
  let criacoes = 0;
  const client = {
    getShopInfo: () => {
      ops.push('get_shop_info');
      return Promise.resolve((op.loja ?? ((): ShopeeShopInfo => lojaInfo()))());
    },
    getShopHolidayMode: () => {
      ops.push('get_shop_holiday_mode');
      return Promise.resolve((op.ferias ?? ((): ShopeeShopHolidayMode => feriasInfo()))());
    },
    getWarehouseDetail: () => {
      ops.push('get_warehouse_detail');
      return Promise.resolve((op.armazens ?? ((): ShopeeWarehouseDetail => SEM_MULTI_ARMAZEM))());
    },
  } as unknown as ShopeeClient;

  return {
    client,
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

function db(): FakeDb {
  return new FakeDb();
}

beforeEach(() => {
  __resetCachesDeContaEstoqueForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetCachesDeContaEstoqueForTests();
});

/* -------------------------------------------------------------------------- */
/*                    (1) the two local rungs — ZERO calls                     */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — os dois degraus locais', () => {
  it('1. shopId nulo ⇒ sem-shop-id, e NENHUMA chamada à Shopee', async () => {
    const cli = clienteFake();

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta({ shopId: null }), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semShopId });
    expect(cli.ops).toEqual([]);
    expect(cli.criacoes()).toBe(0);
  });

  it('2. depósito em branco ⇒ sem-deposito, e NENHUMA chamada à Shopee', async () => {
    const cli = clienteFake();

    const veredito = await avaliarContaParaEstoque(
      asDb(db()),
      conta({ depositoOuterRef: '   ' }),
      cli.deps(),
    );

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semDeposito });
    expect(cli.ops).toEqual([]);
    expect(cli.criacoes()).toBe(0);
  });

  it('3. depósito nulo ⇒ sem-deposito (PAR com o branco acima)', async () => {
    const cli = clienteFake();

    const veredito = await avaliarContaParaEstoque(
      asDb(db()),
      conta({ depositoOuterRef: null }),
      cli.deps(),
    );

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semDeposito });
    expect(cli.ops).toEqual([]);
  });

  it('4. ⚠️ a ORDEM: sem shopId E sem depósito responde sem-shop-id', async () => {
    const cli = clienteFake();

    const veredito = await avaliarContaParaEstoque(
      asDb(db()),
      conta({ shopId: null, depositoOuterRef: null }),
      cli.deps(),
    );

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.semShopId });
  });
});

/* -------------------------------------------------------------------------- */
/*                          (2) get_shop_info's four                           */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — os portões de get_shop_info', () => {
  it('5. uma loja saudável passa os três portões e responde ok', async () => {
    const cli = clienteFake();

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
    expect(cli.ops).toEqual(['get_shop_info', 'get_shop_holiday_mode', 'get_warehouse_detail']);
  });

  it('6. status FROZEN ⇒ loja-banida-ou-congelada, sem ler férias nem armazéns', async () => {
    const cli = clienteFake({ loja: () => lojaInfo({ status: SHOPEE_SHOP_STATUS.frozen }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({
      ok: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.lojaBanidaOuCongelada,
    });
    expect(cli.ops).toEqual(['get_shop_info']);
  });

  it('7. status BANNED ⇒ o MESMO veredito (PAR: os dois são "não vende")', async () => {
    const cli = clienteFake({ loja: () => lojaInfo({ status: SHOPEE_SHOP_STATUS.banned }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({
      ok: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.lojaBanidaOuCongelada,
    });
  });

  it('8. is_upgraded_cbsc verdadeiro ⇒ loja-cbsc', async () => {
    const cli = clienteFake({ loja: () => lojaInfo({ is_upgraded_cbsc: true }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaCbsc });
  });

  it('9. NEAR-MISS: is_upgraded_cbsc falso e nulo ambos ENVIAM ("não informado" ≠ sim)', async () => {
    for (const valor of [false, null]) {
      __resetCachesDeContaEstoqueForTests();
      const cli = clienteFake({ loja: () => lojaInfo({ is_upgraded_cbsc: valor }) });

      const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

      expect(veredito).toEqual({ ok: true });
    }
  });

  it('10. is_outlet_shop verdadeiro ⇒ loja-outlet', async () => {
    const cli = clienteFake({ loja: () => lojaInfo({ is_outlet_shop: true }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaOutlet });
  });

  it('11. mart_outlet_structure_type "warehouse_outlet_shop" ⇒ loja-outlet', async () => {
    const cli = clienteFake({
      loja: () => lojaInfo({ mart_outlet_structure_type: 'warehouse_outlet_shop' }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaOutlet });
  });

  it('12. NEAR-MISS: "normal_outlet_shop" ENVIA — só a estrutura de ARMAZÉM bloqueia', async () => {
    const cli = clienteFake({
      loja: () => lojaInfo({ mart_outlet_structure_type: 'normal_outlet_shop' }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/*         (3) the fulfilment flag — the fold's EQUAL and DISTINCT sides       */
/* -------------------------------------------------------------------------- */

describe('contaAceitaEstoqueShopee — o escopo da dobra', () => {
  it('13. PAR: "Pure - FBS Shop" e " pure - fbs shop " são O MESMO valor (recusam)', () => {
    expect(contaAceitaEstoqueShopee('Pure - FBS Shop')).toBe(false);
    expect(contaAceitaEstoqueShopee(' pure - fbs shop ')).toBe(false);
    expect(contaAceitaEstoqueShopee('PURE - FBS SHOP')).toBe(false);
    expect(contaAceitaEstoqueShopee('\tPure - FBS Shop\n')).toBe(false);
  });

  it('14. NEAR-MISS: "PFF - FBS Shop" é OUTRO regime e ENVIA (nunca endsWith/includes)', () => {
    expect(contaAceitaEstoqueShopee('PFF - FBS Shop')).toBe(true);
  });

  it('15. NEAR-MISS: "Pure - FBS Shopping" ENVIA (nunca startsWith)', () => {
    expect(contaAceitaEstoqueShopee('Pure - FBS Shopping')).toBe(true);
  });

  it('16. NEAR-MISS: "Pure-FBS Shop" (sem os espaços) ENVIA — só o valor exato recusa', () => {
    expect(contaAceitaEstoqueShopee('Pure-FBS Shop')).toBe(true);
  });

  it('17. ⚠️ C-f: "Others - Unknown" é uma FALHA DE LEITURA e ENVIA', () => {
    expect(contaAceitaEstoqueShopee('Others - Unknown')).toBe(true);
  });

  it('18. os outros quatro valores documentados ENVIAM', () => {
    for (const flag of ['Pure - 3PF Shop', 'PFF - 3PF Shop', 'LFF Hybrid Shop', 'Others - New']) {
      expect(contaAceitaEstoqueShopee(flag)).toBe(true);
    }
  });

  it('19. um valor NÃO-string (ausente, nulo, número) ENVIA', () => {
    expect(contaAceitaEstoqueShopee(null)).toBe(true);
    expect(contaAceitaEstoqueShopee(undefined)).toBe(true);
    expect(contaAceitaEstoqueShopee(42)).toBe(true);
    expect(contaAceitaEstoqueShopee('')).toBe(true);
  });
});

describe('avaliarContaParaEstoque — o portão FBS', () => {
  it('20. "Pure - FBS Shop" ⇒ loja-fbs, sem ler férias nem armazéns', async () => {
    const cli = clienteFake({ loja: () => lojaInfo({ shop_fulfillment_flag: 'Pure - FBS Shop' }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaFbs });
    expect(cli.ops).toEqual(['get_shop_info']);
  });

  it('21. PAR (com acolchoamento e caixa trocada) ⇒ o MESMO loja-fbs', async () => {
    const cli = clienteFake({
      loja: () => lojaInfo({ shop_fulfillment_flag: ' pure - fbs shop ' }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaFbs });
  });

  it('22. NEAR-MISS: "PFF - FBS Shop" segue o caminho normal e responde ok', async () => {
    const cli = clienteFake({ loja: () => lojaInfo({ shop_fulfillment_flag: 'PFF - FBS Shop' }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });

  it('23. ⚠️ "Others - Unknown" ENVIA e DEIXA UM REGISTRO com o valor bruto', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cli = clienteFake({
      loja: () => lojaInfo({ shop_fulfillment_flag: 'Others - Unknown' }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(avisos.mock.calls[0]?.[1]).toEqual({
      integracaoId: INT,
      shopFulfillmentFlag: 'Others - Unknown',
    });
  });

  it('24. um valor DESCONHECIDO envia e registra (o único traço de um sétimo valor)', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cli = clienteFake({ loja: () => lojaInfo({ shop_fulfillment_flag: 'Hybrid - 4PF' }) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(avisos.mock.calls[0]?.[1]).toEqual({
      integracaoId: INT,
      shopFulfillmentFlag: 'Hybrid - 4PF',
    });
  });

  it('25. NEAR-MISS: um flag AUSENTE ou documentado NÃO registra nada', async () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await avaliarContaParaEstoque(asDb(db()), conta(), clienteFake().deps());
    __resetCachesDeContaEstoqueForTests();
    await avaliarContaParaEstoque(
      asDb(db()),
      conta(),
      clienteFake({ loja: () => lojaInfo({ shop_fulfillment_flag: 'LFF Hybrid Shop' }) }).deps(),
    );

    expect(avisos).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*                            (4) holiday mode                                 */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — o portão de férias', () => {
  it('26. férias TOTAIS (on: true, type: 0) ⇒ loja-em-ferias, sem ler armazéns', async () => {
    const cli = clienteFake({
      ferias: () =>
        feriasInfo({ holiday_mode_on: true, holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.total }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias });
    expect(cli.ops).toEqual(['get_shop_info', 'get_shop_holiday_mode']);
  });

  it('27. NEAR-MISS: férias PARCIAIS (on: true, type: 1) ENVIAM — P10 mediu que não bloqueiam', async () => {
    const cli = clienteFake({
      ferias: () =>
        feriasInfo({ holiday_mode_on: true, holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.parcial }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });

  it('28. holiday_mode_on nulo ENVIA — ausência não é feriado', async () => {
    const cli = clienteFake({
      ferias: () =>
        feriasInfo({ holiday_mode_on: null, holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.total }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });

  it('29. ⚠️ o corpo medido por P2 (on: false com type 0) ENVIA — lê-se "on" primeiro', async () => {
    const cli = clienteFake({ ferias: () => feriasInfo() });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/*                            (5) the warehouse regime                         */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — o portão de armazéns', () => {
  it('30. uma LISTA não vazia ⇒ multi-armazem', async () => {
    const cli = clienteFake({ armazens: () => listaDeArmazens(2) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.multiArmazem });
  });

  it('31. ⚠️ NEAR-MISS: uma lista com UM armazém já recusa (não há mapa de um depósito só)', async () => {
    const cli = clienteFake({ armazens: () => listaDeArmazens(1) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.multiArmazem });
  });

  it('32. NEAR-MISS: uma lista VAZIA segue o caminho normal — nada a mapear não é um regime', async () => {
    const cli = clienteFake({ armazens: () => listaDeArmazens(0) });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });

  it('33. "sem-multi-armazem" (a recusa de whitelist já dobrada) responde ok', async () => {
    const cli = clienteFake({ armazens: () => SEM_MULTI_ARMAZEM });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/*                      (6) the order between the gates                        */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — a ordem dos portões', () => {
  it('34. ⚠️ FBS **e** em férias responde loja-fbs: a forma da loja vem antes do interruptor', async () => {
    const cli = clienteFake({
      loja: () => lojaInfo({ shop_fulfillment_flag: 'Pure - FBS Shop' }),
      ferias: () =>
        feriasInfo({ holiday_mode_on: true, holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.total }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaFbs });
    expect(cli.ops).toEqual(['get_shop_info']);
  });

  it('35. em férias **e** multi-armazém responde loja-em-ferias', async () => {
    const cli = clienteFake({
      ferias: () =>
        feriasInfo({ holiday_mode_on: true, holiday_mode_type: SHOPEE_HOLIDAY_MODE_TYPE.total }),
      armazens: () => listaDeArmazens(2),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: false, motivo: MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias });
  });

  it('36. banida **e** FBS responde loja-banida-ou-congelada', async () => {
    const cli = clienteFake({
      loja: () =>
        lojaInfo({
          status: SHOPEE_SHOP_STATUS.banned,
          shop_fulfillment_flag: 'Pure - FBS Shop',
        }),
    });

    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({
      ok: false,
      motivo: MOTIVO_ESTOQUE_SHOPEE.lojaBanidaOuCongelada,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                               (7) the caches                                */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — os três caches', () => {
  it('37. PAR: duas avaliações da MESMA conta no mesmo instante ⇒ UMA get_shop_info', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());
    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(cli.ops.filter((o) => o === 'get_shop_info')).toHaveLength(1);
    expect(cli.ops.filter((o) => o === 'get_shop_holiday_mode')).toHaveLength(1);
    expect(cli.ops.filter((o) => o === 'get_warehouse_detail')).toHaveLength(1);
  });

  it('38. NEAR-MISS: depois do reset, a segunda avaliação lê tudo de novo', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());
    __resetCachesDeContaEstoqueForTests();
    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(cli.ops.filter((o) => o === 'get_shop_info')).toHaveLength(2);
  });

  it('39. ⚠️ a chave é o integracaoId: duas contas com o MESMO shopId leem duas vezes', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());
    await avaliarContaParaEstoque(
      asDb(db()),
      conta({ integracaoId: OUTRA_INT, shopId: SHOP }),
      cli.deps(),
    );

    expect(cli.ops.filter((o) => o === 'get_shop_info')).toHaveLength(2);
  });

  it('40. PAR do mesmo fato: a MESMA integração com outro shopId lê UMA vez', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());
    await avaliarContaParaEstoque(asDb(db()), conta({ shopId: SHOP + 1 }), cli.deps());

    expect(cli.ops.filter((o) => o === 'get_shop_info')).toHaveLength(1);
  });

  it('41. um tick totalmente quente não pede cliente nenhum ao seam', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());
    const depois = cli.criacoes();
    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(depois).toBe(1);
    expect(cli.criacoes()).toBe(1);
  });

  it('42. TTL: passados 15 min a loja é relida; férias, com 60 s, já foram relidas antes', async () => {
    const cli = clienteFake();

    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps(AGORA));
    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps(AGORA + TTL_VOLATIL_MS + 1));
    const lojaNoMeio = cli.ops.filter((o) => o === 'get_shop_info').length;
    const feriasNoMeio = cli.ops.filter((o) => o === 'get_shop_holiday_mode').length;
    await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps(AGORA + TTL_CONFIG_MS + 1));

    expect(lojaNoMeio).toBe(1);
    expect(feriasNoMeio).toBe(2);
    expect(cli.ops.filter((o) => o === 'get_shop_info')).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                      (8) a provider failure is NOT a verdict                */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaEstoque — falhas do provedor', () => {
  it('43. ⚠️ um erro de rede em get_shop_info PROPAGA, nunca vira um veredito', async () => {
    const cli = clienteFake({
      loja: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(avaliarContaParaEstoque(asDb(db()), conta(), cli.deps())).rejects.toThrow(
      'fetch failed',
    );
  });

  it('44. um ShopeeApiError em get_shop_holiday_mode PROPAGA', async () => {
    const cli = clienteFake({
      ferias: () =>
        Promise.reject(
          new ShopeeApiError('Shopee respondeu error_server (HTTP 200)', {
            code: 'error_server',
            kind: SHOPEE_ERROR_KIND.other,
            httpStatus: 200,
            path: '/api/v2/shop/get_shop_holiday_mode',
          }),
        ),
    });

    await expect(avaliarContaParaEstoque(asDb(db()), conta(), cli.deps())).rejects.toBeInstanceOf(
      ShopeeApiError,
    );
  });

  it('45. um rate limit em get_warehouse_detail PROPAGA (a varredura é que pausa a conta)', async () => {
    const cli = clienteFake({
      armazens: () =>
        Promise.reject(
          new ShopeeRateLimitError('Shopee respondeu error_limit (HTTP 200)', {
            code: 'error_limit',
            kind: SHOPEE_ERROR_KIND.burst,
            httpStatus: 200,
            path: '/api/v2/shop/get_warehouse_detail',
          }),
        ),
    });

    await expect(avaliarContaParaEstoque(asDb(db()), conta(), cli.deps())).rejects.toBeInstanceOf(
      ShopeeRateLimitError,
    );
  });

  it('46. NEAR-MISS: uma falha NÃO é cacheada — a avaliação seguinte tenta de novo', async () => {
    let tentativas = 0;
    const cli = clienteFake({
      loja: () => {
        tentativas += 1;
        if (tentativas === 1) return Promise.reject(new TypeError('fetch failed'));
        return lojaInfo();
      },
    });

    await expect(avaliarContaParaEstoque(asDb(db()), conta(), cli.deps())).rejects.toThrow(
      'fetch failed',
    );
    const veredito = await avaliarContaParaEstoque(asDb(db()), conta(), cli.deps());

    expect(veredito).toEqual({ ok: true });
    expect(tentativas).toBe(2);
  });
});

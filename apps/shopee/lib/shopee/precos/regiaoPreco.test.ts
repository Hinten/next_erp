import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_PROD_API_HOST,
  SHOPEE_SANDBOX_API_HOST,
  SHOPEE_SHOP_STATUS,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeReauthRequiredError,
  resolveShopeeHosts,
  type ShopeeClient,
  type ShopeeShopHolidayMode,
  type ShopeeShopInfo,
  type ShopeeWarehouseDetail,
} from '@delfrance/integrations-shopee';

import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { ShopeeContaNotConfiguredError, loadShopeeContext } from '../core/shopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
import {
  __resetCachesDeContaEstoqueForTests,
  avaliarContaParaEstoque,
} from '../estoque/contaEstoque';
import { FakeDb, asDb } from '../testing/fakeDb';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import {
  MOEDA_E_MULTIPLO_POR_REGIAO,
  avaliarContaParaPreco,
  ehContaInutilizavel,
  overrideDeSandboxAtivo,
  type ContaParaPreco,
  type ContextoContaPreco,
  type DepsDeContaPreco,
  type VereditoContaPreco,
} from './regiaoPreco';

/**
 * `regiaoPreco.ts` — the conta verdict of the price sync (#1521, step 13,
 * reconcile C-i; D1 §3.4 T-R1…T-R6 and §3.13).
 *
 * The property that matters most is the one a green run hides best: a reais
 * figure must never reach a shop whose currency is not reais. So every region
 * test comes as a PAIR (what must pass) and a NEAR-MISS (the spelling, host or
 * flag one step away that must refuse).
 */

// `loadShopeeContext` is replaced ONLY so the default client seam (no
// `clientFor`) can be observed; the four error classes stay the REAL ones.
const h = vi.hoisted(() => ({ loadCtx: vi.fn() }));

vi.mock('../core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('../core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const SHOP = 987654;
const AGORA = 1_760_000_000_000;
const TABELA = 'documents/listaDePrecos/lp-1';

const CONFIG_PRODUCAO = { sandbox: false, hosts: resolveShopeeHosts({ sandbox: false }) };
const CONFIG_SANDBOX = { sandbox: true, hosts: resolveShopeeHosts({ sandbox: true }) };
/** The flag ON beside an explicit API host pointing at PRODUCTION (override > flag). */
const CONFIG_FLAG_COM_HOST_DE_PRODUCAO = {
  sandbox: true,
  hosts: resolveShopeeHosts({ sandbox: true, apiHost: SHOPEE_PROD_API_HOST }),
};
/** The flag OFF beside an explicit API host pointing at the sandbox. */
const CONFIG_HOST_DA_SANDBOX_SEM_FLAG = {
  sandbox: false,
  hosts: resolveShopeeHosts({ sandbox: false, apiHost: SHOPEE_SANDBOX_API_HOST }),
};

function conta(over: Partial<ContaParaPreco> = {}): ContaParaPreco {
  return { integracaoId: INT, shopId: SHOP, tabelaNormalOuterRef: TABELA, ...over };
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
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly criacoes: () => number;
  readonly deps: (over?: Partial<DepsDeContaPreco>) => DepsDeContaPreco;
}

/**
 * A client whose `get_shop_info` answers `loja()` (a healthy BR shop by
 * default) — or throws it, when `loja` throws. The stock gate's two other reads
 * are answered too, for the shared-cache test.
 */
function clienteFake(loja: () => ShopeeShopInfo = () => lojaInfo()): ClienteFake {
  const ops: string[] = [];
  let criacoes = 0;
  const client = {
    getShopInfo: () => {
      ops.push('get_shop_info');
      return Promise.resolve().then(loja);
    },
    getShopHolidayMode: () => {
      ops.push('get_shop_holiday_mode');
      return Promise.resolve({ holiday_mode_on: false } as unknown as ShopeeShopHolidayMode);
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
    client,
    ops,
    criacoes: () => criacoes,
    deps: (over = {}) => ({
      clientFor: () => {
        criacoes += 1;
        return Promise.resolve(client);
      },
      nowMs: AGORA,
      config: CONFIG_PRODUCAO,
      ...over,
    }),
  };
}

function db() {
  return asDb(new FakeDb());
}

function lidas(cli: ClienteFake): number {
  return cli.ops.filter((o) => o === 'get_shop_info').length;
}

/** The refusal arm, or a failed assertion. */
function recusada(v: VereditoContaPreco) {
  if (v.ok) throw new Error(`esperava recusa, veio ok (${v.contexto.regiao})`);
  return v;
}

/** The accepted context, or a failed assertion. */
function aprovada(v: VereditoContaPreco): ContextoContaPreco {
  if (!v.ok) throw new Error(`esperava ok, veio ${v.motivo}`);
  return v.contexto;
}

beforeEach(() => {
  __resetCachesDeContaEstoqueForTests();
  h.loadCtx.mockReset();
});

afterEach(() => {
  __resetCachesDeContaEstoqueForTests();
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/*                               the region table                              */
/* -------------------------------------------------------------------------- */

describe('MOEDA_E_MULTIPLO_POR_REGIAO', () => {
  it('é EXATAMENTE BR→BRL/4 e SG→SGD/5 — nenhuma outra região tem linha', () => {
    expect([...MOEDA_E_MULTIPLO_POR_REGIAO.entries()]).toEqual([
      ['BR', { moeda: 'BRL', multiplo: 4 }],
      ['SG', { moeda: 'SGD', multiplo: 5 }],
    ]);
  });

  it('⛔ uma chave de protótipo não é região (um Map, nunca um objeto)', () => {
    for (const chave of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(MOEDA_E_MULTIPLO_POR_REGIAO.has(chave)).toBe(false);
      expect(MOEDA_E_MULTIPLO_POR_REGIAO.get(chave)).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                the override                                 */
/* -------------------------------------------------------------------------- */

describe('overrideDeSandboxAtivo — a flag E o host resolvido', () => {
  it('PAR — flag ligada + o host da sandbox (com e sem o override de host explícito) ⇒ ativo', () => {
    expect(overrideDeSandboxAtivo(CONFIG_SANDBOX)).toBe(true);
    expect(
      overrideDeSandboxAtivo({
        sandbox: true,
        hosts: resolveShopeeHosts({ sandbox: true, apiHost: `${SHOPEE_SANDBOX_API_HOST}/` }),
      }),
    ).toBe(true);
  });

  it('⚠️ QUASE-IGUAL (M23, T-R3) — flag ligada + host de PRODUÇÃO ⇒ INATIVO', () => {
    expect(overrideDeSandboxAtivo(CONFIG_FLAG_COM_HOST_DE_PRODUCAO)).toBe(false);
  });

  it('QUASE-IGUAL — flag desligada + host da sandbox ⇒ inativo; produção pura ⇒ inativo', () => {
    expect(overrideDeSandboxAtivo(CONFIG_HOST_DA_SANDBOX_SEM_FLAG)).toBe(false);
    expect(overrideDeSandboxAtivo(CONFIG_PRODUCAO)).toBe(false);
  });

  it('QUASE-IGUAL — o host é comparado por IDENTIDADE e a flag por `=== true`', () => {
    const hosts = resolveShopeeHosts({ sandbox: true });
    expect(
      overrideDeSandboxAtivo({
        sandbox: true,
        hosts: { ...hosts, apiHost: `${SHOPEE_SANDBOX_API_HOST}/` },
      }),
    ).toBe(false);
    expect(
      overrideDeSandboxAtivo({
        sandbox: true,
        hosts: { ...hosts, apiHost: SHOPEE_SANDBOX_API_HOST.toUpperCase() },
      }),
    ).toBe(false);
    expect(overrideDeSandboxAtivo({ sandbox: 'true' as unknown as boolean, hosts })).toBe(false);
    expect(overrideDeSandboxAtivo({ sandbox: 1 as unknown as boolean, hosts })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                              the conta classes                              */
/* -------------------------------------------------------------------------- */

const CLASSES_DE_CONTA: readonly (readonly [string, () => Error])[] = [
  [
    'ShopeeContaNotConfiguredError',
    () => new ShopeeContaNotConfiguredError('Integração int-1 não encontrada.'),
  ],
  ['ShopeeContaSemShopIdError', () => new ShopeeContaSemShopIdError('Integração int-1 sem loja.')],
  [
    'ShopeeSemCredencialError',
    () => new ShopeeSemCredencialError('Integração int-1 sem credencial.'),
  ],
  [
    'ShopeeCredencialInvalidaError',
    () => new ShopeeCredencialInvalidaError('Credencial ilegível.', ['access_token']),
  ],
];

const OUTROS_ERROS: readonly (readonly [string, () => unknown])[] = [
  [
    'ShopeeRefreshEmAndamentoError (transitório)',
    () => new ShopeeRefreshEmAndamentoError('em andamento', AGORA),
  ],
  [
    'ShopeeConfigError (o NOSSO bug)',
    () => new ShopeeConfigError('SHOPEE_PARTNER_KEY não configurado.'),
  ],
  [
    'ShopeeApiError (um envelope da Shopee)',
    () =>
      new ShopeeApiError('falhou', {
        code: 'error_server',
        kind: SHOPEE_ERROR_KIND.transient,
        httpStatus: 500,
        path: '/api/v2/shop/get_shop_info',
      }),
  ],
  [
    'ShopeeReauthRequiredError (a concessão expirou)',
    () =>
      new ShopeeReauthRequiredError('expirou', {
        code: 'error_auth',
        kind: SHOPEE_ERROR_KIND.reauth,
        httpStatus: 403,
        path: '/api/v2/shop/get_shop_info',
      }),
  ],
  ['um Error qualquer', () => new Error('rede caiu')],
];

describe('ehContaInutilizavel — as quatro classes de conta', () => {
  it.each(CLASSES_DE_CONTA)('PAR — %s é conta inutilizável', (_nome, criar) => {
    expect(ehContaInutilizavel(criar())).toBe(true);
  });

  it.each(OUTROS_ERROS)('QUASE-IGUAL — %s NÃO é', (_nome, criar) => {
    expect(ehContaInutilizavel(criar())).toBe(false);
  });

  it('QUASE-IGUAL — um objeto com o MESMO name não é a classe', () => {
    expect(ehContaInutilizavel({ name: 'ShopeeSemCredencialError', message: 'x' })).toBe(false);
    expect(ehContaInutilizavel(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  the rungs                                  */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaPreco — degraus locais (zero chamadas)', () => {
  it('1 — sem shop_id ⇒ sem-shop-id, sem construir cliente', async () => {
    const cli = clienteFake();
    const v = recusada(await avaliarContaParaPreco(db(), conta({ shopId: null }), cli.deps()));

    expect(v).toEqual({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.semShopId,
      regiao: null,
      erro: null,
    });
    expect(cli.criacoes()).toBe(0);
    expect(cli.ops).toEqual([]);
  });

  it('1 antes de 2 — sem shop_id E sem tabela ⇒ sem-shop-id', async () => {
    const cli = clienteFake();
    const v = recusada(
      await avaliarContaParaPreco(
        db(),
        conta({ shopId: null, tabelaNormalOuterRef: null }),
        cli.deps(),
      ),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.semShopId);
  });

  it.each([
    ['null', null],
    ['ausente', undefined],
    ['vazio', ''],
    ['só espaços', '   '],
    ['só barras', '///'],
    ['um número', 42],
    ['um objeto', { id: 'lp-1' }],
  ])('2 — tabela normal %s ⇒ sem-tabela-normal, sem construir cliente', async (_nome, bruto) => {
    const cli = clienteFake();
    const v = recusada(
      await avaliarContaParaPreco(db(), conta({ tabelaNormalOuterRef: bruto }), cli.deps()),
    );

    expect(v).toEqual({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.semTabelaNormal,
      regiao: null,
      erro: null,
    });
    expect(cli.criacoes()).toBe(0);
    expect(cli.ops).toEqual([]);
  });

  it('PAR — as duas codificações do ref da tabela resolvem o MESMO tabelaNormalId', async () => {
    const ids: string[] = [];
    for (const ref of ['documents/listaDePrecos/lp-1', 'listaDePrecos/lp-1']) {
      __resetCachesDeContaEstoqueForTests();
      const cli = clienteFake();
      ids.push(
        aprovada(
          await avaliarContaParaPreco(db(), conta({ tabelaNormalOuterRef: ref }), cli.deps()),
        ).tabelaNormalId,
      );
    }
    expect(ids).toEqual(['lp-1', 'lp-1']);
  });

  it('QUASE-IGUAL — outra tabela continua OUTRO id (lp-1 ≠ lp-12)', async () => {
    const cli = clienteFake();
    const ctx = aprovada(
      await avaliarContaParaPreco(
        db(),
        conta({ tabelaNormalOuterRef: 'documents/listaDePrecos/lp-12' }),
        cli.deps(),
      ),
    );
    expect(ctx.tabelaNormalId).toBe('lp-12');
  });
});

describe('avaliarContaParaPreco — a região (T-R1…T-R5)', () => {
  it('PAR — BR ⇒ ok BRL/4, com o override desligado E ligado', async () => {
    for (const config of [CONFIG_PRODUCAO, CONFIG_SANDBOX]) {
      __resetCachesDeContaEstoqueForTests();
      const cli = clienteFake();
      const ctx = aprovada(await avaliarContaParaPreco(db(), conta(), cli.deps({ config })));
      expect({ regiao: ctx.regiao, moeda: ctx.moeda, multiplo: ctx.multiplo }).toEqual({
        regiao: 'BR',
        moeda: 'BRL',
        multiplo: 4,
      });
    }
  });

  it('T-R1 — config de PRODUÇÃO + SG ⇒ regiao-nao-suportada, com a região', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
    const v = recusada(
      await avaliarContaParaPreco(db(), conta(), cli.deps({ config: CONFIG_PRODUCAO })),
    );

    expect(v).toEqual({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
      regiao: 'SG',
      erro: null,
    });
  });

  it('T-R2 — sandbox ativa (flag + host da sandbox) + SG ⇒ ok, moeda SGD, múltiplo 5', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
    const ctx = aprovada(
      await avaliarContaParaPreco(db(), conta(), cli.deps({ config: CONFIG_SANDBOX })),
    );

    expect({ regiao: ctx.regiao, moeda: ctx.moeda, multiplo: ctx.multiplo }).toEqual({
      regiao: 'SG',
      moeda: 'SGD',
      multiplo: 5,
    });
  });

  it('⚠️ T-R3 (M23) — flag de sandbox + host de PRODUÇÃO + SG ⇒ RECUSADA', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
    const v = recusada(
      await avaliarContaParaPreco(
        db(),
        conta(),
        cli.deps({ config: CONFIG_FLAG_COM_HOST_DE_PRODUCAO }),
      ),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
  });

  it('QUASE-IGUAL — host da sandbox SEM a flag + SG ⇒ recusada', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
    const v = recusada(
      await avaliarContaParaPreco(
        db(),
        conta(),
        cli.deps({ config: CONFIG_HOST_DA_SANDBOX_SEM_FLAG }),
      ),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
  });

  it.each(['MY', 'TW', 'constructor', '__proto__', ''])(
    '⚠️ T-R4 (M24) — override ATIVO + região sem linha %j ⇒ recusada (nunca adivinhada)',
    async (regiao) => {
      const cli = clienteFake(() => lojaInfo({ region: regiao }));
      const v = recusada(
        await avaliarContaParaPreco(db(), conta(), cli.deps({ config: CONFIG_SANDBOX })),
      );

      expect(v).toEqual({
        ok: false,
        motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
        regiao,
        erro: null,
      });
    },
  );

  it.each(['br', ' BR', 'BR ', 'Br', 'BRA'])(
    '⚠️ T-R5 (M25) — QUASE-IGUAL %j não é BR ⇒ recusada, com o override ligado ou desligado',
    async (regiao) => {
      for (const config of [CONFIG_PRODUCAO, CONFIG_SANDBOX]) {
        __resetCachesDeContaEstoqueForTests();
        const cli = clienteFake(() => lojaInfo({ region: regiao }));
        const v = recusada(await avaliarContaParaPreco(db(), conta(), cli.deps({ config })));
        expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
      }
    },
  );

  it('QUASE-IGUAL — "sg" minúsculo com o override ativo também recusa (a chave é a grafia do fio)', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'sg' }));
    const v = recusada(
      await avaliarContaParaPreco(db(), conta(), cli.deps({ config: CONFIG_SANDBOX })),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
  });
});

describe('avaliarContaParaPreco — status e cross-border', () => {
  it.each([SHOPEE_SHOP_STATUS.banned, SHOPEE_SHOP_STATUS.frozen])(
    '%s ⇒ loja-banida-ou-congelada, com a região',
    async (status) => {
      const cli = clienteFake(() => lojaInfo({ status }));
      const v = recusada(await avaliarContaParaPreco(db(), conta(), cli.deps()));
      expect(v).toEqual({
        ok: false,
        motivo: MOTIVO_PRECO_SHOPEE.lojaBanidaOuCongelada,
        regiao: 'BR',
        erro: null,
      });
    },
  );

  it('banida vem ANTES de cross-border', async () => {
    const cli = clienteFake(() => lojaInfo({ status: SHOPEE_SHOP_STATUS.banned, is_cb: true }));
    const v = recusada(await avaliarContaParaPreco(db(), conta(), cli.deps()));
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.lojaBanidaOuCongelada);
  });

  it('⚠️ M26 — is_cb numa loja BR ⇒ loja-cross-border (a região BR não salva)', async () => {
    const cli = clienteFake(() => lojaInfo({ is_cb: true }));
    const v = recusada(await avaliarContaParaPreco(db(), conta(), cli.deps()));
    expect(v).toEqual({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.lojaCrossBorder,
      regiao: 'BR',
      erro: null,
    });
  });

  it('cross-border vem ANTES da região: CB + SG + override ATIVO ⇒ loja-cross-border, nunca ok', async () => {
    const cli = clienteFake(() => lojaInfo({ region: 'SG', is_cb: true }));
    const v = recusada(
      await avaliarContaParaPreco(db(), conta(), cli.deps({ config: CONFIG_SANDBOX })),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.lojaCrossBorder);
  });

  it('PAR — is_cb false segue para a região', async () => {
    const cli = clienteFake(() => lojaInfo({ is_cb: false }));
    expect((await avaliarContaParaPreco(db(), conta(), cli.deps())).ok).toBe(true);
  });
});

describe('avaliarContaParaPreco — as classes de conta viram veredito, nunca throw', () => {
  it.each(CLASSES_DE_CONTA)(
    'lançada ao CONSTRUIR o cliente: %s ⇒ conta-nao-configurada com a classe no erro',
    async (nome, criar) => {
      const cli = clienteFake();
      const erro = criar();
      const v = recusada(
        await avaliarContaParaPreco(
          db(),
          conta(),
          cli.deps({ clientFor: () => Promise.reject(erro) }),
        ),
      );

      expect(v).toEqual({
        ok: false,
        motivo: MOTIVO_PRECO_SHOPEE.contaNaoConfigurada,
        regiao: null,
        erro: `${nome}: ${erro.message}`,
      });
      expect(cli.ops).toEqual([]);
    },
  );

  it.each(CLASSES_DE_CONTA)(
    '⚠️ M27 — lançada PREGUIÇOSAMENTE pela get_shop_info: %s ⇒ conta-nao-configurada',
    async (nome, criar) => {
      const erro = criar();
      const cli = clienteFake(() => {
        throw erro;
      });
      const v = recusada(await avaliarContaParaPreco(db(), conta(), cli.deps()));

      expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.contaNaoConfigurada);
      expect(v.erro).toBe(`${nome}: ${erro.message}`);
      expect(lidas(cli)).toBe(1);
    },
  );

  it.each(OUTROS_ERROS)(
    'QUASE-IGUAL — %s na get_shop_info é RELANÇADO, sem virar linha',
    async (_nome, criar) => {
      const erro = criar();
      const cli = clienteFake(() => {
        throw erro;
      });
      await expect(avaliarContaParaPreco(db(), conta(), cli.deps())).rejects.toBe(erro);
    },
  );

  it.each(OUTROS_ERROS)(
    'QUASE-IGUAL — %s ao construir o cliente é RELANÇADO',
    async (_nome, criar) => {
      const erro = criar();
      const cli = clienteFake();
      await expect(
        avaliarContaParaPreco(db(), conta(), cli.deps({ clientFor: () => Promise.reject(erro) })),
      ).rejects.toBe(erro);
    },
  );

  it('uma falha NÃO fica no cache: a próxima avaliação lê de novo e aprova', async () => {
    let primeira = true;
    const cli = clienteFake(() => {
      if (primeira) {
        primeira = false;
        throw new ShopeeSemCredencialError('sem credencial');
      }
      return lojaInfo();
    });

    expect((await avaliarContaParaPreco(db(), conta(), cli.deps())).ok).toBe(false);
    expect((await avaliarContaParaPreco(db(), conta(), cli.deps())).ok).toBe(true);
    expect(lidas(cli)).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                    the accepted context and the shared cache                */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaPreco — o contexto aprovado e o cache compartilhado', () => {
  it('o contexto carrega o integracaoId, o cliente que leu a loja e a tabela', async () => {
    const cli = clienteFake();
    const ctx = aprovada(await avaliarContaParaPreco(db(), conta(), cli.deps()));

    expect(ctx.integracaoId).toBe(INT);
    expect(ctx.client).toBe(cli.client);
    expect(ctx.tabelaNormalId).toBe('lp-1');
    expect(cli.criacoes()).toBe(1);
    expect(cli.ops).toEqual(['get_shop_info']);
  });

  it('PAR — estoque e depois preço na MESMA janela ⇒ UMA get_shop_info', async () => {
    const cli = clienteFake();
    const contaEstoque = {
      integracaoId: INT,
      shopId: SHOP,
      depositoOuterRef: 'documents/deposito/dep-1',
    };

    expect(await avaliarContaParaEstoque(db(), contaEstoque, cli.deps())).toEqual({ ok: true });
    expect(
      (await avaliarContaParaPreco(db(), conta(), cli.deps({ nowMs: AGORA + 1_000 }))).ok,
    ).toBe(true);
    expect(lidas(cli)).toBe(1);
  });

  it('cache QUENTE + aprovação ⇒ ainda UM cliente (o contexto precisa dele), zero leituras novas', async () => {
    const aquece = clienteFake();
    await avaliarContaParaPreco(db(), conta(), aquece.deps());

    const cli = clienteFake();
    const ctx = aprovada(await avaliarContaParaPreco(db(), conta(), cli.deps()));
    expect(ctx.client).toBe(cli.client);
    expect(cli.criacoes()).toBe(1);
    expect(lidas(cli)).toBe(0);
  });

  it('QUASE-IGUAL — cache QUENTE + recusa ⇒ NENHUM cliente construído', async () => {
    const aquece = clienteFake(() => lojaInfo({ region: 'SG' }));
    await avaliarContaParaPreco(db(), conta(), aquece.deps());

    const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
    const v = recusada(await avaliarContaParaPreco(db(), conta(), cli.deps()));
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
    expect(cli.criacoes()).toBe(0);
  });

  it('cache QUENTE + o cliente falha com classe de conta ⇒ conta-nao-configurada', async () => {
    await avaliarContaParaPreco(db(), conta(), clienteFake().deps());

    const erro = new ShopeeContaSemShopIdError('Integração int-1 sem loja.');
    const v = recusada(
      await avaliarContaParaPreco(
        db(),
        conta(),
        clienteFake().deps({ clientFor: () => Promise.reject(erro) }),
      ),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.contaNaoConfigurada);
    expect(v.erro).toBe(`ShopeeContaSemShopIdError: ${erro.message}`);
  });

  it('a marca: um objeto literal NÃO é um ContextoContaPreco (só o veredito o produz)', () => {
    const cli = clienteFake();
    // @ts-expect-error — the brand is missing: only `avaliarContaParaPreco` applies it.
    const falso: ContextoContaPreco = {
      integracaoId: INT,
      client: cli.client,
      regiao: 'BR',
      moeda: 'BRL',
      multiplo: 4,
      tabelaNormalId: 'lp-1',
    };
    expect(falso.regiao).toBe('BR');
  });
});

/* -------------------------------------------------------------------------- */
/*                              the default seams                              */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaPreco — os padrões (sem clientFor, sem config)', () => {
  it('sem clientFor ⇒ o cliente vem do contexto da conta (loadShopeeContext + createShopClient)', async () => {
    const cli = clienteFake();
    const createShopClient = vi.fn(() => cli.client);
    h.loadCtx.mockResolvedValue({ createShopClient });
    const banco = db();

    const ctx = aprovada(
      await avaliarContaParaPreco(banco, conta(), { nowMs: AGORA, config: CONFIG_PRODUCAO }),
    );

    expect(ctx.client).toBe(cli.client);
    expect(vi.mocked(loadShopeeContext)).toHaveBeenCalledTimes(1);
    expect(h.loadCtx.mock.calls[0]).toEqual([banco, INT]);
    expect(createShopClient).toHaveBeenCalledTimes(1);
  });

  it('sem clientFor, a conta ausente (ShopeeContaNotConfiguredError do carregador) ⇒ conta-nao-configurada', async () => {
    h.loadCtx.mockRejectedValue(
      new ShopeeContaNotConfiguredError('Integração int-1 não encontrada.'),
    );

    const v = recusada(
      await avaliarContaParaPreco(db(), conta(), { nowMs: AGORA, config: CONFIG_PRODUCAO }),
    );
    expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.contaNaoConfigurada);
    expect(v.erro).toBe('ShopeeContaNotConfiguredError: Integração int-1 não encontrada.');
  });

  it('BR nunca lê a config: sem config injetada e SEM ambiente, BR responde ok', async () => {
    vi.stubEnv('SHOPEE_PARTNER_ID', '');
    vi.stubEnv('SHOPEE_PARTNER_KEY', '');
    const cli = clienteFake();
    const { config: _semConfig, ...deps } = cli.deps();

    expect((await avaliarContaParaPreco(db(), conta(), deps)).ok).toBe(true);
  });

  describe('o padrão `shopeeConfig()` para uma região não-BR', () => {
    function ambiente(sandbox: string, apiHost: string): void {
      vi.stubEnv('SHOPEE_PARTNER_ID', '1000001');
      vi.stubEnv('SHOPEE_PARTNER_KEY', 'chave-de-teste-nao-e-credencial');
      vi.stubEnv('SHOPEE_SANDBOX', sandbox);
      vi.stubEnv('SHOPEE_API_HOST', apiHost);
      vi.stubEnv('SHOPEE_AUTH_HOST', '');
    }

    async function avaliarSg(): Promise<VereditoContaPreco> {
      const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
      const { config: _semConfig, ...deps } = cli.deps();
      return avaliarContaParaPreco(db(), conta(), deps);
    }

    it("PAR — flag '1' e nenhum host explícito ⇒ SG aprovada pelo override", async () => {
      ambiente('1', '');
      expect(aprovada(await avaliarSg()).moeda).toBe('SGD');
    });

    it("⚠️ QUASE-IGUAL (D2 M8) — flag 'true' é PRODUÇÃO ⇒ SG recusada", async () => {
      ambiente('true', '');
      expect(recusada(await avaliarSg()).motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
    });

    it("⚠️ QUASE-IGUAL (T-R3 pela config real) — flag '1' + host de PRODUÇÃO explícito ⇒ SG recusada", async () => {
      ambiente('1', SHOPEE_PROD_API_HOST);
      expect(recusada(await avaliarSg()).motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
    });

    it('uma config injetada VENCE o ambiente (a flag ligada no ambiente não liga o override)', async () => {
      ambiente('1', '');
      const cli = clienteFake(() => lojaInfo({ region: 'SG' }));
      const v = recusada(
        await avaliarContaParaPreco(db(), conta(), cli.deps({ config: CONFIG_PRODUCAO })),
      );
      expect(v.motivo).toBe(MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              T-R6 — the source pin                          */
/* -------------------------------------------------------------------------- */

describe('T-R6 — a fonte não lê o ambiente (M28)', () => {
  const FONTE = readFileSync(fileURLToPath(new URL('./regiaoPreco.ts', import.meta.url)), 'utf8');

  it('nenhum acesso ao ambiente do processo, nem o nome da flag de sandbox', () => {
    // Needles built at run time, so this file's own text is not a match.
    const ambienteDoProcesso = ['process', 'env'].join('.');
    const nomeDaFlag = new RegExp(`\\b${['SHOPEE', 'SANDBOX'].join('_')}\\b`);

    expect(FONTE.includes(ambienteDoProcesso)).toBe(false);
    expect(nomeDaFlag.test(FONTE)).toBe(false);
  });

  it('a flag chega pela config: a fonte importa `shopeeConfig` de `../env`', () => {
    expect(FONTE).toMatch(/import \{[^}]*\bshopeeConfig\b[^}]*\} from '\.\.\/env';/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { integracaoCollection } from '@delfrance/data/admin/collections';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  ShopeeHttpError,
  type ShopeePartnerClient,
  type ShopeeShopsByPartner,
} from '@delfrance/integrations-shopee';

import { __setShopeeCacheClockForTests } from '../core/contaCache';
import {
  avisarExpiracaoAutorizacao,
  chaveDesautorizacao,
  chaveExpiracao,
} from '../avisos/autorizacao';
import { DIAS_LIMITE_EXPIRACAO, runShopeeAuthorizationExpirySweep } from './expiracaoSweep';

/* -------------------------------------------------------------------------- */
/*  Fake Admin-SDK Firestore                                                  */
/*                                                                            */
/*  COPIED from `packages/data/src/admin/avisos/escreverAviso.test.ts`, so the */
/*  sweep runs through the REAL `escreverAviso` / `resolverAviso` rather than  */
/*  a mock of them: the property under test is the plano the producer hands    */
/*  over, and a mocked writer cannot show that.                               */
/*                                                                            */
/*  Four deliberate extensions over the original:                             */
/*   - the `collection().where().where().where().limit().get()` chain, which   */
/*     `findIntegracaoByShopId` runs;                                          */
/*   - EVERY path touched is recorded, so a test can assert that nothing under */
/*     `/credenciais/` is ever read;                                          */
/*   - every `update` patch is recorded, so a test can assert which fields a   */
/*     producer OMITTED;                                                       */
/*   - the `{ __increment: n }` sentinel is APPLIED on write, so `ocorrencias` */
/*     across three weekly runs can be read back as a number. The patch log    */
/*     still proves the sentinel itself was written (rule 7 tier 0), which a   */
/*     read-modify-write would not produce.                                    */
/* -------------------------------------------------------------------------- */

type DocData = Record<string, unknown>;

interface Stored {
  data: DocData;
  updateTime: number;
}

interface Filtro {
  campo: string;
  valor: unknown;
}

function grpc(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function ehIncremento(v: unknown): v is { __increment: number } {
  return typeof v === 'object' && v !== null && '__increment' in v;
}

function aplicar(anterior: DocData | undefined, patch: DocData): DocData {
  const saida: DocData = { ...anterior };
  for (const [chave, valor] of Object.entries(patch)) {
    if (ehIncremento(valor)) {
      const base = saida[chave];
      saida[chave] = (typeof base === 'number' ? base : 0) + valor.__increment;
    } else {
      saida[chave] = valor;
    }
  }
  return saida;
}

class FakeDb {
  readonly store: Record<string, Stored> = {};
  /** Every collection and document path this database was asked for. */
  readonly caminhos: string[] = [];
  readonly patches: { path: string; patch: DocData }[] = [];
  /** Injected failures for the `shop_id` query, keyed by the shop it asks for. */
  readonly falhas = new Map<number, Error>();
  private relogio = 100;

  seed(path: string, data: DocData): void {
    this.relogio += 1;
    this.store[path] = { data, updateTime: this.relogio };
  }

  private docRef(path: string) {
    this.caminhos.push(path);
    return {
      path,
      create: (data: DocData) => {
        if (this.store[path]) return Promise.reject(grpc(6, 'ALREADY_EXISTS'));
        this.relogio += 1;
        this.store[path] = { data: aplicar(undefined, data), updateTime: this.relogio };
        return Promise.resolve();
      },
      get: () => {
        const atual = this.store[path];
        return Promise.resolve({
          exists: atual !== undefined,
          updateTime: atual?.updateTime,
          data: () => atual?.data,
        });
      },
      update: (patch: DocData, precond?: { lastUpdateTime?: number }) => {
        const atual = this.store[path];
        if (!atual) return Promise.reject(grpc(5, 'NOT_FOUND'));
        if (precond?.lastUpdateTime !== undefined && precond.lastUpdateTime !== atual.updateTime) {
          return Promise.reject(grpc(9, 'FAILED_PRECONDITION'));
        }
        this.relogio += 1;
        this.patches.push({ path, patch });
        this.store[path] = { data: aplicar(atual.data, patch), updateTime: this.relogio };
        return Promise.resolve();
      },
      set: (data: DocData, opts?: { merge?: boolean }) => {
        const atual = this.store[path];
        this.relogio += 1;
        this.store[path] = {
          data: opts?.merge === true ? aplicar(atual?.data, data) : data,
          updateTime: this.relogio,
        };
        return Promise.resolve();
      },
    };
  }

  collection(colPath: string) {
    this.caminhos.push(colPath);
    const filtros: Filtro[] = [];

    const consulta = {
      where: (campo: string, _op: string, valor: unknown) => {
        filtros.push({ campo, valor });
        return consulta;
      },
      limit: (n: number) => ({
        get: async (): Promise<{ docs: { id: string; data: () => DocData }[] }> => {
          const alvo = filtros.find((f) => f.campo === 'shop_id')?.valor;
          const falha = typeof alvo === 'number' ? this.falhas.get(alvo) : undefined;
          if (falha) throw falha;
          const prefixo = `${colPath}/`;
          const docs = Object.entries(this.store)
            .filter(
              ([path]) => path.startsWith(prefixo) && !path.slice(prefixo.length).includes('/'),
            )
            .filter(([, stored]) => filtros.every((f) => stored.data[f.campo] === f.valor))
            .slice(0, n)
            .map(([path, stored]) => ({ id: path.slice(prefixo.length), data: () => stored.data }));
          return { docs };
        },
      }),
      doc: (id: string) => this.docRef(`${colPath}/${id}`),
    };

    return consulta;
  }

  doc(path: string) {
    return this.docRef(path);
  }
}

const asDb = (db: FakeDb): Firestore => db as unknown as Firestore;

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented values only. No real partner id, key or shop id.      */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_760_000_000_000;
const DIA_MS = 86_400_000;
const SEGUNDO = 1000;

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const SHOP_A = 987654;
const SHOP_B = 987655;

const increment = (by: number): unknown => ({ __increment: by });

const getShopsByPartner = vi.fn();
const partnerClient = { getShopsByPartner } as unknown as ShopeePartnerClient;

/** One `authed_shop_list` row, expiring `dias` whole days from `AGORA_MS`. */
function loja(shopId: number, dias: number) {
  return {
    shop_id: shopId,
    auth_time: (AGORA_MS - 30 * DIA_MS) / SEGUNDO,
    expire_time: (AGORA_MS + dias * DIA_MS) / SEGUNDO,
    region: 'BR',
    sip_affi_shop_list: null,
  };
}

function pagina(lojas: ReturnType<typeof loja>[], more: boolean): ShopeeShopsByPartner {
  return {
    request_id: 'req-1',
    error: '',
    message: null,
    warning: null,
    authed_shop_list: lojas,
    more,
  } as ShopeeShopsByPartner;
}

function contaDoc(over: DocData = {}): DocData {
  return { tipo: INTEGRACAO_TIPO.shopee, ativo: true, nome: 'Loja BR', shop_id: SHOP_A, ...over };
}

function sweep(
  db: FakeDb,
  over: {
    nowMs?: number;
    apenasShopIds?: ReadonlySet<number>;
    relogioEventoMs?: number;
  } = {},
) {
  // ⚠️ The two optionals are spread-or-nothing, never `?? null` and never an
  // explicit `undefined`: the whole property under test is that the weekly cron
  // passes NO `relogioEventoMs` key at all.
  const { apenasShopIds, relogioEventoMs, ...resto } = over;
  return runShopeeAuthorizationExpirySweep(asDb(db), {
    partnerClient,
    increment,
    nowMs: AGORA_MS,
    logger: { warn: () => {} },
    ...resto,
    ...(apenasShopIds === undefined ? {} : { apenasShopIds }),
    ...(relogioEventoMs === undefined ? {} : { relogioEventoMs }),
  });
}

const CHAVE_A = chaveExpiracao('int-1', SHOP_A);
const PATH_A = `avisos/${CHAVE_A}`;

let agora = AGORA_MS;
let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  agora = AGORA_MS;
  __setShopeeCacheClockForTests(() => agora);
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeCacheClockForTests();
  spyWarn.mockRestore();
});

/* -------------------------------------------------------------------------- */

describe('the 30-day boundary', () => {
  it('raises the aviso at 29 days, with the exact plano the inbox renders', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    const out = await sweep(db);

    expect(out).toMatchObject({
      lojasEnumeradas: 1,
      semIntegracao: 0,
      avisados: 1,
      resolvidos: 0,
      resultados: { criado: 1, repetido: 0, reaberto: 0, ignorado: 0 },
      erros: [],
    });
    expect(db.store[PATH_A]?.data).toMatchObject({
      tipo: 'shopeeAutorizacaoExpirando',
      severidade: 'atencao',
      canal: 'shopee',
      params: { loja: 'Loja BR', dias: 29 },
      urlInterna: { rota: '/canais/shopee/int-1', campo: null },
      prazo: (AGORA_MS + 29 * DIA_MS) * 1000,
      ocorrencias: 1,
      resolvidoEm: null,
    });
  });

  it('raises at exactly 30 days — the boundary is INCLUSIVE', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, DIAS_LIMITE_EXPIRACAO)], false));

    const out = await sweep(db);
    expect(out.avisados).toBe(1);
    expect(db.store[PATH_A]?.data.params).toEqual({ loja: 'Loja BR', dias: 30 });
  });

  it('raises NOTHING at 31 days, and resolves both chaves instead', async () => {
    // The near-miss to the two above. The resolve runs unconditionally on the
    // healthy branch — `mergeIfExists` is one write with no read, and remembering
    // whether we ever raised one is exactly the state that goes stale across
    // weekly runs on different instances.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, DIAS_LIMITE_EXPIRACAO + 1)], false));

    const out = await sweep(db);

    expect(out).toMatchObject({ avisados: 0, resolvidos: 0 });
    expect(Object.keys(db.store)).toEqual([`${INTEGRACAO_PATH}/int-1`]);
    // Nothing existed to close, but BOTH keys were attempted — that is what
    // makes the resolver reachable for a row raised on an earlier run.
    expect(db.caminhos).toContain(PATH_A);
    expect(db.caminhos).toContain(`avisos/${chaveDesautorizacao('int-1', SHOP_A)}`);
  });

  it('closes a standing aviso once the shop is authorized further out', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 5)], false));
    await sweep(db);

    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 365)], false));
    const out = await sweep(db, { nowMs: AGORA_MS + DIA_MS });

    expect(out.resolvidos).toBe(1);
    expect(db.store[PATH_A]?.data).toMatchObject({
      resolvidoEm: (AGORA_MS + DIA_MS) * 1000,
      resolucaoMotivo: 'reautorizada',
    });
  });

  it('REOPENS with a fresh criadoEm when the authorization lapses again', async () => {
    // A re-consent that lapses a second time is genuinely new and has to clear
    // the operator's read watermark. This is also why the chave carries no
    // janela: a window keyed on the expiry date would make this a second row the
    // resolver can never find.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());

    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 5)], false));
    await sweep(db);
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 365)], false));
    await sweep(db, { nowMs: AGORA_MS + DIA_MS });
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 400)], false));
    await sweep(db, { nowMs: AGORA_MS + 371 * DIA_MS });

    expect(Object.keys(db.store)).toEqual([`${INTEGRACAO_PATH}/int-1`, PATH_A]);
    expect(db.store[PATH_A]?.data).toMatchObject({
      criadoEm: (AGORA_MS + 371 * DIA_MS) * 1000,
      resolvidoEm: null,
      resolucaoMotivo: null,
      ocorrencias: 2,
    });
  });
});

describe('the sweep and push 12 collapse onto ONE row', () => {
  it('is one document with ocorrencias bumped through the increment sentinel', async () => {
    // The pinned pair: the weekly sweep, then the same body scoped to the shops
    // `push 12` named. Two triggers describing one expiry must not tell the
    // operator twice.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    await sweep(db);
    const push12 = await sweep(db, {
      nowMs: AGORA_MS + 60_000,
      apenasShopIds: new Set([SHOP_A]),
    });

    expect(push12.resultados).toMatchObject({ criado: 0, repetido: 1 });
    expect(Object.keys(db.store)).toEqual([`${INTEGRACAO_PATH}/int-1`, PATH_A]);
    // Rule 7 tier 0: the counter rides a sentinel, never a read-modify-write.
    expect(db.patches[0]?.patch.ocorrencias).toEqual({ __increment: 1 });
    expect(db.store[PATH_A]?.data.ocorrencias).toBe(2);
    // A repeat must not re-alert: `criadoEm` stays put.
    expect(db.store[PATH_A]?.data.criadoEm).toBe(AGORA_MS * 1000);
  });

  it('the scoped run touches ONLY the shops it was given', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    db.seed(`${INTEGRACAO_PATH}/int-2`, contaDoc({ nome: 'Loja 2', shop_id: SHOP_B }));
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29), loja(SHOP_B, 29)], false));

    await sweep(db, { apenasShopIds: new Set([SHOP_B]) });

    expect(Object.keys(db.store)).toContain(`avisos/${chaveExpiracao('int-2', SHOP_B)}`);
    expect(Object.keys(db.store)).not.toContain(PATH_A);
  });
});

describe('the event clock', () => {
  it('the WEEKLY CRON omits relogioEvento, so a push watermark survives its writes', async () => {
    // The cron passes no `relogioEventoMs` (only the push-12 arm has a delivery
    // clock to pass), and an absent optional means "I do not know". `null` would
    // RESET the stored watermark, and a reset watermark is a guard that never
    // rejects anything again — the next stale redelivery would be applied, bump
    // `ocorrencias` and re-alert about a problem that was already handled.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    await sweep(db);
    // `push 12` lands, carrying Shopee's own delivery clock.
    await avisarExpiracaoAutorizacao(
      asDb(db),
      {
        integracaoId: 'int-1',
        shopId: SHOP_A,
        expireTimeMs: AGORA_MS + 29 * DIA_MS,
        lojaNome: 'Loja BR',
        relogioEventoMs: AGORA_MS + 10_000,
      },
      { increment, nowMs: AGORA_MS + 10_000 },
    );
    // …and the next weekly sweep writes over it WITHOUT a clock of its own.
    await sweep(db, { nowMs: AGORA_MS + 20_000 });

    const patchDoSweep = db.patches.at(-1)?.patch ?? {};
    expect('relogioEvento' in patchDoSweep).toBe(false);
    expect(db.store[PATH_A]?.data.relogioEvento).toBe(AGORA_MS + 10_000);
  });

  it('a stale push-12 redelivery is IGNORED after the sweep has written', async () => {
    // The half that proves the guard still fires: the watermark above is not
    // merely preserved, it is still being enforced.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    await sweep(db);
    await avisarExpiracaoAutorizacao(
      asDb(db),
      {
        integracaoId: 'int-1',
        shopId: SHOP_A,
        expireTimeMs: AGORA_MS + 29 * DIA_MS,
        lojaNome: 'Loja BR',
        relogioEventoMs: AGORA_MS + 10_000,
      },
      { increment, nowMs: AGORA_MS + 10_000 },
    );
    await sweep(db, { nowMs: AGORA_MS + 20_000 });

    const stale = await avisarExpiracaoAutorizacao(
      asDb(db),
      {
        integracaoId: 'int-1',
        shopId: SHOP_A,
        expireTimeMs: AGORA_MS + 29 * DIA_MS,
        lojaNome: 'Loja BR',
        relogioEventoMs: AGORA_MS + 5_000,
      },
      { increment, nowMs: AGORA_MS + 30_000 },
    );

    expect(stale.resultado).toBe('ignorado');
  });

  it('a SCOPED run (push 12) carries its clock onto the aviso it writes', async () => {
    // The other half of the pair: the cron omits the key, the push arm supplies
    // it — through the same body, so the watermark advances on the write that
    // WINS rather than only on writes made outside this module.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    // Create path — `db.patches` only records updates, so read the document.
    await sweep(db, {
      apenasShopIds: new Set([SHOP_A]),
      relogioEventoMs: AGORA_MS + 10_000,
    });
    expect(db.store[PATH_A]?.data.relogioEvento).toBe(AGORA_MS + 10_000);

    // Update path — a fresher redelivery of the same batch advances it, and the
    // field really is on the PATCH, not merely still in the stored document.
    const novamente = await sweep(db, {
      nowMs: AGORA_MS + 20_000,
      apenasShopIds: new Set([SHOP_A]),
      relogioEventoMs: AGORA_MS + 20_000,
    });

    expect(novamente.resultados).toMatchObject({ criado: 0, repetido: 1, ignorado: 0 });
    expect(db.patches.at(-1)?.patch.relogioEvento).toBe(AGORA_MS + 20_000);
    expect(db.store[PATH_A]?.data.relogioEvento).toBe(AGORA_MS + 20_000);
  });

  it('a LATER scoped run carrying an OLDER clock is ignored for that shop', async () => {
    // The near-miss to the test above, and the reason the key is threaded at
    // all: Shopee redelivers `push 12`, and an out-of-order redelivery must not
    // bump `ocorrencias` or re-alert about an expiry already reported.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    await sweep(db, {
      apenasShopIds: new Set([SHOP_A]),
      relogioEventoMs: AGORA_MS + 20_000,
    });
    const stale = await sweep(db, {
      // Later WALL clock, older EVENT clock — the whole point of a watermark:
      // arrival order is not event order.
      nowMs: AGORA_MS + 30_000,
      apenasShopIds: new Set([SHOP_A]),
      relogioEventoMs: AGORA_MS + 10_000,
    });

    expect(stale.resultados).toMatchObject({ criado: 0, repetido: 0, ignorado: 1 });
    expect(stale.avisados).toBe(0);
    // Nothing moved: the drop is a drop, not a quieter write.
    expect(db.store[PATH_A]?.data.ocorrencias).toBe(1);
    expect(db.store[PATH_A]?.data.relogioEvento).toBe(AGORA_MS + 20_000);
  });
});

describe('shops this ERP does not own', () => {
  it('counts an unmapped shop as semIntegracao and writes NOTHING', async () => {
    const db = new FakeDb();
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 1)], false));

    const out = await sweep(db);

    expect(out).toMatchObject({ lojasEnumeradas: 1, semIntegracao: 1, avisados: 0 });
    expect(Object.keys(db.store)).toEqual([]);
    expect(db.patches).toEqual([]);
  });

  it('ignores an integração whose consent is main-account only', async () => {
    // A conta with no `shop_id` names no shop, so the shop-driven walk can never
    // reach it. Structural — asserted anyway, because the day someone iterates
    // integrações instead this is the test that fails.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-main`, contaDoc({ shop_id: null, main_account_id: 999 }));
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 1)], false));

    const out = await sweep(db);

    expect(out).toMatchObject({ semIntegracao: 1, avisados: 0 });
    expect(Object.keys(db.store)).toEqual([`${INTEGRACAO_PATH}/int-main`]);
  });
});

describe('per-shop isolation', () => {
  it('contains one shop failure and still checks the next', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-2`, contaDoc({ nome: 'Loja 2', shop_id: SHOP_B }));
    db.falhas.set(SHOP_A, grpc(14, 'UNAVAILABLE'));
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 5), loja(SHOP_B, 5)], false));

    const out = await sweep(db);

    expect(out.erros).toEqual([{ shopId: SHOP_A, erro: 'UNAVAILABLE' }]);
    expect(out.avisados).toBe(1);
    expect(Object.keys(db.store)).toContain(`avisos/${chaveExpiracao('int-2', SHOP_B)}`);
  });

  it('contains a Shopee-side failure too', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-2`, contaDoc({ nome: 'Loja 2', shop_id: SHOP_B }));
    db.falhas.set(
      SHOP_A,
      new ShopeeHttpError('edge recusou a chamada', {
        httpStatus: 403,
        path: '/api/v2/public/get_shops_by_partner',
      }),
    );
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 5), loja(SHOP_B, 5)], false));

    const out = await sweep(db);
    expect(out.erros).toHaveLength(1);
    expect(out.avisados).toBe(1);
  });

  it('does NOT contain an unclassifiable error — it fails the whole tick', async () => {
    // The near-miss. A coding bug must surface loudly instead of becoming a
    // counter nobody reads; `escreverAviso`'s persistent-contention Error is in
    // the same class and is deliberately outside the boundary too.
    const db = new FakeDb();
    db.falhas.set(SHOP_A, new TypeError('x is not a function'));
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 5)], false));

    await expect(sweep(db)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('the enumeration', () => {
  it('deduplicates across pages and reports the page count', async () => {
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner
      .mockResolvedValueOnce(pagina([loja(SHOP_A, 29)], true))
      .mockResolvedValueOnce(pagina([loja(SHOP_A, 29)], false));

    const out = await sweep(db);

    expect(out).toMatchObject({ lojasEnumeradas: 1, paginasLidas: 2, truncado: false });
    expect(out.resultados.criado).toBe(1);
    expect(out.resultados.repetido).toBe(0);
  });

  it('reports truncado when the walk stopped at the page cap', async () => {
    // "No shop needs attention" would otherwise be reported about shops the
    // sweep never looked at.
    const db = new FakeDb();
    getShopsByPartner.mockResolvedValue(pagina([], true));

    const out = await sweep(db);
    expect(out.truncado).toBe(true);
  });
});

describe('the sweep reads no credential, ever', () => {
  it('touches nothing under /credenciais/', async () => {
    // Shopee's refresh token is single-use and rotating: reading one here would
    // put the sweep on the same document the token store leases. It has no
    // reason to — `get_shops_by_partner` is Public-signed and the store name
    // comes from the conta document.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    await sweep(db);

    expect(db.caminhos.length).toBeGreaterThan(0);
    expect(db.caminhos.filter((p) => p.includes('credenciais'))).toEqual([]);
    expect(db.caminhos.filter((p) => p.includes('token'))).toEqual([]);
  });
});

describe('three weekly runs over one unchanged expiry', () => {
  it('hold ONE row: ocorrencias 3, criadoEm untouched, dias refreshed', async () => {
    // The failure this pins is a fresh row every week — an inbox filling up with
    // one problem, and a `criadoEm` that re-alerts on every run.
    const db = new FakeDb();
    db.seed(`${INTEGRACAO_PATH}/int-1`, contaDoc());
    getShopsByPartner.mockResolvedValue(pagina([loja(SHOP_A, 29)], false));

    for (const semana of [0, 7, 14]) {
      agora = AGORA_MS + semana * DIA_MS;
      await sweep(db, { nowMs: agora });
    }

    expect(Object.keys(db.store)).toEqual([`${INTEGRACAO_PATH}/int-1`, PATH_A]);
    expect(db.store[PATH_A]?.data).toMatchObject({
      criadoEm: AGORA_MS * 1000,
      atualizadoEm: (AGORA_MS + 14 * DIA_MS) * 1000,
      ocorrencias: 3,
      // Refreshed on every run, which is what makes an early warning useful.
      params: { loja: 'Loja BR', dias: 15 },
    });
  });
});

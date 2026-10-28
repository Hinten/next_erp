/**
 * The draft's publish LOCK (#1911, D4/D15) over the shared FakeDb, whose
 * `update(patch, { lastUpdateTime })` throws `FAILED_PRECONDITION` on a stale
 * stamp — so every tier-1 write here can LOSE, and the tests make it lose.
 *
 * Fixture ids only: conta `int-1`, invented produto / link ids, Shopee's own
 * doc-sample item ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_ITEM_BASE_INFO_MAX_IDS,
  ShopeeError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemBaseInfoSchema,
  shopeeItemListPayloadSchema,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  CODIGO_RASCUNHO_SHOPEE,
  ESTADO_ANUNCIO_SHOPEE,
  MARGEM_ENVIO_SHOPEE_MS,
  PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
  estadoPublicacaoRascunhoShopee,
} from '@delfrance/schemas';

import { FIXTURE_ITEM_BASE_INFO_SG_KIT, lerFixture } from '../fixtures/wireCorpus';
import { BuscaForaDoPrazoShopeeError } from '../kits/localizarKitPorSku';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { MOTIVO_PUBLICACAO_BLOQUEADA, ShopeePublishBlockedError } from './errosPublicacao';
import {
  ConflitoDeRascunhoShopeeError,
  TENTATIVAS_DA_TRAVA,
  buscaNoPrazoDoEnvio,
  conferirTravaAntesDoEnvio,
  dentroDoPrazoDeEnvio,
  liberarTravaShopee,
  liberarTravaShopeeSemSubstituirErro,
  portaoDeEnvio,
  registrarCriacaoIncerta,
  reivindicarRascunhoShopee,
  reservarRascunhoShopee,
  type BuscaDaCriacaoIncerta,
  type ControlesDaPublicacaoAoVivo,
  type ReservaDeRascunhoShopee,
} from './reservaRascunho';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const PRODUTO = 'prod-pai';
const RASCUNHO = 'rasc-a';
const IRMAO = 'rasc-b';
const VIVO = 'link-vivo';
const COLECAO = `produtos/${PRODUTO}/prodshopee`;
const CAMINHO = `${COLECAO}/${RASCUNHO}`;
const CAMINHO_IRMAO = `${COLECAO}/${IRMAO}`;
const ITEM_NOSSO = 2500139861;
const ITEM_OUTRO = 2500139862;

const AGORA = 1_757_000_000_000;
const ALVO = { integracaoId: INTEGRACAO, produtoId: PRODUTO, linkDocId: RASCUNHO } as const;

function rascunho(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: null,
    item_name: 'Camiseta do rascunho',
    category_id: 100_017,
    brand_id: 0,
    ...extra,
  };
}

/** Another run's lock, NOT stamped: that run has not (or never) reached the send. */
function travaAlheia(expiraEm: number, token = 'token-de-outra-execucao') {
  return { desde: expiraEm - PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS, expiraEm, token };
}

/**
 * Another run's lock as its PRE-SEND re-read left it — stamped with the SKU
 * the create sends: a send may be in flight, so past `expiraEm` it serves the
 * grace and then reads `incerta` (batch-A review).
 */
function travaAlheiaCarimbada(expiraEm: number, sku = 'SKU-1') {
  return { ...travaAlheia(expiraEm), sku };
}

function controles(over: Partial<ControlesDaPublicacaoAoVivo> = {}): ControlesDaPublicacaoAoVivo {
  return {
    agora: () => AGORA,
    prazoDaRequisicao: null,
    aquecerCredencial: () => Promise.resolve(),
    confirmarSegundoAnuncio: false,
    confirmarCriacaoIncerta: false,
    ...over,
  };
}

/**
 * The look-up's client when the case must make NO Shopee call: every method
 * throws, so "never scans" needs no spy.
 */
function clienteQueNaoChama(): ShopeeClient {
  return new Proxy({} as ShopeeClient, {
    get(_t, prop) {
      return () => {
        throw new Error(`fixture: ${String(prop)} não deveria ser chamado`);
      };
    },
  });
}

function buscaSemShopee(): BuscaDaCriacaoIncerta {
  return { client: clienteQueNaoChama(), nowMs: AGORA };
}

/** `reservarRascunhoShopee` with a look-up that may not call Shopee unless one is given. */
function reservar(
  db: Parameters<typeof reservarRascunhoShopee>[0],
  alvo: Parameters<typeof reservarRascunhoShopee>[1],
  c: ControlesDaPublicacaoAoVivo | null,
  busca: BuscaDaCriacaoIncerta = buscaSemShopee(),
): ReturnType<typeof reservarRascunhoShopee> {
  return reservarRascunhoShopee(db, alvo, c, busca);
}

function doc(db: FakeDb, caminho = CAMINHO): Record<string, unknown> | undefined {
  return db.store[caminho]?.data;
}

function escritasEm(db: FakeDb, caminho = CAMINHO): Record<string, unknown>[] {
  return db.writes.filter((w) => w.path === caminho).map((w) => w.patch);
}

async function conflitoDe(p: Promise<unknown>): Promise<ConflitoDeRascunhoShopeeError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ConflitoDeRascunhoShopeeError)) {
    throw new Error(`esperava ConflitoDeRascunhoShopeeError, veio ${String(err)}`);
  }
  return err;
}

/**
 * A db whose `get` of `alvo` lets a CONCURRENT writer land right after it — on
 * the first read only, or on every read (`sempre`). The double's own refs,
 * wrapped; never a raw Firestore ref.
 */
function comEscritaConcorrente(
  db: FakeDb,
  alvo: string,
  escrever: (leitura: number) => void,
  sempre = false,
): FakeDb {
  let leituras = 0;
  const colecao = db.collection.bind(db);
  return new Proxy(db, {
    get(t, prop, r) {
      if (prop !== 'collection') return Reflect.get(t, prop, r) as unknown;
      return (colPath: string) => {
        const col = colecao(colPath);
        return new Proxy(col, {
          get(ct, cp, cr) {
            const original = Reflect.get(ct, cp, cr) as unknown;
            if (cp !== 'doc') return original;
            const construirRef = original as typeof ct.doc;
            return (id?: string) => {
              const ref = construirRef(id);
              if (ref.path !== alvo) return ref;
              return {
                ...ref,
                get: async () => {
                  const snap = await ref.get();
                  leituras += 1;
                  if (sempre || leituras === 1) escrever(leituras);
                  return snap;
                },
              };
            };
          },
        });
      };
    },
  });
}

/** A db that runs `antes` the first time the produto's link SUBCOLLECTION is read. */
function antesDaVarredura(db: FakeDb, antes: () => Promise<void>): FakeDb {
  let feito = false;
  const colecao = db.collection.bind(db);
  return new Proxy(db, {
    get(t, prop, r) {
      if (prop !== 'collection') return Reflect.get(t, prop, r) as unknown;
      return (colPath: string) => {
        const col = colecao(colPath);
        if (colPath !== COLECAO) return col;
        return new Proxy(col, {
          get(ct, cp, cr) {
            const original = Reflect.get(ct, cp, cr) as unknown;
            if (cp !== 'get') return original;
            return async () => {
              if (!feito) {
                feito = true;
                await antes();
              }
              return col.get();
            };
          },
        });
      };
    },
  });
}

let avisos: unknown[][];

beforeEach(() => {
  avisos = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                         1 · reservarRascunhoShopee                          */
/* -------------------------------------------------------------------------- */

describe('reservarRascunhoShopee — a trava', () => {
  it('um rascunho LIVRE: grava {desde, expiraEm = desde + TTL, token} por update guardado, e devolve a reserva "travada"', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());

    const r = await reservar(asDb(db), ALVO, controles());

    expect(r.tipo).toBe('travada');
    if (r.tipo !== 'travada') return;
    expect(r.reserva).toMatchObject({
      produtoId: PRODUTO,
      linkDocId: RASCUNHO,
      desde: AGORA,
      expiraEm: AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
      fase: 'travada',
    });
    expect(r.reserva.token.length).toBeGreaterThan(0);
    expect(doc(db)?.publicacaoEmCurso).toEqual({
      desde: AGORA,
      expiraEm: AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
      token: r.reserva.token,
    });
    // ONE write, and it is an UPDATE (the patch log holds updates only) — never a merge.
    expect(escritasEm(db)).toHaveLength(1);
    expect(db.patches.filter((p) => p.path === CAMINHO)).toEqual([
      { path: CAMINHO, patch: { publicacaoEmCurso: doc(db)?.publicacaoEmCurso } },
    ]);
    // Everything else on the draft stays as it was.
    expect(doc(db)).toMatchObject(rascunho());
  });

  it('dois tokens de duas reservas são distintos (o nonce da execução)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(CAMINHO_IRMAO, rascunho());
    const a = await reservar(asDb(db), ALVO, controles({ confirmarSegundoAnuncio: true }));
    if (a.tipo !== 'travada') throw new Error('fixture');
    await liberarTravaShopee(asDb(db), a.reserva);
    const b = await reservar(
      asDb(db),
      { ...ALVO, linkDocId: IRMAO },
      controles({ confirmarSegundoAnuncio: true }),
    );
    if (b.tipo !== 'travada') throw new Error('fixture');
    expect(b.reserva.token).not.toBe(a.reserva.token);
  });

  it('⛔ quase-par: um vínculo que NÃO é rascunho (anúncio, item_id 0, kitNativo sem item) ⇒ nao-e-rascunho, zero escritas — e não exige controles', async () => {
    for (const corpo of [
      { item_id: ITEM_NOSSO },
      { item_id: 0 },
      { item_id: '123' },
      { kitNativo: true, item_id: undefined },
    ]) {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho(corpo));
      expect(await reservar(asDb(db), ALVO, null), JSON.stringify(corpo)).toEqual({
        tipo: 'nao-e-rascunho',
      });
      expect(db.writes).toEqual([]);
    }
  });

  it('o documento ausente, ou de OUTRA conta ⇒ inexistente, zero escritas', async () => {
    const db = new FakeDb();
    expect(await reservar(asDb(db), ALVO, controles())).toEqual({
      tipo: 'inexistente',
    });
    db.seed(CAMINHO, rascunho({ contaProdutoShopeeOuterRef: 'documents/integracao/int-12' }));
    expect(await reservar(asDb(db), ALVO, controles())).toEqual({
      tipo: 'inexistente',
    });
    expect(db.writes).toEqual([]);
  });

  it('⛔ (K1-3) um RASCUNHO sem os controles ao vivo LANÇA antes de qualquer escrita — nunca um relógio de reserva', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    await expect(reservar(asDb(db), ALVO, null)).rejects.toThrow(/deps\.aoVivo/);
    expect(db.writes).toEqual([]);
  });

  it('uma trava ALHEIA viva ⇒ 409 EM_ANDAMENTO com aguardarMs = expiraEm − agora, zero escritas', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheia(AGORA + 60_000) }));

    const err = await conflitoDe(reservar(asDb(db), ALVO, controles()));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
    expect(err.aguardarMs).toBe(60_000);
    expect(err.vinculos).toBeNull();
    expect(err.linkDocId).toBe(RASCUNHO);
    expect(err.message).toContain(RASCUNHO);
    expect(err).not.toBeInstanceOf(ShopeeError);
    expect(db.writes).toEqual([]);
  });

  describe('as fronteiras da carência pós-expiração (a leitura ÚNICA de @delfrance/schemas)', () => {
    const EXPIRA = AGORA;
    it.each([
      ['expiraEm − 1', EXPIRA - 1, CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento, 1],
      [
        'expiraEm EXATO — ainda na carência, nunca tomada',
        EXPIRA,
        CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
        AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
      ],
      [
        'expiraEm + 240 000 − 1',
        EXPIRA + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1,
        CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
        1,
      ],
    ] as const)('%s', async (_nome, agora, code, aguardarMs) => {
      const db = new FakeDb();
      // STAMPED: the grace is for a send that may be in flight.
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheiaCarimbada(EXPIRA) }));

      const err = await conflitoDe(reservar(asDb(db), ALVO, controles({ agora: () => agora })));

      expect(err.code).toBe(code);
      expect(err.aguardarMs).toBe(aguardarMs);
      expect(db.writes).toEqual([]);
    });

    it('expiraEm + 240 000 — incerta: TOMADA, e a tomada CARREGA o desde da trava velha para criacaoIncertaDesde (P5)', async () => {
      const db = new FakeDb();
      const velha = travaAlheiaCarimbada(EXPIRA);
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: velha }));
      const agora = EXPIRA + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;

      // No produto seeded ⇒ the produto has no SKU while the attempt SENT one ⇒
      // the look-up refuses (the SKU moved) before any Shopee call.
      const err = await reservar(asDb(db), ALVO, controles({ agora: () => agora })).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ShopeePublishBlockedError);
      const [tomada] = escritasEm(db);
      expect(tomada).toMatchObject({
        publicacaoEmCurso: { desde: agora, expiraEm: agora + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS },
        criacaoIncertaDesde: velha.desde,
        criacaoIncertaSku: velha.sku,
      });
      // Released, the RECORD kept: the draft still reads `incerta`, never `livre`.
      expect(doc(db)).toMatchObject({ publicacaoEmCurso: null, criacaoIncertaDesde: velha.desde });
    });

    describe('⛔ a trava que NUNCA foi carimbada (batch-A review, 2026-10-28): o run morreu antes do envio', () => {
      it('vencida há 1 ms, sem registro ⇒ LIVRE: TOMADA como uma trava nova — SEM registro, SEM busca, ZERO chamadas', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheia(EXPIRA) }));

        // `buscaSemShopee`: any Shopee call throws.
        const r = await reservar(asDb(db), ALVO, controles({ agora: () => EXPIRA }));

        expect(r).toMatchObject({ tipo: 'travada', skuBuscadoNaReserva: null });
        const [tomada, ...resto] = escritasEm(db);
        expect(resto).toEqual([]);
        expect(tomada).toEqual({
          publicacaoEmCurso: {
            desde: EXPIRA,
            expiraEm: EXPIRA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
            token: expect.any(String) as unknown,
          },
        });
        expect(doc(db)).not.toHaveProperty('criacaoIncertaDesde');
      });

      it('⛔ NEAR-MISS: ainda VIVA (expiraEm − 1) ⇒ 409 EM_ANDAMENTO — o run pode estar a caminho do envio', async () => {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheia(EXPIRA) }));
        const err = await conflitoDe(
          reservar(asDb(db), ALVO, controles({ agora: () => EXPIRA - 1 })),
        );
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
        expect(err.aguardarMs).toBe(1);
        expect(db.writes).toEqual([]);
      });

      it('⛔ NEAR-MISS: a mesma trava sem carimbo num rascunho COM registro ⇒ a tomada incerta de sempre: o registro (o MAIS ANTIGO) é carregado', async () => {
        const db = new FakeDb();
        const registro = EXPIRA - 3_600_000;
        db.seed(
          CAMINHO,
          rascunho({
            publicacaoEmCurso: travaAlheia(EXPIRA),
            criacaoIncertaDesde: registro,
            criacaoIncertaSku: 'SKU-1',
          }),
        );

        // No produto ⇒ the SKU moved since the attempt ⇒ refused with zero calls.
        const err = await reservar(asDb(db), ALVO, controles({ agora: () => EXPIRA })).catch(
          (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(ShopeePublishBlockedError);
        expect(escritasEm(db)[0]).toMatchObject({
          criacaoIncertaDesde: registro,
          criacaoIncertaSku: 'SKU-1',
        });
        expect(doc(db)).toMatchObject({ publicacaoEmCurso: null, criacaoIncertaDesde: registro });
      });
    });
  });

  it.each([
    [
      'trava ILEGÍVEL (token vazio)',
      { publicacaoEmCurso: { desde: 1, expiraEm: AGORA + 1, token: '' } },
    ],
    ['trava ILEGÍVEL (não é objeto)', { publicacaoEmCurso: 'travado' }],
    [
      'trava ilegível E registro ilegível',
      { publicacaoEmCurso: 'travado', criacaoIncertaDesde: '1757' },
    ],
  ])(
    '%s ⇒ nenhuma JANELA: 409 CRIACAO_INCERTA (nunca "sem evidência, segue"), zero escritas',
    async (_nome, extra) => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho(extra));

      const err = await conflitoDe(reservar(asDb(db), ALVO, controles()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.criacaoIncerta);
      expect(err.aguardarMs).toBeNull();
      expect(db.writes).toEqual([]);
    },
  );

  it('⛔ quase-par: publicacaoEmCurso null e criacaoIncertaDesde null ⇒ LIVRE, reserva', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: null, criacaoIncertaDesde: null }));
    expect((await reservar(asDb(db), ALVO, controles())).tipo).toBe('travada');
  });

  describe('a precondição PERDIDA re-decide do que está lá agora — nunca re-aplica', () => {
    it('uma trava alheia que chega ENTRE o get e o update ⇒ 409 EM_ANDAMENTO, a trava alheia intacta, duas leituras', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const alheia = travaAlheia(AGORA + 90_000);
      const corrida = comEscritaConcorrente(db, CAMINHO, () =>
        db.seed(CAMINHO, rascunho({ publicacaoEmCurso: alheia })),
      );

      const err = await conflitoDe(reservar(asDb(corrida), ALVO, controles()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
      expect(err.aguardarMs).toBe(90_000);
      expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
      expect(escritasEm(db)).toEqual([]);
      expect(db.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(2);
    });

    it('o rascunho virou ANÚNCIO entre o get e o update (outra execução o reivindicou) ⇒ 409 JA_PUBLICADO', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () =>
        db.seed(CAMINHO, rascunho({ item_id: ITEM_OUTRO })),
      );

      const err = await conflitoDe(reservar(asDb(corrida), ALVO, controles()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.jaPublicado);
      expect(doc(db)?.item_id).toBe(ITEM_OUTRO);
      expect(doc(db)?.publicacaoEmCurso).toBeUndefined();
    });

    it('⛔ quase-par: uma edição inócua entre o get e o update ⇒ a SEGUNDA tentativa reserva sobre o documento novo', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(db, CAMINHO, () =>
        db.seed(CAMINHO, rascunho({ item_name: 'Camiseta editada' })),
      );

      const r = await reservar(asDb(corrida), ALVO, controles());

      expect(r.tipo).toBe('travada');
      expect(doc(db)).toMatchObject({ item_name: 'Camiseta editada' });
      expect(doc(db)?.publicacaoEmCurso).toMatchObject({ desde: AGORA });
      expect(escritasEm(db)).toHaveLength(1);
    });

    it(`a precondição perdida ${String(TENTATIVAS_DA_TRAVA)} vezes ⇒ 409 CONTENCAO, nenhuma trava nossa gravada`, async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const corrida = comEscritaConcorrente(
        db,
        CAMINHO,
        (n) => db.seed(CAMINHO, rascunho({ item_name: `edição ${String(n)}` })),
        true,
      );

      const err = await conflitoDe(reservar(asDb(corrida), ALVO, controles()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contencao);
      expect(doc(db)?.publicacaoEmCurso).toBeUndefined();
      expect(escritasEm(db)).toEqual([]);
      expect(db.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(
        TENTATIVAS_DA_TRAVA,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                    2 · D15 na reserva: trava, ENTÃO varre                    */
/* -------------------------------------------------------------------------- */

describe('reservarRascunhoShopee — o segundo anúncio (D15, K1-4)', () => {
  it('dois rascunhos da conta: publicar A sem confirmar ⇒ 409 CONTA_JA_TEM_ANUNCIO nomeando B; a trava de A DEVOLVIDA, B intocado', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(CAMINHO_IRMAO, rascunho());
    const antesB = structuredClone(doc(db, CAMINHO_IRMAO));

    const err = await conflitoDe(reservar(asDb(db), ALVO, controles()));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
    expect(err.vinculos).toEqual([{ linkDocId: IRMAO, itemId: null, rascunho: true }]);
    expect(err.aguardarMs).toBeNull();
    expect(doc(db)?.publicacaoEmCurso).toBeNull();
    expect(doc(db, CAMINHO_IRMAO)).toEqual(antesB);
    expect(escritasEm(db, CAMINHO_IRMAO)).toEqual([]);
  });

  it('um anúncio VIVO (e um SUBSTITUÍDO) do produto na conta também pedem confirmação, com o item_id', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(`${COLECAO}/${VIVO}`, {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: ITEM_OUTRO,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    const err = await conflitoDe(reservar(asDb(db), ALVO, controles()));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
    expect(err.vinculos).toEqual([{ linkDocId: VIVO, itemId: ITEM_OUTRO, rascunho: false }]);
  });

  it('⛔ quase-pares: B REMOVIDO, B de OUTRA conta, ou nenhum irmão ⇒ reserva sem confirmação', async () => {
    for (const irmao of [
      {
        contaProdutoShopeeOuterRef: REF_CONTA,
        item_id: ITEM_OUTRO,
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      },
      rascunho({ contaProdutoShopeeOuterRef: 'documents/integracao/int-12' }),
      null,
    ]) {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      if (irmao !== null) db.seed(CAMINHO_IRMAO, irmao);
      const r = await reservar(asDb(db), ALVO, controles());
      expect(r.tipo, JSON.stringify(irmao)).toBe('travada');
      expect(doc(db)?.publicacaoEmCurso).toMatchObject({ desde: AGORA });
    }
  });

  it('com confirmarSegundoAnuncio ⇒ reserva, a trava FICA', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(CAMINHO_IRMAO, rascunho());

    const r = await reservar(asDb(db), ALVO, controles({ confirmarSegundoAnuncio: true }));

    expect(r.tipo).toBe('travada');
    if (r.tipo !== 'travada') return;
    expect(doc(db)?.publicacaoEmCurso).toMatchObject({ token: r.reserva.token });
  });

  it('⛔ um IRMÃO travado ⇒ 409 EM_ANDAMENTO MESMO com a confirmação, nomeando-o e com a espera dele; a nossa trava devolvida', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(CAMINHO_IRMAO, rascunho({ publicacaoEmCurso: travaAlheia(AGORA + 45_000) }));

    const err = await conflitoDe(
      reservar(asDb(db), ALVO, controles({ confirmarSegundoAnuncio: true })),
    );

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
    expect(err.vinculos).toEqual([{ linkDocId: IRMAO, itemId: null, rascunho: true }]);
    expect(err.aguardarMs).toBe(45_000);
    expect(doc(db)?.publicacaoEmCurso).toBeNull();
    expect(doc(db, CAMINHO_IRMAO)?.publicacaoEmCurso).toEqual(travaAlheia(AGORA + 45_000));
  });

  it('um irmão INCERTO ⇒ 409 EM_ANDAMENTO SEM aguardarMs (esperar não resolve), mesmo com a confirmação', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(CAMINHO_IRMAO, rascunho({ criacaoIncertaDesde: AGORA - 10_000 }));

    const err = await conflitoDe(
      reservar(asDb(db), ALVO, controles({ confirmarSegundoAnuncio: true })),
    );

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
    expect(err.aguardarMs).toBeNull();
    expect(doc(db)?.publicacaoEmCurso).toBeNull();
  });

  it('⚠️ TRAVA-ENTÃO-VARRE: duas reservas concorrentes do mesmo produto, ambas confirmadas, NUNCA passam as duas', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    db.seed(CAMINHO_IRMAO, rascunho());
    const confirmados = controles({ confirmarSegundoAnuncio: true });
    let b:
      | Awaited<ReturnType<typeof reservarRascunhoShopee>>
      | ConflitoDeRascunhoShopeeError
      | null = null;
    // B inteira roda no instante em que A vai varrer os irmãos.
    const corrida = antesDaVarredura(db, async () => {
      b = await reservar(asDb(db), { ...ALVO, linkDocId: IRMAO }, confirmados).catch(
        (e: unknown) => {
          if (e instanceof ConflitoDeRascunhoShopeeError) return e;
          throw e;
        },
      );
    });

    const a = await reservar(asDb(corrida), ALVO, confirmados).catch((e: unknown) => {
      if (e instanceof ConflitoDeRascunhoShopeeError) return e;
      throw e;
    });

    const passaram = [a, b].filter(
      (x) => x !== null && !(x instanceof ConflitoDeRascunhoShopeeError) && x.tipo === 'travada',
    );
    expect(passaram.length).toBeLessThan(2);
    // B escreveu a sua trava DEPOIS da nossa: a varredura de B vê A e recua.
    expect(b).toBeInstanceOf(ConflitoDeRascunhoShopeeError);
    expect((b as ConflitoDeRascunhoShopeeError | null)?.vinculos).toEqual([
      { linkDocId: RASCUNHO, itemId: null, rascunho: true },
    ]);
    expect(doc(db, CAMINHO_IRMAO)?.publicacaoEmCurso).toBeNull();
  });

  describe('(#2050) a liberação que FALHA nunca troca o erro que a reserva está devolvendo', () => {
    it('o update da liberação falha com UNAVAILABLE (gRPC 14) ⇒ o 409 CONTA_JA_TEM_ANUNCIO ORIGINAL chega ao chamador; a nossa trava FICA (expira)', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      db.seed(CAMINHO_IRMAO, rascunho());
      // Armed AFTER our lock lands — the scan runs right after it — so only the
      // RELEASE's update fails.
      const falhando = antesDaVarredura(db, () => {
        db.falhasDeUpdate.set(CAMINHO, grpc(14, 'UNAVAILABLE'));
        return Promise.resolve();
      });

      const err = await conflitoDe(reservar(asDb(falhando), ALVO, controles()));

      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contaJaTemAnuncio);
      expect(err.vinculos).toEqual([{ linkDocId: IRMAO, itemId: null, rascunho: true }]);
      // The lock document is exactly what the reservation wrote: nothing cleared.
      const travaGravada = escritasEm(db)[0]?.publicacaoEmCurso;
      expect(travaGravada).toMatchObject({ desde: AGORA });
      expect(doc(db)?.publicacaoEmCurso).toEqual(travaGravada);
      expect(escritasEm(db)).toHaveLength(1);
      expect(avisos.some((a) => String(a[0]).includes('a liberação da trava falhou'))).toBe(true);
    });

    it('a LEITURA dos irmãos falha E a liberação falha ⇒ o erro da LEITURA (o primeiro) é o que sobe, por identidade', async () => {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho());
      const daLeitura = grpc(4, 'DEADLINE_EXCEEDED');
      const falhando = antesDaVarredura(db, () => {
        db.falhasDeUpdate.set(CAMINHO, grpc(14, 'UNAVAILABLE'));
        return Promise.reject(daLeitura);
      });

      const err = await reservar(asDb(falhando), ALVO, controles()).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBe(daLeitura);
      expect(doc(db)?.publicacaoEmCurso).toMatchObject({ desde: AGORA });
    });

    it('⛔ quase-par: um erro NÃO-gRPC da liberação (um defeito) SOBE — ele é o erro lançado, nunca engolido', async () => {
      for (const defeito of [new TypeError('defeito'), new Error('sem código')]) {
        const db = new FakeDb();
        db.seed(CAMINHO, rascunho());
        db.seed(CAMINHO_IRMAO, rascunho());
        const falhando = antesDaVarredura(db, () => {
          db.falhasDeUpdate.set(CAMINHO, defeito);
          return Promise.resolve();
        });

        const err = await reservar(asDb(falhando), ALVO, controles()).then(
          () => null,
          (e: unknown) => e,
        );

        expect(err, defeito.message).toBe(defeito);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                  3 · antes do envio: a releitura e a porta                  */
/* -------------------------------------------------------------------------- */

function reservaDe(token = 'token-nosso', expiraEm = AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS) {
  const reserva: ReservaDeRascunhoShopee = {
    produtoId: PRODUTO,
    linkDocId: RASCUNHO,
    token,
    desde: expiraEm - PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS,
    expiraEm,
    fase: 'travada',
  };
  return reserva;
}

function travaDa(r: ReservaDeRascunhoShopee) {
  return { desde: r.desde, expiraEm: r.expiraEm, token: r.token };
}

describe('conferirTravaAntesDoEnvio — a releitura E o carimbo do SKU enviado (batch-A review)', () => {
  it('o token ainda é NOSSO ⇒ UM update guardado grava o SKU enviado NA trava e devolve a trava carimbada', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    expect(await conferirTravaAntesDoEnvio(asDb(db), r, 'SKU-1')).toEqual({
      ...travaDa(r),
      sku: 'SKU-1',
    });
    expect(escritasEm(db)).toEqual([{ publicacaoEmCurso: { ...travaDa(r), sku: 'SKU-1' } }]);
    expect(doc(db)?.publicacaoEmCurso).toEqual({ ...travaDa(r), sku: 'SKU-1' });
  });

  it('⛔ quase-par: um corpo SEM SKU carimba \'\' — um VALOR ("enviou sem SKU"), nunca a chave ausente', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    await conferirTravaAntesDoEnvio(asDb(db), r, '');
    expect(doc(db)?.publicacaoEmCurso).toEqual({ ...travaDa(r), sku: '' });
  });

  it('o token foi TROCADO (outra execução assumiu) ⇒ 409 PUBLICACAO_EXPIRADA, a trava alheia intocada', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    const alheia = travaAlheia(AGORA + 100_000);
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: alheia }));

    const err = await conflitoDe(conferirTravaAntesDoEnvio(asDb(db), r, 'SKU-1'));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
    expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
    expect(db.writes).toEqual([]);
  });

  it('o rascunho já foi REIVINDICADO por outro item ⇒ 409 JA_PUBLICADO; apagado ou sem trava ⇒ PUBLICACAO_EXPIRADA', async () => {
    const r = reservaDe();
    const reivindicado = new FakeDb();
    reivindicado.seed(CAMINHO, rascunho({ item_id: ITEM_OUTRO, publicacaoEmCurso: null }));
    expect((await conflitoDe(conferirTravaAntesDoEnvio(asDb(reivindicado), r, 'SKU-1'))).code).toBe(
      CODIGO_RASCUNHO_SHOPEE.jaPublicado,
    );
    expect((await conflitoDe(conferirTravaAntesDoEnvio(asDb(new FakeDb()), r, 'SKU-1'))).code).toBe(
      CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada,
    );
    const semTrava = new FakeDb();
    semTrava.seed(CAMINHO, rascunho({ publicacaoEmCurso: null }));
    expect((await conflitoDe(conferirTravaAntesDoEnvio(asDb(semTrava), r, 'SKU-1'))).code).toBe(
      CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada,
    );
    expect(reivindicado.writes).toEqual([]);
    expect(semTrava.writes).toEqual([]);
  });

  it('uma tomada de posse ENTRE o get e o update ⇒ a releitura decide: 409 PUBLICACAO_EXPIRADA, nada gravado sobre a alheia', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const alheia = travaAlheia(AGORA + 200_000);
    const corrida = comEscritaConcorrente(db, CAMINHO, () => {
      db.seed(CAMINHO, { ...doc(db), publicacaoEmCurso: alheia });
    });

    const err = await conflitoDe(conferirTravaAntesDoEnvio(asDb(corrida), r, 'SKU-1'));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
    expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
  });

  it(`a precondição perdida ${String(TENTATIVAS_DA_TRAVA)} vezes ⇒ 409 CONTENCAO — nada segue para o add_item`, async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const corrida = comEscritaConcorrente(
      db,
      CAMINHO,
      (leitura) => db.seed(CAMINHO, { ...doc(db), ultimaModificacao: leitura }),
      true,
    );

    const err = await conflitoDe(conferirTravaAntesDoEnvio(asDb(corrida), r, 'SKU-1'));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contencao);
    expect(doc(db)?.publicacaoEmCurso).toEqual(travaDa(r));
  });
});

describe('portaoDeEnvio — agora() + MARGEM < min(expiraEm, prazoDaRequisicao)', () => {
  const EXPIRA = AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS;
  const trava = { expiraEm: EXPIRA };

  function passa(agora: number, prazo: number | null): boolean {
    try {
      portaoDeEnvio(RASCUNHO, trava, { agora: () => agora, prazoDaRequisicao: prazo });
      return true;
    } catch (err) {
      if (err instanceof ConflitoDeRascunhoShopeeError) {
        expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
        return false;
      }
      throw err;
    }
  }

  it('sem prazo (a CLI): só a trava limita — − MARGEM − 1 passa, − MARGEM recusa', () => {
    expect(passa(EXPIRA - MARGEM_ENVIO_SHOPEE_MS - 1, null)).toBe(true);
    expect(passa(EXPIRA - MARGEM_ENVIO_SHOPEE_MS, null)).toBe(false);
    expect(passa(EXPIRA, null)).toBe(false);
  });

  it('com o prazo da requisição ANTES da trava: o prazo é quem limita', () => {
    const prazo = AGORA + 180_000;
    expect(passa(prazo - MARGEM_ENVIO_SHOPEE_MS - 1, prazo)).toBe(true);
    expect(passa(prazo - MARGEM_ENVIO_SHOPEE_MS, prazo)).toBe(false);
    // ⛔ quase-par: o MESMO instante sem prazo passa — a trava ainda tem folga.
    expect(passa(prazo - MARGEM_ENVIO_SHOPEE_MS, null)).toBe(true);
  });

  it('com o prazo DEPOIS da trava: a trava continua limitando', () => {
    expect(passa(EXPIRA - MARGEM_ENVIO_SHOPEE_MS, EXPIRA + 60_000)).toBe(false);
    expect(passa(EXPIRA - MARGEM_ENVIO_SHOPEE_MS - 1, EXPIRA + 60_000)).toBe(true);
  });

  it('a frase diz QUAL relógio acabaria — o da requisição ou o da trava', () => {
    const msg = (agora: number, prazo: number | null): string => {
      try {
        portaoDeEnvio(RASCUNHO, trava, { agora: () => agora, prazoDaRequisicao: prazo });
        return '';
      } catch (err) {
        if (err instanceof ConflitoDeRascunhoShopeeError) return err.message;
        throw err;
      }
    };
    expect(msg(EXPIRA, AGORA + 1)).toContain('requisição');
    expect(msg(EXPIRA, null)).toContain('trava');
    expect(msg(EXPIRA, null)).toContain('Nada foi enviado');
  });

  it('⚠️ um relógio NaN RECUSA — nunca envia', () => {
    expect(passa(Number.NaN, null)).toBe(false);
  });

  it('lê o relógio NA HORA, a cada chamada — nunca um valor capturado antes', () => {
    let t = AGORA;
    const c = { agora: () => t, prazoDaRequisicao: null };
    expect(() => portaoDeEnvio(RASCUNHO, trava, c)).not.toThrow();
    t = EXPIRA;
    expect(() => portaoDeEnvio(RASCUNHO, trava, c)).toThrow(ConflitoDeRascunhoShopeeError);
  });
});

describe('dentroDoPrazoDeEnvio — a condição do portão, UMA cópia (batch-A review)', () => {
  const EXPIRA = AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS;
  const trava = { expiraEm: EXPIRA };
  const em = (agora: number, prazo: number | null): boolean =>
    dentroDoPrazoDeEnvio(trava, { agora: () => agora, prazoDaRequisicao: prazo });

  it('responde EXATAMENTE o que o portão decide, nas mesmas fronteiras (o portão a chama)', () => {
    const prazo = AGORA + 180_000;
    const casos: readonly (readonly [number, number | null])[] = [
      [EXPIRA - MARGEM_ENVIO_SHOPEE_MS - 1, null],
      [EXPIRA - MARGEM_ENVIO_SHOPEE_MS, null],
      [prazo - MARGEM_ENVIO_SHOPEE_MS - 1, prazo],
      [prazo - MARGEM_ENVIO_SHOPEE_MS, prazo],
      [EXPIRA - MARGEM_ENVIO_SHOPEE_MS - 1, EXPIRA + 60_000],
      [EXPIRA - MARGEM_ENVIO_SHOPEE_MS, EXPIRA + 60_000],
      [Number.NaN, null],
    ];
    for (const [agora, p] of casos) {
      let passou = true;
      try {
        portaoDeEnvio(RASCUNHO, trava, { agora: () => agora, prazoDaRequisicao: p });
      } catch (err) {
        if (!(err instanceof ConflitoDeRascunhoShopeeError)) throw err;
        passou = false;
      }
      expect(em(agora, p), `${String(agora)} / ${String(p)}`).toBe(passou);
    }
  });

  it('⛔ a fronteira é ESTRITA: agora + MARGEM == limite ⇒ false; um ms antes ⇒ true', () => {
    expect(em(EXPIRA - MARGEM_ENVIO_SHOPEE_MS, null)).toBe(false);
    expect(em(EXPIRA - MARGEM_ENVIO_SHOPEE_MS - 1, null)).toBe(true);
  });

  it('⚠️ um relógio NaN responde false — parar, nunca seguir', () => {
    expect(em(Number.NaN, null)).toBe(false);
    expect(em(Number.NaN, AGORA + 180_000)).toBe(false);
  });

  it('lê o relógio uma vez por chamada, na hora', () => {
    let leituras = 0;
    let t = AGORA;
    const c = {
      agora: () => {
        leituras += 1;
        return t;
      },
      prazoDaRequisicao: null,
    };
    expect(dentroDoPrazoDeEnvio(trava, c)).toBe(true);
    t = EXPIRA;
    expect(dentroDoPrazoDeEnvio(trava, c)).toBe(false);
    expect(leituras).toBe(2);
  });
});

describe('buscaNoPrazoDoEnvio — a busca sob o prazo do portão (batch-A review)', () => {
  const EXPIRA = AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS;
  const trava = { expiraEm: EXPIRA };

  it('entrega à busca o predicado do portão sobre ESTA trava e ESTES controles', async () => {
    let t = AGORA;
    const respostas: boolean[] = [];
    const r = await buscaNoPrazoDoEnvio(
      RASCUNHO,
      trava,
      { agora: () => t, prazoDaRequisicao: AGORA + 100_000 },
      (podeContinuar) => {
        respostas.push(podeContinuar());
        t = AGORA + 100_000 - MARGEM_ENVIO_SHOPEE_MS - 1;
        respostas.push(podeContinuar());
        t = AGORA + 100_000 - MARGEM_ENVIO_SHOPEE_MS;
        respostas.push(podeContinuar());
        return Promise.resolve('resposta');
      },
    );
    expect(r).toBe('resposta');
    expect(respostas).toEqual([true, true, false]);
  });

  it('o CORTE da busca vira o 409 PUBLICACAO_EXPIRADA do portão — a frase diz qual prazo, e que nada foi enviado', async () => {
    const corte = (prazo: number | null): Promise<ConflitoDeRascunhoShopeeError> =>
      conflitoDe(
        buscaNoPrazoDoEnvio(RASCUNHO, trava, { agora: () => AGORA, prazoDaRequisicao: prazo }, () =>
          Promise.reject(new BuscaForaDoPrazoShopeeError('get_item_list')),
        ),
      );
    const daRota = await corte(AGORA + 180_000);
    expect(daRota.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
    expect(daRota.linkDocId).toBe(RASCUNHO);
    expect(daRota.message).toContain('a busca não coube no tempo desta requisição');
    expect(daRota.message).toContain('pelo CLI');
    expect(daRota.message).toContain('Nada foi enviado');
    const doCli = await corte(null);
    expect(doCli.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
    expect(doCli.message).toContain('a busca não coube no tempo da trava');
    expect(doCli.message).not.toContain('pelo CLI');
  });

  it('⛔ quase-par: qualquer OUTRO erro da busca sobe intacto, por identidade (regra 6)', async () => {
    for (const falha of [new ShopeeError('a busca caiu'), new TypeError('bug'), grpc(14, 'x')]) {
      await expect(
        buscaNoPrazoDoEnvio(RASCUNHO, trava, { agora: () => AGORA, prazoDaRequisicao: null }, () =>
          Promise.reject(falha),
        ),
      ).rejects.toBe(falha);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       4 · o write-back #1 é uma REIVINDICAÇÃO               */
/* -------------------------------------------------------------------------- */

describe('reivindicarRascunhoShopee', () => {
  const ALVO_CLAIM = { produtoId: PRODUTO, linkDocId: RASCUNHO, itemId: ITEM_NOSSO };
  const montar = (armazenado: Record<string, unknown>): Record<string, unknown> => ({
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_NOSSO,
    item_name: 'Camiseta do rascunho',
    ultimaModificacao: AGORA,
    ...(armazenado.publicadoEm === undefined ? { publicadoEm: AGORA } : {}),
  });

  it('ainda rascunho ⇒ update GUARDADO no MESMO documento: o item_id e a trava null juntos', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaAlheia(AGORA + 1) }));

    const id = await reivindicarRascunhoShopee(asDb(db), ALVO_CLAIM, montar);

    expect(id).toBe(RASCUNHO);
    expect(doc(db)).toMatchObject({
      item_id: ITEM_NOSSO,
      publicacaoEmCurso: null,
      publicadoEm: AGORA,
    });
    // One UPDATE (it is in the patch log), carrying both keys.
    expect(db.patches.filter((p) => p.path === CAMINHO)).toHaveLength(1);
    expect(db.patches[0]?.patch).toMatchObject({ item_id: ITEM_NOSSO, publicacaoEmCurso: null });
    expect(db.idsEm(COLECAO)).toEqual([RASCUNHO]);
  });

  it('já é NOSSO (um replay) ⇒ o merge simples, mesmo id, nenhum vínculo novo', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ item_id: ITEM_NOSSO, publicadoEm: 1 }));

    const id = await reivindicarRascunhoShopee(asDb(db), ALVO_CLAIM, montar);

    expect(id).toBe(RASCUNHO);
    expect(db.idsEm(COLECAO)).toEqual([RASCUNHO]);
    // A merge, not an update: the patch log is untouched.
    expect(db.patches).toEqual([]);
    expect(doc(db)?.publicadoEm).toBe(1);
  });

  it('REIVINDICADO por OUTRO item ⇒ um vínculo NOVO para o nosso; o do outro intocado (dois vinculados, nunca um órfão)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho({ item_id: ITEM_OUTRO }));
    const antes = structuredClone(doc(db));

    const id = await reivindicarRascunhoShopee(asDb(db), ALVO_CLAIM, montar);

    expect(id).not.toBe(RASCUNHO);
    expect(doc(db, `${COLECAO}/${id}`)).toMatchObject({ item_id: ITEM_NOSSO, publicadoEm: AGORA });
    expect(doc(db)).toEqual(antes);
    expect(avisos.length).toBe(1);
  });

  it('APAGADO (descartado) ⇒ um vínculo novo — o anúncio existe e precisa de vínculo', async () => {
    const db = new FakeDb();
    const id = await reivindicarRascunhoShopee(asDb(db), ALVO_CLAIM, montar);
    expect(id).not.toBe(RASCUNHO);
    expect(doc(db, `${COLECAO}/${id}`)).toMatchObject({ item_id: ITEM_NOSSO });
  });

  it('a precondição perdida RE-DERIVA o patch do documento novo (montar vê a releitura)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    const corrida = comEscritaConcorrente(db, CAMINHO, () =>
      db.seed(CAMINHO, rascunho({ publicadoEm: 42 })),
    );
    const vistos: unknown[] = [];

    const id = await reivindicarRascunhoShopee(asDb(corrida), ALVO_CLAIM, (a) => {
      vistos.push(a.publicadoEm);
      return montar(a);
    });

    expect(id).toBe(RASCUNHO);
    expect(vistos).toEqual([undefined, 42]);
    // The second derivation saw `publicadoEm` and did NOT overwrite it.
    expect(doc(db)).toMatchObject({
      item_id: ITEM_NOSSO,
      publicadoEm: 42,
      publicacaoEmCurso: null,
    });
  });

  it(`perder a precondição ${String(TENTATIVAS_DA_TRAVA)} vezes RELANÇA o FAILED_PRECONDITION — o chamador mantém a trava`, async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, rascunho());
    const corrida = comEscritaConcorrente(
      db,
      CAMINHO,
      (n) => db.seed(CAMINHO, rascunho({ item_name: `edição ${String(n)}` })),
      true,
    );

    await expect(
      reivindicarRascunhoShopee(asDb(corrida), ALVO_CLAIM, montar),
    ).rejects.toMatchObject({ code: 9 });
    expect(doc(db)?.item_id).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                        5 · a liberação GUARDADA pelo token                  */
/* -------------------------------------------------------------------------- */

describe('liberarTravaShopee', () => {
  it('a trava é NOSSA ⇒ null, num update guardado; a reserva fica "encerrada"', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));

    expect(await liberarTravaShopee(asDb(db), r)).toBe('liberada');
    expect(doc(db)?.publicacaoEmCurso).toBeNull();
    expect(r.fase).toBe('encerrada');
    expect(db.patches).toEqual([{ path: CAMINHO, patch: { publicacaoEmCurso: null } }]);
  });

  it('com o carimbo de falha: os DOIS no MESMO update — ou nenhum', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const carimbo = {
      falhaPublicacao: {
        em: AGORA,
        etapa: 'add_item',
        erro: 'error_param',
        mensagem: 'recusado',
        problemas: [],
      },
      ultimaModificacao: AGORA,
    };

    expect(await liberarTravaShopee(asDb(db), r, carimbo)).toBe('liberada');
    expect(db.patches).toHaveLength(1);
    expect(db.patches[0]?.patch).toEqual({ ...carimbo, publicacaoEmCurso: null });
  });

  it('⛔ (K1-14) a trava é de OUTRA execução ⇒ NADA gravado — nem a liberação, nem o carimbo — e uma linha de log', async () => {
    const db = new FakeDb();
    const alheia = travaAlheia(AGORA + 10);
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: alheia }));

    expect(await liberarTravaShopee(asDb(db), reservaDe(), { ultimaModificacao: AGORA })).toBe(
      'nao-e-nossa',
    );
    expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
    expect(db.writes).toEqual([]);
    expect(avisos.length).toBe(1);
  });

  it('sem trava, ou com uma ilegível ⇒ nao-e-nossa, zero escritas; documento apagado ⇒ ausente', async () => {
    for (const extra of [{ publicacaoEmCurso: null }, {}, { publicacaoEmCurso: { token: 1 } }]) {
      const db = new FakeDb();
      db.seed(CAMINHO, rascunho(extra));
      expect(await liberarTravaShopee(asDb(db), reservaDe()), JSON.stringify(extra)).toBe(
        'nao-e-nossa',
      );
      expect(db.writes).toEqual([]);
    }
    expect(await liberarTravaShopee(asDb(new FakeDb()), reservaDe())).toBe('ausente');
  });

  it('uma tomada de posse ENTRE o get e o update ⇒ a releitura decide: nada gravado, a trava alheia intacta', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const alheia = travaAlheia(AGORA + 99);
    const corrida = comEscritaConcorrente(db, CAMINHO, () =>
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: alheia })),
    );

    expect(await liberarTravaShopee(asDb(corrida), r)).toBe('nao-e-nossa');
    expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
    expect(escritasEm(db)).toEqual([]);
  });

  it('três precondições perdidas ⇒ contencao, SEM lançar (a trava expira sozinha; o erro do chamador não é trocado)', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const corrida = comEscritaConcorrente(
      db,
      CAMINHO,
      () => db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) })),
      true,
    );

    expect(await liberarTravaShopee(asDb(corrida), r)).toBe('contencao');
    expect(doc(db)?.publicacaoEmCurso).toEqual(travaDa(r));
  });

  it('um erro do Firestore que NÃO é precondição propaga (regra 6)', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    db.falhasDeUpdate.set(CAMINHO, Object.assign(new Error('UNAVAILABLE'), { code: 14 }));

    await expect(liberarTravaShopee(asDb(db), r)).rejects.toMatchObject({ code: 14 });
  });
});

describe('liberarTravaShopeeSemSubstituirErro — para quem JÁ está devolvendo um erro (#2050)', () => {
  it('a liberação que dá certo é a de sempre: a trava null (com o carimbo, quando dado) num update só', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));

    await liberarTravaShopeeSemSubstituirErro(asDb(db), r, { ultimaModificacao: AGORA });

    expect(db.patches).toEqual([
      { path: CAMINHO, patch: { ultimaModificacao: AGORA, publicacaoEmCurso: null } },
    ]);
    expect(r.fase).toBe('encerrada');
    expect(avisos).toEqual([]);
  });

  it('um erro gRPC do Firestore (UNAVAILABLE, DEADLINE_EXCEEDED…) é ENGOLIDO: resolve, a trava e o documento intactos, UMA linha de log com ids e o código — nunca a mensagem nem o carimbo', async () => {
    for (const codigo of [4, 14]) {
      avisos = [];
      const db = new FakeDb();
      const r = reservaDe();
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
      const antes = structuredClone(doc(db));
      db.falhasDeUpdate.set(CAMINHO, grpc(codigo, 'corpo-da-mensagem-do-sdk'));

      await expect(
        liberarTravaShopeeSemSubstituirErro(asDb(db), r, {
          falhaPublicacao: {
            em: AGORA,
            etapa: 'add_item',
            erro: 'error_param',
            mensagem: 'carimbo-que-nao-pode-vazar',
            problemas: [],
          },
        }),
      ).resolves.toBeUndefined();

      expect(doc(db), String(codigo)).toEqual(antes);
      expect(db.writes).toEqual([]);
      expect(r.fase).toBe('encerrada');
      expect(avisos, String(codigo)).toHaveLength(1);
      expect(avisos[0]?.[1]).toEqual({
        produtoId: PRODUTO,
        linkDocId: RASCUNHO,
        codigoGrpc: codigo,
      });
      expect(JSON.stringify(avisos)).not.toContain('corpo-da-mensagem-do-sdk');
      expect(JSON.stringify(avisos)).not.toContain('carimbo-que-nao-pode-vazar');
    }
  });

  it('QUALQUER status gRPC é engolido, não só os transitórios — NOT_FOUND (5, o rascunho apagado entre a leitura e o update), PERMISSION_DENIED (7) e as bordas 1 e 16: a regra é "o Firestore falhou", nunca "pode dar certo depois"', async () => {
    for (const codigo of [1, 5, 7, 16]) {
      avisos = [];
      const db = new FakeDb();
      const r = reservaDe();
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
      const antes = structuredClone(doc(db));
      db.falhasDeUpdate.set(CAMINHO, grpc(codigo, 'nao-transitorio'));

      await expect(
        liberarTravaShopeeSemSubstituirErro(asDb(db), r),
        String(codigo),
      ).resolves.toBeUndefined();

      expect(doc(db), String(codigo)).toEqual(antes);
      expect(db.writes).toEqual([]);
      expect(avisos, String(codigo)).toHaveLength(1);
      expect(avisos[0]?.[1], String(codigo)).toEqual({
        produtoId: PRODUTO,
        linkDocId: RASCUNHO,
        codigoGrpc: codigo,
      });
    }
  });

  it('⛔ quase-pares: o que NÃO é um status gRPC SOBE, por identidade — um TypeError, um Error sem código, um código em STRING (FirebaseError), um código fora de 1..16', async () => {
    for (const defeito of [
      new TypeError('defeito'),
      new Error('sem código'),
      Object.assign(new Error('functions'), { code: 'functions/unavailable' }),
      Object.assign(new Error('fora'), { code: 17 }),
    ]) {
      const db = new FakeDb();
      const r = reservaDe();
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
      db.falhasDeUpdate.set(CAMINHO, defeito);

      const err = await liberarTravaShopeeSemSubstituirErro(asDb(db), r).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err, defeito.message).toBe(defeito);
    }
  });

  it('a trava de OUTRA execução continua intocada (o guarda do token é o mesmo)', async () => {
    const db = new FakeDb();
    const alheia = travaAlheia(AGORA + 10);
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: alheia }));

    await liberarTravaShopeeSemSubstituirErro(asDb(db), reservaDe(), { ultimaModificacao: AGORA });

    expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
    expect(db.writes).toEqual([]);
  });
});

describe('ConflitoDeRascunhoShopeeError', () => {
  it('é uma classe do APP, nunca um ShopeeError — nada a lê como resposta da Shopee', () => {
    const err = new ConflitoDeRascunhoShopeeError({
      code: CODIGO_RASCUNHO_SHOPEE.contencao,
      linkDocId: RASCUNHO,
      mensagem: 'm',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ShopeeError);
    expect(err.name).toBe('ConflitoDeRascunhoShopeeError');
    expect(err.aguardarMs).toBeNull();
    expect(err.vinculos).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*       #1911 P5 — `incerta` é TOMADA e a BUSCA (ENSURE) decide               */
/* -------------------------------------------------------------------------- */

describe('reservarRascunhoShopee — um rascunho INCERTO (P5: a busca antes de qualquer add_item)', () => {
  const SKU = 'SKU-1';
  const CAMINHO_PRODUTO = `produtos/${PRODUTO}`;
  /** ms — the earlier, uncertain attempt's start. */
  const DESDE_VELHO = AGORA - 600_000;
  const DENTRO_S = Math.floor(DESDE_VELHO / 1000);

  type Json = Record<string, unknown>;

  function baseDe(itemId: number, over: Json = {}): Json {
    const corpo = shopeeItemBaseInfoSchema.parse(
      lerFixture(FIXTURE_ITEM_BASE_INFO_SG_KIT),
    ).response;
    return {
      ...(corpo.item_list[0] as Json),
      item_id: itemId,
      item_sku: SKU,
      create_time: DENTRO_S,
      tag: { kit: false },
      ...over,
    };
  }

  /** The look-up's Shopee: one page holding `bases`, and their base rows. */
  function lojaCom(...bases: readonly Json[]): {
    readonly busca: BuscaDaCriacaoIncerta;
    readonly ops: string[];
  } {
    const ops: string[] = [];
    const porId = new Map(bases.map((b) => [b.item_id as number, b]));
    const client = {
      getItemList: () => {
        ops.push('get_item_list');
        return Promise.resolve(
          shopeeItemListPayloadSchema.parse({
            item: bases.map((b) => ({
              item_id: b.item_id,
              item_status: 'NORMAL',
              update_time: DENTRO_S,
              tag: { kit: false },
            })),
            total_count: bases.length,
            has_next_page: false,
            next_offset: null,
            next: '',
          }),
        );
      },
      getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
        ops.push('get_item_base_info');
        return Promise.resolve(
          shopeeItemBaseInfoPayloadSchema.parse({
            item_list: p.itemIds.map((id) => porId.get(id)).filter((b) => b !== undefined),
          }),
        );
      },
    } as unknown as ShopeeClient;
    return { busca: { client, nowMs: AGORA }, ops };
  }

  function incerto(extra: Json = {}): Json {
    return rascunho({ criacaoIncertaDesde: DESDE_VELHO, ...extra });
  }

  function comProduto(db: FakeDb, sku: string | null = SKU): FakeDb {
    db.seed(CAMINHO_PRODUTO, { nome: 'Camiseta', sku });
    return db;
  }

  it('a busca COMPLETA não acha nada ⇒ travada; a tomada CARREGA o registro, e depois ele é LIMPO sob a trava', async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, incerto());
    const loja = lojaCom();

    const r = await reservar(asDb(db), ALVO, controles(), loja.busca);

    expect(r.tipo).toBe('travada');
    const [tomada, limpeza, ...resto] = escritasEm(db);
    expect(tomada).toMatchObject({
      publicacaoEmCurso: { desde: AGORA, expiraEm: AGORA + PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS },
      criacaoIncertaDesde: DESDE_VELHO,
    });
    expect(limpeza).toEqual({ criacaoIncertaDesde: null, criacaoIncertaSku: null });
    expect(resto).toEqual([]);
    // The lock is still OURS — only the record went.
    expect(doc(db)?.publicacaoEmCurso).toMatchObject({ desde: AGORA });
    expect(doc(db)?.criacaoIncertaDesde).toBeNull();
    expect(loja.ops).toEqual(['get_item_list']);
  });

  it('⛔ quase-par: um rascunho LIVRE nem busca nem grava a chave do registro', async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, rascunho());
    const loja = lojaCom(baseDe(ITEM_NOSSO));

    expect((await reservar(asDb(db), ALVO, controles(), loja.busca)).tipo).toBe('travada');
    expect(loja.ops).toEqual([]);
    expect(escritasEm(db)).toHaveLength(1);
    expect(escritasEm(db)[0]).not.toHaveProperty('criacaoIncertaDesde');
  });

  it('UM anúncio achado ⇒ ADOTADO no MESMO documento (item_id, a conta canônica, trava + registro + carimbo zerados)', async () => {
    const db = comProduto(new FakeDb());
    db.seed(
      CAMINHO,
      incerto({
        contaProdutoShopeeOuterRef: 'integracao/int-1',
        falhaPublicacao: { em: 1, etapa: 'add_item', erro: 'x', mensagem: 'm', problemas: [] },
      }),
    );
    const loja = lojaCom(baseDe(ITEM_NOSSO));

    const r = await reservar(asDb(db), ALVO, controles(), loja.busca);

    expect(r).toEqual({ tipo: 'adotada', itemId: ITEM_NOSSO });
    expect(doc(db)).toMatchObject({
      item_id: ITEM_NOSSO,
      contaProdutoShopeeOuterRef: REF_CONTA,
      publicacaoEmCurso: null,
      criacaoIncertaDesde: null,
      falhaPublicacao: null,
      ultimaModificacao: AGORA,
    });
    // tomada + adoção, ambas UPDATEs guardados; nenhum vínculo novo.
    expect(db.patches.filter((p) => p.path === CAMINHO)).toHaveLength(2);
    expect(db.idsEm(COLECAO)).toEqual([RASCUNHO]);
  });

  it('a busca RECUSA (dois achados) ⇒ 422 ambígua; a trava DEVOLVIDA e o registro FICA', async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, incerto());
    const loja = lojaCom(baseDe(ITEM_NOSSO), baseDe(ITEM_OUTRO));

    const err = await reservar(asDb(db), ALVO, controles(), loja.busca).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeePublishBlockedError);
    expect((err as ShopeePublishBlockedError).motivo).toBe(
      MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaAmbigua,
    );
    expect(doc(db)).toMatchObject({ publicacaoEmCurso: null, criacaoIncertaDesde: DESDE_VELHO });
  });

  it('(K1-11) sem SKU + confirmarCriacaoIncerta ⇒ travada SEM busca, e o registro FICA (nada o provou)', async () => {
    const db = comProduto(new FakeDb(), '   ');
    db.seed(CAMINHO, incerto());
    const loja = lojaCom(baseDe(ITEM_NOSSO));

    const r = await reservar(
      asDb(db),
      ALVO,
      controles({ confirmarCriacaoIncerta: true }),
      loja.busca,
    );

    expect(r.tipo).toBe('travada');
    expect(loja.ops).toEqual([]);
    expect(escritasEm(db)).toHaveLength(1);
    expect(doc(db)?.criacaoIncertaDesde).toBe(DESDE_VELHO);
  });

  it('⛔ sem SKU e SEM a flag ⇒ 422 sem-sku, zero chamadas, trava devolvida, registro fica', async () => {
    const db = comProduto(new FakeDb(), null);
    db.seed(CAMINHO, incerto());
    const loja = lojaCom(baseDe(ITEM_NOSSO));

    const err = await reservar(asDb(db), ALVO, controles(), loja.busca).catch((e: unknown) => e);

    expect((err as ShopeePublishBlockedError).motivo).toBe(
      MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaSemSku,
    );
    expect(loja.ops).toEqual([]);
    expect(doc(db)).toMatchObject({ publicacaoEmCurso: null, criacaoIncertaDesde: DESDE_VELHO });
  });

  it('⚠️ o D15 roda ANTES da busca: um irmão TRAVADO ⇒ 409 EM_ANDAMENTO, ZERO chamadas à Shopee (a criação dele nunca vira a nossa)', async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, incerto());
    db.seed(CAMINHO_IRMAO, rascunho({ publicacaoEmCurso: travaAlheia(AGORA + 60_000) }));
    const loja = lojaCom(baseDe(ITEM_NOSSO));

    const err = await conflitoDe(reservar(asDb(db), ALVO, controles(), loja.busca));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento);
    expect(loja.ops).toEqual([]);
    expect(doc(db)).toMatchObject({ publicacaoEmCurso: null, criacaoIncertaDesde: DESDE_VELHO });
  });

  it('uma falha da Shopee na busca PROPAGA — a trava devolvida, o registro fica', async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, incerto());
    const falha = new ShopeeError('a busca caiu');
    const busca = {
      client: { getItemList: () => Promise.reject(falha) } as unknown as ShopeeClient,
      nowMs: AGORA,
    };

    await expect(reservar(asDb(db), ALVO, controles(), busca)).rejects.toBe(falha);
    expect(doc(db)).toMatchObject({ publicacaoEmCurso: null, criacaoIncertaDesde: DESDE_VELHO });
  });

  it(`a LIMPEZA do registro perde a precondição ${String(TENTATIVAS_DA_TRAVA)} vezes ⇒ 409 CONTENCAO — nada segue para o add_item`, async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, incerto());
    // From the 2nd read on (after our lock landed), a concurrent writer bumps
    // the document — our lock stays, the precondition never holds.
    const corrida = comEscritaConcorrente(
      db,
      CAMINHO,
      (leitura) => {
        if (leitura >= 2) db.seed(CAMINHO, { ...doc(db), ultimaModificacao: leitura });
      },
      true,
    );

    const err = await conflitoDe(reservar(asDb(corrida), ALVO, controles(), lojaCom().busca));

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.contencao);
    expect(doc(db)?.criacaoIncertaDesde).toBe(DESDE_VELHO);
  });

  it('a ADOÇÃO encontra a trava fora desta execução ⇒ 409 PUBLICACAO_EXPIRADA, nada adotado', async () => {
    const db = comProduto(new FakeDb());
    db.seed(CAMINHO, incerto());
    const alheia = travaAlheia(AGORA + 250_000);
    // The 2nd read of the draft is the adoption's: another run's lock is there.
    const corrida = comEscritaConcorrente(
      db,
      CAMINHO,
      (leitura) => {
        if (leitura === 2) db.seed(CAMINHO, { ...doc(db), publicacaoEmCurso: alheia });
      },
      true,
    );

    const err = await conflitoDe(
      reservar(asDb(corrida), ALVO, controles(), lojaCom(baseDe(ITEM_NOSSO)).busca),
    );

    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
    expect(doc(db)).toMatchObject({ item_id: null, publicacaoEmCurso: alheia });
  });

  describe('o SKU que a tentativa ENVIOU decide a busca — nunca o do produto agora (batch-A review)', () => {
    /** A crashed attempt's lock, past its grace: what the takeover reads. */
    function travaVencidaCom(sku: string | undefined) {
      const expira = AGORA - AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS - 1;
      return { ...travaAlheia(expira), ...(sku === undefined ? {} : { sku }) };
    }

    it('a TOMADA de uma trava que caiu (o caminho do crash) carrega o SKU dela para criacaoIncertaSku, na MESMA escrita', async () => {
      const db = comProduto(new FakeDb());
      const velha = travaVencidaCom(SKU);
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: velha }));

      const r = await reservar(asDb(db), ALVO, controles(), lojaCom().busca);

      expect(r.tipo).toBe('travada');
      const [tomada] = escritasEm(db);
      expect(tomada).toMatchObject({ criacaoIncertaDesde: velha.desde, criacaoIncertaSku: SKU });
    });

    it('⚠️ trava que caiu com SKU-1, produto agora SKU-2 ⇒ 422 ambígua, ZERO chamadas, o registro (desde + SKU) FICA', async () => {
      const db = comProduto(new FakeDb(), 'SKU-2');
      const velha = travaVencidaCom(SKU);
      db.seed(CAMINHO, rascunho({ publicacaoEmCurso: velha }));
      const loja = lojaCom(baseDe(ITEM_NOSSO));

      const err = await reservar(asDb(db), ALVO, controles(), loja.busca).catch((e: unknown) => e);

      expect((err as ShopeePublishBlockedError).motivo).toBe(
        MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaAmbigua,
      );
      expect(loja.ops).toEqual([]);
      expect(doc(db)).toMatchObject({
        publicacaoEmCurso: null,
        criacaoIncertaDesde: velha.desde,
        criacaoIncertaSku: SKU,
      });
    });

    it("⚠️ O PAR do orquestrador, ponta a ponta: enviado '' + produto agora 'ABC' + X('') DENTRO ⇒ 422, o registro fica", async () => {
      const db = comProduto(new FakeDb(), 'ABC');
      db.seed(CAMINHO, incerto({ criacaoIncertaSku: '' }));
      const loja = lojaCom(baseDe(ITEM_NOSSO, { item_sku: '' }));

      const err = await reservar(asDb(db), ALVO, controles(), loja.busca).catch((e: unknown) => e);

      expect((err as ShopeePublishBlockedError).motivo).toBe(
        MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaAmbigua,
      );
      expect(loja.ops).toEqual([]);
      expect(doc(db)).toMatchObject({ criacaoIncertaDesde: DESDE_VELHO, criacaoIncertaSku: '' });
    });

    it("⛔ …o quase-par: enviado 'ABC' + produto 'ABC' + X('') DENTRO ⇒ ignorado: travada, o registro LIMPO (os dois campos)", async () => {
      const db = comProduto(new FakeDb(), 'ABC');
      db.seed(CAMINHO, incerto({ criacaoIncertaSku: 'ABC' }));
      const loja = lojaCom(baseDe(ITEM_NOSSO, { item_sku: '' }));

      expect((await reservar(asDb(db), ALVO, controles(), loja.busca)).tipo).toBe('travada');
      expect(doc(db)).toMatchObject({ criacaoIncertaDesde: null, criacaoIncertaSku: null });
    });

    it('enviado SKU-1 + produto SKU-1: o anúncio achado é ADOTADO e o registro (desde + SKU) zerado', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto({ criacaoIncertaSku: SKU }));

      const r = await reservar(asDb(db), ALVO, controles(), lojaCom(baseDe(ITEM_NOSSO)).busca);

      expect(r).toEqual({ tipo: 'adotada', itemId: ITEM_NOSSO });
      expect(doc(db)).toMatchObject({ criacaoIncertaDesde: null, criacaoIncertaSku: null });
    });
  });

  describe('⏱️ a busca para ANTES do prazo da requisição (batch-A review, 2026-10-28)', () => {
    /**
     * A shop whose every Shopee call advances the route's clock by `passo` ms
     * (1 by default; 0 = a constant clock), so with 1
     * `prazoDaRequisicao = AGORA + MARGEM + k` lets exactly k calls through
     * (the checkpoint before call k+1 reads `AGORA + k + MARGEM`, which is
     * not `<` the deadline). `paginas[i]` is page i's rows; the base rows
     * answer by id.
     */
    function lojaNoRelogio(
      paginas: readonly (readonly Json[])[],
      passo = 1,
    ): {
      readonly busca: BuscaDaCriacaoIncerta;
      readonly ops: string[];
      readonly relogio: { t: number };
    } {
      const ops: string[] = [];
      const relogio = { t: AGORA };
      const porId = new Map(paginas.flat().map((b) => [b.item_id as number, b]));
      const client = {
        getItemList: (p: { offset: number }) => {
          ops.push('get_item_list');
          relogio.t += passo;
          const i = p.offset / 100;
          const linhas = paginas[i] ?? [];
          return Promise.resolve(
            shopeeItemListPayloadSchema.parse({
              item: linhas.map((b) => ({
                item_id: b.item_id,
                item_status: 'NORMAL',
                update_time: DENTRO_S,
                tag: { kit: false },
              })),
              total_count: porId.size,
              has_next_page: i + 1 < paginas.length,
              next_offset: i + 1 < paginas.length ? (i + 1) * 100 : null,
              next: '',
            }),
          );
        },
        getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
          ops.push(`get_item_base_info:${String(p.itemIds.length)}`);
          relogio.t += passo;
          return Promise.resolve(
            shopeeItemBaseInfoPayloadSchema.parse({
              item_list: p.itemIds.map((id) => porId.get(id)).filter((b) => b !== undefined),
            }),
          );
        },
      } as unknown as ShopeeClient;
      return { busca: { client, nowMs: AGORA }, ops, relogio };
    }

    /** The route's controls on THAT clock, with the request deadline `AGORA + MARGEM + k`. */
    function noPrazo(relogio: { t: number }, k: number): ControlesDaPublicacaoAoVivo {
      return controles({
        agora: () => relogio.t,
        prazoDaRequisicao: AGORA + MARGEM_ENVIO_SHOPEE_MS + k,
      });
    }

    /** One definite hit (SKU equal, created in the window) FIRST, then `outros` rows of another SKU. */
    function umAchadoE(outros: number): Json[] {
      return [
        baseDe(ITEM_NOSSO),
        ...Array.from({ length: outros }, (_v, i) =>
          baseDe(ITEM_NOSSO + 1_000 + i, { item_sku: 'OUTRO-SKU' }),
        ),
      ];
    }

    async function cortada(
      db: FakeDb,
      busca: BuscaDaCriacaoIncerta,
      c: ControlesDaPublicacaoAoVivo,
    ): Promise<ConflitoDeRascunhoShopeeError> {
      const err = await conflitoDe(reservar(asDb(db), ALVO, c, busca));
      expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.publicacaoExpirada);
      expect(err.message).toContain('a busca não coube no tempo desta requisição');
      expect(err.message).toContain('Nada foi enviado');
      // The lock handed back, the RECORD kept: the draft still reads `incerta`.
      expect(doc(db)).toMatchObject({
        item_id: null,
        publicacaoEmCurso: null,
        criacaoIncertaDesde: DESDE_VELHO,
      });
      return err;
    }

    it('a FRONTEIRA na reserva: agora + MARGEM == prazo ⇒ 409 PUBLICACAO_EXPIRADA antes da 1ª página — ZERO chamadas', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto());
      const loja = lojaNoRelogio([umAchadoE(0)], 0);

      await cortada(db, loja.busca, noPrazo(loja.relogio, 0));

      expect(loja.ops).toEqual([]);
    });

    it('⛔ NEAR-MISS da fronteira: um ms antes (agora + MARGEM == prazo − 1) ⇒ a busca roda inteira e ADOTA', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto());
      const loja = lojaNoRelogio([umAchadoE(0)], 0);

      const r = await reservar(asDb(db), ALVO, noPrazo(loja.relogio, 1), loja.busca);

      expect(r).toEqual({ tipo: 'adotada', itemId: ITEM_NOSSO });
      expect(loja.ops).toEqual(['get_item_list', 'get_item_base_info:1']);
    });

    it('o prazo acaba DEPOIS da página k ⇒ para em k (k = 2 de 3), nenhum base-info, 409, o registro fica', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto());
      const loja = lojaNoRelogio([umAchadoE(0), [baseDe(ITEM_OUTRO)], [baseDe(ITEM_OUTRO + 1)]]);

      await cortada(db, loja.busca, noPrazo(loja.relogio, 2));

      expect(loja.ops).toEqual(['get_item_list', 'get_item_list']);
    });

    it('⛔ o prazo acaba ENTRE dois lotes de base-info ⇒ 409 e NENHUMA decisão — nem sobre o achado DEFINITIVO do 1º lote', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto());
      // 51 candidates ⇒ two chunks (50 + 1); the definite hit is in chunk 1.
      const loja = lojaNoRelogio([umAchadoE(SHOPEE_ITEM_BASE_INFO_MAX_IDS)]);

      await cortada(db, loja.busca, noPrazo(loja.relogio, 2));

      expect(loja.ops).toEqual(['get_item_list', 'get_item_base_info:50']);
      // Nothing adopted: the draft is still a draft.
      expect(doc(db)?.item_id).toBeNull();
    });

    it('⛔ NEAR-MISS: o prazo cabe as três chamadas ⇒ a busca termina como sempre e ADOTA o achado', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto());
      const loja = lojaNoRelogio([umAchadoE(SHOPEE_ITEM_BASE_INFO_MAX_IDS)]);

      const r = await reservar(asDb(db), ALVO, noPrazo(loja.relogio, 3), loja.busca);

      expect(r).toEqual({ tipo: 'adotada', itemId: ITEM_NOSSO });
      expect(loja.ops).toEqual(['get_item_list', 'get_item_base_info:50', 'get_item_base_info:1']);
    });

    it('o CLI (sem prazo de requisição): o limite é o expiraEm da trava — a mesma busca roda inteira', async () => {
      const db = comProduto(new FakeDb());
      db.seed(CAMINHO, incerto());
      const loja = lojaNoRelogio([umAchadoE(SHOPEE_ITEM_BASE_INFO_MAX_IDS)]);

      const r = await reservar(
        asDb(db),
        ALVO,
        controles({ agora: () => loja.relogio.t, prazoDaRequisicao: null }),
        loja.busca,
      );

      expect(r).toEqual({ tipo: 'adotada', itemId: ITEM_NOSSO });
    });
  });
});

describe('registrarCriacaoIncerta — o add_item INCERTO (D5)', () => {
  it('a trava é NOSSA ⇒ fica VIVA por AGUARDAR (mesmo token e desde) e o registro = o desde dela; responde a espera', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const ACEITO = r.desde + 12_345;

    const aguardar = await registrarCriacaoIncerta(asDb(db), r, { agora: () => ACEITO });

    expect(aguardar).toBe(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS);
    expect(doc(db)).toMatchObject({
      publicacaoEmCurso: {
        desde: r.desde,
        token: r.token,
        expiraEm: ACEITO + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
      },
      criacaoIncertaDesde: r.desde,
    });
    expect(doc(db)).not.toHaveProperty('falhaPublicacao');
    expect(r.fase).toBe('encerrada');
    // ONE guarded update.
    expect(db.patches.filter((p) => p.path === CAMINHO)).toHaveLength(1);
  });

  it('⛔ um registro MAIS CEDO fica (stored ?? lock.desde) — nunca movido para depois', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(
      CAMINHO,
      rascunho({ publicacaoEmCurso: travaDa(r), criacaoIncertaDesde: r.desde - 900_000 }),
    );

    await registrarCriacaoIncerta(asDb(db), r, { agora: () => r.desde + 1 });

    expect(doc(db)?.criacaoIncertaDesde).toBe(r.desde - 900_000);
  });

  it('(batch-A review) o SKU que a tentativa ENVIOU — o carimbo da trava — vai para criacaoIncertaSku na MESMA escrita', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: { ...travaDa(r), sku: 'SKU-1' } }));

    await registrarCriacaoIncerta(asDb(db), r, { agora: () => r.desde + 1 });

    expect(doc(db)).toMatchObject({
      publicacaoEmCurso: { sku: 'SKU-1' },
      criacaoIncertaDesde: r.desde,
      criacaoIncertaSku: 'SKU-1',
    });
    expect(db.patches.filter((p) => p.path === CAMINHO)).toHaveLength(1);
  });

  it.each([
    ['o registro anterior enviou o MESMO SKU ⇒ fica', 'SKU-1', 'SKU-1', 'SKU-1'],
    ['o registro anterior enviou OUTRO ⇒ desconhecido (null)', 'SKU-0', 'SKU-1', null],
    ["o anterior enviou '' e este 'SKU-1' ⇒ desconhecido (null)", '', 'SKU-1', null],
    ['o registro anterior é de SKU DESCONHECIDO ⇒ continua desconhecido', undefined, 'SKU-1', null],
    ['a trava nunca carimbou (sem `sku`) ⇒ desconhecido', 'SKU-1', undefined, null],
  ] as const)(
    '⛔ duas tentativas no registro: %s',
    async (_nome, skuDoRegistro, skuDaTrava, esperado) => {
      const db = new FakeDb();
      const r = reservaDe();
      db.seed(
        CAMINHO,
        rascunho({
          publicacaoEmCurso: {
            ...travaDa(r),
            ...(skuDaTrava === undefined ? {} : { sku: skuDaTrava }),
          },
          criacaoIncertaDesde: r.desde - 900_000,
          ...(skuDoRegistro === undefined ? {} : { criacaoIncertaSku: skuDoRegistro }),
        }),
      );

      await registrarCriacaoIncerta(asDb(db), r, { agora: () => r.desde + 1 });

      expect(doc(db)?.criacaoIncertaDesde).toBe(r.desde - 900_000);
      expect(doc(db)?.criacaoIncertaSku).toBe(esperado);
    },
  );

  it('⛔ (K1-14) a trava é de OUTRA execução ⇒ NADA gravado, e a espera responde mesmo assim', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    const alheia = travaAlheia(AGORA + 100_000);
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: alheia }));

    expect(await registrarCriacaoIncerta(asDb(db), r, { agora: () => AGORA })).toBe(
      AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
    );
    expect(db.writes).toEqual([]);
    expect(doc(db)?.publicacaoEmCurso).toEqual(alheia);
    expect(r.fase).toBe('encerrada');
  });

  it('a leitura ÚNICA depois do registro: em-andamento (aposIncerteza) até o fim da espera, então incerta — com a janela no desde', async () => {
    const db = new FakeDb();
    const r = reservaDe();
    db.seed(CAMINHO, rascunho({ publicacaoEmCurso: travaDa(r) }));
    const ACEITO = r.desde + 5_000;
    await registrarCriacaoIncerta(asDb(db), r, { agora: () => ACEITO });
    const fim = ACEITO + AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS;

    expect(estadoPublicacaoRascunhoShopee(doc(db) ?? null, fim - 1)).toMatchObject({
      tipo: 'em-andamento',
      aposIncerteza: true,
      aguardarMs: 1,
    });
    expect(estadoPublicacaoRascunhoShopee(doc(db) ?? null, fim)).toEqual({
      tipo: 'incerta',
      desdeMs: r.desde,
    });
  });
});

describe('reivindicarRascunhoShopee — o registro da criação incerta (P5)', () => {
  it('a reivindicação ZERA criacaoIncertaDesde junto com a trava: o anúncio está gravado', async () => {
    const db = new FakeDb();
    db.seed(
      CAMINHO,
      rascunho({ publicacaoEmCurso: travaAlheia(AGORA + 1), criacaoIncertaDesde: AGORA - 5 }),
    );

    await reivindicarRascunhoShopee(
      asDb(db),
      { produtoId: PRODUTO, linkDocId: RASCUNHO, itemId: ITEM_NOSSO },
      () => ({ contaProdutoShopeeOuterRef: REF_CONTA, item_id: ITEM_NOSSO }),
    );

    expect(doc(db)).toMatchObject({
      item_id: ITEM_NOSSO,
      publicacaoEmCurso: null,
      criacaoIncertaDesde: null,
      criacaoIncertaSku: null,
    });
  });
});

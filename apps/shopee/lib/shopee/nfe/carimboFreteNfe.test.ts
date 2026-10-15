import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@delfrance/data/testing';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  ESTADOS_FRETE_IGNORAR_REMOCAO,
  ESTADOS_FRETE_NAO_POSTADO,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
  type EstadoFrete,
} from '@delfrance/schemas';

import type { PacoteObservadoShopee } from '../pedidos/fretePushShopee';
import { ESTADOS_FRETE_SHOPEE_TERMINAL } from '../pedidos/freteShopeeMapping';
import { salvarFreteShopee } from '../pedidos/freteTx';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  ESTADOS_FRETE_CARIMBAVEIS_NFE,
  carimbarFreteNfeShopee,
  preverCarimboNfeShopee,
  type MotivoCarimbo,
} from './carimboFreteNfe';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, order or buyer.  */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;

const NOW_US = 1_789_000_000_000_000;
const ORDEM_US = NOW_US - 60_000_000;
const FRETE_US = NOW_US - 30_000_000;

/** A diary row as step 7 writes it — visibly fake package number. */
const PACOTE = {
  numero: 'PKG-TESTE-1',
  estado: ESTADO_FRETE.despachoAutorizado,
  estadoMarketplace: 'LOGISTICS_READY',
  codRastreio: null,
  canalId: null,
  prazoDespacho: null,
  atualizadoEm: FRETE_US,
  fonte: 'get_package_detail',
};

/** A `freteInicial` exactly as step 5 seeds it, owned by the channel. */
function bloco(over: Record<string, unknown> = {}): Record<string, unknown> {
  return freteDoPedidoSchema.parse({
    ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
    externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
    estado: ESTADO_FRETE.despachoAutorizado,
    codRastreio: 'RASTREIO-DE-TESTE',
    ultimaModificacao: FRETE_US,
    pacotes: [PACOTE],
    // A passthrough field nothing in the schema names — the whole-map rebuild
    // must carry it, not only the fields someone remembered.
    campoLegadoQualquer: 'fica',
    ...over,
  }) as Record<string, unknown>;
}

function pedidoCru(frete: unknown, extra: DocData = {}): DocData {
  return {
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    itens: {},
    itensIds: [],
    valorCobrado: 31.99,
    lastMarketplaceUpdate: ORDEM_US,
    hasUserInteraction: false,
    ultimaModificacao: NOW_US - 5_000_000,
    freteInicial: frete,
    ...extra,
  };
}

function dbCom(frete: unknown, extra: DocData = {}): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, pedidoCru(frete, extra));
  return db;
}

function carimbar(db: FakeDb, nowUs = NOW_US): Promise<MotivoCarimbo> {
  return carimbarFreteNfeShopee(asDb(db), PEDIDO_ID, nowUs);
}

function doc(db: FakeDb): DocData {
  return db.store[PEDIDO_PATH]!.data;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                              the stampable set                              */
/* -------------------------------------------------------------------------- */

describe('ESTADOS_FRETE_CARIMBAVEIS_NFE — derivado, e os 8 membros fixados', () => {
  it('são EXATAMENTE os oito de NAO_POSTADO ∖ REMOVE_ESTOQUE ∖ SHOPEE_TERMINAL (uma mudança a montante fica vermelha)', () => {
    // ⚠️ A literal list, deliberately: the module derives the set, this test
    // pins what the derivation produced on the day it was reviewed. A set
    // widened upstream reds HERE instead of silently stamping a new estado.
    expect([...ESTADOS_FRETE_CARIMBAVEIS_NFE].sort()).toEqual(
      [
        ESTADO_FRETE.iniciado,
        ESTADO_FRETE.aguardandoAutorizacao,
        ESTADO_FRETE.aguardandoNFe,
        ESTADO_FRETE.aguardandoValidacaoTransporadora,
        ESTADO_FRETE.despachoAutorizado,
        ESTADO_FRETE.emSeparacao,
        ESTADO_FRETE.desconhecido,
        ESTADO_FRETE.aguardandoAgendamento,
      ].sort(),
    );
  });

  it('é a diferença recomputada aqui — e os dois excluídos de NAO_POSTADO são empacotado e despachoNegado', () => {
    const recomputado = [...ESTADOS_FRETE_NAO_POSTADO].filter(
      (e) => !ESTADOS_FRETE_REMOVE_ESTOQUE.has(e) && !ESTADOS_FRETE_SHOPEE_TERMINAL.has(e),
    );
    expect([...ESTADOS_FRETE_CARIMBAVEIS_NFE].sort()).toEqual(recomputado.sort());
    const excluidos = [...ESTADOS_FRETE_NAO_POSTADO].filter(
      (e) => !ESTADOS_FRETE_CARIMBAVEIS_NFE.has(e),
    );
    expect(excluidos.sort()).toEqual([ESTADO_FRETE.empacotado, ESTADO_FRETE.despachoNegado].sort());
  });

  it('é disjunto de REMOVE_ESTOQUE e não contém error — o carimbo é neutro para o estoque', () => {
    for (const e of ESTADOS_FRETE_CARIMBAVEIS_NFE) {
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(e), e).toBe(false);
      expect(ESTADOS_FRETE_SHOPEE_TERMINAL.has(e), e).toBe(false);
    }
    expect(ESTADOS_FRETE_CARIMBAVEIS_NFE.has(ESTADO_FRETE.error)).toBe(false);
    // The written value itself never drives a stock movement.
    expect(ESTADOS_FRETE_IGNORAR_REMOCAO.has(ESTADO_FRETE.error)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                         the pure decision — guard table                     */
/* -------------------------------------------------------------------------- */

describe('preverCarimboNfeShopee — a tabela de guardas', () => {
  it('cada EstadoFrete: os 8 carimbam, error é ja-carimbado, TODO o resto é fora-do-escopo', () => {
    for (const estado of Object.values(ESTADO_FRETE) as EstadoFrete[]) {
      const { motivo, patch } = preverCarimboNfeShopee(pedidoCru(bloco({ estado })), NOW_US);
      const esperado: MotivoCarimbo =
        estado === ESTADO_FRETE.error
          ? 'ja-carimbado'
          : ESTADOS_FRETE_CARIMBAVEIS_NFE.has(estado)
            ? 'carimbado'
            : 'fora-do-escopo';
      expect({ estado, motivo }).toEqual({ estado, motivo: esperado });
      expect(patch === null, estado).toBe(esperado !== 'carimbado');
    }
  });

  it('⚠️ NUNCA sobre empacotado / aguardandoPostagem / cancelado / nada depois do despacho', () => {
    for (const estado of [
      ESTADO_FRETE.empacotado,
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.checkFinalizado,
      ESTADO_FRETE.postado,
      ESTADO_FRETE.entregue,
      ESTADO_FRETE.cancelado,
      ESTADO_FRETE.despachoNegado,
      ESTADO_FRETE.devolvido,
      ESTADO_FRETE.fulfillment,
      ESTADO_FRETE.aguardandoRetirada,
    ]) {
      expect(preverCarimboNfeShopee(pedidoCru(bloco({ estado })), NOW_US), estado).toEqual({
        motivo: 'fora-do-escopo',
        patch: null,
      });
    }
  });

  it('sem-pedido: o pedido não existe', () => {
    expect(preverCarimboNfeShopee(null, NOW_US)).toEqual({ motivo: 'sem-pedido', patch: null });
  });

  it('sem-frete: freteInicial nulo, ausente, array ou escalar — nunca cria um bloco', () => {
    for (const frete of [null, undefined, [], 'shopee', 42]) {
      expect(preverCarimboNfeShopee(pedidoCru(frete), NOW_US), String(frete)).toEqual({
        motivo: 'sem-frete',
        patch: null,
      });
    }
  });

  it("PAR + NEAR-MISS do dono: 'shopee' carimba; outra integradora, dono ausente e 'Shopee' recusam", () => {
    expect(preverCarimboNfeShopee(pedidoCru(bloco()), NOW_US).motivo).toBe('carimbado');
    for (const dono of [
      INTEGRACAO_FRETE.mercadoLivre,
      INTEGRACAO_FRETE.melhorEnvios,
      null,
      'Shopee',
    ]) {
      expect(
        preverCarimboNfeShopee(pedidoCru({ ...bloco(), externalOptionIntegracao: dono }), NOW_US),
        String(dono),
      ).toEqual({ motivo: 'outra-integradora', patch: null });
    }
    const semDono = { ...bloco() };
    delete semDono.externalOptionIntegracao;
    expect(preverCarimboNfeShopee(pedidoCru(semDono), NOW_US).motivo).toBe('outra-integradora');
  });

  it("estado-ilegivel: um estado que não é membro (ausente, 'ERROR', número) não é carimbado", () => {
    for (const estado of [undefined, null, 'ERROR', 'Error', 7]) {
      expect(
        preverCarimboNfeShopee(pedidoCru({ ...bloco(), estado }), NOW_US),
        String(estado),
      ).toEqual({ motivo: 'estado-ilegivel', patch: null });
    }
  });

  it('a ordem das guardas: dono antes de ja-carimbado — um error de OUTRA integradora não é nosso replay', () => {
    const alheio = { ...bloco({ estado: ESTADO_FRETE.error }), externalOptionIntegracao: 'fob' };
    expect(preverCarimboNfeShopee(pedidoCru(alheio), NOW_US).motivo).toBe('outra-integradora');
  });

  it('todos os MotivoCarimbo são alcançáveis pela tabela acima', () => {
    const vistos = new Set<MotivoCarimbo>([
      preverCarimboNfeShopee(null, NOW_US).motivo,
      preverCarimboNfeShopee(pedidoCru(null), NOW_US).motivo,
      preverCarimboNfeShopee(pedidoCru({ ...bloco(), externalOptionIntegracao: null }), NOW_US)
        .motivo,
      preverCarimboNfeShopee(pedidoCru(bloco({ estado: ESTADO_FRETE.error })), NOW_US).motivo,
      preverCarimboNfeShopee(pedidoCru({ ...bloco(), estado: 'ERROR' }), NOW_US).motivo,
      preverCarimboNfeShopee(pedidoCru(bloco({ estado: ESTADO_FRETE.postado })), NOW_US).motivo,
      preverCarimboNfeShopee(pedidoCru(bloco()), NOW_US).motivo,
    ]);
    // A Record over the union: a motivo added to the type without a case here
    // fails typecheck, and one listed here but unreachable fails the size check.
    const todos: Record<MotivoCarimbo, true> = {
      carimbado: true,
      'sem-pedido': true,
      'sem-frete': true,
      'outra-integradora': true,
      'ja-carimbado': true,
      'estado-ilegivel': true,
      'fora-do-escopo': true,
    };
    expect([...vistos].sort()).toEqual(Object.keys(todos).sort());
  });
});

/* -------------------------------------------------------------------------- */
/*                         the pure decision — the patch                       */
/* -------------------------------------------------------------------------- */

describe('preverCarimboNfeShopee — o patch', () => {
  it('reconstrói o MAPA INTEIRO: pacotes, codRastreio, freteInicial.ultimaModificacao e o campo passthrough ficam', () => {
    const armazenado = bloco();
    const previsao = preverCarimboNfeShopee(pedidoCru(armazenado), NOW_US);
    expect(previsao.motivo).toBe('carimbado');
    expect(previsao.patch!.freteInicial).toEqual({ ...armazenado, estado: ESTADO_FRETE.error });
    expect(previsao.patch!.freteInicial.pacotes).toEqual(armazenado.pacotes);
    expect(previsao.patch!.freteInicial.codRastreio).toBe('RASTREIO-DE-TESTE');
    expect(previsao.patch!.freteInicial.ultimaModificacao).toBe(FRETE_US);
    expect(previsao.patch!.freteInicial.campoLegadoQualquer).toBe('fica');
  });

  it('⚠️ o patch tem EXATAMENTE freteInicial + ultimaModificacao — nunca o relógio da ordem, nunca o flag do operador', () => {
    const { patch } = preverCarimboNfeShopee(pedidoCru(bloco()), NOW_US);
    expect(Object.keys(patch!).sort()).toEqual(['freteInicial', 'ultimaModificacao']);
    expect(patch).not.toHaveProperty('lastMarketplaceUpdate');
    expect(patch).not.toHaveProperty('hasUserInteraction');
  });

  it('não muta o documento lido — o bloco é reconstruído por spread', () => {
    const raw = pedidoCru(bloco());
    const antes = structuredClone(raw);
    preverCarimboNfeShopee(raw, NOW_US);
    expect(raw).toEqual(antes);
  });

  it('µs PAR: o relógio armazenado ATRÁS de nowUs perde; À FRENTE ganha (maiorUs)', () => {
    const atras = preverCarimboNfeShopee(
      pedidoCru(bloco(), { ultimaModificacao: NOW_US - 1 }),
      NOW_US,
    );
    expect(atras.patch!.ultimaModificacao).toBe(NOW_US);

    const aFrente = preverCarimboNfeShopee(
      pedidoCru(bloco(), { ultimaModificacao: NOW_US + 7_000_000 }),
      NOW_US,
    );
    expect(aFrente.patch!.ultimaModificacao).toBe(NOW_US + 7_000_000);

    // Equal stamps: either reading is the same number, and it is never lowered.
    const igual = preverCarimboNfeShopee(pedidoCru(bloco(), { ultimaModificacao: NOW_US }), NOW_US);
    expect(igual.patch!.ultimaModificacao).toBe(NOW_US);
  });

  it('µs NEAR-MISS: um legado em MILISSEGUNDOS à frente é lido como µs e ganha — nunca comparado cru', () => {
    // 9 s ahead of `nowUs`, stored in ms as the legacy corpus does. Compared RAW
    // (1.789e12 < 1.789e15) it would lose and the watermark would move BACKWARD
    // relative to the stored instant; through `coerceToMicros` it wins.
    const legadoMs = NOW_US / 1000 + 9_000;
    const { patch } = preverCarimboNfeShopee(
      pedidoCru(bloco(), { ultimaModificacao: legadoMs }),
      NOW_US,
    );
    expect(patch!.ultimaModificacao).toBe(NOW_US + 9_000_000);
    expect(patch!.ultimaModificacao).not.toBe(NOW_US);
  });

  it('µs: uma string ISO legada à frente também é lida; ausente ou ilegível ⇒ nowUs', () => {
    const iso = new Date((NOW_US + 3_000_000) / 1000).toISOString();
    expect(
      preverCarimboNfeShopee(pedidoCru(bloco(), { ultimaModificacao: iso }), NOW_US).patch!
        .ultimaModificacao,
    ).toBe(NOW_US + 3_000_000);
    for (const v of [undefined, null, 'não é data']) {
      expect(
        preverCarimboNfeShopee(pedidoCru(bloco(), { ultimaModificacao: v }), NOW_US).patch!
          .ultimaModificacao,
        String(v),
      ).toBe(NOW_US);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               the transaction                               */
/* -------------------------------------------------------------------------- */

describe('carimbarFreteNfeShopee — a transação', () => {
  it('carimbado: UM update, o bloco inteiro preservado, o resto do pedido intacto', async () => {
    const armazenado = bloco();
    const db = dbCom(armazenado);

    expect(await carimbar(db)).toBe('carimbado');

    expect(db.opLog).toEqual([
      { op: 'get', path: PEDIDO_PATH },
      { op: 'update', path: PEDIDO_PATH },
    ]);
    expect(db.writes).toHaveLength(1);
    const frete = doc(db).freteInicial as Record<string, unknown>;
    expect(frete).toEqual({ ...armazenado, estado: ESTADO_FRETE.error });
    expect(frete.pacotes).toEqual(armazenado.pacotes);
    expect(frete.campoLegadoQualquer).toBe('fica');
    expect(doc(db).ultimaModificacao).toBe(NOW_US);
    // Step 5's order clock and the operator flag are untouched.
    expect(doc(db).lastMarketplaceUpdate).toBe(ORDEM_US);
    expect(doc(db).hasUserInteraction).toBe(false);
    expect(Object.keys(db.patches[0]!.patch).sort()).toEqual(['freteInicial', 'ultimaModificacao']);
  });

  it('⚠️ ja-carimbado: o REPLAY não escreve NADA — opLog só com o get', async () => {
    const db = dbCom(bloco());
    expect(await carimbar(db)).toBe('carimbado');
    const depois = structuredClone(doc(db));
    db.writes.length = 0;
    db.patches.length = 0;
    db.opLog.length = 0;

    expect(await carimbar(db, NOW_US + 60_000_000)).toBe('ja-carimbado');

    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    expect(db.writes).toEqual([]);
    // Not even the watermark moved on the replay.
    expect(doc(db)).toEqual(depois);
  });

  it('ja-carimbado sobre um error armazenado de antes: zero escritas', async () => {
    const db = dbCom(bloco({ estado: ESTADO_FRETE.error }));
    expect(await carimbar(db)).toBe('ja-carimbado');
    expect(db.writes).toEqual([]);
  });

  it('outra-integradora: zero escritas', async () => {
    const db = dbCom(bloco({ externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre }));
    expect(await carimbar(db)).toBe('outra-integradora');
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
  });

  it('sem-pedido: zero escritas e nenhum pedido criado', async () => {
    const db = new FakeDb();
    expect(await carimbar(db)).toBe('sem-pedido');
    expect(db.writes).toEqual([]);
    expect(db.store[PEDIDO_PATH]).toBeUndefined();
  });

  it('sem-frete / estado-ilegivel / fora-do-escopo: zero escritas', async () => {
    const casos: [unknown, MotivoCarimbo][] = [
      [null, 'sem-frete'],
      [{ ...bloco(), estado: 'ERROR' }, 'estado-ilegivel'],
      [bloco({ estado: ESTADO_FRETE.aguardandoPostagem }), 'fora-do-escopo'],
    ];
    for (const [frete, motivo] of casos) {
      const db = dbCom(frete);
      expect(await carimbar(db), motivo).toBe(motivo);
      expect(db.writes, motivo).toEqual([]);
    }
  });

  it('o relógio armazenado À FRENTE ganha também no documento gravado', async () => {
    const db = dbCom(bloco(), { ultimaModificacao: NOW_US + 7_000_000 });
    expect(await carimbar(db)).toBe('carimbado');
    expect(doc(db).ultimaModificacao).toBe(NOW_US + 7_000_000);
  });

  it('um erro do Firestore PROPAGA — nunca engolido', async () => {
    const db = dbCom(bloco());
    const falha = new Error('gRPC 14 UNAVAILABLE (teste)');
    db.occ.beforeCommit = () => {
      throw falha;
    };
    await expect(carimbar(db)).rejects.toBe(falha);
    expect(db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   rule 7 — the loser re-derives, with step 7                */
/* -------------------------------------------------------------------------- */

describe('regra 7 — o carimbo perde a corrida para o step 7 e RE-DERIVA', () => {
  function observado(fulfillmentStatus: string): PacoteObservadoShopee {
    return {
      packageNumber: PACOTE.numero,
      fulfillmentStatus,
      trackingNumber: null,
      shipByDateS: null,
      logisticsChannelId: null,
      updateTimeS: 1_788_973_354,
      fonte: 'get_package_detail',
    };
  }

  function rastrear(db: FakeDb, fulfillmentStatus: string) {
    return salvarFreteShopee(asDb(db), {
      pedidoId: PEDIDO_ID,
      orderSn: ORDER_SN,
      observados: [observado(fulfillmentStatus)],
      relogioDaOrdemUs: null,
      prazoDaOrdemUs: null,
      nowUs: NOW_US,
    });
  }

  it('step 7 grava aguardandoPostagem entre a leitura e o commit ⇒ UM abort, fora-do-escopo, sem carimbo', async () => {
    const db = dbCom(bloco({ pacotes: [] }));
    const chegou = deferred();
    const portao = deferred();
    let segurou = false;
    // ⚠️ The held run is identified by WHAT IT IS ABOUT TO WRITE — an `error`
    // block — never by the transaction's label.
    db.occ.beforeCommit = (ctx) => {
      const ehOCarimbo = ctx.writes.some(
        (w) =>
          ((w.data as Record<string, unknown>).freteInicial as Record<string, unknown> | undefined)
            ?.estado === ESTADO_FRETE.error,
      );
      if (!ehOCarimbo || segurou) return undefined;
      segurou = true;
      chegou.resolve();
      return portao.promise;
    };

    const runCarimbo = carimbar(db);
    await chegou.promise;
    const passo7 = await rastrear(db, 'LOGISTICS_REQUEST_CREATED');
    expect(passo7.acao).toBe('atualizado');
    portao.resolve();

    expect(await runCarimbo).toBe('fora-do-escopo');
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    const frete = doc(db).freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    // Nothing of the stamp's first attempt survived the abort.
    expect(db.writes.some((w) => JSON.stringify(w.patch).includes('"error"'))).toBe(false);
  });

  it('depois do carimbo, o step 7 o PRESERVA na rotina e o substitui quando o pacote se move de fato', async () => {
    const db = dbCom(bloco({ pacotes: [] }));
    expect(await carimbar(db)).toBe('carimbado');

    // Routine churn below the removal set: `erro-preservado`, the stamp stays.
    await rastrear(db, 'LOGISTICS_READY');
    expect((doc(db).freteInicial as Record<string, unknown>).estado).toBe(ESTADO_FRETE.error);

    // A physical fact (into REMOVE_ESTOQUE): step 7 overwrites it.
    const moveu = await rastrear(db, 'LOGISTICS_REQUEST_CREATED');
    expect(moveu.acao).toBe('atualizado');
    expect((doc(db).freteInicial as Record<string, unknown>).estado).toBe(
      ESTADO_FRETE.aguardandoPostagem,
    );
  });
});

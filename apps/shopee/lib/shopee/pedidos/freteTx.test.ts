import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coerceToMicros } from '@delfrance/core/datetime';
import { deferred } from '@delfrance/data/testing';
import {
  CAPTURA_COMPRADOR_ESTADO,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  pacoteFreteSchema,
  seedFreteInicial,
  transportadoraSchema,
  type FreteDoPedido,
} from '@delfrance/schemas';
import {
  shopeePackageDetailRowSchema,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  observadoDoPacoteDetalhe,
  observadosDoDetalheDoPedido,
  type PacoteObservadoShopee,
} from './fretePushShopee';
import { MOTIVO_FRETE_SHOPEE } from './freteShopeeMapping';
import { preverFreteShopee, salvarFreteShopee } from './freteTx';
import { makeItemEnsureUniqueId, makePedidoIdShopee } from './orderIds';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import {
  mapearPedidoShopee,
  microsDeSegundosShopee,
  segundosShopeeUtilizaveis,
  type PedidoMapeadoShopee,
} from './orderMapping';
import { salvarPedidoShopee } from './orderPedidoTx';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, order or buyer.  */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;

/** The `__wire__` SG order's own package, and the doc page's sibling. */
const PKG_A = 'OFG199593509207187';
const PKG_B = 'OFG242672552205937';

const UPDATE_TIME_S = 1_788_973_354;
/** Two package clocks in wire SECONDS, strictly increasing. */
const T1_S = UPDATE_TIME_S;
const T2_S = UPDATE_TIME_S + 3_600;
const NOW_US = 1_789_000_000_000_000;
const WATERMARK_US = microsDeSegundosShopee(UPDATE_TIME_S);

function detalheSG(): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
}

function obs(over: Partial<PacoteObservadoShopee> = {}): PacoteObservadoShopee {
  return {
    packageNumber: PKG_A,
    fulfillmentStatus: 'LOGISTICS_REQUEST_CREATED',
    trackingNumber: null,
    shipByDateS: null,
    logisticsChannelId: null,
    updateTimeS: T1_S,
    fonte: 'get_package_detail',
    ...over,
  };
}

/** A `freteInicial` exactly as step 5 seeds it, plus whatever the case needs. */
function blocoDeFrete(over: Record<string, unknown> = {}): FreteDoPedido {
  return freteDoPedidoSchema.parse({
    ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
    externalOptionIntegracao: 'shopee',
    prazoDespacho: microsDeSegundosShopee(1_789_405_354),
    ...over,
  });
}

function pedidoComFrete(frete: unknown, extra: DocData = {}): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, {
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    itens: {},
    itensIds: [],
    valorCobrado: 31.99,
    lastMarketplaceUpdate: WATERMARK_US,
    ultimaModificacao: NOW_US - 5_000_000,
    freteInicial: frete,
    ...extra,
  });
  return db;
}

function salvar(
  db: FakeDb,
  observados: readonly PacoteObservadoShopee[],
  over: { relogioDaOrdemUs?: number | null; prazoDaOrdemUs?: number | null; nowUs?: number } = {},
) {
  return salvarFreteShopee(asDb(db), {
    pedidoId: PEDIDO_ID,
    orderSn: ORDER_SN,
    observados,
    relogioDaOrdemUs: over.relogioDaOrdemUs ?? null,
    prazoDaOrdemUs: over.prazoDaOrdemUs ?? null,
    nowUs: over.nowUs ?? NOW_US,
  });
}

function freteGravado(db: FakeDb): Record<string, unknown> {
  return db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
}

function diarioGravado(db: FakeDb): Record<string, unknown>[] {
  return (freteGravado(db).pacotes ?? []) as Record<string, unknown>[];
}

const avisos: unknown[][] = [];
const infos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  avisos.length = 0;
  infos.length = 0;
});

/* -------------------------------------------------------------------------- */
/*                        19/20 — what it REFUSES to create                    */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — nunca cria nada', () => {
  it('19 — sem pedido: `ignorado-sem-pedido`, zero escritas, opLog só com o get', async () => {
    const db = new FakeDb();

    const r = await salvar(db, [obs()]);

    expect(r.acao).toBe('ignorado-sem-pedido');
    expect(r.campos).toEqual([]);
    expect(r.pacotes).toBe(0);
    expect(db.writes).toEqual([]);
    // ⚠️ The whole op log, not merely "no create": step 5 owns creation and this
    // transaction must leave a pedido-shaped hole exactly where it found one.
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    expect(db.store[PEDIDO_PATH]).toBeUndefined();
  });

  it('20 — pedido SEM freteInicial: `ignorado-sem-frete-inicial`, zero escritas', async () => {
    const db = pedidoComFrete(undefined);

    const r = await salvar(db, [obs()]);

    expect(r.acao).toBe('ignorado-sem-frete-inicial');
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    // ÂNCORA: the same delivery over a pedido that HAS a block does write, so
    // this outcome is the missing block and not a broken fixture.
    const comBloco = pedidoComFrete(blocoDeFrete());
    expect((await salvar(comBloco, [obs()])).acao).toBe('atualizado');
  });

  it('20 — um freteInicial que não é um objeto (null, string, array) recusa igual', async () => {
    for (const valor of [null, 'iniciado', [1, 2]]) {
      const db = pedidoComFrete(valor);
      const r = await salvar(db, [obs()]);
      expect(r.acao).toBe('ignorado-sem-frete-inicial');
      expect(db.writes).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       21/22 — the first write, and the replay               */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — a primeira entrega e o replay', () => {
  it('21 — LOGISTICS_REQUEST_CREATED escreve estado + diário e NADA mais', async () => {
    const db = pedidoComFrete(blocoDeFrete());

    const r = await salvar(db, [obs()]);

    expect(r.acao).toBe('atualizado');
    expect(r.estadoEscrito).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(r.motivoEstado).toBeNull();
    expect(r.pacotes).toBe(1);
    // ⚠️ EXACTLY these two: the observation carries no tracking number, no
    // channel and no deadline, so the other three fields are "nothing to say"
    // and the rebuild must not assign them.
    expect(r.campos).toEqual(['freteInicial.estado', 'freteInicial.pacotes']);

    const frete = freteGravado(db);
    expect(frete.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(diarioGravado(db)).toEqual([
      {
        numero: PKG_A,
        estado: ESTADO_FRETE.aguardandoPostagem,
        estadoMarketplace: 'LOGISTICS_REQUEST_CREATED',
        codRastreio: null,
        canalId: null,
        prazoDespacho: null,
        atualizadoEm: microsDeSegundosShopee(T1_S),
        fonte: 'get_package_detail',
      },
    ]);
    // …and the step-5 fields it must not have touched.
    expect(frete.prazoDespacho).toBe(microsDeSegundosShopee(1_789_405_354));
    expect(frete.codRastreio).toBeNull();
  });

  it('22 — o replay BYTE-IDÊNTICO não escreve nada, nem com outro nowUs', async () => {
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs()]);
    const antes = structuredClone(db.store[PEDIDO_PATH]!.data);
    db.writes.length = 0;
    db.patches.length = 0;
    db.opLog.length = 0;

    // ⚠️ A DIFFERENT wall clock: if `ultimaModificacao` were appended before the
    // empty check, this alone would write on every replay, for ever.
    const r = await salvar(db, [obs()], { nowUs: NOW_US + 900_000_000 });

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.campos).toEqual([]);
    // The op log beyond the read is EMPTY — `opLog` records writes at STAGING
    // time, so a staged-and-discarded write would still be visible here.
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    expect(db.writes).toEqual([]);
    expect(db.store[PEDIDO_PATH]!.data).toEqual(antes);
  });

  it('22 — QUASE-ERRO: dois tokens que PROJETAM o mesmo estado ainda são uma mudança', async () => {
    // ⚠️ O escopo do fold (#1372). `estadoMarketplace` é a FONTE DA VERDADE e
    // `estado` é a projeção: `LOGISTICS_REQUEST_CREATED` e
    // `LOGISTICS_PICKUP_RETRY` caem os dois em `aguardandoPostagem`, com o MESMO
    // relógio, então a única coisa que muda na linha é o token cru. Uma
    // comparação que só olhasse a projeção escreveria NADA — e a correção da
    // tabela de amanhã se aplicaria a um token que nunca foi gravado.
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs()]);
    db.writes.length = 0;

    const r = await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_RETRY' })]);

    expect(r.acao).toBe('atualizado');
    // O estado do bloco NÃO está em `campos` — ele não mudou.
    expect(r.campos).toEqual(['freteInicial.pacotes']);
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(diarioGravado(db)[0]!.estadoMarketplace).toBe('LOGISTICS_PICKUP_RETRY');
    expect(diarioGravado(db)[0]!.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    // O relógio é o MESMO dos dois lados — é o token, e só ele, que fez a escrita.
    expect(diarioGravado(db)[0]!.atualizadoEm).toBe(microsDeSegundosShopee(T1_S));
  });

  it('22 — QUASE-ERRO: o mesmo pacote com um TOKEN novo escreve', async () => {
    // The anchor for the replay above: the comparison is not constant.
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs()]);
    db.writes.length = 0;

    const r = await salvar(db, [
      obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T2_S }),
    ]);

    expect(r.acao).toBe('atualizado');
    expect(r.estadoEscrito).toBe(ESTADO_FRETE.postado);
    expect(r.campos).toEqual(['freteInicial.estado', 'freteInicial.pacotes']);
    expect(db.writes).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                   23/24 — the freshness gate and the ladder                 */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — o evento ATRASADO', () => {
  /** A pedido whose package was already delivered at T2. */
  function pedidoEntregue(): FakeDb {
    return pedidoComFrete(
      blocoDeFrete({
        estado: ESTADO_FRETE.entregue,
        pacotes: [
          pacoteFreteSchema.parse({
            numero: PKG_A,
            estado: ESTADO_FRETE.entregue,
            estadoMarketplace: 'LOGISTICS_DELIVERY_DONE',
            atualizadoEm: microsDeSegundosShopee(T2_S),
            fonte: 'get_package_detail',
          }),
        ],
      }),
    );
  }

  it('23 — relógio armazenado mais NOVO ⇒ `ignorado-obsoleto`, zero escritas', async () => {
    const db = pedidoEntregue();

    const r = await salvar(db, [
      obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T1_S }),
    ]);

    expect(r.acao).toBe('ignorado-obsoleto');
    expect(r.campos).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.entregue);

    // The dropped package NUMBER is named — the diagnostics carry it, and so
    // does the one log line, so an operator can see WHICH parcel was dropped.
    const previsao = preverFreteShopee(db.store[PEDIDO_PATH]!.data, {
      orderSn: ORDER_SN,
      observados: [obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T1_S })],
      relogioDaOrdemUs: null,
      prazoDaOrdemUs: null,
      nowUs: NOW_US,
    });
    expect(previsao.diagnosticos.obsoletos).toEqual([PKG_A]);
    const linhaDoLog = infos.find((args) => String(args[0]).includes('frete do pacote aplicado'));
    expect((linhaDoLog![1] as Record<string, unknown>).obsoletos).toEqual([PKG_A]);
  });

  it('24 — E6: a SEGUNDA rede é a escada — relógio IGUAL, e o estado ainda é recusado', async () => {
    // ⚠️ Two independent nets, and this is the one the freshness gate hides. An
    // equal clock APPLIES (Shopee's stamps have 1-second resolution), so the
    // diary really does take the older token — and the block estado is still
    // refused, because `entregue → postado` is regressive.
    const db = pedidoComFrete(
      blocoDeFrete({
        estado: ESTADO_FRETE.entregue,
        pacotes: [
          pacoteFreteSchema.parse({
            numero: PKG_A,
            estado: ESTADO_FRETE.entregue,
            estadoMarketplace: 'LOGISTICS_DELIVERY_DONE',
            atualizadoEm: microsDeSegundosShopee(T2_S),
            fonte: 'get_package_detail',
          }),
        ],
      }),
    );

    const r = await salvar(db, [
      obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T2_S }),
    ]);

    expect(r.acao).toBe('atualizado');
    expect(r.campos).toEqual(['freteInicial.pacotes']);
    expect(r.estadoEscrito).toBeNull();
    expect(r.motivoEstado).toBe(MOTIVO_FRETE_SHOPEE.regressivo);
    // The block estado stands…
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.entregue);
    // …while the diary records what the marketplace actually said.
    expect(diarioGravado(db)[0]!.estadoMarketplace).toBe('LOGISTICS_PICKUP_DONE');
  });

  it('24 — QUASE-ERRO: um relógio mais NOVO com o MESMO conteúdo não move atualizadoEm', async () => {
    // The rule that makes the backstop idempotent: the stamp follows a WIRE
    // content change, never the fact that we looked.
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs()]);
    db.writes.length = 0;

    const r = await salvar(db, [obs({ updateTimeS: T2_S })]);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(db.writes).toEqual([]);
    expect(diarioGravado(db)[0]!.atualizadoEm).toBe(microsDeSegundosShopee(T1_S));
  });
});

/* -------------------------------------------------------------------------- */
/*                    25 — `ultimaModificacao`, and where it is NOT            */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — o carimbo do pedido', () => {
  it('25 — monótono: um valor armazenado À FRENTE do nowUs não anda para trás', async () => {
    const adiante = NOW_US + 60_000_000;
    const db = pedidoComFrete(blocoDeFrete(), { ultimaModificacao: adiante });

    await salvar(db, [obs()]);

    expect(db.store[PEDIDO_PATH]!.data.ultimaModificacao).toBe(adiante);
  });

  it('25 — o lado ARMAZENADO passa por coerceToMicros: ms inteiro e string ISO', async () => {
    // The legacy corpus holds ms ints and ISO strings on this field, so the
    // stored side is coerced — and the coerced value is what the monotone
    // comparison sees.
    const msAdiante = 1_790_000_000_000;
    const db = pedidoComFrete(blocoDeFrete(), { ultimaModificacao: msAdiante });
    await salvar(db, [obs()]);
    expect(db.store[PEDIDO_PATH]!.data.ultimaModificacao).toBe(coerceToMicros(msAdiante));
    expect(coerceToMicros(msAdiante)).toBe(msAdiante * 1000);

    const iso = '2026-09-30T00:00:00.000Z';
    const db2 = pedidoComFrete(blocoDeFrete(), { ultimaModificacao: iso });
    await salvar(db2, [obs()]);
    expect(db2.store[PEDIDO_PATH]!.data.ultimaModificacao).toBe(coerceToMicros(iso));

    // ÂNCORA: a stored value BEHIND the tick yields `nowUs`, so the two cases
    // above are the comparison working and not the field being ignored.
    const db3 = pedidoComFrete(blocoDeFrete(), { ultimaModificacao: NOW_US - 1 });
    await salvar(db3, [obs()]);
    expect(db3.store[PEDIDO_PATH]!.data.ultimaModificacao).toBe(NOW_US);
  });

  it('25 — aparece SÓ num patch não vazio', async () => {
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs()]);
    expect(db.patches.at(-1)!.patch).toHaveProperty('ultimaModificacao');
    db.patches.length = 0;

    await salvar(db, [obs()]);

    expect(db.patches).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                26/27/28 — what the rebuild must carry over                  */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — a reconstrução do MAPA INTEIRO', () => {
  it('26 — nada é apagado: uma entrega que só nomeia B deixa A byte-idêntico', async () => {
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs({ packageNumber: PKG_A })]);
    const linhaA = structuredClone(diarioGravado(db).find((l) => l.numero === PKG_A));
    expect(linhaA).toBeDefined();

    const r = await salvar(db, [
      obs({ packageNumber: PKG_B, fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T2_S }),
    ]);

    expect(r.acao).toBe('atualizado');
    expect(r.pacotes).toBe(2);
    const diario = diarioGravado(db);
    expect(diario.find((l) => l.numero === PKG_A)).toEqual(linhaA);
    // …and the fold answers the LEAST-advanced live package, so the pedido does
    // not claim to be posted while parcel A is still waiting for pickup.
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.aguardandoPostagem);
  });

  it('27 — `lastMarketplaceUpdate` NUNCA aparece num patch; `freteInicial.ultimaModificacao` é o ARMAZENADO', async () => {
    // ⚠️ The nested `ultimaModificacao` cannot be ABSENT from the patch — the
    // whole map is replaced at one top-level key, so omitting it would ERASE
    // step 5's order watermark. "Never written" means never ASSIGNED, and this
    // is what that looks like: the value in the patch is the stored one.
    const carimboDaOrdem = microsDeSegundosShopee(UPDATE_TIME_S);
    const db = pedidoComFrete(blocoDeFrete({ ultimaModificacao: carimboDaOrdem }));

    await salvar(db, [obs()]);
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T2_S })]);

    expect(db.patches).toHaveLength(2);
    for (const { patch } of db.patches) {
      expect(Object.keys(patch).sort()).toEqual(['freteInicial', 'ultimaModificacao']);
      expect(Object.hasOwn(patch, 'lastMarketplaceUpdate')).toBe(false);
      expect((patch.freteInicial as Record<string, unknown>).ultimaModificacao).toBe(
        carimboDaOrdem,
      );
    }
    expect(db.store[PEDIDO_PATH]!.data.lastMarketplaceUpdate).toBe(WATERMARK_US);
  });

  it('28 — printLabelId, transportadora e uma chave DESCONHECIDA sobrevivem verbatim', async () => {
    // ⚠️ `transportadora` goes through its own schema HERE because `parseMerge`
    // validates `freteInicial` in FULL (it `.partial()`s the top-level pedido
    // schema only), so a partially-stored sub-object comes back with its own
    // defaults materialised. That is every writer of this block, not step 7 —
    // and it is why the fixture is what a stored block really looks like.
    const transportadora = transportadoraSchema.parse({ nome: 'Transportadora Teste' });
    const db = pedidoComFrete({
      ...blocoDeFrete({ printLabelId: 'ETQ-1' }),
      transportadora,
      // `.passthrough()` — a key a later step (or another channel) added.
      chaveDesconhecida: { qualquer: 'coisa' },
    });

    const r = await salvar(db, [obs()]);

    expect(r.acao).toBe('atualizado');
    const frete = freteGravado(db);
    expect(frete.printLabelId).toBe('ETQ-1');
    expect(frete.transportadora).toEqual(transportadora);
    expect(frete.chaveDesconhecida).toEqual({ qualquer: 'coisa' });
    // ÂNCORA: the write really happened over this block.
    expect(frete.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
  });

  it('28 — QUASE-ERRO: uma linha do diário ILEGÍVEL não bloqueia as outras', async () => {
    // Per-ELEMENT tolerance, never per FIELD. The unreadable row cannot be
    // re-serialised (the block schema validates every row on the way in), so it
    // is the ONE thing this writer does not carry over — and the readable row
    // is untouched.
    // ⚠️ The corrupt row is spliced in AFTER the block parse on purpose: the
    // schema would refuse it, which is exactly why a stored one can only have
    // come from another writer or a hand edit — and why the read is tolerant.
    const db = pedidoComFrete({
      ...blocoDeFrete(),
      pacotes: [
        { numero: '', estado: 'nao-e-um-estado' },
        pacoteFreteSchema.parse({ numero: PKG_B, estadoMarketplace: 'LOGISTICS_READY' }),
      ],
    });

    const r = await salvar(db, [obs({ packageNumber: PKG_A })]);

    expect(r.acao).toBe('atualizado');
    const diario = diarioGravado(db);
    expect(diario.map((l) => l.numero).sort()).toEqual([PKG_A, PKG_B].sort());
    expect(diario.find((l) => l.numero === PKG_B)!.estadoMarketplace).toBe('LOGISTICS_READY');
  });
});

/* -------------------------------------------------------------------------- */
/*                     29 — two writers on one `freteInicial`                  */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — a corrida com a transação do PEDIDO', () => {
  function mapear(over: Record<string, unknown> = {}): PedidoMapeadoShopee {
    const detalhe = { ...detalheSG(), ...over } as ShopeeOrderDetailRow;
    return mapearPedidoShopee({
      detalhe,
      escrow: null,
      itens: [
        {
          produtoUid: null,
          ordem: 0,
          ensureUniqueId: makeItemEnsureUniqueId(ORDER_SN, '12984093', 0),
          mktplaceId: '12984093',
          sku: '123002002',
          gtin: null,
          nomeDeVenda: 'Cotton T-shirt Black,02',
          precoDeVenda: 15,
          descontoUnitario: 0,
          quantidade: 2,
          custo: null,
          timestamp: NOW_US,
          imposto: null,
        },
      ],
      conferencia: {
        orderSn: ORDER_SN,
        somaDosItens: 30,
        descontoDasLinhas: 0,
        freteCobrado: 1.99,
        totalConferido: 31.99,
        totalDoPedido: 31.99,
        diferenca: 0,
      },
      frete: mapearFreteInicialShopee({ detalhe, escrow: null, watermarkUs: WATERMARK_US }).frete,
      conta: {
        integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
        listaDePrecosOuterRef: null,
        operacaoPedidoOuterRef: null,
      },
      captura: { estado: CAPTURA_COMPRADOR_ESTADO.expirado, camposRecusados: ['regiao:nao-br'] },
      clientePedidoOuterRef: null,
      enderecoFiscalOuterRef: null,
      watermarkUs: WATERMARK_US,
    });
  }

  it('29 — o perdedor RE-LÊ e os dois escritores sobrevivem, com UM abort', async () => {
    const db = new FakeDb();
    // The pedido exists, written by step 5's own transaction.
    await salvarPedidoShopee(asDb(db), {
      pedidoId: PEDIDO_ID,
      mapeado: mapear(),
      watermarkUs: WATERMARK_US,
      nowUs: NOW_US,
    });
    db.writes.length = 0;
    db.opLog.length = 0;
    // ⚠️ The CREATE above is a committed transaction too — without this the
    // commit count below is 3 and the assertion would have to be loosened,
    // which is how a race test stops proving anything.
    db.occ.txLog.length = 0;

    const portao = deferred();
    let segurou = false;
    // ⚠️ The held run is identified by WHAT IT IS ABOUT TO WRITE — the diary —
    // never by `ctx.label`, which follows transaction-open order and is an
    // artefact of whichever await chain got there first.
    db.occ.beforeCommit = (ctx) => {
      const ehOFrete = ctx.writes.some((w) => {
        const bloco = (w.data as Record<string, unknown>).freteInicial;
        return typeof bloco === 'object' && bloco !== null && Object.hasOwn(bloco, 'pacotes');
      });
      if (!ehOFrete || segurou) return undefined;
      segurou = true;
      return portao.promise;
    };

    const runFrete = salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE' })]);
    const runPedido = salvarPedidoShopee(asDb(db), {
      pedidoId: PEDIDO_ID,
      mapeado: mapear({ order_status: 'CANCELLED' }),
      watermarkUs: WATERMARK_US,
      nowUs: NOW_US,
    });

    await runPedido;
    portao.resolve();
    const [frete, pedido] = await Promise.all([runFrete, runPedido]);

    expect(pedido.acao).toBe('atualizado');
    expect(frete.acao).toBe('atualizado');
    // Exactly one abort — the freight writer's — and both attempts committed.
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    expect(db.occ.txLog.filter((e) => e.phase === 'commit')).toHaveLength(2);

    const doc = db.store[PEDIDO_PATH]!.data;
    // Both writers' fields are present: the pedido estado the order writer moved…
    expect(doc.estado).toBe(ESTADO_PEDIDO.cancelado);
    // …and the freight state the retry re-derived from the WINNER's snapshot.
    const frete0 = doc.freteInicial as Record<string, unknown>;
    expect(frete0.estado).toBe(ESTADO_FRETE.postado);
    expect(frete0.pacotes).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                 30/31 — the operator, and the `-` sentinel                  */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — o operador e a sentinela', () => {
  it('30 — `hasUserInteraction: true` NÃO silencia o passo 7', async () => {
    // Step 5's freeze reason is MONEY (`valorCobrado` feeds
    // `derivePedidoFreteTotals`) and step 7 writes no money field. Honouring the
    // latch would blind the physical-stock feed of the pedido an operator
    // touched: the goods ship and the shelf never empties.
    const db = pedidoComFrete(blocoDeFrete(), { hasUserInteraction: true });

    const r = await salvar(db, [obs()]);

    expect(r.acao).toBe('atualizado');
    expect(r.campos).toEqual(['freteInicial.estado', 'freteInicial.pacotes']);
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    // …and the flag itself is untouched.
    expect(db.store[PEDIDO_PATH]!.data.hasUserInteraction).toBe(true);
    expect(Object.hasOwn(db.patches.at(-1)!.patch, 'hasUserInteraction')).toBe(false);
  });

  it('30 — um codRastreio digitado à mão é SUBSTITUÍDO pelo primeiro valor do fold', async () => {
    const db = pedidoComFrete(blocoDeFrete({ codRastreio: 'DIGITADO-A-MAO' }), {
      hasUserInteraction: true,
    });

    const r = await salvar(db, [obs({ trackingNumber: 'BR000000001BR' })]);

    expect(r.campos).toContain('freteInicial.codRastreio');
    expect(freteGravado(db).codRastreio).toBe('BR000000001BR');
  });

  it('31 — um `tracking_number` "-" NUNCA chega ao codRastreio', async () => {
    // Driven through the REAL producer, so this asserts the normalisation from
    // the consumer's side rather than re-implementing it.
    const linha = shopeePackageDetailRowSchema.parse({
      order_sn: ORDER_SN,
      package_number: PKG_A,
      fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
      tracking_number: '-',
      update_time: T1_S,
    });
    const observado = observadoDoPacoteDetalhe(linha)!;
    expect(observado.trackingNumber).toBeNull();

    const db = pedidoComFrete(blocoDeFrete({ codRastreio: 'BR000000001BR' }));
    const r = await salvar(db, [observado]);

    expect(r.campos).not.toContain('freteInicial.codRastreio');
    // Fill-or-keep: the stored number stands, and the sentinel reaches nothing.
    expect(freteGravado(db).codRastreio).toBe('BR000000001BR');
    expect(diarioGravado(db)[0]!.codRastreio).toBeNull();

    // ⚠️ QUASE-ERRO: a number that merely CONTAINS the sentinel is a real
    // tracking number and must travel verbatim.
    const quase = observadoDoPacoteDetalhe(
      shopeePackageDetailRowSchema.parse({
        order_sn: ORDER_SN,
        package_number: PKG_A,
        tracking_number: 'BR-123',
        update_time: T2_S,
      }),
    )!;
    expect(quase.trackingNumber).toBe('BR-123');
  });
});

/* -------------------------------------------------------------------------- */
/*                     32/33/34 — the logs and the op kinds                    */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — os logs e as operações', () => {
  it('32 — nenhum log carrega endereço, driver, número virtual ou o VALOR do rastreio', async () => {
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [
      obs({ trackingNumber: 'BR000000001BR', logisticsChannelId: 11006, shipByDateS: T2_S }),
    ]);
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_NAO_EXISTE', updateTimeS: T2_S })]);
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_DELIVERY_DONE', updateTimeS: T2_S })]);

    const tudo = [...infos, ...avisos]
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    // ÂNCORA: there IS log output, and it names the pedido — otherwise every
    // assertion below passes over an empty string.
    expect(tudo).toContain(PEDIDO_ID);
    expect(tudo).toContain('frete do pacote aplicado');
    // The tracking-number VALUE never appears, although the transaction wrote it.
    expect(freteGravado(db).codRastreio).toBe('BR000000001BR');
    expect(tudo).not.toContain('BR000000001BR');
    for (const chave of [
      'recipient_address',
      'driver_info',
      'virtual_contact_number',
      'driver_name',
      'driver_phone',
      'consultation_id',
    ]) {
      expect(tudo).not.toContain(chave);
    }
  });

  it('33 — o token desconhecido é logado UMA vez por entrega, distinto', async () => {
    const db = pedidoComFrete(blocoDeFrete());

    const r = await salvar(
      db,
      ['1', '2', '3', '4', '5'].map((n) =>
        obs({ packageNumber: `${PKG_A}${n}`, fulfillmentStatus: 'LOGISTICS_FUTURO_DESCONHECIDO' }),
      ),
    );

    expect(r.tokensDesconhecidos).toEqual(['LOGISTICS_FUTURO_DESCONHECIDO']);
    const linhas = infos.filter((args) => String(args[0]).includes('token de frete desconhecido'));
    expect(linhas).toHaveLength(1);
    expect((linhas[0]![1] as Record<string, unknown>).tokens).toEqual([
      'LOGISTICS_FUTURO_DESCONHECIDO',
    ]);
    // Five rows were still recorded VERBATIM — an unknown token is data, not an
    // error, and the block estado simply stays where it was.
    expect(r.pacotes).toBe(5);
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.iniciado);
  });

  it('33 — um replay de um token desconhecido vira `ignorado-desconhecido`', async () => {
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_FUTURO_DESCONHECIDO' })]);
    db.writes.length = 0;

    const r = await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_FUTURO_DESCONHECIDO' })]);

    // ⚠️ Distinct from `ignorado-sem-mudanca` on purpose: the one line this
    // transaction logs gets to say "we wrote nothing, and here is the token we
    // did not understand".
    expect(r.acao).toBe('ignorado-desconhecido');
    expect(r.tokensDesconhecidos).toEqual(['LOGISTICS_FUTURO_DESCONHECIDO']);
    expect(db.writes).toEqual([]);
  });

  it('33 — QUASE-ERRO: um token de RETORNO não é "desconhecido"', async () => {
    // `LOGISTICS_PENDING_ARRANGE` is a token we DID understand — as step 17's.
    // Naming the outcome `ignorado-desconhecido` over it would point the log at
    // an empty token list.
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PENDING_ARRANGE' })]);
    db.writes.length = 0;
    infos.length = 0;

    const r = await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PENDING_ARRANGE' })]);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.tokensDesconhecidos).toEqual([]);
    expect(infos.filter((args) => String(args[0]).includes('token de frete desconhecido'))).toEqual(
      [],
    );
    // …and the fact is not lost: it rides the delivery's own log line.
    const linhaDoLog = infos.find((args) => String(args[0]).includes('frete do pacote aplicado'));
    expect((linhaDoLog![1] as Record<string, unknown>).tokensDeRetorno).toEqual([
      'LOGISTICS_PENDING_ARRANGE',
    ]);
  });

  it('34 — as operações são SÓ `get` e `update` — nunca `set`, nunca `create`', async () => {
    const db = pedidoComFrete(blocoDeFrete());

    await salvar(db, [obs()]);
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T2_S })]);
    await salvar(db, [obs({ fulfillmentStatus: 'LOGISTICS_PICKUP_DONE', updateTimeS: T2_S })]);

    expect(new Set(db.opLog.map((o) => o.op))).toEqual(new Set(['get', 'update']));
    expect(db.opLog.filter((o) => o.op === 'update')).toHaveLength(2);
    expect(db.opLog.every((o) => o.path === PEDIDO_PATH)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                    the unit, and the scope of the comparison                */
/* -------------------------------------------------------------------------- */

describe('salvarFreteShopee — a unidade É a guarda', () => {
  it('⚠️ QUASE-ERRO: coerceToMicros num valor em SEGUNDOS responde 1970 e a guarda morre', () => {
    // The direct near-miss, against the helper itself. `coerceToMicros`
    // classifies by MAGNITUDE: a Shopee seconds value is below the millisecond
    // upper bound, so it is read as MILLISECONDS.
    const correto = microsDeSegundosShopee(UPDATE_TIME_S);
    const errado = coerceToMicros(UPDATE_TIME_S)!;
    expect(correto).toBe(UPDATE_TIME_S * 1_000_000);
    expect(errado).toBe(UPDATE_TIME_S * 1_000);
    expect(new Date(errado / 1000).getUTCFullYear()).toBe(1970);
    // …and a freshness gate fed the wrong one answers "older" for ever: every
    // real stored stamp is greater than every 1970 one.
    expect(errado).toBeLessThan(correto);
  });

  it('o relógio da ORDEM só entra quando a observação não traz nenhum', async () => {
    // The code-3 backstop's clock. It is ALREADY µs (`watermarkUs`), which is
    // why nothing converts it here — and it must not displace a package clock.
    const db = pedidoComFrete(blocoDeFrete());
    await salvar(db, [obs({ updateTimeS: null })], { relogioDaOrdemUs: WATERMARK_US });
    expect(diarioGravado(db)[0]!.atualizadoEm).toBe(WATERMARK_US);

    const db2 = pedidoComFrete(blocoDeFrete());
    await salvar(db2, [obs({ updateTimeS: T2_S })], { relogioDaOrdemUs: WATERMARK_US });
    expect(diarioGravado(db2)[0]!.atualizadoEm).toBe(microsDeSegundosShopee(T2_S));
  });

  it('o `ship_by_date` do pacote atravessa a fronteira UMA vez, em µs', async () => {
    const db = pedidoComFrete(blocoDeFrete());

    await salvar(db, [obs({ shipByDateS: T2_S })]);

    expect(diarioGravado(db)[0]!.prazoDespacho).toBe(microsDeSegundosShopee(T2_S));
    expect(freteGravado(db).prazoDespacho).toBe(microsDeSegundosShopee(T2_S));
    // ÂNCORA: a seconds value reaching the diary would land in 1970 — the row
    // schema's own preprocess classifies by magnitude, so nothing downstream
    // could repair it.
    expect(pacoteFreteSchema.parse({ numero: PKG_A, prazoDespacho: T2_S }).prazoDespacho).toBe(
      T2_S * 1_000,
    );
  });

  it('um `estado` armazenado ILEGÍVEL não é substituído por `desconhecido`', async () => {
    // ⚠️ A escolha, documentada no módulo: `desconhecido` é um membro REAL do
    // enum, com significado próprio (`ESTADOS_FRETE_IGNORAR_REMOCAO` o nomeia),
    // então tratá-lo como o estado armazenado seria inventar um fato que o
    // documento não diz. A leitura honesta é "não há nada a preservar": o fold
    // escreve quando tem um estado. Hoje as duas leituras dão o MESMO resultado
    // (`desconhecido` está fora da escada e fora de todo conjunto de guarda), e
    // é por isso que a diferença é de honestidade e não de comportamento — o
    // dia em que a tabela do canal puder produzir `desconhecido`, ela deixa de
    // ser a mesma coisa.
    const db = pedidoComFrete({ ...blocoDeFrete(), estado: 'ESTADO_QUE_NAO_EXISTE' });

    const r = await salvar(db, [obs()]);

    expect(r.acao).toBe('atualizado');
    expect(r.estadoEscrito).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(r.estadoRessuscitado).toBe(false);
    expect(freteGravado(db).estado).toBe(ESTADO_FRETE.aguardandoPostagem);

    // ⚠️ E a outra metade, MEDIDA e não deduzida: quando o fold NÃO tem estado,
    // o bloco reconstruído ainda carrega o valor ilegal pelo spread — e
    // `freteInicial.estado` é obrigatório, então o `parseMerge` recusa a
    // ESCRITA INTEIRA com um `ZodError`. Nada é capturado aqui (regra 6): o
    // braço da notificação PARQUEIA, que é a disposição certa para um documento
    // que nenhuma escrita consegue expressar. A primeira metade acima é,
    // portanto, também a cura: qualquer entrega cujo fold tenha um estado
    // substitui o valor ilegal e o bloco volta a ser gravável.
    const db2 = pedidoComFrete({ ...blocoDeFrete(), estado: 'ESTADO_QUE_NAO_EXISTE' });
    await expect(
      salvar(db2, [obs({ fulfillmentStatus: 'LOGISTICS_PENDING_ARRANGE' })]),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(db2.writes).toEqual([]);
    expect(freteGravado(db2).estado).toBe('ESTADO_QUE_NAO_EXISTE');

    // ÂNCORA: a MESMA entrega sobre um bloco legível não levanta nada e recusa o
    // estado com o motivo de um token que não foi entendido.
    const db3 = pedidoComFrete(blocoDeFrete());
    const r3 = await salvar(db3, [obs({ fulfillmentStatus: 'LOGISTICS_PENDING_ARRANGE' })]);
    expect(r3.motivoEstado).toBe(MOTIVO_FRETE_SHOPEE.tokenDesconhecido);
    expect(freteGravado(db3).estado).toBe(ESTADO_FRETE.iniciado);
  });

  it('a comparação de linha cobre TODOS os campos declarados do schema', () => {
    // The drift anchor for `mesmaLinhaPacote`: a field ADDED to
    // `pacoteFreteSchema` and not compared would be written once and then never
    // compared again — invisible to every test above.
    expect(Object.keys(pacoteFreteSchema.shape).sort()).toEqual(
      [
        'numero',
        'estado',
        'estadoMarketplace',
        'codRastreio',
        'canalId',
        'prazoDespacho',
        'atualizadoEm',
        'fonte',
      ].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                      the code-3 backstop, as the arm feeds it               */
/* -------------------------------------------------------------------------- */

describe('preverFreteShopee — a fonte de BACKSTOP', () => {
  it('o detalhe da ORDEM produz o mesmo estado que o pull produziria', () => {
    // One table serves both vocabularies (`guide 229` heads one list "Package
    // Fulfillment Status / Logistics Status"), which is what makes the push path
    // and the order-import backstop converge.
    const linha = detalheSG();
    const { observados } = observadosDoDetalheDoPedido(linha, {
      relogioDoPedidoS: segundosShopeeUtilizaveis(linha.update_time),
    });
    expect(observados).toHaveLength(1);
    expect(observados[0]!.fonte).toBe('get_order_detail');

    const previsao = preverFreteShopee(
      { freteInicial: blocoDeFrete(), ultimaModificacao: NOW_US - 1 },
      {
        orderSn: ORDER_SN,
        observados,
        relogioDaOrdemUs: WATERMARK_US,
        prazoDaOrdemUs: microsDeSegundosShopee(1_789_405_354),
        nowUs: NOW_US,
      },
    );

    expect(previsao.acao).toBe('atualizado');
    // The SG body's package is `LOGISTICS_READY`.
    expect(previsao.diagnosticos.estadoAlvo).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(previsao.patch!.freteInicial.estado).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(previsao.diagnosticos.pacotes).toBe(1);
  });
});

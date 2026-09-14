import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coerceToMicros } from '@delfrance/core/datetime';
import { deferred } from '@delfrance/data/testing';
import {
  CAPTURA_COMPRADOR_ESTADO,
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  type ItemDoPedido,
} from '@delfrance/schemas';
import type { ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { makeItemEnsureUniqueId, makePedidoIdShopee } from './orderIds';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import {
  mapearPedidoShopee,
  microsDeSegundosShopee,
  type MapearPedidoShopeeArgs,
  type PedidoMapeadoShopee,
} from './orderMapping';
import { MOTIVO_ESTADO_SHOPEE } from './orderStatusMaps';
import { salvarPedidoShopee } from './orderPedidoTx';

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const UPDATE_TIME_S = 1_788_973_354;
const WATERMARK_US = microsDeSegundosShopee(UPDATE_TIME_S);
const NOW_US = 1_789_000_000_000_000;

function detalheSG(): ShopeeOrderDetailRow {
  return lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
}

function linha(patch: Record<string, unknown>): ShopeeOrderDetailRow {
  return { ...detalheSG(), ...patch } as ShopeeOrderDetailRow;
}

function itemDe(index: number, produtoUid: string | null = null): ItemDoPedido {
  return {
    produtoUid,
    ordem: index,
    ensureUniqueId: makeItemEnsureUniqueId(ORDER_SN, '12984093', index),
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
  };
}

function mapear(patch: Partial<MapearPedidoShopeeArgs> = {}): PedidoMapeadoShopee {
  const detalhe = patch.detalhe ?? detalheSG();
  const watermarkUs = patch.watermarkUs ?? WATERMARK_US;
  return mapearPedidoShopee({
    detalhe,
    escrow: null,
    itens: [itemDe(0)],
    conferencia: {
      orderSn: ORDER_SN,
      somaDosItens: 30,
      descontoDasLinhas: 0,
      freteCobrado: 1.99,
      totalConferido: 31.99,
      totalDoPedido: 31.99,
      diferenca: 0,
    },
    frete: mapearFreteInicialShopee({ detalhe, escrow: null, watermarkUs }).frete,
    conta: {
      integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
      listaDePrecosOuterRef: 'documents/listaDePrecos/lp-1',
      operacaoPedidoOuterRef: 'documents/operacao/op-1',
    },
    captura: { estado: CAPTURA_COMPRADOR_ESTADO.expirado, camposRecusados: ['regiao:nao-br'] },
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
    watermarkUs,
    ...patch,
  });
}

function salvar(db: FakeDb, mapeado = mapear(), watermarkUs = WATERMARK_US, nowUs = NOW_US) {
  return salvarPedidoShopee(asDb(db), { pedidoId: PEDIDO_ID, mapeado, watermarkUs, nowUs });
}

/** Every `console.warn` / `console.info` argument list, in order. */
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
/*                                    CREATE                                   */
/* -------------------------------------------------------------------------- */

describe('salvarPedidoShopee — criação', () => {
  it('cria o pedido com o corpo mapeado inteiro', async () => {
    const db = new FakeDb();
    const r = await salvar(db);

    expect(r.acao).toBe('criado');
    expect(r.pedidoId).toBe(PEDIDO_ID);
    expect(r.itensGravados).toBeNull();

    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.numero).toBe(ORDER_SN);
    expect(doc.estado).toBe(ESTADO_PEDIDO.pago); // READY_TO_SHIP
    expect(doc.ehSaida).toBe(true);
    expect(doc.lastMarketplaceUpdate).toBe(WATERMARK_US);
    expect(doc.ultimaModificacao).toBe(NOW_US);
    expect(doc.integracaoPedidoOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(doc.itensIds).toEqual(['NONE']);
  });

  it('⚠️ usa tx.create e NUNCA tx.set — o opLog é [get, create]', async () => {
    // Under OCC a concurrent create aborts us and the retry takes the update
    // path; if the engine ever failed to detect it, `create` fails loudly
    // instead of clobbering the winner. A `set` would clobber silently.
    const db = new FakeDb();
    await salvar(db);
    expect(db.opLog).toEqual([
      { op: 'get', path: PEDIDO_PATH },
      { op: 'create', path: PEDIDO_PATH },
    ]);
  });

  it('todo carimbo gravado é µs — lastMarketplaceUpdate === update_time × 1_000_000', async () => {
    const db = new FakeDb();
    await salvar(db);
    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.lastMarketplaceUpdate).toBe(UPDATE_TIME_S * 1_000_000);
    expect(doc.timestamp).toBe(1_788_973_351 * 1_000_000);
  });

  it('marketplace.statusEm é IGUAL a lastMarketplaceUpdate no documento escrito', async () => {
    // Same instant, two readers: the watermark is the guard, `statusEm` is what
    // a screen renders. A later step moving one and not the other is visible
    // here rather than silent.
    const db = new FakeDb();
    await salvar(db);
    const doc = db.store[PEDIDO_PATH]!.data as Record<string, Record<string, unknown>>;
    expect(doc.marketplace!.statusEm).toBe(doc.lastMarketplaceUpdate as unknown as number);
  });

  it('TO_RETURN numa CRIAÇÃO semeia pago — não há estado a manter', async () => {
    const db = new FakeDb();
    const r = await salvar(db, mapear({ detalhe: linha({ order_status: 'TO_RETURN' }) }));
    expect(r.estadoEscrito).toBe(ESTADO_PEDIDO.pago);
    expect((db.store[PEDIDO_PATH]!.data.marketplace as Record<string, unknown>).status).toBe(
      'TO_RETURN',
    );
  });

  it('bloquearEmissaoNFe é true na criação de um pedido com region != "BR"', async () => {
    const db = new FakeDb();
    await salvar(db);
    expect(db.store[PEDIDO_PATH]!.data.bloquearEmissaoNFe).toBe(true);
  });

  it('num pedido BR com comprador mascarado, bloquearEmissaoNFe NÃO é escrito', async () => {
    // The masked case is carried by `capturaComprador` + the absent
    // `clientePedidoOuterRef`, which the NF-e orchestrator already refuses on.
    const db = new FakeDb();
    await salvar(
      db,
      mapear({
        detalhe: linha({ region: 'BR' }),
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.pendente,
          camposRecusados: ['nome:mascarado', 'cpf_cnpj:ausente'],
        },
      }),
    );
    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.bloquearEmissaoNFe).toBeNull();
    expect(doc.clientePedidoOuterRef).toBeNull();
    expect((doc.capturaComprador as Record<string, unknown>).estado).toBe('pendente');
  });

  it('capturaComprador abre com tentativas 1 e em = nowUs', async () => {
    const db = new FakeDb();
    await salvar(db);
    expect(db.store[PEDIDO_PATH]!.data.capturaComprador).toEqual({
      estado: CAPTURA_COMPRADOR_ESTADO.expirado,
      statusObservado: 'READY_TO_SHIP',
      em: NOW_US,
      tentativas: 1,
      camposRecusados: ['regiao:nao-br'],
    });
  });

  it('um create_time zerado cai para o relógio de parede, nunca para null', async () => {
    // `/pedidos` orders by `timestamp desc`; a null there sinks the pedido to
    // the bottom of the list for ever.
    const db = new FakeDb();
    await salvar(db, mapear({ detalhe: linha({ create_time: 0 }) }));
    expect(db.store[PEDIDO_PATH]!.data.timestamp).toBe(NOW_US);
  });

  it('um status desconhecido grava estado error e o error com o prefixo [shopee]', async () => {
    const db = new FakeDb();
    const r = await salvar(db, mapear({ detalhe: linha({ order_status: 'INVOICE_PENDING' }) }));
    expect(r.estadoEscrito).toBe(ESTADO_PEDIDO.error);
    expect(db.store[PEDIDO_PATH]!.data.error).toBe(
      '[shopee] status desconhecido: "INVOICE_PENDING"',
    );
  });

  it('não toca nenhum caminho fora de pedidos/ — este módulo não move estoque', async () => {
    const db = new FakeDb();
    await salvar(db, mapear({ detalhe: linha({ order_status: 'CANCELLED' }) }));
    expect(db.writes.map((w) => w.path)).toEqual([PEDIDO_PATH]);
    expect(db.caminhos.every((p) => p.startsWith('pedidos'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                            the watermark gate                               */
/* -------------------------------------------------------------------------- */

describe('salvarPedidoShopee — o watermark', () => {
  async function comPedidoCriado(): Promise<FakeDb> {
    const db = new FakeDb();
    await salvar(db);
    db.opLog.length = 0;
    db.writes.length = 0;
    return db;
  }

  it('descarta um carimbo ESTRITAMENTE mais velho, sem escrever nada', async () => {
    const db = await comPedidoCriado();
    const antes = { ...db.store[PEDIDO_PATH]!.data };
    const velho = microsDeSegundosShopee(UPDATE_TIME_S - 60);

    const r = await salvar(db, mapear({ watermarkUs: velho }), velho);

    expect(r.acao).toBe('ignorado-obsoleto');
    expect(r.watermarkUs).toBe(WATERMARK_US); // the STORED one, not the dropped payload's
    expect(db.writes).toEqual([]);
    expect(db.store[PEDIDO_PATH]!.data).toEqual(antes);
    // ADR 0011: a handler drops AND says so.
    expect(infos.length).toBeGreaterThan(0);
  });

  it('⚠️ um carimbo IGUAL é ACEITO e re-mapeado — o documento fica idêntico', async () => {
    // `>=`, not `>`: `UNPAID → PENDING → READY_TO_SHIP` inside one second share
    // one stamp, and `>` would drop the last two for ever. The replay is safe
    // because the mapper is pure, so it produces an EMPTY patch.
    const db = await comPedidoCriado();
    const antes = structuredClone(db.store[PEDIDO_PATH]!.data);

    const r = await salvar(db);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(db.store[PEDIDO_PATH]!.data).toEqual(antes);
    // The op log shows the read and NOTHING else — no update was even staged.
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    expect(db.writes).toEqual([]);
  });

  it('um carimbo mais NOVO é aceito e avança o watermark', async () => {
    const db = await comPedidoCriado();
    const novo = microsDeSegundosShopee(UPDATE_TIME_S + 60);

    const r = await salvar(
      db,
      mapear({ detalhe: linha({ update_time: UPDATE_TIME_S + 60 }), watermarkUs: novo }),
      novo,
    );

    expect(r.acao).toBe('atualizado');
    expect(db.store[PEDIDO_PATH]!.data.lastMarketplaceUpdate).toBe(novo);
  });

  it('⚠️ NEAR-MISS: coerceToMicros sobre SEGUNDOS mataria a comparação para sempre', async () => {
    // Asserted against the real helper, not against a comment: `coerceToMicros`
    // classifies by MAGNITUDE, so a Shopee `update_time` reads as milliseconds
    // and lands in 1970 — every later payload would then look OLDER than the
    // stored µs stamp and be dropped for ever.
    expect(microsDeSegundosShopee(UPDATE_TIME_S)).toBe(1_788_973_354_000_000);
    expect(coerceToMicros(UPDATE_TIME_S)).toBe(1_788_973_354_000);
    expect(coerceToMicros(UPDATE_TIME_S)).toBeLessThan(microsDeSegundosShopee(UPDATE_TIME_S));

    const db = await comPedidoCriado();
    const errado = coerceToMicros(UPDATE_TIME_S)!;
    const r = await salvar(db, mapear({ watermarkUs: errado }), errado);
    expect(r.acao).toBe('ignorado-obsoleto');
  });

  it('lê um lastMarketplaceUpdate ARMAZENADO em milissegundos (corpus legado)', async () => {
    // The stored side really does hold ms ints and ISO strings, which is why
    // `coerceToMicros` is right THERE and wrong on the wire value.
    const db = new FakeDb();
    db.seed(PEDIDO_PATH, {
      estado: ESTADO_PEDIDO.pago,
      lastMarketplaceUpdate: UPDATE_TIME_S * 1000 + 1000, // ms, one second NEWER
      itens: {},
    });
    const r = await salvar(db);
    expect(r.acao).toBe('ignorado-obsoleto');
  });
});

/* -------------------------------------------------------------------------- */
/*                                 monotonicity                                */
/* -------------------------------------------------------------------------- */

describe('salvarPedidoShopee — o estado', () => {
  function comEstado(estado: string, extra: Record<string, unknown> = {}): FakeDb {
    const db = new FakeDb();
    db.seed(PEDIDO_PATH, {
      estado,
      numero: ORDER_SN,
      itens: {},
      itensIds: [],
      lastMarketplaceUpdate: WATERMARK_US - 1_000_000,
      ultimaModificacao: NOW_US - 5_000_000,
      ...extra,
    });
    return db;
  }

  it('⚠️ um UNPAID atrasado NÃO desfaz um pago — mas o watermark e a flag avançam', async () => {
    const db = comEstado(ESTADO_PEDIDO.pago);
    const r = await salvar(db, mapear({ detalhe: linha({ order_status: 'UNPAID' }) }));

    expect(r.acao).toBe('atualizado');
    expect(r.estadoEscrito).toBeNull();
    expect(r.motivoEstado).toBe(MOTIVO_ESTADO_SHOPEE.regressivo);
    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.estado).toBe(ESTADO_PEDIDO.pago);
    expect(doc.lastMarketplaceUpdate).toBe(WATERMARK_US);
    expect((doc.marketplace as Record<string, unknown>).status).toBe('UNPAID');
  });

  it('⚠️ PAR: o MESMO UNPAID que um pago recusa, um cancelado aceita — o veredito sai do ARMAZENADO', async () => {
    // The near-miss twin of the test above: identical incoming payload, opposite
    // verdict, decided only by what the snapshot holds. `UNPAID` is the one rung
    // that is regressive from every on-ladder state and writable only out of an
    // off-ladder one, so this is what proves the off-ladder branch is evaluated
    // BEFORE the monotonic comparison — and that the verdict is computed inside
    // the callback, from `tx.get`, rather than from the mapped body's own idea of
    // the estado. (The RACE that makes a re-derivation necessary is pinned once,
    // in the concurrency describe below; here the same verdict is driven
    // sequentially.)
    const db = comEstado(ESTADO_PEDIDO.cancelado);
    const r = await salvar(db, mapear({ detalhe: linha({ order_status: 'UNPAID' }) }));

    expect(r.estadoEscrito).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
    expect(r.estadoRessuscitado).toBe(true);
    expect(db.store[PEDIDO_PATH]!.data.estado).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('⚠️ cancelado → pago é ACEITO e registrado como ressuscitado', async () => {
    const db = comEstado(ESTADO_PEDIDO.cancelado);
    const r = await salvar(db);

    expect(r.estadoEscrito).toBe(ESTADO_PEDIDO.pago);
    expect(r.estadoRessuscitado).toBe(true);
    expect(db.store[PEDIDO_PATH]!.data.estado).toBe(ESTADO_PEDIDO.pago);
    expect(avisos.some((c) => String(c[0]).includes('ressuscitado'))).toBe(true);
  });

  it('um pedido em finalizado não recebe estado nenhum — fora da escada', async () => {
    const db = comEstado(ESTADO_PEDIDO.finalizado);
    const r = await salvar(db);
    expect(r.motivoEstado).toBe(MOTIVO_ESTADO_SHOPEE.foraDaEscada);
    expect(db.store[PEDIDO_PATH]!.data.estado).toBe(ESTADO_PEDIDO.finalizado);
  });

  it('um CANCELLED escreve cancelado e não move estoque', async () => {
    const db = comEstado(ESTADO_PEDIDO.pago);
    await salvar(db, mapear({ detalhe: linha({ order_status: 'CANCELLED' }) }));
    expect(db.store[PEDIDO_PATH]!.data.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(db.writes.map((w) => w.path)).toEqual([PEDIDO_PATH]);
  });

  it('a importação seguinte com status conhecido limpa o error que NÓS escrevemos', async () => {
    const db = comEstado(ESTADO_PEDIDO.pago, {
      error: '[shopee] status desconhecido: "INVOICE_PENDING"',
    });
    await salvar(db);
    expect(db.store[PEDIDO_PATH]!.data.error).toBeNull();
  });

  it('⚠️ NEAR-MISS: um error de OUTRO writer (sem o prefixo) não é limpo', async () => {
    const db = comEstado(ESTADO_PEDIDO.pago, { error: 'NF-e rejeitada: cStat 539' });
    await salvar(db);
    expect(db.store[PEDIDO_PATH]!.data.error).toBe('NF-e rejeitada: cStat 539');
  });
});

/* -------------------------------------------------------------------------- */
/*                        the field groups on an update                        */
/* -------------------------------------------------------------------------- */

describe('salvarPedidoShopee — os grupos de campos', () => {
  function pedidoArmazenado(extra: Record<string, unknown> = {}): FakeDb {
    const db = new FakeDb();
    db.seed(PEDIDO_PATH, {
      estado: ESTADO_PEDIDO.pago,
      numero: ORDER_SN,
      itens: {},
      itensIds: [],
      valorCobrado: 1,
      descontoTotal: 0,
      lastMarketplaceUpdate: WATERMARK_US - 1_000_000,
      ultimaModificacao: NOW_US - 5_000_000,
      ...extra,
    });
    return db;
  }

  it('hasUserInteraction CONGELA itens, valorCobrado, descontoTotal e freteInicial', async () => {
    const db = pedidoArmazenado({ hasUserInteraction: true, freteInicial: null });
    await salvar(db);

    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.itens).toEqual({});
    expect(doc.itensIds).toEqual([]);
    expect(doc.valorCobrado).toBe(1);
    expect(doc.freteInicial).toBeNull();
  });

  it('⚠️ hasUserInteraction NÃO congela o ESTADO — um CANCELLED ainda cancela', async () => {
    // Freezing the estado would hold a stock reservation on a cancelled sale for
    // ever. The operator owns the line-up, not the sale.
    const db = pedidoArmazenado({ hasUserInteraction: true });
    await salvar(db, mapear({ detalhe: linha({ order_status: 'CANCELLED' }) }));
    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(doc.lastMarketplaceUpdate).toBe(WATERMARK_US);
    expect((doc.marketplace as Record<string, unknown>).status).toBe('CANCELLED');
  });

  it('o CONJUNTO de linhas é append-only: a identidade da linha armazenada sobrevive', async () => {
    const jaGravado = { ...itemDe(0, 'prod-antigo'), precoDeVenda: 99, custo: 7, imposto: 3 };
    const db = pedidoArmazenado({
      itens: { 'prod-antigo': [jaGravado] },
      itensIds: ['prod-antigo'],
    });

    await salvar(db, mapear({ itens: [itemDe(0), itemDe(1)] }));

    const doc = db.store[PEDIDO_PATH]!.data as Record<string, Record<string, ItemDoPedido[]>>;
    // ⚠️ The produto binding an operator may have made by hand is what the merge
    // must never touch, together with the line's identity and the ERP-side
    // money. The incoming line carries `produtoUid: null` and would land in
    // 'NONE' if the row had been replaced.
    expect(doc.itens!['prod-antigo']).toHaveLength(1);
    expect(doc.itens!['prod-antigo']![0]).toMatchObject({
      produtoUid: 'prod-antigo',
      ordem: 0,
      ensureUniqueId: jaGravado.ensureUniqueId,
      custo: 7,
      imposto: 3,
      timestamp: jaGravado.timestamp,
    });
    // …no line is removed, and only the genuinely new one is appended.
    expect(doc.itens!['NONE']).toHaveLength(1);
    expect(doc.itens!['NONE']![0]!.ordem).toBe(1);
  });

  it('⚠️ o DINHEIRO da linha é REFRESCADO — o escrow chega tarde e a refinação tem de pousar', async () => {
    // The escrow is the authority for the five discounts and for a bundle line's
    // real money, and it is routinely absent on the FIRST delivery (an unpaid
    // order has none; a contained escrow failure and a refused kit parse look the
    // same). If the re-priced line were dropped, the pedido would keep a
    // provisional price for ever WHILE the same `tx.update` refreshes
    // `valorCobrado` from the escrow — a header and a line set that contradict
    // each other permanently, and `pedidoTotal` reads the LINES.
    const jaGravado = { ...itemDe(0, 'prod-antigo'), precoDeVenda: 0, descontoUnitario: 0 };
    const db = pedidoArmazenado({
      itens: { 'prod-antigo': [jaGravado] },
      itensIds: ['prod-antigo'],
    });

    const reprecificado = { ...itemDe(0), precoDeVenda: 90, descontoUnitario: 10, quantidade: 3 };
    await salvar(db, mapear({ itens: [reprecificado] }));

    const doc = db.store[PEDIDO_PATH]!.data as Record<string, Record<string, ItemDoPedido[]>>;
    expect(doc.itens!['prod-antigo']![0]).toMatchObject({
      precoDeVenda: 90,
      descontoUnitario: 10,
      quantidade: 3,
      // …still ours, still in the same bucket.
      produtoUid: 'prod-antigo',
      ensureUniqueId: jaGravado.ensureUniqueId,
    });
    expect(doc.itens!['NONE']).toBeUndefined();
    // …and the refresh is REPORTED rather than silently absorbed.
    expect(avisos.some((c) => String(c[0]).includes('campos atualizados'))).toBe(true);
  });

  it('⚠️ NEAR-MISS: uma linha IDÊNTICA não reescreve itens nem avisa', async () => {
    // The refresh must be driven by a real difference, not by the re-import
    // itself — otherwise every replay would rewrite the whole `itens` map and
    // no equal-stamp delivery could ever be `ignorado-sem-mudanca`.
    const armazenado = { ...itemDe(0, 'prod-antigo') };
    const db = pedidoArmazenado({
      itens: { 'prod-antigo': [armazenado] },
      itensIds: ['prod-antigo'],
    });

    await salvar(db, mapear({ itens: [itemDe(0)] }));

    const doc = db.store[PEDIDO_PATH]!.data as Record<string, Record<string, ItemDoPedido[]>>;
    expect(doc.itens).toEqual({ 'prod-antigo': [armazenado] });
    expect(avisos.some((c) => String(c[0]).includes('campos atualizados'))).toBe(false);
  });

  it('hasUserInteraction ainda congela o dinheiro da linha', async () => {
    // The refresh lives INSIDE the `!congelado` block, so an operator who edited
    // the pedido keeps their numbers.
    const jaGravado = { ...itemDe(0, 'prod-antigo'), precoDeVenda: 99 };
    const db = pedidoArmazenado({
      hasUserInteraction: true,
      itens: { 'prod-antigo': [jaGravado] },
      itensIds: ['prod-antigo'],
    });

    await salvar(db, mapear({ itens: [{ ...itemDe(0), precoDeVenda: 90 }] }));

    const doc = db.store[PEDIDO_PATH]!.data as Record<string, Record<string, ItemDoPedido[]>>;
    expect(doc.itens!['prod-antigo']![0]!.precoDeVenda).toBe(99);
  });

  it('o frete é mesclado sem tocar estado nem codRastreio', async () => {
    const db = pedidoArmazenado({
      freteInicial: {
        estado: ESTADO_FRETE.postado,
        modalidade: '1',
        codRastreio: 'BR123',
        valorCobrado: null,
      },
    });
    await salvar(db);
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe(ESTADO_FRETE.postado);
    expect(frete.codRastreio).toBe('BR123');
    expect(frete.valorCobrado).toBe(1.99);
  });

  it('preencher-uma-vez: um outer ref já gravado NUNCA é sobrescrito', async () => {
    const db = pedidoArmazenado({
      clientePedidoOuterRef: 'documents/clientes/cli-existente',
      integracaoPedidoOuterRef: 'documents/integracao/outra',
    });
    await salvar(db, mapear({ clientePedidoOuterRef: 'documents/clientes/cli-novo' }));

    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.clientePedidoOuterRef).toBe('documents/clientes/cli-existente');
    expect(doc.integracaoPedidoOuterRef).toBe('documents/integracao/outra');
  });

  it('⚠️ uma importação MASCARADA não desvincula um cliente já ligado', async () => {
    // Structural, not a guard: a masked import supplies `null` for both buyer
    // refs, so the fill-once loop skips them and there is nothing to unlink.
    const db = pedidoArmazenado({
      clientePedidoOuterRef: 'documents/clientes/cli-existente',
      enderecoFiscalOuterRef: 'documents/clientes/cli-existente/enderecos/end-1',
    });
    await salvar(
      db,
      mapear({
        clientePedidoOuterRef: null,
        enderecoFiscalOuterRef: null,
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.pendente,
          camposRecusados: ['nome:mascarado'],
        },
      }),
    );
    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.clientePedidoOuterRef).toBe('documents/clientes/cli-existente');
    expect(doc.enderecoFiscalOuterRef).toBe('documents/clientes/cli-existente/enderecos/end-1');
  });

  it('preencher-uma-vez é POR CAMPO: o endereço entra mesmo com o cliente já ligado', async () => {
    const db = pedidoArmazenado({
      clientePedidoOuterRef: 'documents/clientes/cli-existente',
      enderecoFiscalOuterRef: null,
    });
    await salvar(
      db,
      mapear({
        clientePedidoOuterRef: 'documents/clientes/cli-novo',
        enderecoFiscalOuterRef: 'documents/clientes/cli-existente/enderecos/end-9',
      }),
    );
    const doc = db.store[PEDIDO_PATH]!.data;
    expect(doc.clientePedidoOuterRef).toBe('documents/clientes/cli-existente');
    expect(doc.enderecoFiscalOuterRef).toBe('documents/clientes/cli-existente/enderecos/end-9');
  });

  it('⚠️ bloquearEmissaoNFe nunca é escrito nem limpo numa ATUALIZAÇÃO', async () => {
    const comBloqueio = pedidoArmazenado({ bloquearEmissaoNFe: true });
    await salvar(comBloqueio, mapear({ detalhe: linha({ region: 'BR' }) }));
    expect(comBloqueio.store[PEDIDO_PATH]!.data.bloquearEmissaoNFe).toBe(true);

    const semBloqueio = pedidoArmazenado({ bloquearEmissaoNFe: null });
    await salvar(semBloqueio);
    expect(semBloqueio.store[PEDIDO_PATH]!.data.bloquearEmissaoNFe).toBeNull();
  });

  it('ultimaModificacao é monotônico — um carimbo mais novo de outro writer sobrevive', async () => {
    const futuro = NOW_US + 10_000_000;
    const db = pedidoArmazenado({ ultimaModificacao: futuro });
    await salvar(db, mapear({ detalhe: linha({ order_status: 'CANCELLED' }) }));
    expect(db.store[PEDIDO_PATH]!.data.ultimaModificacao).toBe(futuro);
  });

  it('⚠️ capturaComprador: uma vez EXPIRADO, continua expirado', async () => {
    const db = pedidoArmazenado({
      capturaComprador: {
        estado: CAPTURA_COMPRADOR_ESTADO.expirado,
        statusObservado: 'CANCELLED',
        em: NOW_US - 1_000,
        tentativas: 4,
        camposRecusados: ['nome:mascarado'],
      },
    });
    await salvar(
      db,
      mapear({
        detalhe: linha({ region: 'BR' }),
        captura: { estado: CAPTURA_COMPRADOR_ESTADO.pendente, camposRecusados: [] },
      }),
    );
    const captura = db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe(CAPTURA_COMPRADOR_ESTADO.expirado);
    expect(captura.tentativas).toBe(5);
  });

  it('⚠️ NEAR-MISS: uma entrega que REALMENTE captura levanta um expirado armazenado', async () => {
    // The precedence, stated as a pair with the test above: `expirado` latches
    // against a payload that captured NOTHING (`pendente` there), and loses to
    // one that captured something. Otherwise a pedido masked out of the window
    // on its first delivery and unmasked later would end up with a linked
    // cliente and a diary saying nothing was ever captured.
    const db = pedidoArmazenado({
      capturaComprador: {
        estado: CAPTURA_COMPRADOR_ESTADO.expirado,
        statusObservado: 'SHIPPED',
        em: NOW_US - 1_000,
        tentativas: 2,
        camposRecusados: ['nome:mascarado'],
      },
    });
    await salvar(
      db,
      mapear({
        detalhe: linha({ region: 'BR', order_status: 'SHIPPED' }),
        clientePedidoOuterRef: 'documents/clientes/cli-real',
        captura: { estado: CAPTURA_COMPRADOR_ESTADO.capturado, camposRecusados: [] },
      }),
    );
    const captura = db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe(CAPTURA_COMPRADOR_ESTADO.capturado);
    expect(captura.camposRecusados).toEqual([]);
  });

  it('⚠️ capturaComprador: uma vez CAPTURADO, uma entrega MASCARADA não o rebaixa a expirado', async () => {
    // Shopee re-masks the buyer once the order leaves the unmask window, and
    // `SHIPPED`/`COMPLETED` is where every finished BR order ends — so without
    // the latch this is the TERMINAL record of every successfully captured BR
    // order, saying "the window closed with NO capture" while the cliente is
    // linked. The buyer refusals go with the latch: a field that was captured
    // was not refused.
    const db = pedidoArmazenado({
      clientePedidoOuterRef: 'documents/clientes/cli-real',
      enderecoFiscalOuterRef: 'documents/clientes/cli-real/enderecos/end-1',
      capturaComprador: {
        estado: CAPTURA_COMPRADOR_ESTADO.capturado,
        statusObservado: 'READY_TO_SHIP',
        em: NOW_US - 1_000,
        tentativas: 1,
        camposRecusados: [],
      },
    });
    await salvar(
      db,
      mapear({
        detalhe: linha({ region: 'BR', order_status: 'SHIPPED' }),
        clientePedidoOuterRef: null,
        enderecoFiscalOuterRef: null,
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.expirado,
          camposRecusados: ['nome:mascarado', 'cpf_cnpj:mascarado'],
        },
      }),
    );
    const captura = db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe(CAPTURA_COMPRADOR_ESTADO.capturado);
    expect(captura.camposRecusados).toEqual([]);
    expect(captura.statusObservado).toBe('SHIPPED');
    expect(db.store[PEDIDO_PATH]!.data.clientePedidoOuterRef).toBe('documents/clientes/cli-real');
  });

  it('⚠️ NEAR-MISS: o mesmo payload mascarado sobre um PENDENTE vira expirado', async () => {
    // The half that gives the latch its meaning — the state is decided by what
    // is STORED, not by the payload, and a pedido that captured nothing still
    // expires on the same delivery that leaves a captured one alone.
    const db = pedidoArmazenado({
      capturaComprador: {
        estado: CAPTURA_COMPRADOR_ESTADO.pendente,
        statusObservado: 'READY_TO_SHIP',
        em: NOW_US - 1_000,
        tentativas: 1,
        camposRecusados: ['nome:mascarado'],
      },
    });
    await salvar(
      db,
      mapear({
        detalhe: linha({ region: 'BR', order_status: 'SHIPPED' }),
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.expirado,
          camposRecusados: ['nome:mascarado', 'cpf_cnpj:mascarado'],
        },
      }),
    );
    const captura = db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe(CAPTURA_COMPRADOR_ESTADO.expirado);
    expect(captura.camposRecusados).toEqual(['nome:mascarado', 'cpf_cnpj:mascarado']);
  });

  it('⚠️ o latch CAPTURADO não engole um `endereco:*` — o pedido segue sem endereço fiscal', async () => {
    // The `endereco:sem-cep` half is IO-observed, not a buyer-field verdict, and
    // it is reachable exactly here: a pedido whose cliente is linked but whose
    // endereço is not re-runs the endereço step on every delivery. Dropping it
    // with the buyer refusals would silence the only record that this pedido can
    // never be fiscalizado.
    const db = pedidoArmazenado({
      clientePedidoOuterRef: 'documents/clientes/cli-real',
      enderecoFiscalOuterRef: null,
      capturaComprador: {
        estado: CAPTURA_COMPRADOR_ESTADO.capturado,
        statusObservado: 'READY_TO_SHIP',
        em: NOW_US - 1_000,
        tentativas: 1,
        camposRecusados: ['endereco:sem-cep'],
      },
    });
    await salvar(
      db,
      mapear({
        detalhe: linha({ region: 'BR', order_status: 'SHIPPED' }),
        clientePedidoOuterRef: null,
        enderecoFiscalOuterRef: null,
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.expirado,
          camposRecusados: ['nome:mascarado'],
        },
        camposRecusadosExtra: ['endereco:sem-cep'],
      }),
    );
    const captura = db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>;
    expect(captura.estado).toBe(CAPTURA_COMPRADOR_ESTADO.capturado);
    expect(captura.camposRecusados).toEqual(['endereco:sem-cep']);
  });

  it('tentativas conta ENTREGAS NOVAS, não redeliveries do mesmo carimbo', async () => {
    const db = new FakeDb();
    await salvar(db);
    expect(
      (db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>).tentativas,
    ).toBe(1);

    // The same payload again — a Cloud Tasks retry — must not move the counter,
    // or no replay could ever be recognised as a no-op.
    await salvar(db);
    expect(
      (db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>).tentativas,
    ).toBe(1);

    const novo = microsDeSegundosShopee(UPDATE_TIME_S + 30);
    await salvar(db, mapear({ watermarkUs: novo }), novo);
    expect(
      (db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>).tentativas,
    ).toBe(2);
  });

  it('nenhum log carrega dado do comprador — só ids, nomes de campo e números', async () => {
    const db = pedidoArmazenado({ estado: ESTADO_PEDIDO.cancelado });
    await salvar(db);
    const tudo = JSON.stringify([...avisos, ...infos]);
    expect(tudo).not.toContain('Rua Redacted');
    expect(tudo).not.toContain('****');
    expect(tudo).not.toContain('12345678909');
  });
});

/* -------------------------------------------------------------------------- */
/*                    the SCOPE of the field-by-field comparisons              */
/* -------------------------------------------------------------------------- */

describe('salvarPedidoShopee — o escopo das comparações', () => {
  /**
   * The patch is built by comparing each field against the snapshot, so those
   * comparisons decide which edits are silently never written (#1372's shape).
   * Each case below is an equal pair and its near-miss, driven through the real
   * transaction rather than through the private helpers.
   */
  async function segundaRodada(mapeado: PedidoMapeadoShopee) {
    const db = new FakeDb();
    await salvar(db);
    db.writes.length = 0;
    // Same stamp on purpose: an equal watermark is ACCEPTED and re-mapped, so
    // whatever this run writes came from a field comparison and from nothing
    // else.
    const r = await salvar(db, mapeado);
    return { db, r };
  }

  it('o PAR IGUAL: o mesmo payload não escreve nada', async () => {
    const { r, db } = await segundaRodada(mapear());
    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(db.writes).toEqual([]);
  });

  it('⚠️ NEAR-MISS: pendingTerms null e [] são DISTINTOS', async () => {
    // "we did not ask" and "we asked and there are none" are different facts,
    // and a comparison that folded them would never write the transition.
    const { r, db } = await segundaRodada(mapear({ detalhe: linha({ pending_terms: [] }) }));
    expect(r.acao).toBe('atualizado');
    expect(
      (db.store[PEDIDO_PATH]!.data.marketplace as Record<string, unknown>).pendingTerms,
    ).toEqual([]);
  });

  it('⚠️ NEAR-MISS: uma ORDEM diferente em camposRecusados conta como mudança', async () => {
    // The producer is deterministic, so a reordering means the verdict itself
    // changed. Folding the array into a set would hide exactly that.
    const { r, db } = await segundaRodada(
      mapear({
        captura: {
          estado: CAPTURA_COMPRADOR_ESTADO.expirado,
          camposRecusados: ['regiao:nao-br', 'endereco:sem-cep'],
        },
      }),
    );
    expect(r.acao).toBe('atualizado');
    expect(
      (db.store[PEDIDO_PATH]!.data.capturaComprador as Record<string, unknown>).camposRecusados,
    ).toEqual(['regiao:nao-br', 'endereco:sem-cep']);
  });

  it('⚠️ NEAR-MISS: um volume que muda SÓ o pesoBruto é uma mudança', async () => {
    const { r, db } = await segundaRodada(
      mapear({
        detalhe: linha({
          package_list: [
            {
              ...detalheSG().package_list![0]!,
              parcel_chargeable_weight_gram: 1200,
            },
          ],
        }),
      }),
    );
    expect(r.acao).toBe('atualizado');
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    expect((frete.volumes as { pesoBruto: number }[])[0]!.pesoBruto).toBe(1.2);
  });

  it('⚠️ NEAR-MISS: um cancelReason que só muda de "" para texto é uma mudança', async () => {
    const { r, db } = await segundaRodada(
      mapear({ detalhe: linha({ cancel_reason: 'BUYER_CHANGED_MIND' }) }),
    );
    expect(r.acao).toBe('atualizado');
    expect((db.store[PEDIDO_PATH]!.data.marketplace as Record<string, unknown>).cancelReason).toBe(
      'BUYER_CHANGED_MIND',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                        concurrency — the REAL OccEngine                     */
/* -------------------------------------------------------------------------- */

describe('salvarPedidoShopee — duas tarefas code-3 concorrentes', () => {
  it('produz UM pedido, UMA criação e exatamente UM abort', async () => {
    // Two deliveries of the same order land at once — a push and the backfill's
    // synthetic twin, or two Cloud Tasks attempts. Both compute the same
    // deterministic id, so both read and write the same document. The loser must
    // ABORT, re-run its callback against the winner's committed state and take
    // the UPDATE path; if its body were applied verbatim, the create would
    // either throw ALREADY_EXISTS or clobber the winner.
    const db = new FakeDb();
    const portao = deferred();
    const novo = microsDeSegundosShopee(UPDATE_TIME_S + 30);
    let segurou = false;
    // ⚠️ The held run is identified by WHAT IT IS ABOUT TO WRITE, never by
    // `ctx.label` — labels follow transaction-open order, which is an artefact
    // of whichever await chain got there first rather than of the test's intent
    // (the engine's own header says so). Holding the NEWER payload makes the
    // outcome deterministic: the older one commits the create, the newer one
    // aborts, re-reads and takes the update path.
    db.occ.beforeCommit = (ctx) => {
      const ehONovo = ctx.writes.some(
        (w) => (w.data as Record<string, unknown>).lastMarketplaceUpdate === novo,
      );
      if (!ehONovo || segurou) return undefined;
      segurou = true;
      return portao.promise;
    };

    const runA = salvar(db);
    const runB = salvar(db, mapear({ watermarkUs: novo }), novo);

    await Promise.race([runA, runB]);
    portao.resolve();
    const [a, b] = await Promise.all([runA, runB]);

    expect(a.pedidoId).toBe(b.pedidoId);
    // Exactly one abort, and both attempts eventually commit.
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    expect(db.occ.txLog.filter((e) => e.phase === 'commit')).toHaveLength(2);
    // ⚠️ `opLog` logs at STAGING time, so the loser's discarded `create` is
    // visible here — and that is the evidence the retry really happened: two
    // creates were STAGED, one was thrown away by the abort, and the re-run took
    // the update path. `db.writes` is the COMMITTED side.
    expect(db.opLog.filter((o) => o.op === 'create')).toHaveLength(2);
    expect(db.opLog.filter((o) => o.op === 'update')).toHaveLength(1);
    expect(db.opLog.filter((o) => o.op === 'set')).toHaveLength(0);
    // ONE document, and exactly two committed writes to it — never two creates,
    // never a lost update.
    expect(db.writes.map((w) => w.path)).toEqual([PEDIDO_PATH, PEDIDO_PATH]);
    expect(db.idsEm('pedidos')).toEqual([PEDIDO_ID]);
    expect([a.acao, b.acao].sort()).toEqual(['atualizado', 'criado']);
    // The winner's watermark is the NEWER of the two, whichever ran second.
    expect(db.store[PEDIDO_PATH]!.data.lastMarketplaceUpdate).toBe(novo);
  });
});

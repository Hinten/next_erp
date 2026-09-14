/**
 * The DRY-RUN half of `rastrear:pedido` (#1515, step 7, plan §3.0-P P4).
 *
 * ⚠️ Two of these are the only thing standing between a rehearsal and the two
 * ways it can lie, and neither is a happy path:
 *
 *  - **4** proves the dry run shares the transaction's PATCH BYTES, not merely
 *    its opinion: it runs the real `salvarFreteShopee` over a second copy of the
 *    same seeded database and compares what was staged against what was
 *    predicted. A rehearsal with its own copy of the fold is worse than none.
 *  - **3** proves it writes nothing and enqueues nothing, structurally: the op
 *    log is `get`-only and the module's own source names no scheduler at all, so
 *    the guarantee cannot decay into a promise somebody forgot to keep.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
  type FreteDoPedido,
} from '@delfrance/schemas';
import type {
  ShopeeClient,
  ShopeeOrderDetail,
  ShopeePackageDetail,
} from '@delfrance/integrations-shopee';

import { FIXTURE_ORDER_DETAIL_QTY2_SG, lerPedidoDetalhe } from '../fixtures/wireCorpus';
import { FakeDb, asDb } from '../testing/fakeDb';
import { preverFreteShopee, salvarFreteShopee } from './freteTx';
import { makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import {
  resolverPacotesDeRastreio,
  simularRastreioShopee,
  type SimulacaoRastreioShopee,
} from './rastrearPedidoSimulacao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, order or buyer.  */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
/** The `__wire__` SG order, and its own package. */
const ORDER_SN = '260910KJBHUJDM';
const PKG_A = 'OFG242672552205937';
/** The doc page's sibling package — never listed by the SG order. */
const PKG_B = 'OFG199593509207187';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;

/** The SG order's own clock and deadline, in wire SECONDS. */
const RELOGIO_DA_ORDEM_S = 1_788_973_354;
const PRAZO_DA_ORDEM_S = 1_789_405_354;
const T_S = RELOGIO_DA_ORDEM_S;
const NOW_US = 1_789_000_000_000_000;
/** An invented carrier code. Never a real one. */
const RASTREIO = 'BR000000001BR';

function blocoDeFrete(over: Record<string, unknown> = {}): FreteDoPedido {
  return freteDoPedidoSchema.parse({
    ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
    externalOptionIntegracao: 'shopee',
    ...over,
  });
}

function volume(numero: string): Record<string, unknown> {
  return {
    quantidade: 1,
    especie: 'pacote',
    marca: null,
    numero,
    pesoBruto: 0.5,
    pesoLiquido: null,
    dimensoes: null,
    lacres: null,
  };
}

function pedidoComVolumes(numeros: readonly string[], over: Record<string, unknown> = {}): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, {
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    itens: {},
    itensIds: [],
    valorCobrado: 31.99,
    lastMarketplaceUpdate: microsDeSegundosShopee(T_S),
    ultimaModificacao: microsDeSegundosShopee(T_S),
    freteInicial: blocoDeFrete({ volumes: numeros.map((n) => volume(n)), ...over }),
  });
  return db;
}

/** One `get_package_detail` row, only the fields step 7 reads. */
function linha(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_sn: ORDER_SN,
    package_number: PKG_A,
    fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
    tracking_number: RASTREIO,
    logistics_channel_id: 11_006,
    ship_by_date: PRAZO_DA_ORDEM_S,
    update_time: T_S,
    is_shipment_arranged: true,
    group_shipment_id: 0,
    item_list: [{ item_id: 846_056_136, model_id: 12_984_093, model_quantity: 2 }],
    ...over,
  };
}

interface ClienteFake {
  readonly client: ShopeeClient;
  readonly pacotes: { packageNumbers: readonly string[] }[];
  readonly orders: { orderSnList: readonly string[] }[];
}

/**
 * A `ShopeeClient` that answers exactly the two operations this path uses. Every
 * other member is absent on purpose: reaching for one is a routing bug, and a
 * `TypeError` naming it is a better signal than a silent `undefined`.
 */
function cliente(
  rows: readonly (Record<string, unknown> | null)[],
  ordem: ShopeeOrderDetail = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response,
): ClienteFake {
  const pacotes: { packageNumbers: readonly string[] }[] = [];
  const orders: { orderSnList: readonly string[] }[] = [];
  const client = {
    getPackageDetail: (p: { packageNumbers: readonly string[] }) => {
      pacotes.push(p);
      return Promise.resolve({ package_list: rows } as unknown as ShopeePackageDetail);
    },
    getOrderDetail: (p: { orderSnList: readonly string[] }) => {
      orders.push(p);
      return Promise.resolve(ordem);
    },
  } as unknown as ShopeeClient;
  return { client, pacotes, orders };
}

function simular(
  db: FakeDb,
  fake: ClienteFake,
  packageNumber: string | null = null,
): Promise<SimulacaoRastreioShopee> {
  return simularRastreioShopee(asDb(db), fake.client, {
    integracaoId: CONTA,
    orderSn: ORDER_SN,
    packageNumber,
    nowUs: NOW_US,
  });
}

const FONTE = readFileSync(new URL('./rastrearPedidoSimulacao.ts', import.meta.url), 'utf8');
/**
 * The module's source with every comment removed.
 *
 * ⚠️ The structural pin below has to read CODE: the docblock NAMES the scheduler
 * it promises not to hold, so matching the raw file would fail on the very
 * sentence that documents the guarantee.
 */
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/* ========================================================================== */
/*  1 · os três rungs, e a DIFERENÇA entre os dois lados                      */
/* ========================================================================== */

describe('resolverPacotesDeRastreio — os três rungs', () => {
  it('1. volumes e package_list se misturam, cada linha carrega a sua origem e a diferença sai nos DOIS sentidos', async () => {
    // O pedido guarda um pacote que a order NÃO lista; a order lista um que o
    // pedido NÃO guarda. Esse é exatamente o drift (um split) que a aba Frete
    // não mostra.
    const db = pedidoComVolumes([PKG_B]);
    const fake = cliente([]);

    const r = await resolverPacotesDeRastreio(asDb(db), fake.client, {
      integracaoId: CONTA,
      orderSn: ORDER_SN,
      packageNumber: null,
    });

    expect(r.pedidoId).toBe(PEDIDO_ID);
    expect(r.existePedido).toBe(true);
    expect(r.temFreteInicial).toBe(true);
    expect(r.volumesArmazenados).toEqual([PKG_B]);
    expect(r.pacotesDaOrdem).toEqual([PKG_A]);
    expect(r.soNaShopee).toEqual([PKG_A]);
    expect(r.soNoPedido).toEqual([PKG_B]);
    // A ORDEM importa: o rung `volume` vem antes do `order_detail`.
    expect(r.alvos).toEqual([
      { packageNumber: PKG_B, origem: 'volume' },
      { packageNumber: PKG_A, origem: 'order_detail' },
    ]);
    expect(fake.orders).toEqual([{ orderSnList: [ORDER_SN], requestOrderStatusPending: true }]);
  });

  it('1b. quando os dois lados concordam, a diferença é VAZIA e o pacote aparece UMA vez — a âncora do teste acima', async () => {
    const db = pedidoComVolumes([PKG_A]);
    const fake = cliente([]);

    const r = await resolverPacotesDeRastreio(asDb(db), fake.client, {
      integracaoId: CONTA,
      orderSn: ORDER_SN,
      packageNumber: null,
    });

    expect(r.soNaShopee).toEqual([]);
    expect(r.soNoPedido).toEqual([]);
    expect(r.alvos).toEqual([{ packageNumber: PKG_A, origem: 'volume' }]);
  });

  it('2. `--package` curto-circuita os outros dois rungs: nenhum get_order_detail, nenhum backstop', async () => {
    const db = pedidoComVolumes([PKG_B]);
    const fake = cliente([linha()]);

    const s = await simular(db, fake, PKG_A);

    expect(s.alvos).toEqual([{ packageNumber: PKG_A, origem: 'flag' }]);
    // ⚠️ O sentido inteiro da flag: UM pacote nomeado, UMA chamada.
    expect(fake.orders).toEqual([]);
    expect(s.pacotesDaOrdem).toBeNull();
    expect(s.backstop).toBeNull();
    // ÂNCORA: os volumes guardados continuam sendo LIDOS e reportados, só não
    // entram no conjunto.
    expect(s.volumesArmazenados).toEqual([PKG_B]);
    expect(fake.pacotes).toEqual([{ packageNumbers: [PKG_A] }]);
  });

  it('2b. um freteInicial sem volumes (ou com `numero` em branco / `-`) não inventa pacote nenhum', async () => {
    const db = pedidoComVolumes([]);
    db.seed(PEDIDO_PATH, {
      ...db.store[PEDIDO_PATH]!.data,
      freteInicial: blocoDeFrete({
        volumes: [volume('   '), volume('-'), volume(PKG_B), volume(PKG_B)],
      }),
    });
    const fake = cliente([]);

    const r = await resolverPacotesDeRastreio(asDb(db), fake.client, {
      integracaoId: CONTA,
      orderSn: ORDER_SN,
      packageNumber: null,
    });

    // O branco e o sentinela somem; a repetição colapsa numa entrada só.
    expect(r.volumesArmazenados).toEqual([PKG_B]);
  });
});

/* ========================================================================== */
/*  3 · o dry-run não grava e não enfileira — estruturalmente                 */
/* ========================================================================== */

describe('simularRastreioShopee — zero escritas, zero enfileiramentos', () => {
  it('3. o op log é só `get`, nada foi escrito, e o módulo não conhece agendador nenhum', async () => {
    const db = pedidoComVolumes([PKG_A]);
    const fake = cliente([linha()]);

    const s = await simular(db, fake);

    expect(db.writes).toEqual([]);
    expect(db.patches).toEqual([]);
    // O log INTEIRO, não só "nenhum create": uma única leitura do pedido.
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    // ⚠️ A metade ESTRUTURAL: um spy só provaria que ESTE caminho não enfileirou.
    // O módulo não tem como enfileirar — nenhum agendador entra nele, e o código
    // (sem comentários) não nomeia nenhum.
    expect(CODIGO).not.toMatch(/scheduler|enqueue|notificacaoSintetica/i);
    // ⚠️ ÂNCORA do próprio pin: o stripper de comentários não engoliu o arquivo.
    expect(CODIGO).toContain('preverFreteShopee');
    expect(CODIGO).toContain('getPackageDetail');
    // ÂNCORA: o negativo não é vazio — a simulação de fato decidiu alguma coisa.
    expect(s.linhas).toHaveLength(1);
    expect(s.linhas[0]!.previsao!.acao).toBe('atualizado');
  });

  it('3b. sem pedido, a previsão é `ignorado-sem-pedido` e continua sem escrever nada', async () => {
    const db = new FakeDb();
    const fake = cliente([linha()]);

    const s = await simular(db, fake);

    expect(s.existePedido).toBe(false);
    expect(s.temFreteInicial).toBe(false);
    expect(s.volumesArmazenados).toEqual([]);
    // O conjunto ainda é resolvido pela order — é assim que um operador
    // descobre QUAIS pacotes um code 3 sintético traria.
    expect(s.alvos).toEqual([{ packageNumber: PKG_A, origem: 'order_detail' }]);
    expect(s.linhas[0]!.previsao!.acao).toBe('ignorado-sem-pedido');
    expect(db.writes).toEqual([]);
    expect(db.store[PEDIDO_PATH]).toBeUndefined();
  });
});

/* ========================================================================== */
/*  4 · a previsão é a MESMA da transação — os bytes, não a opinião           */
/* ========================================================================== */

describe('simularRastreioShopee — a mesma previsão da transação', () => {
  it('4. o patch previsto é byte a byte o que `salvarFreteShopee` grava com a mesma observação', async () => {
    const dbSeco = pedidoComVolumes([PKG_A]);
    const dbVivo = pedidoComVolumes([PKG_A]);
    const fake = cliente([linha()]);

    const s = await simular(dbSeco, fake);
    const previsto = s.linhas[0]!.previsao!;

    // O caminho vivo: a MESMA observação, o MESMO relógio, a transação de verdade.
    const observado = s.linhas[0]!.observado!;
    const resultado = await salvarFreteShopee(asDb(dbVivo), {
      pedidoId: PEDIDO_ID,
      orderSn: ORDER_SN,
      observados: [observado],
      relogioDaOrdemUs: null,
      prazoDaOrdemUs: null,
      nowUs: NOW_US,
    });

    expect(resultado.acao).toBe('atualizado');
    expect(dbVivo.patches).toHaveLength(1);
    // ⚠️ Os BYTES. `campos` sozinho já passou em versões que divergiam no mapa.
    expect(previsto.patch!.freteInicial).toEqual(dbVivo.patches[0]!.patch.freteInicial);
    expect(previsto.patch!.ultimaModificacao).toEqual(dbVivo.patches[0]!.patch.ultimaModificacao);
    expect(previsto.campos).toEqual(resultado.campos);
    expect(previsto.diagnosticos.estadoAlvo).toBe(ESTADO_FRETE.aguardandoPostagem);
    // …e o dry-run continua sem ter escrito nada no SEU banco.
    expect(dbSeco.writes).toEqual([]);
  });

  it('4b. e é a mesma função pura, rodada sobre o mesmo raw — a NÃO-diferença fixada de frente', async () => {
    const db = pedidoComVolumes([PKG_A]);
    const fake = cliente([linha()]);

    const s = await simular(db, fake);
    const observado = s.linhas[0]!.observado!;
    const direto = preverFreteShopee(db.store[PEDIDO_PATH]!.data, {
      orderSn: ORDER_SN,
      observados: [observado],
      relogioDaOrdemUs: null,
      prazoDaOrdemUs: null,
      nowUs: NOW_US,
    });

    expect(s.linhas[0]!.previsao).toEqual(direto);
  });

  it('4c. um pacote SEM ship_by_date não ganha prazo nenhum — o caminho de push não dobra prazo de ORDER', async () => {
    // ⚠️ O que este teste protege é um ARGUMENTO, não um resultado: a previsão
    // por pacote recebe `prazoDaOrdemUs: null` porque um push não traz payload de
    // order nenhum. Com um prazo de order inventado, o fold cairia no fallback e
    // carimbaria um `prazoDespacho` que a Shopee nunca mandou — e nenhum dos
    // outros testes veria, porque nos outros o pacote traz o seu próprio prazo.
    const prazoGuardado = microsDeSegundosShopee(PRAZO_DA_ORDEM_S);
    const db = pedidoComVolumes([PKG_A], { prazoDespacho: prazoGuardado });
    // `0` é o zero-fill da Shopee, e o produtor o lê como AUSÊNCIA.
    const fake = cliente([linha({ ship_by_date: 0 })]);

    const s = await simular(db, fake, PKG_A);
    const p = s.linhas[0]!.previsao!;
    const bloco = p.patch!.freteInicial;
    const pacotes = (bloco.pacotes ?? []) as Record<string, unknown>[];

    expect(s.linhas[0]!.observado!.shipByDateS).toBeNull();
    // O bloco mantém o prazo guardado, e o campo não entra no diff…
    expect(bloco.prazoDespacho).toBe(prazoGuardado);
    expect(p.campos).not.toContain('freteInicial.prazoDespacho');
    // …e a linha do diário não inventa um.
    expect(pacotes[0]!.prazoDespacho).toBeNull();
    // ÂNCORA: o mesmo pacote COM prazo carimba mesmo — o negativo acima não é
    // um fold que nunca escreve nada.
    const comPrazo = await simular(
      pedidoComVolumes([PKG_A], { prazoDespacho: null }),
      cliente([linha()]),
      PKG_A,
    );
    expect(comPrazo.linhas[0]!.previsao!.patch!.freteInicial.prazoDespacho).toBe(prazoGuardado);
  });
});

/* ========================================================================== */
/*  5 · a resposta é reconciliada por NÚMERO, nunca por posição               */
/* ========================================================================== */

describe('simularRastreioShopee — a resposta do get_package_detail', () => {
  it('5. duas linhas fora de ordem caem no pacote certo', async () => {
    const db = pedidoComVolumes([PKG_A, PKG_B]);
    // A Shopee responde ao contrário da pergunta.
    const fake = cliente([
      linha({ package_number: PKG_B, fulfillment_status: 'LOGISTICS_PICKUP_DONE' }),
      linha({ package_number: PKG_A, fulfillment_status: 'LOGISTICS_REQUEST_CREATED' }),
    ]);

    const s = await simular(db, fake, null);

    expect(fake.pacotes).toEqual([{ packageNumbers: [PKG_A, PKG_B] }]);
    expect(s.linhas.map((l) => l.packageNumber)).toEqual([PKG_A, PKG_B]);
    expect(s.linhas[0]!.observado!.fulfillmentStatus).toBe('LOGISTICS_REQUEST_CREATED');
    expect(s.linhas[1]!.observado!.fulfillmentStatus).toBe('LOGISTICS_PICKUP_DONE');
  });

  it('6. um pacote que não voltou vira `motivo`, sem previsão, e a linha ilegível vira CONTAGEM', async () => {
    const db = pedidoComVolumes([PKG_A, PKG_B]);
    const fake = cliente([null, linha({ package_number: PKG_A })]);

    const s = await simular(db, fake, null);

    expect(s.ilegiveis).toBe(1);
    expect(s.linhas[0]!.previsao).not.toBeNull();
    const ausente = s.linhas[1]!;
    expect(ausente.packageNumber).toBe(PKG_B);
    expect(ausente.linha).toBeNull();
    expect(ausente.observado).toBeNull();
    expect(ausente.previsao).toBeNull();
    expect(ausente.motivo).toContain('ausente-na-resposta');
    // O motivo carrega a CONTAGEM e nenhum corpo.
    expect(ausente.motivo).toContain('1');
  });

  it('6b. uma linha cujo package_number é o sentinela `-` não vira observação', async () => {
    const db = pedidoComVolumes([PKG_A]);
    // O schema exige `.min(1)`, então o sentinela chega como texto e é o
    // produtor que o recusa — aqui a linha volta com OUTRO número e o pacote
    // pedido simplesmente não veio.
    const fake = cliente([linha({ package_number: '-' })]);

    const s = await simular(db, fake, null);

    expect(s.linhas[0]!.observado).toBeNull();
    expect(s.linhas[0]!.motivo).toContain('ausente-na-resposta');
  });

  it('6c. nenhum pacote resolvido ⇒ nenhuma chamada de get_package_detail', async () => {
    const db = new FakeDb();
    // Uma order sem package_list: nada a perguntar.
    const fake = cliente([], { order_list: [] } as unknown as ShopeeOrderDetail);

    const s = await simular(db, fake, null);

    expect(s.alvos).toEqual([]);
    expect(s.linhas).toEqual([]);
    expect(fake.pacotes).toEqual([]);
    expect(s.backstop).toBeNull();
  });
});

/* ========================================================================== */
/*  7 · o backstop do code 3, do MESMO corpo que o passo 5 já busca           */
/* ========================================================================== */

describe('simularRastreioShopee — o backstop do code 3', () => {
  it('7. dobra as linhas da order com o relógio da ORDER em SEGUNDOS, e nunca traz código de rastreio', async () => {
    const db = pedidoComVolumes([PKG_A]);
    const fake = cliente([linha()]);

    const s = await simular(db, fake, null);
    const b = s.backstop!;

    // ⚠️ SEGUNDOS do fio, o valor ANTES de qualquer conversão — nunca um
    // watermark em µs dividido por 1e6.
    expect(b.relogioDoPedidoS).toBe(RELOGIO_DA_ORDEM_S);
    expect(b.ignorados).toBe(0);
    expect(b.observados).toEqual([
      {
        packageNumber: PKG_A,
        // O vocabulário da ORDER (LogisticsStatus), não o do pacote.
        fulfillmentStatus: 'LOGISTICS_READY',
        trackingNumber: null,
        // Um pacote legível só ⇒ herda o prazo da order (resolução R2).
        shipByDateS: PRAZO_DA_ORDEM_S,
        logisticsChannelId: 11_006,
        updateTimeS: RELOGIO_DA_ORDEM_S,
        fonte: 'get_order_detail',
      },
    ]);
    // E a previsão do backstop é a do MESMO fold puro.
    expect(b.previsao.diagnosticos.estadoAlvo).toBe(ESTADO_FRETE.despachoAutorizado);
    // ÂNCORA do item 28 do registro: os dois lados discordam, e é isso que o
    // relatório coloca lado a lado.
    expect(s.linhas[0]!.observado!.fulfillmentStatus).toBe('LOGISTICS_REQUEST_CREATED');
    expect(s.linhas[0]!.observado!.fonte).toBe('get_package_detail');
  });

  it('7b. um `update_time` zerado cai no MESMO ladder do importador: nowUs, nunca "sem relógio"', async () => {
    // ⚠️ Zero-fill é o estilo da casa da Shopee, e `segundosShopeeUtilizaveis`
    // lê o `0` como AUSÊNCIA. Aí toda observação do backstop fica sem relógio e
    // o `relogioDaOrdemUs` passa a ser consultado — é o único caminho em que
    // esse argumento é alcançável, e é onde o passo 5 usa `nowUs`.
    const db = pedidoComVolumes([PKG_A]);
    const base = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response;
    const semRelogio = {
      order_list: [{ ...base.order_list[0]!, update_time: 0 }],
    } as unknown as ShopeeOrderDetail;
    const fake = cliente([linha()], semRelogio);

    const s = await simular(db, fake, null);
    const b = s.backstop!;

    expect(b.relogioDoPedidoS).toBeNull();
    expect(b.observados[0]!.updateTimeS).toBeNull();
    // O fold recebeu `nowUs` e carimbou o diário com ele.
    const pacotes = (b.previsao.patch!.freteInicial.pacotes ?? []) as Record<string, unknown>[];
    expect(pacotes[0]!.atualizadoEm).toBe(NOW_US);
    // ÂNCORA: com o relógio de verdade, o carimbo é o da ORDER e não o `nowUs`.
    const comRelogio = await simular(pedidoComVolumes([PKG_A]), cliente([linha()]), null);
    const pacotesOk = (comRelogio.backstop!.previsao.patch!.freteInicial.pacotes ?? []) as Record<
      string,
      unknown
    >[];
    expect(pacotesOk[0]!.atualizadoEm).toBe(microsDeSegundosShopee(RELOGIO_DA_ORDEM_S));
  });
});

/* ========================================================================== */
/*  8 · o teto de 50 da chamada em lote                                       */
/* ========================================================================== */

describe('simularRastreioShopee — o teto do get_package_detail', () => {
  it('8. 51 pacotes viram UMA chamada de 50 e um aviso de truncamento', async () => {
    // `assertPackageDetailParams` RECUSA uma lista maior que 50 antes do fetch,
    // então sem o corte o ensaio morreria num ShopeeConfigError em vez de
    // imprimir um relatório.
    const numeros = Array.from({ length: 51 }, (_, i) => `OFG${String(i).padStart(15, '0')}`);
    // Uma order sem `package_list`, para que o conjunto venha SÓ dos volumes e
    // a contagem seja exatamente a que este teste fala.
    const semPacotes = { order_list: [] } as unknown as ShopeeOrderDetail;
    const fake = cliente([], semPacotes);

    const s = await simular(pedidoComVolumes(numeros), fake, null);

    expect(s.alvos).toHaveLength(51);
    expect(s.truncadoNoLimite).toBe(true);
    expect(fake.pacotes).toHaveLength(1);
    expect(fake.pacotes[0]!.packageNumbers).toHaveLength(50);
    expect(s.linhas).toHaveLength(50);
    // ÂNCORA (near-miss): exatamente 50 NÃO trunca, e as 50 são pedidas.
    const noLimite = await simular(
      pedidoComVolumes(numeros.slice(0, 50)),
      cliente([], semPacotes),
      null,
    );
    expect(noLimite.truncadoNoLimite).toBe(false);
    expect(noLimite.linhas).toHaveLength(50);
  });
});

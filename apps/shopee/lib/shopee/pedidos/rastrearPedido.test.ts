import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
  type FreteDoPedido,
} from '@delfrance/schemas';
import type { ShopeeClient, ShopeePackageDetail } from '@delfrance/integrations-shopee';
import { ShopeeApiError, SHOPEE_ERROR_KIND } from '@delfrance/integrations-shopee';

import { FakeDb, asDb } from '../testing/fakeDb';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import type { ShopeeNotificationPayload } from '../notificacoes/notificacao';
import type { DiagnosticoPushFrete } from './fretePushShopee';
import { makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import {
  ACAO_FRETE_PACOTE_AUSENTE,
  ACAO_FRETE_SEM_PEDIDO,
  rastrearPedidoShopee,
  type AlvoDeRastreioShopee,
} from './rastrearPedido';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, order or buyer.  */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const SHOP_ID = 987654;
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;

/** The `__wire__` SG order's own package, and the doc page's sibling. */
const PKG_A = 'OFG242672552205937';
const PKG_B = 'OFG199593509207187';

/** Wire SECONDS, comfortably past the 2020 floor. */
const T_S = 1_788_973_354;
const AGORA_MS = 1_789_000_000_000;
/** An invented carrier code. Never a real one, and never logged as a VALUE. */
const RASTREIO = 'BR000000001BR';

function diagnostico(over: Partial<DiagnosticoPushFrete> = {}): DiagnosticoPushFrete {
  return {
    code: 4,
    grafiaDoPedido: 'ordersn',
    trackingNoDoPush: RASTREIO,
    statusDoPush: null,
    camposMudados: null,
    shipByDateAntigaS: null,
    shipByDateNovaS: null,
    canalAntigo: null,
    canalNovo: null,
    relogioDoPushS: null,
    ...over,
  };
}

function alvo(over: Partial<AlvoDeRastreioShopee> = {}): AlvoDeRastreioShopee {
  return {
    integracaoId: CONTA,
    shopId: SHOP_ID,
    orderSn: ORDER_SN,
    packageNumber: PKG_A,
    code: 4,
    nowMs: AGORA_MS,
    diagnostico: diagnostico(),
    ...over,
  };
}

/** A `freteInicial` exactly as step 5 seeds it for a Shopee pedido. */
function blocoDeFrete(over: Record<string, unknown> = {}): FreteDoPedido {
  return freteDoPedidoSchema.parse({
    ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
    externalOptionIntegracao: 'shopee',
    ...over,
  });
}

function pedidoSemeado(): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, {
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    itens: {},
    itensIds: [],
    valorCobrado: 31.99,
    lastMarketplaceUpdate: microsDeSegundosShopee(T_S),
    ultimaModificacao: microsDeSegundosShopee(T_S),
    freteInicial: blocoDeFrete(),
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
    update_time: T_S,
    ...over,
  };
}

interface ClienteFake {
  readonly client: ShopeeClient;
  readonly chamadas: { packageNumbers: readonly string[] }[];
}

/**
 * A `ShopeeClient` that answers ONE operation. Every other member is absent on
 * purpose: reaching for one is a routing bug, and a `TypeError` naming it is a
 * better signal than a silent `undefined`.
 */
function clienteQueResponde(rows: readonly (Record<string, unknown> | null)[]): ClienteFake {
  const chamadas: { packageNumbers: readonly string[] }[] = [];
  const client = {
    getPackageDetail: (p: { packageNumbers: readonly string[] }) => {
      chamadas.push(p);
      return Promise.resolve({ package_list: rows } as unknown as ShopeePackageDetail);
    },
  } as unknown as ShopeeClient;
  return { client, chamadas };
}

interface AgendadorFake {
  readonly scheduler: ShopeeTaskScheduler;
  readonly enfileirados: ShopeeNotificationPayload[];
}

function agendador(aoEnfileirar?: () => never): AgendadorFake {
  const enfileirados: ShopeeNotificationPayload[] = [];
  return {
    enfileirados,
    scheduler: {
      enqueue(payload) {
        if (aoEnfileirar) aoEnfileirar();
        enfileirados.push(payload);
        return Promise.resolve();
      },
    },
  };
}

const infos: unknown[][] = [];
const avisos: unknown[][] = [];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    infos.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  infos.length = 0;
  avisos.length = 0;
});

/** The whole log of a run, flattened, so a "never appears" claim is total. */
function logInteiro(): string {
  return [...infos, ...avisos]
    .map((args) => args.map((a) => JSON.stringify(a)).join(' '))
    .join('|');
}

/**
 * The ARM's own lines, separated from the transaction's.
 *
 * ⚠️ `freteTx.ts` logs up to three lines of its own per call, and the arm must
 * not repeat them: this filter is what lets a test say "exactly ONE line from
 * the arm" without counting the transaction's.
 */
const TAG_DO_BRACO = '[shopee/frete] entrega de rastreio';
function linhasDoBraco(): Record<string, unknown>[] {
  return infos
    .filter((args) => args[0] === TAG_DO_BRACO)
    .map((args) => args[1] as Record<string, unknown>);
}

/* -------------------------------------------------------------------------- */
/*                     1/2 — the pedido that is not here yet                   */
/* -------------------------------------------------------------------------- */

describe('rastrearPedidoShopee — o pedido ainda não existe', () => {
  it('1 — gasta ZERO chamadas à Shopee e enfileira EXATAMENTE um code 3 sintético', async () => {
    const db = new FakeDb();
    const cli = clienteQueResponde([linha()]);
    const ag = agendador();

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: ag.scheduler,
    });

    // ⚠️ A economia é a razão de a leitura barata vir ANTES do pull: um pedido
    // ausente seria re-tentado sete vezes pela pista diária, e cada re-tentativa
    // gastaria uma chamada por nada.
    expect(cli.chamadas).toEqual([]);
    expect(r.acao).toBe(ACAO_FRETE_SEM_PEDIDO);
    expect(r.pedidoId).toBe(PEDIDO_ID);
    expect(r.statusMarketplace).toBeNull();
    expect(r.estadoEscrito).toBeNull();
    expect(r.campos).toEqual([]);
    expect(r.sinteticaEnfileirada).toBe(true);

    // UM sintético, com a origem do passo 7 e a grafia que `identidadeDoPush` lê.
    expect(ag.enfileirados).toHaveLength(1);
    expect(ag.enfileirados[0]).toMatchObject({
      code: 3,
      shopId: SHOP_ID,
      timestamp: AGORA_MS,
      data: { ordersn: ORDER_SN, origem: 'rastreio' },
    });
    // Nada foi escrito, e o opLog inteiro é a leitura BARATA e nada mais: a
    // transação nunca abriu, então não há um segundo `get` pelo mesmo caminho.
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
  });

  it('2 — ⚠️ DUAS execuções seguidas enfileiram DOIS sintéticos: não há dedup entre corridas', async () => {
    const db = new FakeDb();
    const ag = agendador();
    const deps = {
      clientFor: () => Promise.resolve(clienteQueResponde([]).client),
      scheduler: ag.scheduler,
    };

    await rastrearPedidoShopee(asDb(db), alvo({ nowMs: AGORA_MS }), deps);
    await rastrearPedidoShopee(asDb(db), alvo({ nowMs: AGORA_MS + 86_400_000 }), deps);

    // ⚠️ O pino HONESTO. O limite do módulo é "≤ 1 + MAX_TENTATIVAS_DEFERRED por
    // ENTREGA", e ele vale porque um `defer` não re-tenta na fila e a pista
    // diária re-conduz UM documento — não porque exista deduplicação aqui. Um
    // teste que afirmasse "o segundo não enfileira" estaria descrevendo um
    // mecanismo que não existe.
    expect(ag.enfileirados).toHaveLength(2);
    // …e o par que tem de ficar DISTINTO: cada corrida carrega o SEU relógio, que
    // é o que dá a cada tentativa o seu próprio documento (`docIdOf` leva o
    // carimbo) em vez de colapsar as duas numa linha só.
    expect(ag.enfileirados[0]!.timestamp).not.toBe(ag.enfileirados[1]!.timestamp);
  });

  it('3 — a válvula (`SHOPEE_TASKS_DISABLED`) é CONTIDA: sinteticaEnfileirada false, e um warn', async () => {
    const db = new FakeDb();
    const ag = agendador(() => {
      throw new ShopeeTasksDisabledError();
    });

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(clienteQueResponde([]).client),
      scheduler: ag.scheduler,
    });

    // Modo configurado, não falha: deixar a entrega falhar transformaria o modo
    // "só varredura" numa linha `failed` por push de remessa.
    expect(r.acao).toBe(ACAO_FRETE_SEM_PEDIDO);
    expect(r.sinteticaEnfileirada).toBe(false);
    expect(ag.enfileirados).toEqual([]);
    expect(avisos).toHaveLength(1);
    expect(JSON.stringify(avisos[0])).toContain('válvula');
  });

  it('4 — ⚠️ a quase-falha da válvula: QUALQUER outra falha de enfileiramento SOBE', async () => {
    const db = new FakeDb();
    const bug = new TypeError('queue path undefined');
    const ag = agendador(() => {
      throw bug;
    });

    await expect(
      rastrearPedidoShopee(asDb(db), alvo(), {
        clientFor: () => Promise.resolve(clienteQueResponde([]).client),
        scheduler: ag.scheduler,
      }),
    ).rejects.toBe(bug);
  });
});

/* -------------------------------------------------------------------------- */
/*                   5/6/7 — the pull, and the reconciliation                  */
/* -------------------------------------------------------------------------- */

describe('rastrearPedidoShopee — o pull e a reconciliação', () => {
  it('5 — com o pedido presente gasta EXATAMENTE uma chamada, pelo pacote nomeado, e escreve', async () => {
    const db = pedidoSemeado();
    const cli = clienteQueResponde([linha()]);
    const ag = agendador();

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: ag.scheduler,
    });

    expect(cli.chamadas).toEqual([{ packageNumbers: [PKG_A] }]);
    expect(r.acao).toBe('atualizado');
    expect(r.pedidoId).toBe(PEDIDO_ID);
    expect(r.statusMarketplace).toBe('LOGISTICS_REQUEST_CREATED');
    expect(r.estadoEscrito).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(r.campos).toContain('freteInicial.pacotes');
    // Nenhum sintético: o pedido existe.
    expect(ag.enfileirados).toEqual([]);

    // O que a transação gravou, medido no documento e não no resultado.
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(frete.codRastreio).toBe(RASTREIO);
    const diario = frete.pacotes as Record<string, unknown>[];
    expect(diario).toHaveLength(1);
    expect(diario[0]).toMatchObject({
      numero: PKG_A,
      estadoMarketplace: 'LOGISTICS_REQUEST_CREATED',
      fonte: 'get_package_detail',
    });

    // ⚠️ A ÚNICA conversão deste caminho, medida no documento: o `nowMs` do
    // handler entra na transação como MICROssegundos (sítio µs 6). Um
    // `millisToMicros` esquecido daria `1.789e12`, que é MENOR que o
    // `ultimaModificacao` já armazenado (µs) — então o `maiorUs` da transação
    // manteria o valor velho e o carimbo não andaria. Este par de números é o
    // que separa os dois casos.
    expect(db.store[PEDIDO_PATH]!.data.ultimaModificacao).toBe(AGORA_MS * 1000);
    expect(db.store[PEDIDO_PATH]!.data.ultimaModificacao).not.toBe(AGORA_MS);
  });

  it('6 — ⚠️ reconcilia por `package_number`, NUNCA por posição', async () => {
    const db = pedidoSemeado();
    // A resposta traz UMA linha, e ela é de OUTRO pacote. Por posição isto seria
    // "a linha 0", e o diário do pacote A receberia o estado do pacote B.
    const cli = clienteQueResponde([linha({ package_number: PKG_B })]);

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: agendador().scheduler,
    });

    expect(r.acao).toBe(ACAO_FRETE_PACOTE_AUSENTE);
    expect(r.pedidoId).toBeNull();
    expect(r.detail).toContain(PKG_A);
    expect(r.detail).toContain('linhas ilegíveis: 0');
    // Nada foi escrito, e o opLog é só a leitura barata: a transação nunca abriu.
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    expect(db.writes).toEqual([]);

    // ÂNCORA: a MESMA resposta, pedindo o pacote B, resolve — então o resultado
    // acima é a reconciliação e não um fake quebrado.
    const db2 = pedidoSemeado();
    const cli2 = clienteQueResponde([linha({ package_number: PKG_B })]);
    const r2 = await rastrearPedidoShopee(asDb(db2), alvo({ packageNumber: PKG_B }), {
      clientFor: () => Promise.resolve(cli2.client),
      scheduler: agendador().scheduler,
    });
    expect(r2.acao).toBe('atualizado');
  });

  it('7 — uma linha ILEGÍVEL ao lado da pedida ainda resolve, e a contagem viaja', async () => {
    const db = pedidoSemeado();
    // O `.catch(null)` é por ELEMENTO: uma linha que não parseia vira `null` e
    // custa uma CONTAGEM, nunca a entrega.
    const cli = clienteQueResponde([null, linha()]);

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: agendador().scheduler,
    });

    expect(r.acao).toBe('atualizado');
    expect(linhasDoBraco()[0]!.ilegiveis).toBe(1);

    // …e o par: quando a ilegível é a ÚNICA linha, o pacote está ausente e a
    // contagem é o que diagnostica por quê.
    const db2 = pedidoSemeado();
    const cli2 = clienteQueResponde([null]);
    const r2 = await rastrearPedidoShopee(asDb(db2), alvo(), {
      clientFor: () => Promise.resolve(cli2.client),
      scheduler: agendador().scheduler,
    });
    expect(r2.acao).toBe(ACAO_FRETE_PACOTE_AUSENTE);
    expect(r2.detail).toContain('linhas ilegíveis: 1');
  });

  it('8 — uma linha cujo `package_number` é a sentinela `-` conta como pacote AUSENTE', async () => {
    const db = pedidoSemeado();
    // Esta página amostra `-` como AUSÊNCIA no próprio corpo, então uma linha
    // assim não identifica pacote nenhum. Ela chega aqui pelo `find`, porque a
    // string pedida nunca é `-` (o `assertPackageDetailParams` recusa antes).
    const cli = clienteQueResponde([linha({ package_number: PKG_A, tracking_number: '-' })]);

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: agendador().scheduler,
    });

    // O `-` no TRACKING é uma ausência e não impede nada; o pacote resolve.
    expect(r.acao).toBe('atualizado');
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    // ⚠️ E a sentinela NUNCA vira um `codRastreio`.
    expect(frete.codRastreio).toBeNull();
  });

  it('9 — uma falha do pull SOBE, com o erro ORIGINAL (a disposição é do braço)', async () => {
    const db = pedidoSemeado();
    const err = new ShopeeApiError('parâmetro', {
      code: 'error_param',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: '/api/v2/order/get_package_detail',
    });

    await expect(
      rastrearPedidoShopee(asDb(db), alvo(), {
        clientFor: () => Promise.reject(err),
        scheduler: agendador().scheduler,
      }),
    ).rejects.toBe(err);
  });
});

/* -------------------------------------------------------------------------- */
/*                          10/11 — the one log line                           */
/* -------------------------------------------------------------------------- */

describe('rastrearPedidoShopee — a única linha de log', () => {
  it('10 — os BOOLEANOS de rastreio e a divergência push-vs-pull são o que ela carrega', async () => {
    const db = pedidoSemeado();
    // O push disse um token; o pull respondeu OUTRO. Essa é a pergunta do item 28
    // do registro, e esta linha é o único lugar onde os dois se encontram.
    const cli = clienteQueResponde([linha({ fulfillment_status: 'LOGISTICS_PICKUP_DONE' })]);

    await rastrearPedidoShopee(
      asDb(db),
      alvo({
        code: 30,
        diagnostico: diagnostico({
          code: 30,
          trackingNoDoPush: null,
          statusDoPush: 'LOGISTICS_REQUEST_CREATED',
          relogioDoPushS: T_S,
        }),
      }),
      { clientFor: () => Promise.resolve(cli.client), scheduler: agendador().scheduler },
    );

    // ⚠️ UMA linha do braço, e a transação tem as suas: a pendência do wave 3 é
    // que o braço não repita nenhuma delas.
    const doBraco = linhasDoBraco();
    expect(doBraco).toHaveLength(1);
    const linhaLog = doBraco[0]!;
    expect(linhaLog).toMatchObject({
      integracaoId: CONTA,
      shopId: SHOP_ID,
      orderSn: ORDER_SN,
      pedidoId: PEDIDO_ID,
      packageNumber: PKG_A,
      code: 30,
      acao: 'atualizado',
      statusMarketplace: 'LOGISTICS_PICKUP_DONE',
      statusDoPush: 'LOGISTICS_REQUEST_CREATED',
      divergePushVsPull: true,
      // ⚠️ BOOLEANOS, nunca o número. O par é o que responde "o push e o pull
      // concordaram que existe um?", que é a pergunta.
      temTrackingNoPush: false,
      temTrackingNoPull: true,
      relogioDoPushS: T_S,
      relogioDoPacoteS: T_S,
      ilegiveis: 0,
      sintetica: false,
    });

    // …e o par que tem de ficar DISTINTO: tokens IGUAIS não divergem.
    infos.length = 0;
    const db2 = pedidoSemeado();
    const cli2 = clienteQueResponde([linha({ fulfillment_status: 'LOGISTICS_REQUEST_CREATED' })]);
    await rastrearPedidoShopee(
      asDb(db2),
      alvo({ diagnostico: diagnostico({ statusDoPush: 'LOGISTICS_REQUEST_CREATED' }) }),
      { clientFor: () => Promise.resolve(cli2.client), scheduler: agendador().scheduler },
    );
    expect(linhasDoBraco()[0]!.divergePushVsPull).toBe(false);
  });

  it('11 — ⚠️ nenhuma linha de log carrega um VALOR de rastreio, endereço ou motorista', async () => {
    const db = pedidoSemeado();
    // A linha do pull carrega os campos de PII que a página documenta. Eles
    // atravessam o `.passthrough()` do schema — e é exatamente por isso que o
    // negativo vale alguma coisa: os dados ESTÃO no objeto que o handler leu.
    const cli = clienteQueResponde([
      linha({
        recipient_address: { name: 'NOME DO COMPRADOR', full_address: 'RUA X, 123' },
        driver_info: { driver_name: 'MOTORISTA', driver_phone: '+55 11 90000-0000' },
        virtual_contact_number: '+55 11 90000-0001',
      }),
    ]);

    await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: agendador().scheduler,
    });

    const tudo = logInteiro();
    // ÂNCORA: a linha existe e nomeia o pacote, então o negativo não é vácuo.
    expect(tudo).toContain(PKG_A);
    for (const proibido of [
      RASTREIO,
      'NOME DO COMPRADOR',
      'RUA X, 123',
      'MOTORISTA',
      '90000-0000',
      '90000-0001',
      'recipient_address',
      'driver_info',
      'virtual_contact_number',
    ]) {
      expect(tudo, proibido).not.toContain(proibido);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pedidoCollection } from '@delfrance/data/admin/collections';
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
  ShopeePackageDetail,
  ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';
import {
  ShopeeApiError,
  SHOPEE_ERROR_KIND,
  shopeePackageDetailRowSchema,
} from '@delfrance/integrations-shopee';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import type { ShopeeNotificationPayload } from '../notificacoes/notificacao';
import { observadoDoPacoteDetalhe, type DiagnosticoPushFrete } from './fretePushShopee';
import { makePedidoIdShopee } from './orderIds';
import { microsDeSegundosShopee } from './orderMapping';
import {
  ACAO_FRETE_PACOTE_AUSENTE,
  ACAO_FRETE_SEM_PEDIDO,
  rastrearPedidoShopee,
  type AlvoDeRastreioShopee,
} from './rastrearPedido';
import { avisarNfeShopee, chaveAvisoNfeShopee } from '../nfe/avisoNfe';
import { MOTIVO_NFE_SHOPEE } from '../nfe/errosNfe';
import {
  elegibilidadeDoArranjoAutomatico,
  observacaoDoPacoteShopee,
} from '../etiqueta/faseEtiqueta';
import {
  CLASSE_DESPACHO_PENDENTE,
  RESOLUCAO_AVISO_DESPACHO,
  acoesDeAvisoDoDespacho,
  chaveAvisoDespachoPendente,
  chaveAvisoEtiquetaComPrazo,
  executarAcoesDeAvisoDoDespacho,
  type EncerramentoDespachoShopee,
} from '../avisos/despachoAutomatico';
// ⚠️ TYPES only — the handler under test must never load the arrange either.
import type {
  ArranjadorDePacote,
  EntradaArranjoAutomatico,
  ResultadoArranjoAutomatico,
} from './arranjoAutomatico';

/**
 * Step 15b — the two aviso resolvers are reached through a DELEGATING seam, so
 * a test can read their CALL ORDER against the arrange, read what the despacho
 * one was handed, and make it fail.
 *
 * ⚠️ Both delegate to the REAL implementation unless `seam.erroDespacho` is
 * set, so every other assertion in this file (the step-14 ones included) is
 * still about production code and not about a double.
 */
const seam = vi.hoisted(() => ({
  ordem: [] as string[],
  encerramentos: [] as EncerramentoDespachoShopee[],
  erroDespacho: null as unknown,
}));
vi.mock('../nfe/avisoNfe', async (importOriginal) => {
  const real = await importOriginal<typeof import('../nfe/avisoNfe')>();
  return {
    ...real,
    resolverAvisoNfeSeEncerrado: async (
      ...args: Parameters<typeof real.resolverAvisoNfeSeEncerrado>
    ): ReturnType<typeof real.resolverAvisoNfeSeEncerrado> => {
      seam.ordem.push('resolver-nfe');
      return real.resolverAvisoNfeSeEncerrado(...args);
    },
  };
});
vi.mock('../avisos/despachoAutomatico', async (importOriginal) => {
  const real = await importOriginal<typeof import('../avisos/despachoAutomatico')>();
  return {
    ...real,
    resolverAvisosDeDespachoSeEncerrado: async (
      ...args: Parameters<typeof real.resolverAvisosDeDespachoSeEncerrado>
    ): ReturnType<typeof real.resolverAvisosDeDespachoSeEncerrado> => {
      seam.ordem.push('resolver-despacho');
      seam.encerramentos.push(args[1]);
      if (seam.erroDespacho != null) throw seam.erroDespacho;
      return real.resolverAvisosDeDespachoSeEncerrado(...args);
    },
  };
});

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
  seam.ordem.length = 0;
  seam.encerramentos.length = 0;
  seam.erroDespacho = null;
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

/* -------------------------------------------------------------------------- */
/*      step 14 (#1522) — o gancho que resolve o aviso de NF-e (R-k)          */
/* -------------------------------------------------------------------------- */

const AVISO_NFE_PATH = `avisos/${chaveAvisoNfeShopee(CONTA, PEDIDO_ID)}`;

/**
 * Abre o aviso de NF-e do pedido pelo PRODUTOR real, como o handler do passo
 * 14 faria. A criação não usa o incremento. Zera `caminhos` ao final.
 */
async function abrirAvisoNfe(db: FakeDb): Promise<void> {
  await avisarNfeShopee(
    asDb(db),
    {
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      numero: ORDER_SN,
      motivo: MOTIVO_NFE_SHOPEE.cnpjDivergente,
      excerto: null,
    },
    { increment: (by: number) => ({ __increment: by }), nowMs: AGORA_MS - 60_000 },
  );
  expect(db.store[AVISO_NFE_PATH]!.data.resolvidoEm).toBeNull();
  db.caminhos.length = 0;
}

/** Um pedido semeado COM o aviso de NF-e já aberto. */
async function pedidoComAvisoNfe(): Promise<FakeDb> {
  const db = pedidoSemeado();
  await abrirAvisoNfe(db);
  return db;
}

/** O pedido semeado, com o bloco de frete num estado que o OPERADOR gravou. */
function pedidoComFreteEm(estado: FreteDoPedido['estado']): FakeDb {
  const db = pedidoSemeado();
  db.seed(PEDIDO_PATH, { ...db.store[PEDIDO_PATH]!.data, freteInicial: blocoDeFrete({ estado }) });
  return db;
}

/** As dependências de uma entrega cujo pull responde `fulfillment_status`. */
function entregaCom(fulfillmentStatus: string) {
  return {
    clientFor: () =>
      Promise.resolve(
        clienteQueResponde([linha({ fulfillment_status: fulfillmentStatus })]).client,
      ),
    scheduler: agendador().scheduler,
  };
}

function avisoNfe(db: FakeDb): Record<string, unknown> {
  return db.store[AVISO_NFE_PATH]!.data;
}

describe('rastrearPedidoShopee — o gancho do aviso de NF-e (passo 14)', () => {
  it('um pacote escrito no conjunto de remoção resolve o aviso aberto com `frete-despachado`', async () => {
    const db = await pedidoComAvisoNfe();

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(clienteQueResponde([linha()]).client),
      scheduler: agendador().scheduler,
    });

    expect(r.estadoEscrito).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(avisoNfe(db)).toMatchObject({
      resolvidoEm: AGORA_MS * 1000,
      resolucaoMotivo: 'frete-despachado',
    });
    expect(linhasDoBraco()[0]!.avisoNfeResolvido).toBe(true);
  });

  it('QUASE-ERRO: um pacote escrito FORA do conjunto (`despachoAutorizado`) não resolve e nem LÊ o aviso', async () => {
    const db = await pedidoComAvisoNfe();

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () =>
        Promise.resolve(
          clienteQueResponde([linha({ fulfillment_status: 'LOGISTICS_READY' })]).client,
        ),
      scheduler: agendador().scheduler,
    });

    expect(r.acao).toBe('atualizado');
    expect(r.estadoEscrito).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(db.caminhos).not.toContain(AVISO_NFE_PATH);
    expect(avisoNfe(db).resolvidoEm).toBeNull();
    expect(linhasDoBraco()[0]!.avisoNfeResolvido).toBe(false);
  });

  it('a REPETIÇÃO de uma entrega JÁ no conjunto de remoção (`ignorado-sem-mudanca`) resolve o aviso aberto (R2-1)', async () => {
    // O PAR do quase-erro abaixo: a mesma repetição sem escrita, mas de um
    // pacote que a Shopee já pôs em `aguardandoPostagem`. O frete não muda, e
    // ainda assim o gancho recebe o estado — é o que torna a nova tentativa
    // real depois de uma resolução que falhou.
    const db = pedidoSemeado();
    const deps = entregaCom('LOGISTICS_REQUEST_CREATED');
    await rastrearPedidoShopee(asDb(db), alvo(), deps);
    await abrirAvisoNfe(db);

    const r = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.estadoEscrito).toBeNull();
    expect(avisoNfe(db)).toMatchObject({
      resolvidoEm: AGORA_MS * 1000,
      resolucaoMotivo: 'frete-despachado',
    });
    expect(linhasDoBraco()[1]!.avisoNfeResolvido).toBe(true);
  });

  it('QUASE-ERRO: a REPETIÇÃO de uma entrega PRÉ-despacho (`despachoAutorizado`) não escreve o frete, e o gancho não LÊ nada', async () => {
    const db = pedidoSemeado();
    const deps = entregaCom('LOGISTICS_READY');
    await rastrearPedidoShopee(asDb(db), alvo(), deps);
    db.caminhos.length = 0;

    const r = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(db.caminhos).not.toContain(AVISO_NFE_PATH);
  });

  it('⚠️ QUASE-ERRO: um frete `empacotado` pelo OPERADOR está no conjunto de remoção, mas a Shopee não o confirma — não resolve e nem LÊ o aviso', async () => {
    // `empacotado` é um estado de DEPÓSITO: a escada o mantém contra um pull
    // mais baixo (`regressivo`), então o bloco guarda um membro do conjunto de
    // remoção enquanto o diário da Shopee diz `despachoAutorizado`. Entregar o
    // estado GUARDADO ao gancho fecharia o aviso de uma NF-e que a Shopee ainda
    // não aceitou — um problema escondido. Nem na primeira entrega, nem na
    // repetição.
    const db = pedidoComFreteEm(ESTADO_FRETE.empacotado);
    await abrirAvisoNfe(db);
    const deps = entregaCom('LOGISTICS_READY');

    const r1 = await rastrearPedidoShopee(asDb(db), alvo(), deps);
    const r2 = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r1.acao).toBe('atualizado');
    expect(r2.acao).toBe('ignorado-sem-mudanca');
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe(ESTADO_FRETE.empacotado);
    expect(db.caminhos).not.toContain(AVISO_NFE_PATH);
    expect(avisoNfe(db).resolvidoEm).toBeNull();
  });

  it('⚠️ uma falha do Firestore na resolução SOBE, e a REPETIÇÃO da entrega resolve (mutante 57, R2-1)', async () => {
    const db = await pedidoComAvisoNfe();
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falhasDeUpdate.set(AVISO_NFE_PATH, falha);
    const deps = entregaCom('LOGISTICS_REQUEST_CREATED');

    await expect(rastrearPedidoShopee(asDb(db), alvo(), deps)).rejects.toBe(falha);
    // O frete já tinha commitado, e o aviso segue aberto.
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(avisoNfe(db).resolvidoEm).toBeNull();

    // A fila re-entrega a MESMA entrega: o frete volta `ignorado-sem-mudanca`, e
    // o gancho tenta a resolução de novo — agora com sucesso.
    db.falhasDeUpdate.delete(AVISO_NFE_PATH);
    const r = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(avisoNfe(db)).toMatchObject({
      resolvidoEm: AGORA_MS * 1000,
      resolucaoMotivo: 'frete-despachado',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*     step 15b (#1744) — o resolvedor do despacho e o arranjo automático       */
/* -------------------------------------------------------------------------- */

/** Announcement 1573's first Turbo channel — a fixture of the wire's own list. */
const CANAL_TURBO = 90011;

/**
 * A package the automatic arrange must ship: a Turbo channel, READY, not
 * arranged, no invoice pending, no terms — PARSED by the real schema, so the
 * row the handler hands over carries every field `observado` drops.
 */
function linhaTurbo(over: Record<string, unknown> = {}): ShopeePackageDetailRow {
  return shopeePackageDetailRowSchema.parse(
    linha({
      logistics_channel_id: CANAL_TURBO,
      fulfillment_status: 'LOGISTICS_READY',
      is_shipment_arranged: false,
      ...over,
    }),
  );
}

/**
 * A client that answers `get_package_detail` and RECORDS every other member a
 * caller reaches for, rejecting it — so "exactly ONE Shopee call" is a claim
 * about the WHOLE client, not about the one member a fake happens to define.
 */
function clienteQueContaTudo(rows: readonly ShopeePackageDetailRow[]): {
  readonly client: ShopeeClient;
  readonly chamadas: string[];
} {
  const chamadas: string[] = [];
  const client = new Proxy(
    {},
    {
      get(_alvo, nome) {
        // `then` must stay absent, or `Promise.resolve(client)` would adopt it.
        if (typeof nome !== 'string' || nome === 'then') return undefined;
        return () => {
          chamadas.push(nome);
          return nome === 'getPackageDetail'
            ? Promise.resolve({ package_list: rows } as unknown as ShopeePackageDetail)
            : Promise.reject(new TypeError(`chamada Shopee inesperada: ${nome}`));
        };
      },
    },
  ) as unknown as ShopeeClient;
  return { client, chamadas };
}

function resultadoArranjo(
  over: Partial<ResultadoArranjoAutomatico> = {},
): ResultadoArranjoAutomatico {
  return {
    desfecho: 'programado',
    canalId: CANAL_TURBO,
    fase: 'programar',
    motivo: null,
    shopeeCode: null,
    operacao: null,
    semPacote: false,
    ...over,
  };
}

interface ArranjadorFake {
  readonly arranjar: ArranjadorDePacote;
  readonly entradas: EntradaArranjoAutomatico[];
  readonly clientes: ShopeeClient[];
}

/** A fake hook that records each call — into the shared ORDER log too. */
function arranjador(resultado: ResultadoArranjoAutomatico = resultadoArranjo()): ArranjadorFake {
  const entradas: EntradaArranjoAutomatico[] = [];
  const clientes: ShopeeClient[] = [];
  return {
    entradas,
    clientes,
    arranjar: (_db, client, e) => {
      seam.ordem.push('arranjar');
      entradas.push(e);
      clientes.push(client);
      return Promise.resolve(resultado);
    },
  };
}

/** The deps of a delivery whose pull answers `rows`, with the fake hook wired. */
function entregaTurbo(rows: readonly ShopeePackageDetailRow[], arr: ArranjadorFake) {
  return {
    clientFor: () => Promise.resolve(clienteQueResponde(rows).client),
    scheduler: agendador().scheduler,
    arranjar: arr.arranjar,
  };
}

const AVISO_DESPACHO_NFE_PATH = `avisos/${chaveAvisoDespachoPendente(
  CONTA,
  PEDIDO_ID,
  PKG_A,
  CLASSE_DESPACHO_PENDENTE.nfe,
)}`;

/**
 * Abre o aviso `despachoAutomaticoPendente` (classe `nfe`) do pacote pelo
 * EXECUTOR real do produtor, como o gancho faria ao ver a nota pendente. A
 * criação não usa o incremento. Zera `caminhos` e a ordem ao final.
 */
async function abrirAvisoDespachoNfe(db: FakeDb): Promise<void> {
  const nowMs = AGORA_MS - 60_000;
  await executarAcoesDeAvisoDoDespacho(
    asDb(db),
    {
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      orderSn: ORDER_SN,
      packageNumber: PKG_A,
      linha: linhaTurbo({ invoice_pending: { status: 'pending' } }),
      nowMs,
      estadoFreteConfirmado: null,
    },
    [{ tipo: 'abrir-despacho', classe: CLASSE_DESPACHO_PENDENTE.nfe, motivo: 'nfe-pendente' }],
    { increment: (by: number) => ({ __increment: by }), nowMs },
  );
  expect(db.store[AVISO_DESPACHO_NFE_PATH]!.data.resolvidoEm).toBeNull();
  db.caminhos.length = 0;
  seam.ordem.length = 0;
}

/** Every key the arm's ONE line carries — a CLOSED list, so a new one is looked at. */
const CAMPOS_DA_LINHA_DO_BRACO = [
  'integracaoId',
  'shopId',
  'orderSn',
  'pedidoId',
  'packageNumber',
  'code',
  'acao',
  'estadoEscrito',
  'campos',
  'statusMarketplace',
  'statusDoPush',
  'camposMudados',
  'divergePushVsPull',
  'temTrackingNoPush',
  'temTrackingNoPull',
  'relogioDoPushS',
  'relogioDoPacoteS',
  'ilegiveis',
  'sintetica',
  'avisoNfeResolvido',
  'despachoResolvidos',
  'etiquetaResolvida',
  'acaoArranjo',
  'motivoArranjo',
  'canalArranjo',
  'faseArranjo',
  'shopeeCodeArranjo',
  'temPreparacaoAutomatica',
] as const;

describe('rastrearPedidoShopee — o arranjo automático (passo 15b): QUANDO roda', () => {
  it('32 — SEM `arranjar` não há arranjo: um pacote Turbo candidato custa EXATAMENTE uma chamada e `arranjo: null`', async () => {
    const row = linhaTurbo();
    // ÂNCORA: a linha É uma candidata para o gancho real — sem isto o negativo
    // abaixo seria vácuo (um pacote que o gancho recusaria de graça).
    expect(elegibilidadeDoArranjoAutomatico(observacaoDoPacoteShopee(row)).tipo).toBe('candidato');

    const db = pedidoSemeado();
    const cli = clienteQueContaTudo([row]);
    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(cli.client),
      scheduler: agendador().scheduler,
    });

    // ⚠️ É o que mantém `rastrear:pedido --live` (que não passa deps) longe do
    // `ship_order`: um padrão aqui leria a ordem, os parâmetros, e despacharia.
    expect(cli.chamadas).toEqual(['getPackageDetail']);
    expect(r.acao).toBe('atualizado');
    expect(r.arranjo).toBeNull();
    expect(linhasDoBraco()[0]).toMatchObject({
      acaoArranjo: null,
      motivoArranjo: null,
      canalArranjo: null,
      faseArranjo: null,
      shopeeCodeArranjo: null,
    });
    // E ninguém abriu aviso nenhum.
    expect(Object.keys(db.store).filter((p) => p.startsWith('avisos/'))).toEqual([]);

    // O PAR: a MESMA entrega, com o gancho ligado, arranja UMA vez, no MESMO
    // cliente, com a linha FRESCA do pull e o relógio da tarefa.
    const db2 = pedidoSemeado();
    const cli2 = clienteQueContaTudo([row]);
    const arr = arranjador();
    const r2 = await rastrearPedidoShopee(asDb(db2), alvo(), {
      clientFor: () => Promise.resolve(cli2.client),
      scheduler: agendador().scheduler,
      arranjar: arr.arranjar,
    });
    expect(arr.entradas).toHaveLength(1);
    expect(arr.clientes[0] === cli2.client).toBe(true);
    expect(arr.entradas[0]).toEqual({
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      orderSn: ORDER_SN,
      packageNumber: PKG_A,
      linha: row,
      nowMs: AGORA_MS,
      // The transaction's CONFIRMED estado — the READY row it just wrote.
      estadoFreteConfirmado: ESTADO_FRETE.despachoAutorizado,
    });
    // ⚠️ A linha, nunca o `observado`: só ela carrega o que o gancho decide.
    expect(arr.entradas[0]!.linha).toBe(row);
    expect(arr.entradas[0]!.linha.is_shipment_arranged).toBe(false);
    expect(r2.arranjo).toEqual(resultadoArranjo());
    // O fake não chama a Shopee: a ÚNICA chamada continua sendo o pull.
    expect(cli2.chamadas).toEqual(['getPackageDetail']);
  });

  it('34 — uma REPETIÇÃO (`ignorado-sem-mudanca`) AINDA arranja: o gate nunca é `acao === atualizado`', async () => {
    const db = pedidoSemeado();
    const arr = arranjador();
    const deps = entregaTurbo([linhaTurbo()], arr);

    const r1 = await rastrearPedidoShopee(asDb(db), alvo(), deps);
    const r2 = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r1.acao).toBe('atualizado');
    // ⚠️ A repetição é o caminho NORMAL de um arranjo que ainda não aconteceu:
    // o frete não muda, e um gate em `atualizado` perderia o pedido para o
    // cancelamento automático da Shopee.
    expect(r2.acao).toBe('ignorado-sem-mudanca');
    expect(arr.entradas).toHaveLength(2);
    expect(r2.arranjo).toEqual(resultadoArranjo());
    expect(linhasDoBraco()[1]!.acaoArranjo).toBe('programado');
  });

  it('35 — um push ATRASADO (`ignorado-obsoleto`) AINDA arranja: a linha que ele lê é fresca', async () => {
    const db = pedidoSemeado();
    const arr = arranjador();
    await rastrearPedidoShopee(
      asDb(db),
      alvo(),
      entregaTurbo([linhaTurbo({ update_time: T_S + 600 })], arr),
    );

    // Um relógio de pacote MAIS VELHO que o guardado — o lag de leitura depois
    // de uma escrita, ou uma réplica atrasada.
    const r = await rastrearPedidoShopee(
      asDb(db),
      alvo(),
      entregaTurbo(
        [linhaTurbo({ update_time: T_S, fulfillment_status: 'LOGISTICS_NOT_START' })],
        arr,
      ),
    );

    expect(r.acao).toBe('ignorado-obsoleto');
    expect(arr.entradas).toHaveLength(2);
    expect(arr.entradas[1]!.linha.fulfillment_status).toBe('LOGISTICS_NOT_START');
    expect(r.arranjo).toEqual(resultadoArranjo());
    // ⚠️ Q2-F1: the hook is handed the transaction's CONFIRMED estado — the
    // NEWER diary's (READY ⇒ despachoAutorizado) — never the stale row's
    // (NOT_START ⇒ iniciado). That pair is what lets the producer refuse an
    // open the newer fact contradicts.
    expect(arr.entradas[1]!.estadoFreteConfirmado).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(arr.entradas[1]!.estadoFreteConfirmado).not.toBe(ESTADO_FRETE.iniciado);
  });

  it('os outros desfechos SEM escrita (`-sem-frete-inicial`, `-desconhecido`) também arranjam', async () => {
    // Sem bloco de frete: o passo 5 ainda não semeou — o pacote existe e é
    // fresco do mesmo jeito.
    const semBloco = new FakeDb();
    semBloco.seed(PEDIDO_PATH, {
      estado: ESTADO_PEDIDO.pago,
      numero: ORDER_SN,
      lastMarketplaceUpdate: microsDeSegundosShopee(T_S),
      ultimaModificacao: microsDeSegundosShopee(T_S),
    });
    const arr1 = arranjador();
    const r1 = await rastrearPedidoShopee(
      asDb(semBloco),
      alvo(),
      entregaTurbo([linhaTurbo()], arr1),
    );
    expect(r1.acao).toBe('ignorado-sem-frete-inicial');
    expect(arr1.entradas).toHaveLength(1);

    // Um token que o passo 7 não conhece, repetido: a segunda entrega não
    // escreve e responde `ignorado-desconhecido`.
    const db = pedidoSemeado();
    const arr2 = arranjador();
    const deps = entregaTurbo(
      [linhaTurbo({ fulfillment_status: 'LOGISTICS_TOKEN_INVENTADO' })],
      arr2,
    );
    await rastrearPedidoShopee(asDb(db), alvo(), deps);
    const r2 = await rastrearPedidoShopee(asDb(db), alvo(), deps);
    expect(r2.acao).toBe('ignorado-desconhecido');
    expect(arr2.entradas).toHaveLength(2);
  });

  it('36 — NÃO arranja no `ignorado-sem-pedido` da TRANSAÇÃO (o pedido sumiu entre a leitura barata e o pull)', async () => {
    const db = pedidoSemeado();
    const arr = arranjador();
    const ag = agendador();
    let pulls = 0;
    const client = {
      getPackageDetail: async () => {
        pulls += 1;
        // O pedido some DEPOIS da leitura barata e ANTES da transação.
        await pedidoCollection.docRef(asDb(db), {}, PEDIDO_ID).delete();
        return { package_list: [linhaTurbo()] } as unknown as ShopeePackageDetail;
      },
    } as unknown as ShopeeClient;

    const r = await rastrearPedidoShopee(asDb(db), alvo(), {
      clientFor: () => Promise.resolve(client),
      scheduler: ag.scheduler,
      arranjar: arr.arranjar,
    });

    // ÂNCORA: é o veredito da TRANSAÇÃO, não a leitura barata — o pull aconteceu.
    expect(pulls).toBe(1);
    expect(r.acao).toBe(ACAO_FRETE_SEM_PEDIDO);
    expect(ag.enfileirados).toHaveLength(1);
    // ⚠️ Sem pedido não há o que arranjar: o code 3 sintético cria o pedido, e
    // a re-entrega seguinte arranja.
    expect(arr.entradas).toEqual([]);
    expect(r.arranjo).toBeNull();
    expect(seam.ordem).not.toContain('arranjar');
  });

  it('36b — nem com o pedido AUSENTE na leitura barata, nem com o pacote AUSENTE do pull', async () => {
    const arr = arranjador();

    // Pedido ausente: nenhum cliente é construído, nenhum resolvedor roda.
    let clientes = 0;
    const r1 = await rastrearPedidoShopee(asDb(new FakeDb()), alvo(), {
      clientFor: () => {
        clientes += 1;
        return Promise.resolve(clienteQueResponde([linhaTurbo()]).client);
      },
      scheduler: agendador().scheduler,
      arranjar: arr.arranjar,
    });
    expect(r1.acao).toBe(ACAO_FRETE_SEM_PEDIDO);
    expect(clientes).toBe(0);
    expect(r1.arranjo).toBeNull();

    // Pacote ausente: a resposta só traz OUTRO pacote.
    const r2 = await rastrearPedidoShopee(
      asDb(pedidoSemeado()),
      alvo(),
      entregaTurbo([linhaTurbo({ package_number: PKG_B })], arr),
    );
    expect(r2.acao).toBe(ACAO_FRETE_PACOTE_AUSENTE);
    expect(r2.arranjo).toBeNull();

    expect(arr.entradas).toEqual([]);
    expect(seam.encerramentos).toEqual([]);
  });
});

describe('rastrearPedidoShopee — o resolvedor do despacho e a ORDEM (passo 15b, R-a/R-k)', () => {
  it('a ordem é NF-e → despacho → arranjo: os resolvedores rodam ANTES do gancho', async () => {
    const db = pedidoSemeado();
    const arr = arranjador();

    await rastrearPedidoShopee(asDb(db), alvo(), entregaTurbo([linhaTurbo()], arr));

    // ⚠️ Resolvedores primeiro: um resolve guiado pelo estado PRÉ-arranjo nunca
    // pode fechar um aviso que o gancho abre nesta MESMA entrega.
    expect(seam.ordem).toEqual(['resolver-nfe', 'resolver-despacho', 'arranjar']);
  });

  it('uma falha do resolvedor do despacho SOBE, e o arranjo NUNCA roda depois dela', async () => {
    const db = pedidoSemeado();
    const arr = arranjador();
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    seam.erroDespacho = falha;

    await expect(
      rastrearPedidoShopee(asDb(db), alvo(), entregaTurbo([linhaTurbo()], arr)),
    ).rejects.toBe(falha);

    expect(seam.ordem).toEqual(['resolver-nfe', 'resolver-despacho']);
    expect(arr.entradas).toEqual([]);
  });

  it('65 — recebe o estado CONFIRMADO e o pacote OBSERVADO em todo desfecho, inclusive na repetição', async () => {
    const db = pedidoSemeado();
    const row = linhaTurbo({ fulfillment_status: 'LOGISTICS_REQUEST_CREATED' });
    const deps = entregaTurbo([row], arranjador());

    const r1 = await rastrearPedidoShopee(asDb(db), alvo(), deps);
    const r2 = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r1.acao).toBe('atualizado');
    expect(r2.acao).toBe('ignorado-sem-mudanca');
    // ⚠️ DUAS chamadas: um resolvedor só no `atualizado` nunca re-tentaria uma
    // resolução que falhou depois de o frete ter commitado.
    const esperado: EncerramentoDespachoShopee = {
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      estadoConfirmado: ESTADO_FRETE.aguardandoPostagem,
      // O caminho do push não tem linha de ordem, então não tem status de ordem.
      orderStatus: null,
      pacotes: [observadoDoPacoteDetalhe(row)!],
    };
    expect(seam.encerramentos).toEqual([esperado, esperado]);
  });

  it('65 — ⚠️ uma falha do Firestore ao RESOLVER o despacho sobe, e a REPETIÇÃO resolve (o gêmeo do mutante 57)', async () => {
    const db = pedidoSemeado();
    await abrirAvisoDespachoNfe(db);
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falhasDeUpdate.set(AVISO_DESPACHO_NFE_PATH, falha);
    const arr = arranjador();
    // O pacote ANDOU: a Shopee já o arranjou (o nosso ou o Auto Call Driver).
    const deps = entregaTurbo(
      [linhaTurbo({ fulfillment_status: 'LOGISTICS_REQUEST_CREATED', is_shipment_arranged: true })],
      arr,
    );

    await expect(rastrearPedidoShopee(asDb(db), alvo(), deps)).rejects.toBe(falha);
    // O frete já tinha commitado, o aviso segue aberto e o gancho não rodou.
    const frete = db.store[PEDIDO_PATH]!.data.freteInicial as Record<string, unknown>;
    expect(frete.estado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(db.store[AVISO_DESPACHO_NFE_PATH]!.data.resolvidoEm).toBeNull();
    expect(arr.entradas).toEqual([]);

    // A fila re-entrega a MESMA entrega: o frete volta `ignorado-sem-mudanca`,
    // e o resolvedor tenta de novo — agora com sucesso, e só então o gancho.
    db.falhasDeUpdate.delete(AVISO_DESPACHO_NFE_PATH);
    const r = await rastrearPedidoShopee(asDb(db), alvo(), deps);

    expect(r.acao).toBe('ignorado-sem-mudanca');
    // RT8 pelo lado do chamador: a chave que o abridor escreveu é a que o
    // resolvedor recomputa a partir do pacote observado.
    expect(db.store[AVISO_DESPACHO_NFE_PATH]!.data).toMatchObject({
      resolvidoEm: AGORA_MS * 1000,
      resolucaoMotivo: RESOLUCAO_AVISO_DESPACHO.arranjado,
    });
    expect(arr.entradas).toHaveLength(1);
    expect(linhasDoBraco().at(-1)).toMatchObject({
      despachoResolvidos: 1,
      etiquetaResolvida: false,
    });
  });
});

/**
 * A hook stand-in that answers a GIVEN result and then runs the REAL producer
 * (the table + the executor, with FakeDb's increment sentinel) on the entrada
 * the HANDLER built — so handler → `estadoFreteConfirmado` → table → writer is
 * production code end to end, while the arrange itself stays unloaded (this
 * file's rule: the handler under test never loads `ship_order`).
 */
function arranjadorComProdutorReal(resultado: ResultadoArranjoAutomatico): ArranjadorFake {
  const base = arranjador(resultado);
  return {
    ...base,
    arranjar: async (db, client, e) => {
      const r = await base.arranjar(db, client, e);
      await executarAcoesDeAvisoDoDespacho(db, e, acoesDeAvisoDoDespacho(e, r), {
        increment,
        nowMs: e.nowMs,
      });
      return r;
    },
  };
}

const AVISO_ETIQUETA_PATH = `avisos/${chaveAvisoEtiquetaComPrazo(CONTA, PEDIDO_ID)}`;

describe('rastrearPedidoShopee — a linha VELHA não reabre o que a nova resolveu (review 3a, Q2-F1)', () => {
  it('⚠️ B: REQUEST_CREATED → PICKUP_DONE → a REQUEST_CREATED velha (`ignorado-obsoleto`) ARRANJA, mas B fica resolvido', async () => {
    const db = pedidoSemeado();
    const arranjado = linhaTurbo({
      fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
      is_shipment_arranged: true,
      update_time: T_S + 100,
    });
    const jaProgramado = arranjadorComProdutorReal(
      resultadoArranjo({ desfecho: 'ja-programado', fase: 'arranjado' }),
    );

    // 1 — arranjado: B ABRE (o QUASE-ERRO — aguardandoPostagem é o pacote que
    // o aviso existe para alertar, e não pode suprimir).
    await rastrearPedidoShopee(asDb(db), alvo(), entregaTurbo([arranjado], jaProgramado));
    expect(jaProgramado.entradas[0]!.estadoFreteConfirmado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(db.store[AVISO_ETIQUETA_PATH]!.data.resolvidoEm).toBeNull();

    // 2 — PICKUP_DONE: o resolvedor entre passos fecha B `coletado`.
    const r2 = await rastrearPedidoShopee(
      asDb(db),
      alvo({ nowMs: AGORA_MS + 60_000 }),
      entregaTurbo(
        [linhaTurbo({ fulfillment_status: 'LOGISTICS_PICKUP_DONE', update_time: T_S + 600 })],
        arranjadorComProdutorReal(
          resultadoArranjo({ desfecho: 'nao-elegivel', fase: 'janela-fechada' }),
        ),
      ),
    );
    expect(r2.estadoEscrito).toBe(ESTADO_FRETE.postado);
    const fechado = { ...db.store[AVISO_ETIQUETA_PATH]!.data };
    expect(fechado.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.coletado);

    // 3 — uma réplica atrasada devolve a linha de (1).
    const r3 = await rastrearPedidoShopee(
      asDb(db),
      alvo({ nowMs: AGORA_MS + 120_000 }),
      entregaTurbo([arranjado], jaProgramado),
    );

    expect(r3.acao).toBe('ignorado-obsoleto');
    // O arranjo AINDA rodou (mutante 35), com o estado CONFIRMADO mais novo.
    expect(jaProgramado.entradas).toHaveLength(2);
    expect(jaProgramado.entradas[1]!.estadoFreteConfirmado).toBe(ESTADO_FRETE.postado);
    // …e B não foi reaberto: nem `resolvidoEm`, nem `criadoEm` andaram.
    expect(db.store[AVISO_ETIQUETA_PATH]!.data).toEqual(fechado);
  });

  it('⚠️ A nfe: READY+pendente → REQUEST_CREATED → a READY+pendente velha não reabre A', async () => {
    const db = pedidoSemeado();
    const pendente = linhaTurbo({
      invoice_pending: { status: 'pending' },
      update_time: T_S + 100,
    });
    const nfePendente = arranjadorComProdutorReal(
      resultadoArranjo({ desfecho: 'nfe-pendente', fase: 'nfe-pendente' }),
    );

    // 1 — a nota pendente num pacote PRÉ-arranjo: A ABRE (o QUASE-ERRO).
    await rastrearPedidoShopee(asDb(db), alvo(), entregaTurbo([pendente], nfePendente));
    expect(nfePendente.entradas[0]!.estadoFreteConfirmado).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(db.store[AVISO_DESPACHO_NFE_PATH]!.data.resolvidoEm).toBeNull();

    // 2 — arranjado em outro lugar: o resolvedor fecha A `arranjado`.
    await rastrearPedidoShopee(
      asDb(db),
      alvo({ nowMs: AGORA_MS + 60_000 }),
      entregaTurbo(
        [
          linhaTurbo({
            fulfillment_status: 'LOGISTICS_REQUEST_CREATED',
            is_shipment_arranged: true,
            update_time: T_S + 600,
          }),
        ],
        arranjadorComProdutorReal(
          resultadoArranjo({ desfecho: 'ja-programado', fase: 'arranjado' }),
        ),
      ),
    );
    const fechado = { ...db.store[AVISO_DESPACHO_NFE_PATH]!.data };
    expect(fechado.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DESPACHO.arranjado);

    // 3 — a réplica atrasada devolve a linha de (1).
    const r3 = await rastrearPedidoShopee(
      asDb(db),
      alvo({ nowMs: AGORA_MS + 120_000 }),
      entregaTurbo([pendente], nfePendente),
    );

    expect(r3.acao).toBe('ignorado-obsoleto');
    expect(nfePendente.entradas).toHaveLength(2);
    expect(nfePendente.entradas[1]!.estadoFreteConfirmado).toBe(ESTADO_FRETE.aguardandoPostagem);
    expect(db.store[AVISO_DESPACHO_NFE_PATH]!.data).toEqual(fechado);
  });
});

describe('rastrearPedidoShopee — o arranjo na ÚNICA linha de log (passo 15b)', () => {
  it('49 — campos PLANOS, lista FECHADA, e nem `rotulo` nem o valor da preparação', async () => {
    const SENTINELA_ROTULO = 'SENTINELA-ENDERECO-DE-COLETA-DO-VENDEDOR';
    const PREPARACAO_S = 1_788_980_017;
    // Um resultado CONTAMINADO: o tipo não admite `rotulo`, e um gancho com
    // defeito que o vazasse no objeto não pode levá-lo ao log.
    const contaminado = {
      ...resultadoArranjo({
        desfecho: 'recusado',
        motivo: 'recusa-desconhecida',
        shopeeCode: 'logistics.erro_de_teste',
        operacao: 'programar',
      }),
      rotulo: SENTINELA_ROTULO,
      endereco: { address: SENTINELA_ROTULO },
    } as unknown as ResultadoArranjoAutomatico;

    const db = pedidoSemeado();
    const r = await rastrearPedidoShopee(
      asDb(db),
      alvo(),
      entregaTurbo([linhaTurbo({ preparation_end_time: PREPARACAO_S })], arranjador(contaminado)),
    );

    // ÂNCORA: o sentinela viajou mesmo — está no resultado que o handler devolve.
    expect(JSON.stringify(r.arranjo)).toContain(SENTINELA_ROTULO);

    const doBraco = linhasDoBraco();
    expect(doBraco).toHaveLength(1);
    const linhaLog = doBraco[0]!;
    expect(linhaLog).toMatchObject({
      despachoResolvidos: 0,
      etiquetaResolvida: false,
      acaoArranjo: 'recusado',
      motivoArranjo: 'recusa-desconhecida',
      canalArranjo: CANAL_TURBO,
      faseArranjo: 'programar',
      shopeeCodeArranjo: 'logistics.erro_de_teste',
      // ⚠️ PRESENÇA, nunca o valor.
      temPreparacaoAutomatica: true,
    });
    // A lista é FECHADA: um `arranjo` inteiro (ou um spread dele) entraria aqui.
    expect(Object.keys(linhaLog).sort()).toEqual([...CAMPOS_DA_LINHA_DO_BRACO].sort());

    const tudo = logInteiro();
    expect(tudo).not.toContain(SENTINELA_ROTULO);
    expect(tudo).not.toContain('rotulo');
    expect(tudo).not.toContain(String(PREPARACAO_S));

    // O PAR: sem prazo de preparação, a presença é `false`.
    infos.length = 0;
    await rastrearPedidoShopee(
      asDb(pedidoSemeado()),
      alvo(),
      entregaTurbo([linhaTurbo()], arranjador()),
    );
    expect(linhasDoBraco()[0]!.temPreparacaoAutomatica).toBe(false);
  });

  it('Q3-1 — ⚠️ QUASE-ERRO: o zero-fill da Shopee (`preparation_end_time: 0`) NÃO é presença', async () => {
    // Esta página zero-preenche int64 ausentes (a própria amostra manda
    // `pickup_done_time: 0`): ler `0` como "presente" responderia o registro 230
    // com "sim" para toda loja cujas linhas zero-preenchem.
    for (const [preparacao, esperado] of [
      [0, false],
      // Abaixo do piso de 2020 também não é um prazo.
      [1_000_000_000, false],
      [1_788_980_017, true],
    ] as const) {
      infos.length = 0;
      await rastrearPedidoShopee(
        asDb(pedidoSemeado()),
        alvo(),
        entregaTurbo([linhaTurbo({ preparation_end_time: preparacao })], arranjador()),
      );
      expect(linhasDoBraco()[0]!.temPreparacaoAutomatica, String(preparacao)).toBe(esperado);
    }
  });
});

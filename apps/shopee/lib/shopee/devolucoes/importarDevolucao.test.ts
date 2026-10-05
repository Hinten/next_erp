import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ORIGEM_INCIDENTE, TIPO_INCIDENTE } from '@delfrance/schemas';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  ShopeeApiError,
  type ShopeeClient,
  type ShopeeReturnDetail,
  type ShopeeReturnDetailEnvelope,
} from '@delfrance/integrations-shopee';

import { FIXTURE_RETURN_DETAIL_DOC, lerDevolucaoDetalhe } from '../fixtures/wireCorpus';
import {
  carimboDoDiaUtcMs,
  notificacaoSinteticaDePedido,
} from '../notificacoes/notificacaoSintetica';
import type { ShopeeNotificationPayload } from '../notificacoes/notificacao';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { microsDeSegundosShopee } from '../pedidos/orderMapping';
import { ShopeeTasksDisabledError, type ShopeeTaskScheduler } from '../shopeeTasks';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { chaveDoAvisoDeDevolucao } from './avisoDevolucao';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';
import {
  ACAO_DEVOLUCAO_INEXISTENTE,
  ACAO_DEVOLUCAO_OUTRO_PEDIDO,
  ACAO_DEVOLUCAO_SEM_PEDIDO,
  importarDevolucaoShopee,
  type AlvoDeImportacaoDevolucaoShopee,
  type ShopeeImportarDevolucaoDeps,
} from './importarDevolucao';
import type { DiarioPushDevolucao } from './pushDevolucao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real conta, order, return or buyer.  */
/* -------------------------------------------------------------------------- */

/** Deliberately NOT a day boundary, so the day stamp and the raw clock differ. */
const NOW_MS = 1_789_000_123_456;
const CONTA = 'int-1';
const SHOP_ID = 987654;
const ORDER_SN = '260910KJBHUJDM';
/** The corpus detail's own return_sn — ALPHANUMERIC, like Shopee's samples. */
const RETURN_SN = '260910ABCDE0001';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const INCIDENTE_PATH = `${PEDIDO_PATH}/incidentes/${idIncidenteDevolucaoShopee(RETURN_SN)}`;
const AVISO_PATH = `avisos/${chaveDoAvisoDeDevolucao(CONTA, RETURN_SN)}`;

function corpus(): ShopeeReturnDetailEnvelope {
  return lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC);
}

const T0_S = corpus().response.update_time;

/** The corpus envelope, its detail at `T0 + segundos` with overrides. */
function envelope(
  segundos = 0,
  over: Partial<ShopeeReturnDetail> = {},
): ShopeeReturnDetailEnvelope {
  const e = corpus();
  return { ...e, response: { ...e.response, update_time: T0_S + segundos, ...over } };
}

function recusa(code: string, providerMessage: string | null): ShopeeApiError {
  return new ShopeeApiError(
    `Shopee ${SHOPEE_GET_RETURN_DETAIL_PATH} respondeu ${code} (HTTP 200)`,
    {
      code,
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: SHOPEE_GET_RETURN_DETAIL_PATH,
      providerMessage,
    },
  );
}

function alvo(
  over: Partial<AlvoDeImportacaoDevolucaoShopee> = {},
): AlvoDeImportacaoDevolucaoShopee {
  return {
    integracaoId: CONTA,
    shopId: SHOP_ID,
    orderSn: ORDER_SN,
    returnSn: RETURN_SN,
    nowMs: NOW_MS,
    origem: 'push',
    diario: null,
    ...over,
  };
}

function dbComPedido(): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, { numero: ORDER_SN });
  return db;
}

interface Arnes {
  readonly deps: ShopeeImportarDevolucaoDeps;
  readonly clientFor: ReturnType<typeof vi.fn>;
  readonly getReturnDetail: ReturnType<typeof vi.fn>;
  readonly enfileirados: ShopeeNotificationPayload[];
}

/**
 * The seams, each a spy. `resposta` is what `get_return_detail` answers — an
 * envelope, an error to throw, or a function run at call time (the race tests).
 */
function arnes(
  resposta: ShopeeReturnDetailEnvelope | Error | (() => ShopeeReturnDetailEnvelope) = envelope(),
  scheduler?: ShopeeTaskScheduler,
): Arnes {
  const enfileirados: ShopeeNotificationPayload[] = [];
  const getReturnDetail = vi.fn((_p: { returnSn: string }) => {
    if (resposta instanceof Error) return Promise.reject(resposta);
    return Promise.resolve(typeof resposta === 'function' ? resposta() : resposta);
  });
  const clientFor = vi.fn(() =>
    Promise.resolve({ getReturnDetail } as unknown as Pick<ShopeeClient, 'getReturnDetail'>),
  );
  return {
    deps: {
      clientFor,
      scheduler: scheduler ?? {
        enqueue: (p: ShopeeNotificationPayload) => {
          enfileirados.push(p);
          return Promise.resolve();
        },
      },
      aviso: { increment, nowMs: NOW_MS },
    },
    clientFor,
    getReturnDetail,
    enfileirados,
  };
}

function importar(db: FakeDb, a: Arnes, over: Partial<AlvoDeImportacaoDevolucaoShopee> = {}) {
  return importarDevolucaoShopee(asDb(db), alvo(over), a.deps);
}

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The ONE delivery line's metadata. */
function linhaDeLog(): Record<string, unknown> {
  const linhas = info.mock.calls.filter((c) => c[0] === '[shopee/devolucao] entrega de devolução');
  expect(linhas).toHaveLength(1);
  return linhas[0]?.[1] as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*  (1) o pedido ausente — ZERO chamadas à Shopee, UM code 3 do dia            */
/* -------------------------------------------------------------------------- */

describe('pedido ausente — o skip barato', () => {
  it('não chama a Shopee (nem monta o cliente) e enfileira UM code 3 com o carimbo do DIA', async () => {
    const db = new FakeDb();
    const a = arnes();
    const r = await importar(db, a);

    expect(r).toEqual({
      acao: ACAO_DEVOLUCAO_SEM_PEDIDO,
      pedidoId: PEDIDO_ID,
      statusDevolucao: null,
      aviso: null,
      sinteticaEnfileirada: true,
      detail: `ignorado-sem-pedido:pedido ${ORDER_SN} ainda não existe`,
    });
    expect(a.clientFor).not.toHaveBeenCalled();
    expect(a.getReturnDetail).not.toHaveBeenCalled();
    expect(a.enfileirados).toEqual([
      notificacaoSinteticaDePedido({
        shopId: SHOP_ID,
        orderSn: ORDER_SN,
        nowMs: carimboDoDiaUtcMs(NOW_MS),
        origem: 'devolucao',
      }),
    ]);
    expect(a.enfileirados[0]?.timestamp).not.toBe(NOW_MS);
    expect(db.writes).toEqual([]);
  });

  it('sem `clientFor`: nem a conta é lida — só o pedido', async () => {
    const db = new FakeDb();
    const a = arnes();
    const r = await importarDevolucaoShopee(asDb(db), alvo(), {
      scheduler: a.deps.scheduler,
      aviso: a.deps.aviso,
    });
    expect(r.acao).toBe(ACAO_DEVOLUCAO_SEM_PEDIDO);
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
  });

  it('a válvula (ShopeeTasksDisabledError) é CONTIDA: a entrega segue, sinteticaEnfileirada false', async () => {
    const a = arnes(envelope(), {
      enqueue: () => Promise.reject(new ShopeeTasksDisabledError()),
    });
    const r = await importar(new FakeDb(), a);
    expect(r.acao).toBe(ACAO_DEVOLUCAO_SEM_PEDIDO);
    expect(r.sinteticaEnfileirada).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(linhaDeLog().sintetica).toBe(false);
  });

  it('qualquer OUTRA falha do enqueue propaga (regra 6)', async () => {
    const a = arnes(envelope(), { enqueue: () => Promise.reject(grpc(14, 'UNAVAILABLE')) });
    await expect(importar(new FakeDb(), a)).rejects.toThrow('UNAVAILABLE');
  });

  it('o pedido some ENTRE o skip e a transação ⇒ `ignorado-sem-pedido` do tx, UM code 3, zero escritas', async () => {
    const db = dbComPedido();
    const a = arnes(() => {
      delete db.store[PEDIDO_PATH];
      return envelope();
    });
    const r = await importar(db, a);
    expect(r.acao).toBe(ACAO_DEVOLUCAO_SEM_PEDIDO);
    expect(r.statusDevolucao).toBe('ACCEPTED');
    expect(r.sinteticaEnfileirada).toBe(true);
    expect(a.getReturnDetail).toHaveBeenCalledTimes(1);
    expect(a.enfileirados).toHaveLength(1);
    expect(db.store[INCIDENTE_PATH]).toBeUndefined();
    expect(db.store[AVISO_PATH]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) o pull — inexistente, outro pedido, e o resto propaga                  */
/* -------------------------------------------------------------------------- */

describe('get_return_detail — só "não existe" vira desfecho', () => {
  it.each(["The return you queried doesn't exist.", 'The return detail is not available.'])(
    'error_data "%s" ⇒ `ignorado-inexistente`, zero escritas, nenhum code 3',
    async (frase) => {
      const db = dbComPedido();
      const a = arnes(recusa('error_data', frase));
      const r = await importar(db, a);
      expect(r).toEqual({
        acao: ACAO_DEVOLUCAO_INEXISTENTE,
        pedidoId: PEDIDO_ID,
        statusDevolucao: null,
        aviso: null,
        sinteticaEnfileirada: false,
        detail: `ignorado-inexistente:devolução ${RETURN_SN} não existe na Shopee`,
      });
      expect(db.writes).toEqual([]);
      expect(a.enfileirados).toEqual([]);
      expect(linhaDeLog().erroEnvelope).toBe('error_data');
    },
  );

  it('o código no log passa por `codigoSeguro` — o código acolchoado que a dobra perdoou sai aparado, nunca cru', async () => {
    // PAIR: the classifier folds `' error_data\t'` (and a module segment) to
    // inexistente, so the delivery is the same outcome; the log carries the
    // GATED code, never the raw one.
    for (const [codigo, noLog] of [
      [' error_data\t', 'error_data'],
      ['returns.error_data', 'returns.error_data'],
    ] as const) {
      info.mockClear();
      const r = await importar(
        dbComPedido(),
        arnes(recusa(codigo, 'The return detail is not available.')),
      );
      expect(r.acao, codigo).toBe(ACAO_DEVOLUCAO_INEXISTENTE);
      expect(linhaDeLog().erroEnvelope, codigo).toBe(noLog);
    }
  });

  it('error_permission com a MESMA frase NÃO é inexistente — propaga para a tabela do braço', async () => {
    const a = arnes(recusa('error_permission', "The return you queried doesn't exist."));
    await expect(importar(dbComPedido(), a)).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it.each([
    ['error_param', 'Return SN or ID is invalid.'],
    ['error_data', 'Shopee is reviewing the case and will get back to you.'],
    // R3 F2's near-miss: a TRANSIENT "not available" is never "the return is gone".
    ['error_data', 'Service is temporarily not available, please try later.'],
    ['error_server', null],
  ])('a recusa %s (%s) propaga', async (code, frase) => {
    const a = arnes(recusa(code, frase));
    await expect(importar(dbComPedido(), a)).rejects.toBeInstanceOf(ShopeeApiError);
  });

  it('um erro que não é da Shopee propaga intacto', async () => {
    const a = arnes(grpc(14, 'UNAVAILABLE'));
    await expect(importar(dbComPedido(), a)).rejects.toThrow('UNAVAILABLE');
  });

  it('o detalhe de OUTRO pedido ⇒ `ignorado-outro-pedido`, zero escritas, nenhum aviso nem code 3', async () => {
    const db = dbComPedido();
    const a = arnes(envelope(0, { order_sn: '260910ZZZZZZZZ' }));
    const r = await importar(db, a);
    expect(r.acao).toBe(ACAO_DEVOLUCAO_OUTRO_PEDIDO);
    expect(r.detail).toBe(`ignorado-outro-pedido:devolução ${RETURN_SN} pertence a outro pedido`);
    expect(r.aviso).toBeNull();
    expect(db.writes).toEqual([]);
    expect(a.enfileirados).toEqual([]);
  });

  it('o detalhe de OUTRA devolução ⇒ também zero escritas (nunca gravada sob a chave desta)', async () => {
    const db = dbComPedido();
    const r = await importar(db, arnes(envelope(0, { return_sn: '2609100000000002' })));
    expect(r.acao).toBe(ACAO_DEVOLUCAO_OUTRO_PEDIDO);
    expect(db.writes).toEqual([]);
  });

  it('um return_sn fora do formato é recusado ANTES de qualquer leitura', async () => {
    const db = dbComPedido();
    const a = arnes();
    await expect(importar(db, a, { returnSn: 'abc-001' })).rejects.toBeInstanceOf(RangeError);
    expect(db.opLog).toEqual([]);
    expect(a.clientFor).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) a escrita e o aviso — pelo estado CONFIRMADO                           */
/* -------------------------------------------------------------------------- */

describe('o incidente e o aviso', () => {
  it('cria o incidente na id derivada e abre o aviso; o pull é pedido pelo return_sn VERBATIM', async () => {
    const db = dbComPedido();
    const a = arnes();
    const r = await importar(db, a);
    expect(r).toEqual({
      acao: 'criado',
      pedidoId: PEDIDO_ID,
      statusDevolucao: 'ACCEPTED',
      aviso: 'aberto',
      sinteticaEnfileirada: false,
      detail: 'criado',
    });
    expect(a.clientFor).toHaveBeenCalledWith(expect.anything(), CONTA);
    expect(a.getReturnDetail).toHaveBeenCalledWith({ returnSn: RETURN_SN });
    const inc = db.store[INCIDENTE_PATH]?.data ?? {};
    expect(inc.origem).toBe(ORIGEM_INCIDENTE.pedidoShopee);
    expect(inc.tipo).toBe(TIPO_INCIDENTE.devolucao);
    expect(inc.externalId).toBe(RETURN_SN);
    expect(db.store[AVISO_PATH]?.data.tipo).toBe('reclamacaoAguardandoVendedor');
    // The aviso clock is the CONFIRMED watermark (the detail's `update_time`)
    // plus the revision — never the return's creation stamp.
    expect(db.store[AVISO_PATH]?.data.relogioEvento).toBe(microsDeSegundosShopee(T0_S) + 1);
    expect(inc.relogioProvedorUs).toBe(microsDeSegundosShopee(T0_S));
    expect(a.enfileirados).toEqual([]);
  });

  it('o status do PULL vence o do push (o diário é só log)', async () => {
    const db = dbComPedido();
    const diario: DiarioPushDevolucao = {
      camposMudados: ['return_status'],
      relogioDoPushS: T0_S,
      statusNoPush: 'REQUESTED',
    };
    const r = await importar(db, arnes(), { diario });
    expect(r.statusDevolucao).toBe('ACCEPTED');
    const bloco = db.store[INCIDENTE_PATH]?.data.devolucaoShopee as Record<string, unknown>;
    expect(bloco.status).toBe('ACCEPTED');
    expect(db.store[AVISO_PATH]?.data.motivo).toBe('ACCEPTED');
    expect(linhaDeLog().divergePushVsPull).toBe(true);
  });

  it('a sequência RT-4: criado → replay idêntico → mais velho → igual-e-diferente (revisão 2)', async () => {
    const db = dbComPedido();
    expect((await importar(db, arnes(envelope(5)))).acao).toBe('criado');

    db.writes.length = 0;
    const replay = await importar(db, arnes(envelope(5)));
    expect(replay.acao).toBe('ignorado-sem-mudanca');
    expect(db.writes).toEqual([]);

    const velho = await importar(db, arnes(envelope(0, { status: 'REQUESTED' })));
    expect(velho.acao).toBe('ignorado-obsoleto');
    expect(velho.aviso).toBe('inalterado');
    expect(db.writes).toEqual([]);

    const igualDiferente = await importar(db, arnes(envelope(5, { refund_amount: 9.5 })));
    expect(igualDiferente.acao).toBe('atualizado');
    const bloco = db.store[INCIDENTE_PATH]?.data.devolucaoShopee as Record<string, unknown>;
    expect(bloco.revisao).toBe(2);
  });

  it('um `ignorado-obsoleto` não toca o aviso: o encerrado continua encerrado', async () => {
    const db = dbComPedido();
    await importar(db, arnes(envelope(0, { status: 'REQUESTED' })));
    expect((await importar(db, arnes(envelope(5, { status: 'CLOSED' })))).aviso).toBe('resolvido');
    db.writes.length = 0;
    const r = await importar(db, arnes(envelope(1, { status: 'REQUESTED' })));
    expect(r.acao).toBe('ignorado-obsoleto');
    expect(r.aviso).toBe('inalterado');
    expect(db.writes.filter((w) => w.path === AVISO_PATH)).toEqual([]);
    expect(db.store[AVISO_PATH]?.data.resolvidoEm).not.toBeNull();
  });

  it('um avanço só de relógio (`relogio-avancado`) não toca o aviso', async () => {
    const db = dbComPedido();
    await importar(db, arnes(envelope(0)));
    db.writes.length = 0;
    const r = await importar(db, arnes(envelope(9)));
    expect(r.acao).toBe('relogio-avancado');
    expect(r.aviso).toBe('inalterado');
    expect(db.writes.filter((w) => w.path === AVISO_PATH)).toEqual([]);
  });

  it('o handoff do W2: commit ok + aviso falhou ⇒ a re-entrega (`ignorado-sem-mudanca`) abre o aviso', async () => {
    const db = dbComPedido();
    db.falhasDeCriacao.set(AVISO_PATH, grpc(14, 'UNAVAILABLE'));
    await expect(importar(db, arnes())).rejects.toThrow('UNAVAILABLE');
    expect(db.store[INCIDENTE_PATH]).toBeDefined();
    expect(db.store[AVISO_PATH]).toBeUndefined();

    db.falhasDeCriacao.clear();
    const r = await importar(db, arnes());
    expect(r.acao).toBe('ignorado-sem-mudanca');
    expect(r.aviso).toBe('aberto');

    const outra = await importar(db, arnes());
    expect(outra.aviso).toBe('inalterado');
    expect(db.store[AVISO_PATH]?.data.ocorrencias).toBe(1);
  });

  it('sem `deps.aviso`, o "agora" do aviso é o nowMs da entrega — nunca um segundo relógio', async () => {
    const db = dbComPedido();
    const a = arnes();
    await importarDevolucaoShopee(asDb(db), alvo(), {
      clientFor: a.deps.clientFor,
      scheduler: a.deps.scheduler,
    });
    expect(db.store[AVISO_PATH]?.data.criadoEm).toBe(NOW_MS * 1000);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) a linha de log — ids, tokens, contagens e booleanos                   */
/* -------------------------------------------------------------------------- */

describe('a linha de log', () => {
  it('UMA por entrega, com exatamente estas chaves', async () => {
    await importar(dbComPedido(), arnes(), {
      origem: 'reconciliacao',
      diario: { camposMudados: ['return_status'], relogioDoPushS: T0_S, statusNoPush: 'ACCEPTED' },
    });
    const m = linhaDeLog();
    expect(Object.keys(m).sort()).toEqual(
      [
        'acao',
        'aviso',
        'camposMudados',
        'divergePushVsPull',
        'erroEnvelope',
        'integracaoId',
        'motivoDevolucao',
        'mudouAviso',
        'orderSn',
        'origem',
        'pedidoId',
        'relogioDaDevolucaoS',
        'relogioDoPushS',
        'returnSn',
        'revisao',
        'shopId',
        'sintetica',
        'status',
        'statusDesconhecido',
        'statusLogistica',
        'statusLogisticaReversa',
      ].sort(),
    );
    expect(m).toMatchObject({
      origem: 'reconciliacao',
      acao: 'criado',
      status: 'ACCEPTED',
      statusDesconhecido: false,
      motivoDevolucao: 'NOT_RECEIPT',
      erroEnvelope: '-',
      relogioDaDevolucaoS: T0_S,
      divergePushVsPull: false,
      revisao: 1,
      mudouAviso: true,
      aviso: 'aberto',
    });
  });

  it('nunca um valor em dinheiro nem um dado do comprador', async () => {
    await importar(dbComPedido(), arnes());
    const json = JSON.stringify(linhaDeLog());
    for (const proibido of ['13.97', '13.99', 'REDACTED', 'macaron', 'SGC']) {
      expect(json).not.toContain(proibido);
    }
  });

  it('um status DESCONHECIDO é marcado; um texto que não é token vira marcador, nunca o valor', async () => {
    await importar(
      dbComPedido(),
      arnes(envelope(0, { status: 'NOVO_STATUS', reason: 'texto livre do comprador' })),
    );
    const m = linhaDeLog();
    expect(m.status).toBe('NOVO_STATUS');
    expect(m.statusDesconhecido).toBe(true);
    expect(m.motivoDevolucao).toBe('<nao-token>');
    expect(JSON.stringify(m)).not.toContain('texto livre');
  });

  it('um status que NÃO é token vira <nao-token> no log — nunca o valor (G2)', async () => {
    // Near-miss of the case above: there the unknown status IS a token and is
    // logged verbatim; here it is free text and only the marker and the
    // `statusDesconhecido` flag survive.
    await importar(dbComPedido(), arnes(envelope(0, { status: 'em análise pela loja' })));
    const m = linhaDeLog();
    expect(m.status).toBe('<nao-token>');
    expect(m.statusDesconhecido).toBe(true);
    expect(JSON.stringify(m)).not.toContain('em análise pela loja');
  });

  it('o logístico também passa pela regra do token: um token passa, um texto com espaço vira marcador', async () => {
    await importar(
      dbComPedido(),
      arnes(
        envelope(0, {
          logistics_status: 'LOGISTICS_DELIVERY_DONE',
          reverse_logistics_status: 'Delivery Failed',
        }),
      ),
    );
    const m = linhaDeLog();
    expect(m.statusLogistica).toBe('LOGISTICS_DELIVERY_DONE');
    expect(m.statusLogisticaReversa).toBe('<nao-token>');
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) unidades — este módulo não converte nada nem lê relógio (R-10)        */
/* -------------------------------------------------------------------------- */

describe('unidades', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./importarDevolucao.ts', import.meta.url)),
    'utf8',
  );
  const codigo = fonte
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*\*|\/\/)/.test(l))
    .join('\n');

  it.each(['millisToMicros', 'coerceToMicros', 'microsDeSegundosShopee', 'Date.now', 'new Date'])(
    'o código não chama %s',
    (nome) => {
      expect(codigo).not.toContain(nome);
    },
  );

  it('UM call site do code 3, e ele usa o carimbo do dia', () => {
    expect(codigo.match(/notificacaoSinteticaDePedido\(/g)).toHaveLength(1);
    expect(codigo).toContain('nowMs: carimboDoDiaUtcMs(p.nowMs)');
  });
});

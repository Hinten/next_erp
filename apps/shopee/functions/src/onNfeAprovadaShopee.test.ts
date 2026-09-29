import type { Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { pedidoCollection } from '@delfrance/data/admin/collections';
import { ESTADO_NFE, INTEGRACAO_FRETE, TIPO_AVISO } from '@delfrance/schemas';

import { chaveAvisoNfeShopee } from '../../lib/shopee/nfe/avisoNfe';
import {
  ATRASO_SERPRO_S,
  SHOPEE_NFE_UPLOAD_QUEUE,
  atrasoSerproS,
} from '../../lib/shopee/nfe/constantesNfe';
import {
  MOTIVO_NFE_SHOPEE,
  ShopeeNfeUploadTasksDisabledError,
  fraseDoErroDoAviso,
} from '../../lib/shopee/nfe/errosNfe';
import type {
  AgendadorNfeShopee,
  OpcoesDeEnfileiramentoNfe,
  TarefaNfeShopee,
} from '../../lib/shopee/nfe/tarefaNfe';
import { makePedidoIdShopee } from '../../lib/shopee/pedidos/orderIds';
import { ShopeeTasksDisabledError } from '../../lib/shopee/shopeeTasks';
import { FakeDb, asDb, grpc, increment, type DocData } from '../../lib/shopee/testing/fakeDb';

/**
 * The NF-e approval trigger's ladder (T1–T5, reconcile §2.9), driven two ways:
 *
 *  - through the exported `tratarEscritaNfeShopee` with doubles — the FakeDb
 *    (so the aviso goes through the REAL writer), a recording scheduler, a
 *    lazy `db` and a clock spy — which is where each rung's ZERO-READ and
 *    NO-LOG claims can be asserted;
 *  - through the real `onNfeAprovadaShopee.run(event)` for the WIRING only:
 *    the ids come from the event PARAMS, and a write that is not an edge never
 *    reaches `getDb()` or builds the scheduler.
 *
 * The deployed options (`database`, `retry`, the path, no secrets) are
 * `index.test.ts`'s — the `GATILHOS` loop and its own describe.
 *
 * ⚠️ Every XML here is SYNTHETIC and carries NO access key at all: the trigger
 * never reads one, and a key in a fixture is a key that can reach a log.
 */
const admin = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock('./lib/admin', () => ({ getDb: admin.getDb }));

const tasks = vi.hoisted(() => ({ createShopeeNfeUploadScheduler: vi.fn() }));
vi.mock('../../lib/shopee/nfe/shopeeNfeUploadTasks', () => ({
  createShopeeNfeUploadScheduler: tasks.createShopeeNfeUploadScheduler,
}));

const { onNfeAprovadaShopee, tratarEscritaNfeShopee } = await import('./onNfeAprovadaShopee');

/* ---------------------------------- fixtures ------------------------------ */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const NFE_ID = 's1';
const PEDIDO_PATH = pedidoCollection.docPath({}, PEDIDO_ID);
const AVISO_PATH = `avisos/${chaveAvisoNfeShopee(CONTA, PEDIDO_ID)}`;
const NOW_MS = 1_789_000_000_000;

/** A minimal synthetic `nfeProc` — no key, no signature, no party. */
function procXml(o: { tpAmb?: string; tpNF?: string | null; finNFe?: string } = {}): string {
  const tpNF = o.tpNF === null ? '' : `<tpNF>${o.tpNF ?? '1'}</tpNF>`;
  return [
    '<nfeProc versao="4.00"><NFe><infNFe versao="4.00"><ide><cUF>99</cUF><mod>55</mod>',
    `${tpNF}<tpAmb>${o.tpAmb ?? '1'}</tpAmb><finNFe>${o.finNFe ?? '1'}</finNFe>`,
    '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit></infNFe></NFe>',
    '</nfeProc>',
  ].join('');
}

/** An approved, production, SALE nfev4 body — authorized a month ago. */
function nfe(o: DocData = {}): DocData {
  return {
    estado: ESTADO_NFE.aprovada,
    xml_nfe_proc: procXml(),
    data_autorizacao: NOW_MS - 30 * 86_400_000,
    ...o,
  };
}

/** A pedido the Shopee importer wrote: its id recomputes from (conta, order_sn). */
function pedidoRaw(o: DocData = {}): DocData {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    bloquearEmissaoNFe: false,
    freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.shopee, estado: 'aguardandoNFe' },
    ...o,
  };
}

type Chamada = [TarefaNfeShopee, OpcoesDeEnfileiramentoNfe | undefined];

let db: FakeDb;
let chamadas: Chamada[];
let falhaDoEnqueue: Error | null;
let dbSpy: ReturnType<typeof vi.fn<() => Firestore>>;
let criarAgendador: ReturnType<typeof vi.fn<() => AgendadorNfeShopee>>;
let agoraMs: ReturnType<typeof vi.fn<() => number>>;
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let erro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  chamadas = [];
  falhaDoEnqueue = null;
  const agendador: AgendadorNfeShopee = {
    async enqueue(payload, opts) {
      chamadas.push([payload, opts]);
      if (falhaDoEnqueue !== null) throw falhaDoEnqueue;
    },
  };
  dbSpy = vi.fn(() => asDb(db));
  criarAgendador = vi.fn(() => agendador);
  agoraMs = vi.fn(() => NOW_MS);
  admin.getDb.mockImplementation(() => asDb(db));
  tasks.createShopeeNfeUploadScheduler.mockImplementation(() => agendador);
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  erro = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
  erro.mockRestore();
});

function tratar(
  before: DocData | undefined,
  after: DocData | undefined,
  pedidoId = PEDIDO_ID,
): Promise<void> {
  return tratarEscritaNfeShopee(
    { db: dbSpy, agendador: criarAgendador, agoraMs, increment },
    { pedidoId, nfeId: NFE_ID, before, after },
  );
}

/** Reads the trigger made, in order (the FakeDb logs a doc `get` there). */
function leituras(): string[] {
  return db.opLog.filter((o) => o.op === 'get').map((o) => o.path);
}

/** Every log payload, serialized — for the PII assertions. */
function tudoQueFoiLogado(): string {
  return JSON.stringify([info.mock.calls, warn.mock.calls, erro.mock.calls]);
}

function semLogNenhum(): void {
  expect(info).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(erro).not.toHaveBeenCalled();
}

/* -------------------------------------------------------------------------- */

describe('T1 — a TRANSIÇÃO para "pronta", nunca o nível', () => {
  it('PAR: uma NF-e CRIADA aprovada (tpAmb 1, venda) enfileira UMA tarefa após UMA leitura', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(undefined, nfe());

    expect(chamadas).toEqual([
      [
        {
          pedidoId: PEDIDO_ID,
          nfeId: NFE_ID,
          fase: 'envio',
          adiamentosSerpro: 0,
          pausas: 0,
          reverificacoes: 0,
        },
        { scheduleDelaySeconds: ATRASO_SERPRO_S },
      ],
    ]);
    expect(leituras()).toEqual([PEDIDO_PATH]);
    expect(info).toHaveBeenCalledTimes(1);
    expect((info.mock.calls[0] as unknown[])[1]).toEqual({
      queue: SHOPEE_NFE_UPLOAD_QUEUE,
      pedidoId: PEDIDO_ID,
      nfeId: NFE_ID,
      integracaoId: CONTA,
      atrasoSegundos: ATRASO_SERPRO_S,
    });
  });

  it('⛔ QUASE-FALHA: a reescrita `nfe-totais` de um doc JÁ aprovado não lê, não enfileira e NÃO loga', async () => {
    // The window's migration rewrites `totais` on EVERY approved nfev4 doc. A
    // level trigger would turn it into one upload task per historic NF-e — and
    // with two sibling functions on the same path, even one log line per fire
    // is noise ×3.
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(nfe(), { ...nfe(), totais: { vNF: 10 } });

    expect(dbSpy).not.toHaveBeenCalled();
    expect(criarAgendador).not.toHaveBeenCalled();
    expect(chamadas).toEqual([]);
    expect(leituras()).toEqual([]);
    semLogNenhum();
  });

  it('o reparo tardio do proc (aprovada SEM xml → COM xml) É uma borda', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(nfe({ xml_nfe_proc: null }), nfe());

    expect(chamadas).toHaveLength(1);
  });

  it('silêncio total (0 leituras, 0 linhas) em todo pulo do T1', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());
    const casos: [DocData | undefined, DocData | undefined][] = [
      [undefined, nfe({ estado: ESTADO_NFE.enviando })], // not approved yet
      [undefined, nfe({ xml_nfe_proc: procXml({ tpAmb: '2' }) })], // homologação
      [undefined, nfe({ xml_nfe_proc: null })], // approved, no proc yet
      [nfe(), undefined], // deleted
      [nfe(), nfe({ estado: ESTADO_NFE.cancelada })], // cancelled after approval
      [undefined, nfe({ estado: ESTADO_NFE.epecAprovado })], // EPEC is never ready
    ];
    for (const [antes, depois] of casos) await tratar(antes, depois);

    expect(dbSpy).not.toHaveBeenCalled();
    expect(chamadas).toEqual([]);
    semLogNenhum();
  });
});

describe('T1b — só a NF-e de VENDA segue, sem ler nada', () => {
  it('uma devolução (finNFe 4) é descartada com UMA linha info — e o pedido nem é lido', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(undefined, nfe({ xml_nfe_proc: procXml({ finNFe: '4' }) }));

    expect(dbSpy).not.toHaveBeenCalled();
    expect(chamadas).toEqual([]);
    expect(info).toHaveBeenCalledTimes(1);
    expect((info.mock.calls[0] as unknown[])[1]).toEqual({
      pedidoId: PEDIDO_ID,
      nfeId: NFE_ID,
      motivo: MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    });
  });

  it('PAR / QUASE-FALHA: tpNF 1 + finNFe 1 segue; uma ENTRADA (tpNF 0) é descartada igual', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(undefined, nfe({ xml_nfe_proc: procXml({ tpNF: '0' }) }));
    expect(chamadas).toEqual([]);
    await tratar(undefined, nfe());
    expect(chamadas).toHaveLength(1);
  });

  it('⚠️ um proc ILEGÍVEL (sem tpNF) NÃO é descartado aqui — enfileira, e o handler o julga com aviso', async () => {
    // A drop at this rung would turn the handler's loud `xml-invalido` (aviso +
    // frete stamp, zero Shopee calls) into silence.
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(undefined, nfe({ xml_nfe_proc: procXml({ tpNF: null }) }));

    expect(chamadas).toHaveLength(1);
  });
});

describe('T2/T3 — UMA leitura e a PROVA de posse', () => {
  it('pedido ausente ⇒ `pedido-nao-encontrado`, uma linha info, nada enfileirado', async () => {
    await tratar(undefined, nfe());

    expect(leituras()).toEqual([PEDIDO_PATH]);
    expect(chamadas).toEqual([]);
    expect(((info.mock.calls[0] as unknown[])[1] as Record<string, unknown>).motivo).toBe(
      MOTIVO_NFE_SHOPEE.pedidoNaoEncontrado,
    );
  });

  it('⛔ QUASE-FALHA: um pedido cujo id NÃO recomputa de (conta, order_sn) é `nao-shopee`', async () => {
    // Same order number, another conta: the digest differs, so this document
    // cannot have been written by the Shopee importer for THIS id. Uploading
    // another channel's note to a Shopee order is not a refusal anyone sees.
    db.seed(PEDIDO_PATH, pedidoRaw({ integracaoPedidoOuterRef: 'documents/integracao/int-2' }));

    await tratar(undefined, nfe());

    expect(chamadas).toEqual([]);
    expect(((info.mock.calls[0] as unknown[])[1] as Record<string, unknown>).motivo).toBe(
      MOTIVO_NFE_SHOPEE.naoShopee,
    );
  });

  it('`bloquearEmissaoNFe` ⇒ `emissao-bloqueada`, nada enfileirado', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw({ bloquearEmissaoNFe: true }));

    await tratar(undefined, nfe());

    expect(chamadas).toEqual([]);
    expect(((info.mock.calls[0] as unknown[])[1] as Record<string, unknown>).motivo).toBe(
      MOTIVO_NFE_SHOPEE.emissaoBloqueada,
    );
  });

  it('a FRETE não decide: sem `freteInicial` ou com frete de OUTRA integradora, enfileira igual', async () => {
    // Shopee attaches the note to the ORDER, not to a package: only the later
    // frete stamp is owner-guarded (carimboFreteNfe.ts).
    db.seed(PEDIDO_PATH, pedidoRaw({ freteInicial: null }));
    await tratar(undefined, nfe());
    db.seed(
      PEDIDO_PATH,
      pedidoRaw({ freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre } }),
    );
    await tratar(undefined, nfe());

    expect(chamadas).toHaveLength(2);
  });

  it('uma falha do Firestore na leitura do pedido PROPAGA — o Eventarc re-tenta', async () => {
    const falha = grpc(14, 'unavailable');
    const quebrado = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            throw falha;
          },
        }),
      }),
    } as unknown as Firestore;

    await expect(
      tratarEscritaNfeShopee(
        { db: () => quebrado, agendador: criarAgendador, agoraMs, increment },
        { pedidoId: PEDIDO_ID, nfeId: NFE_ID, before: undefined, after: nfe() },
      ),
    ).rejects.toBe(falha);
    expect(criarAgendador).not.toHaveBeenCalled();
  });
});

describe('T4 — o primeiro enfileiramento', () => {
  it('o atraso é a CONSTANTE, sem relógio — mesmo para uma NF-e autorizada há 30 dias', async () => {
    // QUASE-FALHA: the route's formula would answer 0 for this note. The
    // trigger runs AT the approval, so it never computes a remainder and the
    // enqueue path reads no clock at all.
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(undefined, nfe());

    expect(atrasoSerproS(NOW_MS - 30 * 86_400_000, NOW_MS)).toBe(0);
    expect(chamadas[0]?.[1]).toEqual({ scheduleDelaySeconds: ATRASO_SERPRO_S });
    expect(ATRASO_SERPRO_S).toBe(360);
    expect(agoraMs).not.toHaveBeenCalled();
  });

  it('o payload não leva conta, número do pedido nem XML — e nenhuma linha de log os leva', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());

    await tratar(undefined, nfe());

    const [payload] = chamadas[0] ?? [];
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      'adiamentosSerpro',
      'fase',
      'nfeId',
      'pausas',
      'pedidoId',
      'reverificacoes',
    ]);
    expect(JSON.stringify(payload)).not.toContain(ORDER_SN);
    const logado = tudoQueFoiLogado();
    expect(logado).not.toContain(ORDER_SN);
    expect(logado).not.toContain('<');
  });
});

describe('T5 — a válvula (SHOPEE_TASKS_DISABLED)', () => {
  it('a classe da NF-e ⇒ UM warn + o aviso `tasks-desabilitadas`, e o gatilho NÃO lança', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());
    falhaDoEnqueue = new ShopeeNfeUploadTasksDisabledError();

    await expect(tratar(undefined, nfe())).resolves.toBeUndefined();

    const aviso = db.store[AVISO_PATH]?.data;
    expect(aviso).toBeDefined();
    expect(aviso?.tipo).toBe(TIPO_AVISO.nfeUploadRejeitado);
    expect(aviso?.motivo).toBe(MOTIVO_NFE_SHOPEE.tasksDesabilitadas);
    expect(aviso?.params).toEqual({
      pedido: ORDER_SN,
      erro: fraseDoErroDoAviso(MOTIVO_NFE_SHOPEE.tasksDesabilitadas, null),
    });
    expect(aviso?.ocorrencias).toBe(1);
    // The clock is read ONLY here, once, for the aviso's stamps.
    expect(agoraMs).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const linha = (warn.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(linha).toMatchObject({
      pedidoId: PEDIDO_ID,
      nfeId: NFE_ID,
      integracaoId: CONTA,
      motivo: MOTIVO_NFE_SHOPEE.tasksDesabilitadas,
    });
    expect(info).not.toHaveBeenCalled();
    expect(tudoQueFoiLogado()).not.toContain(ORDER_SN);
  });

  it('uma redelivery com a válvula ainda fechada soma no MESMO aviso (tier 0 + increment)', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());
    falhaDoEnqueue = new ShopeeNfeUploadTasksDisabledError();

    await tratar(undefined, nfe());
    await tratar(undefined, nfe());

    expect(db.store[AVISO_PATH]?.data.ocorrencias).toBe(2);
    expect(Object.keys(db.store).filter((p) => p.startsWith('avisos/'))).toEqual([AVISO_PATH]);
  });

  it('⛔ QUASE-FALHA: a classe COMPARTILHADA do canal NÃO é a válvula da NF-e — propaga, sem aviso', async () => {
    // The shared class sits in `core/containment.ts`'s per-conta set; the NF-e
    // scheduler never throws it, so meeting it here is a bug to surface.
    db.seed(PEDIDO_PATH, pedidoRaw());
    const falha = new ShopeeTasksDisabledError();
    falhaDoEnqueue = falha;

    await expect(tratar(undefined, nfe())).rejects.toBe(falha);
    expect(db.store[AVISO_PATH]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('um ZodError, uma região ausente ou um erro de transporte PROPAGAM (retry: true), sem aviso', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());
    for (const falha of [new ZodError([]), new Error('SHOPEE_TASKS_REGION não definida')]) {
      falhaDoEnqueue = falha;
      await expect(tratar(undefined, nfe())).rejects.toBe(falha);
    }
    expect(db.store[AVISO_PATH]).toBeUndefined();
  });
});

describe('o invólucro onDocumentWritten', () => {
  type Snap = { exists: boolean; data: () => DocData | undefined };
  type Evento = {
    data: { before: Snap; after: Snap } | undefined;
    params: { pedidoId: string; nfeId: string };
  };

  function snap(data: DocData | null): Snap {
    return { exists: data !== null, data: () => data ?? undefined };
  }

  function run(antes: DocData | null, depois: DocData | null): Promise<unknown> {
    const evento: Evento = {
      data: { before: snap(antes), after: snap(depois) },
      params: { pedidoId: PEDIDO_ID, nfeId: NFE_ID },
    };
    return (onNfeAprovadaShopee as unknown as { run(e: Evento): Promise<unknown> }).run(evento);
  }

  it('uma escrita que não é borda NÃO chama getDb nem constrói o agendador', async () => {
    await run(nfe(), { ...nfe(), totais: { vNF: 10 } });

    expect(admin.getDb).not.toHaveBeenCalled();
    expect(tasks.createShopeeNfeUploadScheduler).not.toHaveBeenCalled();
    semLogNenhum();
  });

  it('uma aprovação nova usa os ids dos PARAMS do evento e enfileira pelo agendador real', async () => {
    db.seed(PEDIDO_PATH, pedidoRaw());

    await run(null, nfe());

    expect(admin.getDb).toHaveBeenCalledTimes(1);
    expect(tasks.createShopeeNfeUploadScheduler).toHaveBeenCalledTimes(1);
    expect(chamadas.map(([p]) => [p.pedidoId, p.nfeId])).toEqual([[PEDIDO_ID, NFE_ID]]);
  });

  it('um evento sem data nenhuma é um no-op silencioso', async () => {
    const evento = { data: undefined, params: { pedidoId: PEDIDO_ID, nfeId: NFE_ID } };
    await expect(
      (onNfeAprovadaShopee as unknown as { run(e: typeof evento): Promise<unknown> }).run(evento),
    ).resolves.toBeUndefined();
    expect(admin.getDb).not.toHaveBeenCalled();
    semLogNenhum();
  });
});

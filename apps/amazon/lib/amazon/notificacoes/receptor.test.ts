/**
 * The push receiver (`receptor.ts`), driven with a stream spy, a logger spy,
 * the app's fake db and a scripted producer. D11: nothing here reaches Amazon
 * or Cloud Tasks — the producer is a fake, or the REAL one over a transport
 * that rejects with the SDK's own classes (`testing/falhaDeEnfileiramento.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { MissingRegionError } from '@delfrance/core/region';
import { verifyStaticSecret } from '@delfrance/data/admin/signatures';
import { CABECALHO_CHAVE_RELAY_AMAZON } from '@delfrance/schemas';

import type { AmbienteAmazon } from '../env';
import { DIRETORIO_WIRE_AMAZON } from '../fixtures/wireCorpus';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  CORPO_DA_RESPOSTA_DO_TASKS,
  falhaDoFunctions,
  rejeicaoDoTransporte,
} from '../testing/falhaDeEnfileiramento';
import {
  APPLICATION_ID,
  type LinhaDeLog,
  SEGREDO_RELAY,
  SEGREDO_RELAY_ANTERIOR,
  SPID_A,
  fluxoEspiao,
  loggerEspiao,
} from '../testing/fixtures';
import {
  type AgendadorAmazon,
  AmazonTarefasDesligadasError,
  criarAgendadorAmazon,
} from './agendador';
import { MAX_CORPO_RECEPTOR_BYTES } from './corpo';
import type { PayloadNotificacaoAmazon } from './notificacao';
import {
  type DepsReceptorAmazon,
  PRAZO_ENFILEIRAMENTO_RECEPTOR_MS,
  PRAZO_PERSISTENCIA_RECEPTOR_MS,
  type RespostaReceptorAmazon,
  criarEstadoDaInstanciaReceptorAmazon,
  digestCurto,
  receberNotificacaoAmazon,
} from './receptor';

// A passthrough spy over the shared comparator: the comparisons must really go
// through it (a `===` would answer the same), and BOTH must run.
vi.mock('@delfrance/data/admin/signatures', async (importOriginal) => {
  const original = await importOriginal<typeof import('@delfrance/data/admin/signatures')>();
  return { ...original, verifyStaticSecret: vi.fn(original.verifyStaticSecret) };
});

/* -------------------------------------------------------------------------- */
/*                                  The kit                                   */
/* -------------------------------------------------------------------------- */

const COLECAO = 'notificacoesAmazon';
const REGIAO = 'xx-regiao-1';
const AGORA = Date.UTC(2027, 0, 15, 15, 0, 0);

/** The committed model example (`sb-order-change.json`), as the SQS body. */
function corpoOrderChange(): Record<string, unknown> {
  const envelope = JSON.parse(
    readFileSync(join(DIRETORIO_WIRE_AMAZON, 'sb-order-change.json'), 'utf8'),
  ) as { resposta: { corpo: Record<string, unknown> } };
  const corpo = structuredClone(envelope.resposta.corpo);
  // The sanitizer redacted both routing values: put the test placeholders back.
  (corpo.NotificationMetadata as Record<string, unknown>).ApplicationId = APPLICATION_ID;
  (
    (corpo.Payload as Record<string, unknown>).OrderChangeNotification as Record<string, unknown>
  ).SellerId = SPID_A;
  return corpo;
}

const BASE = corpoOrderChange();
const NOTIFICACAO = String((BASE.NotificationMetadata as Record<string, unknown>).NotificationId);
const PEDIDO = String(
  ((BASE.Payload as Record<string, unknown>).OrderChangeNotification as Record<string, unknown>)
    .AmazonOrderId,
);
/** `NotificationMetadata.PublishTime` of the model example: 2020-07-13T19:42:04.284Z. */
const PUBLISH_MS = Date.UTC(2020, 6, 13, 19, 42, 4, 284);
const DOC = `${COLECAO}/push:${NOTIFICACAO}`;

/** A camelCase FEED_PROCESSING_FINISHED, in-test (placeholder ids; no committed fixture, §3 decision 28). */
function corpoFeed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notificationVersion: '2020-09-04',
    notificationType: 'FEED_PROCESSING_FINISHED',
    payloadVersion: '2020-09-04',
    eventTime: '2020-07-13T19:42:04.284Z',
    payload: {
      feedProcessingFinishedNotification: {
        sellerId: SPID_A,
        accountId: 'amzn1.merchant.o.AXXXXXXXXXXXXX',
        feedId: '00000000000',
        feedType: 'POST_PRODUCT_DATA',
        processingStatus: 'DONE',
        ...over,
      },
    },
    notificationMetadata: {
      applicationId: APPLICATION_ID,
      subscriptionId: '00000000-0000-0000-0000-000000000000',
      publishTime: '2020-07-13T19:42:04.284Z',
      notificationId: '00000000-0000-0000-0000-000000000099',
    },
  };
}

const AMBIENTE: AmbienteAmazon = Object.freeze({
  AMAZON_RELAY_SECRET: SEGREDO_RELAY,
  AMAZON_APPLICATION_ID: APPLICATION_ID,
});

interface Entrega {
  readonly req: { headers: Headers; body: ReadableStream<Uint8Array> };
  readonly puxados: () => number;
  readonly cancelado: () => boolean;
}

/** One delivery: `corpo` is the SQS body, wrapped as the relay's template does unless `cru`. */
function entrega(
  corpo: unknown,
  opts: { chave?: string | null; cru?: boolean; partes?: readonly (string | Uint8Array)[] } = {},
): Entrega {
  const texto =
    typeof corpo === 'string' ? corpo : JSON.stringify(opts.cru === true ? corpo : { body: corpo });
  const f = fluxoEspiao(opts.partes ?? [texto]);
  const headers = new Headers({ 'content-type': 'application/json' });
  const chave = opts.chave === undefined ? SEGREDO_RELAY : opts.chave;
  if (chave !== null) headers.set(CABECALHO_CHAVE_RELAY_AMAZON, chave);
  return { req: { headers, body: f.stream }, puxados: f.puxados, cancelado: f.cancelado };
}

let db: FakeDb;
let linhas: LinhaDeLog[];
let enfileirados: PayloadNotificacaoAmazon[];

const agendadorQueAceita: AgendadorAmazon = {
  enfileirar(p) {
    enfileirados.push(p);
    return Promise.resolve();
  },
};

function deps(over: Partial<DepsReceptorAmazon> = {}): DepsReceptorAmazon {
  const espiao = loggerEspiao();
  linhas = espiao.linhas;
  return {
    ambiente: AMBIENTE,
    regiao: () => REGIAO,
    agendador: agendadorQueAceita,
    db: () => asDb(db),
    logger: espiao.logger,
    agora: () => AGORA,
    instancia: criarEstadoDaInstanciaReceptorAmazon(),
    ...over,
  };
}

function receber(e: Entrega, d: DepsReceptorAmazon = deps()): Promise<RespostaReceptorAmazon> {
  return receberNotificacaoAmazon(e.req, d);
}

/** The delivery lines (`evento: 'notificacao'`, with a status). */
const linhasDeEntrega = () => linhas.filter((l) => l.meta?.status !== undefined);
const ultima = () => linhasDeEntrega().at(-1);

const rejeicoesNaoTratadas: unknown[] = [];
const ouvir = (motivo: unknown) => {
  rejeicoesNaoTratadas.push(motivo);
};

beforeEach(() => {
  db = new FakeDb();
  enfileirados = [];
  linhas = [];
  rejeicoesNaoTratadas.length = 0;
  process.on('unhandledRejection', ouvir);
  vi.mocked(verifyStaticSecret).mockClear();
});

afterEach(() => {
  process.off('unhandledRejection', ouvir);
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/*                         The happy path and its line                        */
/* -------------------------------------------------------------------------- */

describe('the happy path', () => {
  it('the committed ORDER_CHANGE, wrapped { body }, is enqueued with EXACTLY the six fields', async () => {
    const r = await receber(entrega(BASE));
    expect(r).toEqual({ status: 200, resultado: 'enfileirada', detalhe: 'ok' });
    expect(enfileirados).toEqual([
      {
        tipo: 'pedido',
        origem: 'push',
        sellerId: SPID_A,
        amazonOrderId: PEDIDO,
        notificationId: NOTIFICACAO,
        publishTimeMs: PUBLISH_MS,
      },
    ]);
    expect(Object.keys(enfileirados[0] ?? {}).sort()).toEqual(
      ['amazonOrderId', 'notificationId', 'origem', 'publishTimeMs', 'sellerId', 'tipo'].sort(),
    );
  });

  it('touches no Firestore at all', async () => {
    const resolverDb = vi.fn(() => asDb(db));
    await receber(entrega(BASE), deps({ db: resolverDb }));
    expect(resolverDb).not.toHaveBeenCalled();
    expect(db.operacoes).toBe(0);
  });

  it('writes ONE line: the projection, with the task’s notification id and the timings', async () => {
    const relogio = [AGORA, AGORA + 37];
    await receber(entrega(BASE), deps({ agora: () => relogio.shift() ?? AGORA + 37 }));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('info');
    expect(linhas[0]?.meta).toEqual({
      evento: 'notificacao',
      idNotificacao: `push:${NOTIFICACAO}`,
      status: 200,
      resultado: 'enfileirada',
      detalhe: 'ok',
      chave: 'atual',
      forma: 'relay',
      casing: 'pascal',
      tipo: 'ORDER_CHANGE',
      bytes: JSON.stringify({ body: BASE }).length,
      amazonOrderId: PEDIDO,
      atrasoMs: AGORA - PUBLISH_MS,
      duracaoMs: 37,
    });
  });

  it('`body` as a JSON STRING is parsed once (forma relay-string)', async () => {
    const r = await receber(entrega(JSON.stringify({ body: JSON.stringify(BASE) })));
    expect(r.resultado).toBe('enfileirada');
    expect(enfileirados).toHaveLength(1);
    expect(ultima()?.meta?.forma).toBe('relay-string');
  });

  it('PublishTime is used and EventTime ignored (the model example has them differ)', async () => {
    expect(BASE.EventTime).not.toBe(
      (BASE.NotificationMetadata as Record<string, unknown>).PublishTime,
    );
    await receber(entrega(BASE));
    expect(enfileirados[0]?.origem === 'push' && enfileirados[0].publishTimeMs).toBe(PUBLISH_MS);
    // EventTime gone: still enqueued. PublishTime gone with EventTime valid: refused.
    const semEventTime = structuredClone(BASE);
    delete semEventTime.EventTime;
    expect((await receber(entrega(semEventTime))).resultado).toBe('enfileirada');
    const semPublish = structuredClone(BASE);
    delete (semPublish.NotificationMetadata as Record<string, unknown>).PublishTime;
    expect(await receber(entrega(semPublish))).toEqual({
      status: 200,
      resultado: 'descartada',
      detalhe: 'campo-invalido:PublishTime',
    });
  });

  it('the same NotificationId twice ⇒ two enqueues, both 200 (dedup is the store’s and the importer’s)', async () => {
    const instancia = criarEstadoDaInstanciaReceptorAmazon();
    expect((await receber(entrega(BASE), deps({ instancia }))).status).toBe(200);
    expect((await receber(entrega(BASE), deps({ instancia }))).status).toBe(200);
    expect(enfileirados).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*                              503: configuration                            */
/* -------------------------------------------------------------------------- */

describe('503: the configuration, before anything is read', () => {
  it.each([
    ['the secret unset', { AMAZON_RELAY_SECRET: undefined }, 'AMAZON_RELAY_SECRET'],
    ['the secret blank', { AMAZON_RELAY_SECRET: '   ' }, 'AMAZON_RELAY_SECRET'],
    [
      'a secret ending in \\n',
      { AMAZON_RELAY_SECRET: `${SEGREDO_RELAY}\n` },
      'AMAZON_RELAY_SECRET',
    ],
    ['a 31-character secret', { AMAZON_RELAY_SECRET: 'a'.repeat(31) }, 'AMAZON_RELAY_SECRET'],
    [
      'a previous secret with a trailing space',
      { AMAZON_RELAY_PREVIOUS_SECRET: `${SEGREDO_RELAY_ANTERIOR} ` },
      'AMAZON_RELAY_PREVIOUS_SECRET',
    ],
    ['the application id unset', { AMAZON_APPLICATION_ID: undefined }, 'AMAZON_APPLICATION_ID'],
    [
      'an application id holding a space',
      { AMAZON_APPLICATION_ID: 'amzn1.sp.solution.0000 0000' },
      'AMAZON_APPLICATION_ID',
    ],
  ])('%s ⇒ 503 with ZERO body reads, naming the key', async (_caso, sobre, chave) => {
    const e = entrega(BASE);
    const r = await receber(e, deps({ ambiente: { ...AMBIENTE, ...sobre } }));
    expect(r).toEqual({ status: 503, resultado: 'recusada', detalhe: 'config' });
    expect(e.puxados()).toBe(0);
    expect(enfileirados).toEqual([]);
    expect(vi.mocked(verifyStaticSecret)).not.toHaveBeenCalled();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.nivel).toBe('warn');
    expect(linhas[0]?.meta?.chaves).toBe(chave);
    // Names, never values.
    expect(JSON.stringify(linhas)).not.toContain(SEGREDO_RELAY);
    expect(JSON.stringify(linhas)).not.toContain(APPLICATION_ID);
  });

  it('the region unset (MissingRegionError) ⇒ 503 naming AMAZON_TASKS_REGION', async () => {
    const e = entrega(BASE);
    const regiao = () => {
      throw new MissingRegionError('sem região', ['AMAZON_TASKS_REGION', 'FUNCTIONS_REGION']);
    };
    const r = await receber(e, deps({ regiao }));
    expect(r.status).toBe(503);
    expect(e.puxados()).toBe(0);
    expect(ultima()?.meta?.chaves).toBe('AMAZON_TASKS_REGION');
  });

  it('a region outside the queue path’s grammar ⇒ 503 too', async () => {
    const r = await receber(entrega(BASE), deps({ regiao: () => 'regiao/outra' }));
    expect(r.status).toBe(503);
  });

  it('any other error from the region resolver is NOT a config gap: rethrown', async () => {
    const erro = new TypeError('bug');
    await expect(
      receber(
        entrega(BASE),
        deps({
          regiao: () => {
            throw erro;
          },
        }),
      ),
    ).rejects.toBe(erro);
  });

  it('every refused key at once, in a fixed order', async () => {
    await receber(entrega(BASE), deps({ ambiente: {}, regiao: () => 'X' }));
    expect(ultima()?.meta?.chaves).toBe(
      'AMAZON_RELAY_SECRET,AMAZON_APPLICATION_ID,AMAZON_TASKS_REGION',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                401: the key                                */
/* -------------------------------------------------------------------------- */

describe('401: the relay key, with the body never read', () => {
  it.each([
    ['missing', null, 'chave-ausente'],
    ['empty', '', 'chave-ausente'],
    ['wrong', `${SEGREDO_RELAY.slice(0, -1)}X`, 'chave-invalida'],
    // (`Headers` strips surrounding whitespace itself, so a padded copy of the
    // secret is not a case a request can carry; a prefix is.)
    ['a prefix of the secret', SEGREDO_RELAY.slice(0, -1), 'chave-invalida'],
    ['the previous one while none is set', SEGREDO_RELAY_ANTERIOR, 'chave-invalida'],
  ])('a %s header ⇒ 401, body unread', async (_caso, chave, detalhe) => {
    const e = entrega(BASE, { chave });
    const r = await receber(e);
    expect(r).toEqual({ status: 401, resultado: 'recusada', detalhe });
    expect(e.puxados()).toBe(0);
    expect(enfileirados).toEqual([]);
    expect(ultima()?.meta?.chave).toBeNull();
    expect(JSON.stringify(linhas)).not.toContain(SEGREDO_RELAY.slice(0, 20));
  });

  it('compares through the shared constant-time primitive — current, then previous, BOTH always', async () => {
    const ambiente = { ...AMBIENTE, AMAZON_RELAY_PREVIOUS_SECRET: SEGREDO_RELAY_ANTERIOR };
    await receber(entrega(BASE), deps({ ambiente }));
    expect(vi.mocked(verifyStaticSecret).mock.calls).toEqual([
      [{ received: SEGREDO_RELAY, expected: SEGREDO_RELAY }],
      [{ received: SEGREDO_RELAY, expected: SEGREDO_RELAY_ANTERIOR }],
    ]);
  });

  it('with no previous secret, exactly one comparison', async () => {
    await receber(entrega(BASE));
    expect(vi.mocked(verifyStaticSecret).mock.calls).toEqual([
      [{ received: SEGREDO_RELAY, expected: SEGREDO_RELAY }],
    ]);
  });

  it('the previous secret is accepted while set, and logged chave: anterior', async () => {
    const ambiente = { ...AMBIENTE, AMAZON_RELAY_PREVIOUS_SECRET: SEGREDO_RELAY_ANTERIOR };
    const r = await receber(entrega(BASE, { chave: SEGREDO_RELAY_ANTERIOR }), deps({ ambiente }));
    expect(r.status).toBe(200);
    expect(ultima()?.meta?.chave).toBe('anterior');
  });

  it('the current one is logged chave: atual — and wins when both match', async () => {
    await receber(entrega(BASE));
    expect(ultima()?.meta?.chave).toBe('atual');
    const ambos = { ...AMBIENTE, AMAZON_RELAY_PREVIOUS_SECRET: SEGREDO_RELAY };
    await receber(entrega(BASE), deps({ ambiente: ambos }));
    expect(ultima()?.meta?.chave).toBe('atual');
  });

  it('once the previous secret is unset, the old value is a 401', async () => {
    const r = await receber(entrega(BASE, { chave: SEGREDO_RELAY_ANTERIOR }));
    expect(r.status).toBe(401);
  });

  it.each(['', '   '])(
    'a blank previous secret (%j) never matches an EMPTY or equally blank header',
    async (anterior) => {
      const ambiente = { ...AMBIENTE, AMAZON_RELAY_PREVIOUS_SECRET: anterior };
      expect((await receber(entrega(BASE, { chave: '' }), deps({ ambiente }))).status).toBe(401);
      expect(
        (
          await receber(
            entrega(BASE, { chave: anterior === '' ? null : anterior }),
            deps({ ambiente }),
          )
        ).status,
      ).toBe(401);
    },
  );

  it('the rotation WARNING appears once per instance while a previous secret is set', async () => {
    const ambiente = { ...AMBIENTE, AMAZON_RELAY_PREVIOUS_SECRET: SEGREDO_RELAY_ANTERIOR };
    const instancia = criarEstadoDaInstanciaReceptorAmazon();
    const todas: LinhaDeLog[] = [];
    for (let i = 0; i < 3; i++) {
      await receber(entrega(BASE), deps({ ambiente, instancia }));
      todas.push(...linhas);
    }
    const rotacao = (l: readonly LinhaDeLog[]) =>
      l.filter((x) => x.meta?.resultado === 'rotacao-aberta');
    expect(rotacao(todas)).toHaveLength(1);
    expect(rotacao(todas)[0]?.nivel).toBe('warn');
    // A new instance warns again; no previous secret, no warning.
    await receber(entrega(BASE), deps({ ambiente }));
    expect(rotacao(linhas)).toHaveLength(1);
    await receber(entrega(BASE));
    expect(rotacao(linhas)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                               200: the drops                               */
/* -------------------------------------------------------------------------- */

describe('200 + drop: never a 4xx', () => {
  const descartada = (detalhe: string) => ({ status: 200, resultado: 'descartada', detalhe });

  it('a foreign application id ⇒ 200, no enqueue, a WARNING with its 8-hex digest prefix only', async () => {
    const estrangeiro = 'app-id-00000000-0000-0000-0000-000000000000';
    const corpo = structuredClone(BASE);
    (corpo.NotificationMetadata as Record<string, unknown>).ApplicationId = estrangeiro;
    expect(await receber(entrega(corpo))).toEqual(descartada('aplicacao-estrangeira'));
    expect(enfileirados).toEqual([]);
    const linha = ultima();
    expect(linha?.nivel).toBe('warn');
    expect(linha?.meta?.aplicacaoDigest).toBe(digestCurto(estrangeiro));
    expect(String(linha?.meta?.aplicacaoDigest)).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(linhas)).not.toContain(estrangeiro);
  });

  it.each([
    ['upper-cased', APPLICATION_ID.toUpperCase()],
    ['with a trailing space', `${APPLICATION_ID} `],
    ['with a leading space', ` ${APPLICATION_ID}`],
  ])('an application id differing only %s is foreign (no trim, no fold)', async (_c, id) => {
    const corpo = structuredClone(BASE);
    (corpo.NotificationMetadata as Record<string, unknown>).ApplicationId = id;
    expect(await receber(entrega(corpo))).toEqual(descartada('aplicacao-estrangeira'));
    expect(enfileirados).toEqual([]);
  });

  it('a missing application id is foreign, with no digest', async () => {
    const corpo = structuredClone(BASE);
    delete (corpo.NotificationMetadata as Record<string, unknown>).ApplicationId;
    expect(await receber(entrega(corpo))).toEqual(descartada('aplicacao-estrangeira'));
    expect(ultima()?.meta?.aplicacaoDigest).toBeNull();
  });

  it('the app id is checked BEFORE the routing fields', async () => {
    const corpo = structuredClone(BASE);
    (corpo.NotificationMetadata as Record<string, unknown>).ApplicationId = 'outra';
    (corpo.NotificationMetadata as Record<string, unknown>).NotificationId = 'com/barra';
    expect((await receber(entrega(corpo))).detalhe).toBe('aplicacao-estrangeira');
  });

  it.each(['{', '', 'null x', '\u0000'])(
    'malformed JSON (%j) ⇒ 200 json-invalido',
    async (texto) => {
      expect(await receber(entrega(texto))).toEqual(descartada('json-invalido'));
    },
  );

  it('a `body` string that is not JSON ⇒ json-invalido, forma relay-string', async () => {
    expect(await receber(entrega(JSON.stringify({ body: '{nao' })))).toEqual(
      descartada('json-invalido'),
    );
    expect(ultima()?.meta?.forma).toBe('relay-string');
  });

  it('oversized (256 KiB + 1) ⇒ 200 corpo-grande, and the read stops at the bound', async () => {
    const meio = 128 * 1024;
    const e = entrega('', {
      partes: [
        new Uint8Array(meio),
        new Uint8Array(meio),
        new Uint8Array(1),
        new Uint8Array(meio),
        new Uint8Array(meio),
      ],
    });
    const r = await receber(e);
    expect(r).toEqual(descartada('corpo-grande'));
    expect(e.puxados()).toBe(3);
    expect(e.cancelado()).toBe(true);
    expect(ultima()?.nivel).toBe('warn');
    expect(ultima()?.meta?.bytes).toBe(MAX_CORPO_RECEPTOR_BYTES + 1);
  });

  it('a bare envelope (no relay wrapper) ⇒ sem-envelope-do-relay, a WARNING', async () => {
    expect(await receber(entrega(BASE, { cru: true }))).toEqual(
      descartada('sem-envelope-do-relay'),
    );
    expect(ultima()?.nivel).toBe('warn');
    expect(ultima()?.meta?.forma).toBe('sem-envelope');
    expect(enfileirados).toEqual([]);
  });

  it('both type keys ⇒ forma-ambigua; neither ⇒ sem-tipo (WARNINGs)', async () => {
    expect(await receber(entrega({ ...BASE, notificationType: 'ORDER_CHANGE' }))).toEqual(
      descartada('forma-ambigua'),
    );
    expect(ultima()?.nivel).toBe('warn');
    const semTipo = structuredClone(BASE);
    delete semTipo.NotificationType;
    expect(await receber(entrega(semTipo))).toEqual(descartada('sem-tipo'));
  });

  it('another type ⇒ tipo-desconhecido (INFO), with the type when it is UPPER_SNAKE', async () => {
    expect(await receber(entrega({ ...BASE, NotificationType: 'ANY_OFFER_CHANGED' }))).toEqual(
      descartada('tipo-desconhecido'),
    );
    expect(ultima()?.nivel).toBe('info');
    expect(ultima()?.meta?.tipo).toBe('ANY_OFFER_CHANGED');
    await receber(entrega({ ...BASE, NotificationType: 'texto livre do corpo' }));
    expect(ultima()?.meta?.tipo).toBeNull();
  });

  it('the casing is pinned: a Pascal FEED and a camel ORDER_CHANGE are both unknown', async () => {
    const pascalFeed = { ...corpoFeed(), NotificationType: 'FEED_PROCESSING_FINISHED' } as Record<
      string,
      unknown
    >;
    delete pascalFeed.notificationType;
    expect((await receber(entrega(pascalFeed))).detalhe).toBe('tipo-desconhecido');
    const camelOrder = { ...BASE, notificationType: 'ORDER_CHANGE' } as Record<string, unknown>;
    delete camelOrder.NotificationType;
    expect((await receber(entrega(camelOrder))).detalhe).toBe('tipo-desconhecido');
    expect(enfileirados).toEqual([]);
  });

  it.each([
    ['SellerId', ['Payload', 'OrderChangeNotification', 'SellerId'], 'vendedor com espaço'],
    [
      'AmazonOrderId',
      ['Payload', 'OrderChangeNotification', 'AmazonOrderId'],
      '000-0000000-68028140',
    ],
    ['NotificationId', ['NotificationMetadata', 'NotificationId'], 'id/com/barra'],
    ['PublishTime', ['NotificationMetadata', 'PublishTime'], '2020-07-13T19:42:04.284'],
  ])('an invalid %s ⇒ campo-invalido:%s, nothing enqueued', async (nome, caminho, valor) => {
    const corpo = structuredClone(BASE);
    let alvo = corpo as Record<string, unknown>;
    for (const chave of caminho.slice(0, -1)) alvo = alvo[chave] as Record<string, unknown>;
    alvo[caminho.at(-1) ?? ''] = valor;
    expect(await receber(entrega(corpo))).toEqual(descartada(`campo-invalido:${nome}`));
    expect(enfileirados).toEqual([]);
    expect(ultima()?.meta?.amazonOrderId).toBeNull();
  });

  it('FEED_PROCESSING_FINISHED (camelCase) ⇒ parsed, then feed-sem-consumidor (INFO), never enqueued', async () => {
    expect(await receber(entrega(corpoFeed()))).toEqual(descartada('feed-sem-consumidor'));
    expect(ultima()?.nivel).toBe('info');
    expect(ultima()?.meta?.casing).toBe('camel');
    expect(ultima()?.meta?.tipo).toBe('FEED_PROCESSING_FINISHED');
    expect(enfileirados).toEqual([]);
    // Its own fields are checked too, and its app id first.
    expect((await receber(entrega(corpoFeed({ accountId: undefined })))).detalhe).toBe(
      'campo-invalido:accountId',
    );
    const estrangeiro = corpoFeed();
    (estrangeiro.notificationMetadata as Record<string, unknown>).applicationId = 'outra';
    expect((await receber(entrega(estrangeiro))).detalhe).toBe('aplicacao-estrangeira');
  });
});

/* -------------------------------------------------------------------------- */
/*                             Enqueue failures                               */
/* -------------------------------------------------------------------------- */

describe('an enqueue failure', () => {
  it('the valve closed (the REAL producer) ⇒ a failed doc + 200, a WARNING', async () => {
    const agendador = criarAgendadorAmazon({
      desligado: true,
      fila: () => {
        throw new Error('a fila não pode ser resolvida com a válvula fechada');
      },
    });
    const r = await receber(entrega(BASE), deps({ agendador }));
    expect(r).toEqual({
      status: 200,
      resultado: 'persistida',
      detalhe: 'enfileiramento/AmazonTarefasDesligadasError',
    });
    expect(db.ler(DOC)).toMatchObject({
      status: 'failed',
      erro: 'enfileiramento/AmazonTarefasDesligadasError',
      sellerId: SPID_A,
      amazonOrderId: PEDIDO,
      notificationId: NOTIFICACAO,
      publishTimeMs: PUBLISH_MS,
      origem: 'push',
    });
    expect(ultima()?.nivel).toBe('warn');
  });

  it('a named transient (the REAL classifier over a 503) ⇒ a failed doc + 200, no SDK text anywhere', async () => {
    const agendador: AgendadorAmazon = {
      enfileirar: () => rejeicaoDoTransporte(falhaDoFunctions('unknown-error', 503)),
    };
    const r = await receber(entrega(BASE), deps({ agendador }));
    expect(r).toEqual({
      status: 200,
      resultado: 'persistida',
      detalhe: 'enfileiramento/AmazonTarefasTransitoriasError/functions/unknown-error',
    });
    expect(db.ler(DOC)?.status).toBe('failed');
    expect(JSON.stringify(db.ler(DOC))).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(JSON.stringify(linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
    expect(ultima()?.nivel).toBe('warn');
  });

  it('a raw SDK permission-denied ⇒ a failed doc + 200 + an ERROR (deploy-shaped)', async () => {
    const agendador: AgendadorAmazon = {
      enfileirar: () => rejeicaoDoTransporte(falhaDoFunctions('permission-denied', 403)),
    };
    const r = await receber(entrega(BASE), deps({ agendador }));
    expect(r).toEqual({
      status: 200,
      resultado: 'persistida',
      detalhe: 'enfileiramento/FirebaseFunctionsError/functions/permission-denied',
    });
    expect(db.ler(DOC)?.status).toBe('failed');
    expect(ultima()?.nivel).toBe('error');
    expect(JSON.stringify(linhas)).not.toContain(CORPO_DA_RESPOSTA_DO_TASKS);
  });

  it('a TypeError from the enqueue ⇒ rethrown (500), NOTHING persisted, one ERROR line', async () => {
    const erro = new TypeError('bug no produtor');
    const agendador: AgendadorAmazon = { enfileirar: () => Promise.reject(erro) };
    await expect(receber(entrega(BASE), deps({ agendador }))).rejects.toBe(erro);
    expect(db.caminhos()).toEqual([]);
    expect(linhasDeEntrega()).toHaveLength(1);
    expect(ultima()?.meta).toMatchObject({
      status: 500,
      resultado: 'falhou',
      detalhe: 'enfileiramento/TypeError',
    });
    expect(JSON.stringify(linhas)).not.toContain('bug no produtor');
  });

  it('a persist ZodError ⇒ 200 falha-nao-persistivel (ERROR)', async () => {
    db.antesDaProximaEscrita(DOC, () => {
      throw new ZodError([]);
    });
    const agendador: AgendadorAmazon = {
      enfileirar: () => Promise.reject(new AmazonTarefasDesligadasError()),
    };
    const r = await receber(entrega(BASE), deps({ agendador }));
    expect(r).toEqual({ status: 200, resultado: 'descartada', detalhe: 'falha-nao-persistivel' });
    expect(ultima()?.nivel).toBe('error');
  });

  it('a persist gRPC UNAVAILABLE ⇒ rethrown (500), never a 200', async () => {
    const falha = grpc(14, 'UNAVAILABLE');
    db.falharEscrita(DOC, falha);
    const agendador: AgendadorAmazon = {
      enfileirar: () => Promise.reject(new AmazonTarefasDesligadasError()),
    };
    await expect(receber(entrega(BASE), deps({ agendador }))).rejects.toBe(falha);
    expect(ultima()?.meta).toMatchObject({ status: 500, resultado: 'falhou' });
    expect(ultima()?.nivel).toBe('error');
  });
});

/* -------------------------------------------------------------------------- */
/*                          The deadlines (fake timers)                       */
/* -------------------------------------------------------------------------- */

describe('the deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('pins the two deadlines', () => {
    expect(PRAZO_ENFILEIRAMENTO_RECEPTOR_MS).toBe(2000);
    expect(PRAZO_PERSISTENCIA_RECEPTOR_MS).toBe(1500);
  });

  it('an enqueue that never resolves ⇒ a failed doc + 200 by the enqueue deadline; its late rejection is consumed', async () => {
    let rejeitar: (e: unknown) => void = () => undefined;
    const agendador: AgendadorAmazon = {
      enfileirar: () =>
        new Promise<void>((_res, rej) => {
          rejeitar = rej;
        }),
    };
    let resposta: RespostaReceptorAmazon | null = null;
    void receber(entrega(BASE), deps({ agendador })).then((r) => {
      resposta = r;
    });
    await vi.advanceTimersByTimeAsync(PRAZO_ENFILEIRAMENTO_RECEPTOR_MS - 1);
    expect(resposta).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(resposta).toEqual({
      status: 200,
      resultado: 'persistida',
      detalhe: 'enfileiramento/AmazonTarefasTransitoriasError/prazo',
    });
    expect(db.ler(DOC)?.erro).toBe('enfileiramento/AmazonTarefasTransitoriasError/prazo');

    // The loser rejects AFTER the answer: one ERROR line, the class only.
    rejeitar(new TypeError('detalhe que não pode vazar'));
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((r) => setImmediate(r));
    const tardias = linhas.filter((l) => l.meta?.resultado === 'rejeicao-tardia');
    expect(tardias).toHaveLength(1);
    expect(tardias[0]?.nivel).toBe('error');
    expect(tardias[0]?.meta).toEqual({
      evento: 'notificacao',
      idNotificacao: `push:${NOTIFICACAO}`,
      resultado: 'rejeicao-tardia',
      operacao: 'enfileiramento',
      classe: 'TypeError',
    });
    expect(JSON.stringify(linhas)).not.toContain('detalhe que não pode vazar');
    expect(rejeicoesNaoTratadas).toEqual([]);
  });

  it('a LATE named transient is a WARNING, still consumed', async () => {
    let rejeitar: (e: unknown) => void = () => undefined;
    const agendador: AgendadorAmazon = {
      enfileirar: () =>
        new Promise<void>((_res, rej) => {
          rejeitar = rej;
        }),
    };
    void receber(entrega(BASE), deps({ agendador }));
    await vi.advanceTimersByTimeAsync(PRAZO_ENFILEIRAMENTO_RECEPTOR_MS);
    rejeitar(new AmazonTarefasDesligadasError());
    await new Promise<void>((r) => setImmediate(r));
    const tardias = linhas.filter((l) => l.meta?.resultado === 'rejeicao-tardia');
    expect(tardias.map((l) => l.nivel)).toEqual(['warn']);
    expect(rejeicoesNaoTratadas).toEqual([]);
  });

  it('a persist that never resolves ⇒ 500 at its deadline', async () => {
    db.antesDaProximaEscrita(DOC, () => new Promise<void>(() => undefined));
    const agendador: AgendadorAmazon = {
      enfileirar: () => Promise.reject(new AmazonTarefasDesligadasError()),
    };
    let resposta: RespostaReceptorAmazon | null = null;
    void receber(entrega(BASE), deps({ agendador })).then((r) => {
      resposta = r;
    });
    await vi.advanceTimersByTimeAsync(PRAZO_PERSISTENCIA_RECEPTOR_MS - 1);
    expect(resposta).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(resposta).toEqual({ status: 500, resultado: 'falhou', detalhe: 'persistencia/prazo' });
    expect(ultima()?.nivel).toBe('error');
  });

  it('both deadlines together stay within the sum (enqueue hangs, then the persist hangs)', async () => {
    db.antesDaProximaEscrita(DOC, () => new Promise<void>(() => undefined));
    const agendador: AgendadorAmazon = { enfileirar: () => new Promise<void>(() => undefined) };
    let resposta: RespostaReceptorAmazon | null = null;
    void receber(entrega(BASE), deps({ agendador })).then((r) => {
      resposta = r;
    });
    await vi.advanceTimersByTimeAsync(
      PRAZO_ENFILEIRAMENTO_RECEPTOR_MS + PRAZO_PERSISTENCIA_RECEPTOR_MS,
    );
    expect(resposta).toMatchObject({ status: 500, detalhe: 'persistencia/prazo' });
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Hygiene                                   */
/* -------------------------------------------------------------------------- */

describe('the log lines', () => {
  it('no line, over every outcome, carries the seller id, our app id or the relay secret', async () => {
    const todas: LinhaDeLog[] = [];
    const estrangeiro = structuredClone(BASE);
    (estrangeiro.NotificationMetadata as Record<string, unknown>).ApplicationId =
      'app-id-estrangeiro';
    const casos: [Entrega, Partial<DepsReceptorAmazon>][] = [
      [entrega(BASE), {}],
      [entrega(estrangeiro), {}],
      [entrega(corpoFeed()), {}],
      [entrega(BASE, { chave: 'errada' }), {}],
      [entrega(BASE), { ambiente: { ...AMBIENTE, AMAZON_RELAY_SECRET: undefined } }],
      [
        entrega(BASE),
        { agendador: { enfileirar: () => Promise.reject(new AmazonTarefasDesligadasError()) } },
      ],
    ];
    for (const [e, sobre] of casos) {
      await receber(e, deps(sobre));
      todas.push(...linhas);
    }
    expect(todas.length).toBeGreaterThanOrEqual(casos.length);
    const texto = JSON.stringify(todas);
    expect(texto).not.toContain(SPID_A);
    expect(texto).not.toContain(APPLICATION_ID);
    expect(texto).not.toContain('app-id-estrangeiro');
    expect(texto).not.toContain(SEGREDO_RELAY);
  });

  it('digestCurto is 8 lowercase hex characters, and tells two ids apart', () => {
    expect(digestCurto('a')).toMatch(/^[0-9a-f]{8}$/);
    expect(digestCurto('a')).not.toBe(digestCurto('A'));
  });
});

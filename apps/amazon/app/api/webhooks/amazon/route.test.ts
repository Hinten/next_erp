/**
 * `POST /api/webhooks/amazon` — the thin route over `receberNotificacaoAmazon`
 * (whose table `receptor.test.ts` covers case by case). Here: the bindings, the
 * status passthrough with an EMPTY body and both headers, the exports, and that
 * the instance memory lives at module scope.
 *
 * Mocked: the Admin singleton (the fake db) and the queue root (a recording
 * producer per queue: the reads queue's and, since step 12a (PR 12-c), the jobs
 * queue's). D11: nothing reaches Amazon or Cloud Tasks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CABECALHO_CHAVE_RELAY_AMAZON, CAMINHO_RECEPTOR_AMAZON } from '@delfrance/schemas';

import type { AgendadorLotesAmazon } from '@/lib/amazon/feeds/agendadorLotes';
import type { AgendadorAmazon } from '@/lib/amazon/notificacoes/agendador';
import type { PayloadNotificacaoAmazon } from '@/lib/amazon/notificacoes/notificacao';
import { FakeDb, asDb } from '@/lib/amazon/testing/fakeDb';
import {
  APPLICATION_ID,
  SEGREDO_RELAY,
  SEGREDO_RELAY_ANTERIOR,
  SPID_A,
  espiarStdout,
} from '@/lib/amazon/testing/fixtures';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  enfileirados: [] as unknown[],
  agendador: undefined as unknown,
  lotes: [] as unknown[],
  agendadorLotes: undefined as unknown,
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => {
    throw new Error('o receptor é público: não verifica token');
  },
  getAdminFirestore: () => h.db,
}));

vi.mock('@/lib/firebase/filaLeitura', () => ({
  regiaoDaFilaLeituraAmazon: () => 'xx-regiao-1',
  agendadorDaFilaLeituraAmazon: () => h.agendador,
  agendadorDaFilaLotesAmazon: () => h.agendadorLotes,
}));

const rota = await import('./route');
const { POST } = rota;

const URL_RECEPTOR = `http://localhost:3011${CAMINHO_RECEPTOR_AMAZON}`;

function corpo(): Record<string, unknown> {
  return {
    NotificationType: 'ORDER_CHANGE',
    Payload: {
      OrderChangeNotification: { SellerId: SPID_A, AmazonOrderId: '000-0000000-0000001' },
    },
    NotificationMetadata: {
      ApplicationId: APPLICATION_ID,
      PublishTime: '2020-07-13T19:42:04.284Z',
      NotificationId: '00000000-0000-0000-0000-000000000001',
    },
  };
}

/** A FEED_PROCESSING_FINISHED of one of our listings feeds (camelCase, placeholder ids). */
function corpoFeed(): Record<string, unknown> {
  return {
    notificationType: 'FEED_PROCESSING_FINISHED',
    payload: {
      feedProcessingFinishedNotification: {
        sellerId: SPID_A,
        accountId: 'amzn1.merchant.o.AXXXXXXXXXXXXX',
        feedId: '00000000000',
        feedType: 'JSON_LISTINGS_FEED',
        processingStatus: 'DONE',
      },
    },
    notificationMetadata: {
      applicationId: APPLICATION_ID,
      notificationId: '00000000-0000-0000-0000-000000000002',
    },
  };
}

function post(
  chave: string | null = SEGREDO_RELAY,
  envelope: Record<string, unknown> = corpo(),
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (chave !== null) headers.set(CABECALHO_CHAVE_RELAY_AMAZON, chave);
  return POST(
    new Request(URL_RECEPTOR, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: envelope }),
    }),
  );
}

let db: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;

const aceita: AgendadorAmazon = {
  enfileirar(p: PayloadNotificacaoAmazon) {
    h.enfileirados.push(p);
    return Promise.resolve();
  },
};

const aceitaLotes: AgendadorLotesAmazon = {
  enfileirarLote(tarefa, pedido) {
    h.lotes.push({ tarefa, pedido });
    return Promise.resolve('enfileirada');
  },
};

async function resposta(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await res.text()).toBe('');
}

beforeEach(() => {
  db = new FakeDb();
  h.db = asDb(db);
  h.enfileirados.length = 0;
  h.agendador = aceita;
  h.lotes.length = 0;
  h.agendadorLotes = aceitaLotes;
  vi.stubEnv('AMAZON_RELAY_SECRET', SEGREDO_RELAY);
  vi.stubEnv('AMAZON_RELAY_PREVIOUS_SECRET', '');
  vi.stubEnv('AMAZON_APPLICATION_ID', APPLICATION_ID);
  stdout = espiarStdout();
});

afterEach(() => {
  stdout.restaurar();
  vi.unstubAllEnvs();
});

describe('POST /api/webhooks/amazon', () => {
  it('exports POST alone, force-dynamic on the Node runtime', () => {
    expect(rota.dynamic).toBe('force-dynamic');
    expect(rota.runtime).toBe('nodejs');
    const verbos = Object.keys(rota).filter((k) => /^[A-Z]+$/.test(k));
    expect(verbos).toEqual(['POST']);
  });

  it('a valid delivery ⇒ 200, an EMPTY body, no-store and no-referrer; enqueued', async () => {
    await resposta(await post(), 200);
    expect(h.enfileirados).toHaveLength(1);
    expect(h.lotes).toEqual([]);
    expect(db.operacoes).toBe(0);
  });

  it('★ binds the jobs producer beside the reads one: a feed wake-up goes to the jobs queue alone ⇒ 200, empty', async () => {
    await resposta(await post(SEGREDO_RELAY, corpoFeed()), 200);
    expect(h.lotes).toHaveLength(1);
    expect(h.lotes[0]).toMatchObject({
      tarefa: { tipo: 'feed-resultado', contaId: null, feedId: '00000000000', rodada: 0 },
    });
    expect(h.enfileirados).toEqual([]);
    expect(db.operacoes).toBe(0);
  });

  it('a feed wake-up the jobs queue refuses ⇒ still 200, nothing persisted', async () => {
    const { AmazonLotesTarefasDesligadasError } = await import('@/lib/amazon/feeds/agendadorLotes');
    h.agendadorLotes = {
      enfileirarLote: () => Promise.reject(new AmazonLotesTarefasDesligadasError()),
    } satisfies AgendadorLotesAmazon;
    await resposta(await post(SEGREDO_RELAY, corpoFeed()), 200);
    expect(db.caminhos()).toEqual([]);
  });

  it('passes the receptor’s 401 and 503 through, empty and uncached', async () => {
    await resposta(await post('errada-errada-errada-errada-errada-x'), 401);
    vi.stubEnv('AMAZON_RELAY_SECRET', '');
    await resposta(await post(), 503);
    expect(h.enfileirados).toEqual([]);
  });

  it('an enqueue failure is persisted through the Admin singleton ⇒ 200', async () => {
    vi.stubEnv('AMAZON_TASKS_DISABLED', '1');
    const { AmazonTarefasDesligadasError } = await import('@/lib/amazon/notificacoes/agendador');
    h.agendador = {
      enfileirar: () => Promise.reject(new AmazonTarefasDesligadasError()),
    } satisfies AgendadorAmazon;
    await resposta(await post(), 200);
    expect(db.caminhos()).toEqual(['notificacoesAmazon/push:00000000-0000-0000-0000-000000000001']);
  });

  it('what the receptor rethrows reaches the platform (its 500)', async () => {
    const erro = new TypeError('bug');
    h.agendador = { enfileirar: () => Promise.reject(erro) } satisfies AgendadorAmazon;
    await expect(post()).rejects.toBe(erro);
  });

  it('logs on stdout, one JSON line per delivery, the rotation WARNING once per MODULE instance', async () => {
    vi.stubEnv('AMAZON_RELAY_PREVIOUS_SECRET', SEGREDO_RELAY_ANTERIOR);
    await post();
    await post(SEGREDO_RELAY_ANTERIOR);
    const linhas = stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
    // Earlier cases ran with no previous secret, so this module instance warns
    // here for the first time — and only once over the two deliveries.
    expect(linhas.filter((l) => l.resultado === 'rotacao-aberta')).toHaveLength(1);
    const entregas = linhas.filter((l) => l.evento === 'notificacao' && l.status !== undefined);
    expect(entregas.map((l) => l.chave)).toEqual(['atual', 'anterior']);
    const texto = stdout.linhas().join('');
    for (const proibido of [SPID_A, APPLICATION_ID, SEGREDO_RELAY, SEGREDO_RELAY_ANTERIOR]) {
      expect(texto).not.toContain(proibido);
    }
  });
});

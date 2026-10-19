/**
 * `POST /api/webhooks/amazon` — the thin route over `receberNotificacaoAmazon`
 * (whose table `receptor.test.ts` covers case by case). Here: the bindings, the
 * status passthrough with an EMPTY body and both headers, the exports, and that
 * the instance memory lives at module scope.
 *
 * Mocked: the Admin singleton (the fake db) and the queue root (a recording
 * producer). D11: nothing reaches Amazon or Cloud Tasks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CABECALHO_CHAVE_RELAY_AMAZON, CAMINHO_RECEPTOR_AMAZON } from '@delfrance/schemas';

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

function post(chave: string | null = SEGREDO_RELAY): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (chave !== null) headers.set(CABECALHO_CHAVE_RELAY_AMAZON, chave);
  return POST(
    new Request(URL_RECEPTOR, { method: 'POST', headers, body: JSON.stringify({ body: corpo() }) }),
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
    expect(db.operacoes).toBe(0);
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

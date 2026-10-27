/**
 * The writes-queue PRODUCER (master plan step 7, PR 7-d): its naming, and what
 * an enqueue's rejection means. The failures are the SDK's own classes
 * (`testing/falhaDeEnfileiramento.ts`) — never a numeric gRPC stand-in.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { ESTADO_RASTREIO_LI, TIPO_TAREFA_ESCRITA_LI } from '@delfrance/schemas';

import { LiTarefasDesligadasError, LiTarefasTransitoriasError } from '../notificacoes/agendador';
import {
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  type FilaEscritaLi,
  criarAgendadorEscritaLi,
  eventoDoHistoricoLi,
  idDaTarefaEscritaLi,
} from './agendadorEscrita';
import type { PayloadTarefaEscritaLi } from './notificacaoEscrita';

// D17, per file: nothing here may reach the global `fetch` (no client is built at all).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendadorEscrita.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PEDIDO_ID = '0123456789abcdef'.repeat(4);

function payload(over: Partial<PayloadTarefaEscritaLi> = {}): PayloadTarefaEscritaLi {
  return {
    tipo: TIPO_TAREFA_ESCRITA_LI.rastreio,
    contaId: 'conta-li-1',
    numero: '165',
    pedidoId: PEDIDO_ID,
    evento: eventoDoHistoricoLi(PEDIDO_ID, 'hist-1'),
    estado: ESTADO_RASTREIO_LI.postado,
    eventoEmMs: 1_789_000_000_123,
    ...over,
  };
}

function fila(falha: Error | null = null) {
  const chamadas: { payload: PayloadTarefaEscritaLi; opcoes: { id: string } }[] = [];
  const f: FilaEscritaLi = {
    enqueue: (p, opcoes) => {
      chamadas.push({ payload: p, opcoes });
      return falha === null ? Promise.resolve() : Promise.reject(falha);
    },
  };
  return { f, chamadas };
}

describe('the naming: a hash, never the source id itself', () => {
  it("evento = sha256('historico:' + pedidoId + '/' + historicoId), lowercase hex", () => {
    expect(eventoDoHistoricoLi(PEDIDO_ID, 'hist-1')).toBe(
      createHash('sha256').update(`historico:${PEDIDO_ID}/hist-1`, 'utf8').digest('hex'),
    );
    expect(eventoDoHistoricoLi(PEDIDO_ID, 'hist-1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('EQUAL pair: the same (pedidoId, historicoId) ⇒ the same evento', () => {
    expect(eventoDoHistoricoLi(PEDIDO_ID, 'hist-1')).toBe(eventoDoHistoricoLi(PEDIDO_ID, 'hist-1'));
  });

  it('⚠️ NEAR-MISS: another pedidoId or historicoId ⇒ another evento', () => {
    // The pedido id is always 64 hex characters (the payload schema), so the `/`
    // after it is unambiguous: no other pair spells the same preimage.
    const base = eventoDoHistoricoLi(PEDIDO_ID, 'hist-1');
    expect(eventoDoHistoricoLi(PEDIDO_ID, 'hist-2')).not.toBe(base);
    expect(eventoDoHistoricoLi(PEDIDO_ID, 'Hist-1')).not.toBe(base);
    expect(eventoDoHistoricoLi('f'.repeat(64), 'hist-1')).not.toBe(base);
  });

  it('the task id is `rastreio-<evento>`: within Cloud Tasks’ [A-Za-z0-9_-]{1,500}, whatever the source id holds', () => {
    const p = payload({ evento: eventoDoHistoricoLi(PEDIDO_ID, 'id com espaço/ç') });
    expect(idDaTarefaEscritaLi(p)).toBe(`rastreio-${p.evento}`);
    expect(idDaTarefaEscritaLi(p)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
  });
});

describe('the producer: what an enqueue rejection means', () => {
  it('sends the payload AND its task id, and resolves', async () => {
    const { f, chamadas } = fila();
    const p = payload();
    await criarAgendadorEscritaLi({ fila: () => f, desligado: false }).enfileirar(p, {
      id: idDaTarefaEscritaLi(p),
    });
    expect(chamadas).toEqual([{ payload: p, opcoes: { id: `rastreio-${p.evento}` } }]);
  });

  it('`functions/task-already-exists` (a 409 Cloud Tasks ANSWERED) is SUCCESS: the same event is already queued', async () => {
    const { f, chamadas } = fila(falhaDoFunctions('task-already-exists', 409));
    await expect(
      criarAgendadorEscritaLi({ fila: () => f, desligado: false }).enfileirar(payload(), {
        id: 'rastreio-x',
      }),
    ).resolves.toBeUndefined();
    expect(chamadas).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: an already-exists code with NO response is not a dedup ⇒ rethrown untouched', async () => {
    const semResposta = new FirebaseFunctionsError({
      code: 'task-already-exists',
      message: 'sem resposta',
    });
    const { f } = fila(semResposta);
    await expect(
      criarAgendadorEscritaLi({ fila: () => f, desligado: false }).enfileirar(payload(), {
        id: 'rastreio-x',
      }),
    ).rejects.toBe(semResposta);
  });

  it('the sweep-only valve closed ⇒ LiTarefasDesligadasError, and the queue is never resolved', async () => {
    let resolvida = false;
    await expect(
      criarAgendadorEscritaLi({
        fila: () => {
          resolvida = true;
          return fila().f;
        },
        desligado: true,
      }).enfileirar(payload(), { id: 'rastreio-x' }),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(resolvida).toBe(false);
  });

  it.each([
    ['a 503 answered', falhaDoFunctions('unknown-error', 503)],
    ['a 500 answered', falhaDoFunctions('internal-error', 500)],
    ['a socket failure', falhaDoApp('network-error')],
  ])('%s ⇒ LiTarefasTransitoriasError (persisted by the caller)', async (_caso, falha) => {
    const { f } = fila(falha);
    await expect(
      criarAgendadorEscritaLi({ fila: () => f, desligado: false }).enfileirar(payload(), {
        id: 'rastreio-x',
      }),
    ).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
  });

  it.each([
    ['permission denied', falhaDoFunctions('permission-denied', 403)],
    ['no queue in that region', falhaDoFunctions('not-found', 404)],
    ['the SDK cannot resolve the project', falhaDeConfiguracaoDoFunctions('projeto')],
    ['a coding bug', new TypeError('bug')],
  ])('%s ⇒ rethrown EXACTLY as thrown (a broken deploy, loud)', async (_caso, falha) => {
    const { f } = fila(falha);
    await expect(
      criarAgendadorEscritaLi({ fila: () => f, desligado: false }).enfileirar(payload(), {
        id: 'rastreio-x',
      }),
    ).rejects.toBe(falha);
  });
});

/**
 * The jobs queue's producer (step 12a, PR 12-c), offline: the path, the valve,
 * the caller's NAME (a digest, mandatory for a rung and a recovery), the delay
 * in WHOLE seconds, and the shared transient naming, driven with the Admin
 * SDK's REAL error classes (`testing/falhaDeEnfileiramento.ts`). No transport
 * is real and no network is reachable: the queue is a recording fake that, like
 * Cloud Tasks, refuses a name it already holds.
 */
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { AmazonNfeTarefasDesligadasError } from '../nfe/agendadorNfe';
import { AmazonTarefasDesligadasError } from '../notificacoes/agendador';
import { AmazonAgendamentoTarefasDesligadasError } from '../agendamento/agendadorAgendamento';
import {
  falhaDeConflitoDoTasks,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
  FILA_LOTES_AMAZON,
  type FilaLotesAmazon,
  MAX_ATRASO_LOTE_S,
  caminhoDaFilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from './agendadorLotes';
import { PRAZO_FEED_MS } from './registroFeed';
import {
  type TarefaLoteAmazon,
  nomeConsultaFeed,
  nomeEnvioFeed,
  nomeIncertoFeed,
  nomeNotificacaoFeed,
  nomeRecuperacaoFeed,
  tarefaLoteAmazonSchema,
} from './tarefaLote';

const CONTA = 'conta-teste';
const EXECUCAO = 'exec-teste-0001';
const FEED = '50001234567';

const ENVIAR = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-enviar',
  fluxo: 'estoque',
  contaId: CONTA,
  execucaoId: EXECUCAO,
  origem: 'delta',
  lote: {
    tipo: 'janela',
    desdeMs: 1_000,
    ateMs: 2_000,
    manterDesdeMs: 1_000,
    commitAposMs: null,
    esperaAteMs: null,
    depositoId: 'deposito-1',
  },
});
const RESULTADO = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-resultado',
  contaId: CONTA,
  feedId: FEED,
  rodada: 1,
  origem: 'consulta',
});
const INCERTO = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-incerto',
  fluxo: 'estoque',
  contaId: CONTA,
  execucaoId: EXECUCAO,
});
const RECUPERAR = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-recuperar',
  fluxo: 'estoque',
  contaId: CONTA,
  desfecho: 'concluido',
  feedId: FEED,
  execucaoId: EXECUCAO,
  snapshotEmMs: 1_500,
  pendenteDesdeMs: null,
  janela: null,
});

const NOME_RODADA = nomeConsultaFeed(CONTA, FEED, 1);
const NOME_RECUPERACAO = nomeRecuperacaoFeed(CONTA, FEED, null);

/** Every `fetch` is a failure: the producer must never reach the network itself. */
const chamadasDeRede: string[] = [];
vi.stubGlobal('fetch', (input: unknown) => {
  chamadasDeRede.push(String(input));
  return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
});
afterEach(() => {
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/**
 * A queue that records every enqueue with ALL its arguments and, like Cloud
 * Tasks, refuses a task id it already holds (the SDK's own 409) — a name stays
 * held after its task ran (a tombstone).
 */
function filaGravadora(falha?: () => unknown) {
  const ids = new Set<string>();
  const enqueue = vi.fn((...args: unknown[]): Promise<void> => {
    if (falha !== undefined) return Promise.reject(falha());
    const id = (args[1] as { id?: string } | undefined)?.id;
    if (id !== undefined) {
      if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
      ids.add(id);
    }
    return Promise.resolve();
  });
  const fila: FilaLotesAmazon = {
    enqueue: (...args: Parameters<FilaLotesAmazon['enqueue']>) => enqueue(...args),
  };
  const resolver = vi.fn(() => fila);
  return { enqueue, resolver };
}

/** The rejection of one enqueue, or a failed test when it resolved. */
async function rejeicaoDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => expect.unreachable('o enqueue deveria ter rejeitado'),
    (e: unknown) => e,
  );
}

describe('caminhoDaFilaLotesAmazon — the region-qualified queue path', () => {
  it('is locations/<region>/functions/processAmazonListingsJob', () => {
    expect(FILA_LOTES_AMAZON).toBe('processAmazonListingsJob');
    expect(caminhoDaFilaLotesAmazon('xx-regiao1')).toBe(
      'locations/xx-regiao1/functions/processAmazonListingsJob',
    );
  });

  it.each(['', 'a/b', '../x', 'XX-REGIAO1', ' xx', 'xx\n'])(
    'refuses the region %j: never another path, never a path to nowhere',
    (regiao) => {
      expect(() => caminhoDaFilaLotesAmazon(regiao)).toThrow(AmazonLotesRegiaoDaFilaInvalidaError);
      expect(() => caminhoDaFilaLotesAmazon(regiao)).toThrow(TypeError);
    },
  );
});

describe('criarAgendadorLotesAmazon — the valve', () => {
  it('★ closed: named and unnamed enqueues reject with the jobs queue’s OWN class and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: true });

    const nomeada = await rejeicaoDe(agendador.enfileirarLote(RESULTADO, { nome: NOME_RODADA }));
    const anonima = await rejeicaoDe(agendador.enfileirarLote(ENVIAR, { atrasoS: 300 }));
    for (const erro of [nomeada, anonima]) {
      expect(erro).toBeInstanceOf(AmazonLotesTarefasDesligadasError);
      // Never another queue's class: each promises a different remedy.
      expect(erro).not.toBeInstanceOf(AmazonTarefasDesligadasError);
      expect(erro).not.toBeInstanceOf(AmazonNfeTarefasDesligadasError);
      expect(erro).not.toBeInstanceOf(AmazonAgendamentoTarefasDesligadasError);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('criarAgendadorLotesAmazon — the name', () => {
  it('★ a NAMED enqueue carries the name as the task id; the same name again is ja-enfileirada, a new one lands', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    await expect(agendador.enfileirarLote(RESULTADO, { nome: NOME_RODADA })).resolves.toBe(
      'enfileirada',
    );
    await expect(agendador.enfileirarLote(RESULTADO, { nome: NOME_RODADA })).resolves.toBe(
      'ja-enfileirada',
    );
    const outra = nomeConsultaFeed(CONTA, FEED, 2);
    await expect(agendador.enfileirarLote(RESULTADO, { nome: outra })).resolves.toBe('enfileirada');
    expect(enqueue.mock.calls).toEqual([
      [RESULTADO, { id: NOME_RODADA }],
      [RESULTADO, { id: NOME_RODADA }],
      [RESULTADO, { id: outra }],
    ]);
  });

  it('★ NEAR-MISS: the same 409 answered ABORTED on a NAMED enqueue is a transient, never “already there”', async () => {
    const { resolver } = filaGravadora(() => falhaDeTarefaJaExistente(NOME_RODADA, 'ABORTED'));
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    const erro = await rejeicaoDe(agendador.enfileirarLote(RESULTADO, { nome: NOME_RODADA }));
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('★ an UNNAMED enqueue sends no id, and its 409 (an ABORTED) is a transient', async () => {
    const ok = filaGravadora();
    await expect(
      criarAgendadorLotesAmazon({ fila: ok.resolver, desligado: false }).enfileirarLote(ENVIAR),
    ).resolves.toBe('enfileirada');
    // The payload ALONE: no id, no delay, no `uri`.
    expect(ok.enqueue.mock.calls).toEqual([[ENVIAR]]);

    const conflito = filaGravadora(() => falhaDeConflitoDoTasks());
    const erro = await rejeicaoDe(
      criarAgendadorLotesAmazon({ fila: conflito.resolver, desligado: false }).enfileirarLote(
        INCERTO,
        { atrasoS: 60 },
      ),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('NEAR-MISS: an UNNAMED enqueue is never “already there”, whatever its 409 body says (it holds no name to find)', async () => {
    const { resolver } = filaGravadora(() => falhaDeTarefaJaExistente('undefined'));
    const erro = await rejeicaoDe(
      criarAgendadorLotesAmazon({ fila: resolver, desligado: false }).enfileirarLote(ENVIAR),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it.each<[string, TarefaLoteAmazon]>([
    ['feed-resultado', RESULTADO],
    ['feed-recuperar', RECUPERAR],
  ])(
    '★ a %s WITHOUT a name is refused (an unnamed rung or recovery forks its chain), nothing enqueued',
    async (_tipo, tarefa) => {
      const { enqueue, resolver } = filaGravadora();
      const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

      await expect(agendador.enfileirarLote(tarefa)).rejects.toBeInstanceOf(RangeError);
      await expect(agendador.enfileirarLote(tarefa, { atrasoS: 120 })).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(resolver).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('NEAR-MISS: a feed-enviar and a feed-incerto MAY go unnamed (the waits)', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirarLote(ENVIAR, { atrasoS: 300 });
    await agendador.enfileirarLote(INCERTO, { atrasoS: 1 });
    expect(enqueue.mock.calls).toEqual([
      [ENVIAR, { scheduleDelaySeconds: 300 }],
      [INCERTO, { scheduleDelaySeconds: 1 }],
    ]);
  });

  it.each([
    ['a raw id', `${CONTA}:${FEED}`],
    ['upper-case hex', NOME_RODADA.toUpperCase()],
    ['one digit short', NOME_RODADA.slice(1)],
    ['one digit long', `${NOME_RODADA}0`],
    ['empty', ''],
  ])('★ a name that is not a sha256 digest (%s) is refused, nothing enqueued', async (_c, nome) => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    await expect(agendador.enfileirarLote(ENVIAR, { nome })).rejects.toBeInstanceOf(RangeError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('every name the feed core mints passes the grammar', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });
    const nomes = [
      NOME_RODADA,
      nomeConsultaFeed(CONTA, FEED, 'adocao'),
      nomeNotificacaoFeed(null, FEED),
      nomeIncertoFeed(CONTA, EXECUCAO),
      nomeEnvioFeed(CONTA, EXECUCAO),
      NOME_RECUPERACAO,
    ];
    for (const nome of nomes) await agendador.enfileirarLote(RECUPERAR, { nome });
    expect(enqueue.mock.calls.map((c) => (c[1] as { id: string }).id)).toEqual(nomes);
  });
});

describe('criarAgendadorLotesAmazon — the delay, in WHOLE seconds', () => {
  it('★ the uncertain wait (≈ 12 h) leaves as 43,200 scheduleDelaySeconds, exactly as given', async () => {
    const { enqueue, resolver } = filaGravadora();
    const nome = nomeIncertoFeed(CONTA, EXECUCAO);

    await criarAgendadorLotesAmazon({ fila: resolver, desligado: false }).enfileirarLote(INCERTO, {
      nome,
      atrasoS: 43_200,
    });
    expect(enqueue.mock.calls).toEqual([[INCERTO, { id: nome, scheduleDelaySeconds: 43_200 }]]);
  });

  it('★ NEAR-MISS: the same 12 h handed over in MILLISECONDS is refused, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    await expect(
      agendador.enfileirarLote(INCERTO, {
        nome: nomeIncertoFeed(CONTA, EXECUCAO),
        atrasoS: 43_200_000,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    // The two-minute floor and the 300-s wait in ms, too.
    await expect(agendador.enfileirarLote(ENVIAR, { atrasoS: 120_000 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(agendador.enfileirarLote(ENVIAR, { atrasoS: 300_000 })).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('the bound: exactly one day passes, one second more is refused', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirarLote(ENVIAR, { atrasoS: MAX_ATRASO_LOTE_S });
    await expect(
      agendador.enfileirarLote(ENVIAR, { atrasoS: MAX_ATRASO_LOTE_S + 1 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(enqueue.mock.calls).toEqual([[ENVIAR, { scheduleDelaySeconds: MAX_ATRASO_LOTE_S }]]);
    // Twice the longest wait the core asks for (the uncertain wait).
    expect(MAX_ATRASO_LOTE_S * 1000).toBe(2 * PRAZO_FEED_MS);
  });

  it.each([1.5, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    '★ a fractional, negative or non-finite delay (%s) is refused, nothing enqueued',
    async (atrasoS) => {
      const { enqueue, resolver } = filaGravadora();
      const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

      await expect(agendador.enfileirarLote(ENVIAR, { atrasoS })).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('a zero delay is no delay: the payload alone (a named one keeps only its id)', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });

    await agendador.enfileirarLote(ENVIAR, { atrasoS: 0 });
    await agendador.enfileirarLote(RECUPERAR, { nome: NOME_RECUPERACAO, atrasoS: 0 });
    expect(enqueue.mock.calls).toEqual([[ENVIAR], [RECUPERAR, { id: NOME_RECUPERACAO }]]);
  });
});

describe('criarAgendadorLotesAmazon — the payload and the failures', () => {
  it('the payload is re-checked before it leaves: an unknown key is a ZodError, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const agendador = criarAgendadorLotesAmazon({ fila: resolver, desligado: false });
    const comSku = { ...ENVIAR, skus: ['SKU-1'] } as unknown as TarefaLoteAmazon;

    await expect(agendador.enfileirarLote(comSku)).rejects.toBeInstanceOf(ZodError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a Cloud Tasks 503 is NAMED as the shared transient', async () => {
    const { resolver } = filaGravadora(() => falhaDoFunctions('unknown-error', 503));
    const erro = await rejeicaoDe(
      criarAgendadorLotesAmazon({ fila: resolver, desligado: false }).enfileirarLote(RESULTADO, {
        nome: NOME_RODADA,
      }),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('NEAR-MISS: a deploy-shaped 403 is rethrown EXACTLY as thrown', async () => {
    const original = falhaDoFunctions('permission-denied', 403);
    const { resolver } = filaGravadora(() => original);
    const erro = await rejeicaoDe(
      criarAgendadorLotesAmazon({ fila: resolver, desligado: false }).enfileirarLote(ENVIAR),
    );
    expect(erro).toBe(original);
    expect(erro).toBeInstanceOf(FirebaseFunctionsError);
  });

  it('a region error from the root rejects THAT enqueue, rethrown untouched', async () => {
    const agendador = criarAgendadorLotesAmazon({
      fila: () => {
        throw new AmazonLotesRegiaoDaFilaInvalidaError();
      },
      desligado: false,
    });
    await expect(agendador.enfileirarLote(ENVIAR)).rejects.toBeInstanceOf(
      AmazonLotesRegiaoDaFilaInvalidaError,
    );
  });
});

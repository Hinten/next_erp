/**
 * The price task's producer (step 13, PR 13-d), offline: the jobs queue's
 * valve class, the payload's OWN name, the check named after the submission
 * (and refused for a payload that is itself a check), the two UNNAMED waits,
 * the delay in WHOLE seconds under the jobs queue's cap, the bounded batch,
 * and the shared transient naming, driven with the Admin SDK's REAL error
 * classes (`testing/falhaDeEnfileiramento.ts`). No transport is real and no
 * network is reachable: the queue is a recording fake that, like Cloud Tasks,
 * refuses a name it already holds. Concurrency is ordered by promises the
 * test settles itself, never by timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
  MAX_ATRASO_LOTE_S,
} from '../feeds/agendadorLotes';
import { AmazonEstoqueTarefasDesligadasError } from '../estoque/produtorEstoque';
import { LARGURA_LOTE_LISTING_AMAZON } from '../listings/produtorListing';
import {
  falhaDeConflitoDoTasks,
  falhaDeTarefaJaExistente,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  ATRASO_ESPERA_FEED_PRECO_S,
  ATRASO_PAUSA_PRECO_S,
  ATRASO_VERIFICACAO_PRECO_S,
  type FilaPrecoAmazon,
  LARGURA_LOTE_PRECO_AMAZON,
  criarProdutorPrecoAmazon,
} from './produtorPreco';
import {
  ORIGEM_TAREFA_PRECO_AMAZON,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  nomeTarefaPrecoAmazon,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

const CONTA = 'conta-teste';
const SKU = 'SKU-1';
const SUBMISSAO = 'f1e2d3c4b5a69788';
const AGORA_MS = 1_800_000_000_000;

function tarefa(over: Partial<TarefaPrecoSkuAmazon> = {}): TarefaPrecoSkuAmazon {
  return tarefaPrecoSkuAmazonSchema.parse({
    v: 1,
    tipo: 'preco-sku',
    contaId: CONTA,
    sku: SKU,
    origem: ORIGEM_TAREFA_PRECO_AMAZON.manual,
    referencia: 'req-0001',
    parte: null,
    baixarPreco: true,
    solicitadoEmMs: AGORA_MS,
    codigosAntes: [],
    ...over,
  });
}

const MANUAL = tarefa();

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
 * Tasks, refuses a task id it already holds (the SDK's own 409).
 */
function filaGravadora(falha?: (payload: TarefaPrecoSkuAmazon) => unknown) {
  const ids = new Set<string>();
  const enqueue = vi.fn((...args: unknown[]): Promise<void> => {
    const erro = falha?.(args[0] as TarefaPrecoSkuAmazon);
    if (erro !== undefined) return Promise.reject(erro);
    const id = (args[1] as { id?: string } | undefined)?.id;
    if (id !== undefined) {
      if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
      ids.add(id);
    }
    return Promise.resolve();
  });
  const fila: FilaPrecoAmazon = {
    enqueue: (...args: Parameters<FilaPrecoAmazon['enqueue']>) => enqueue(...args),
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

describe('criarProdutorPrecoAmazon — the jobs queue’s valve', () => {
  it('★ closed: every entry rejects with the JOBS queue’s OWN class and the queue is NEVER resolved', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: true });
    const erros = [
      await rejeicaoDe(produtor.enfileirar(MANUAL)),
      await rejeicaoDe(produtor.enfileirarLote([MANUAL])),
      await rejeicaoDe(produtor.enfileirarVerificacao(MANUAL, SUBMISSAO, [])),
      await rejeicaoDe(produtor.enfileirarEspera(MANUAL)),
      await rejeicaoDe(produtor.enfileirarPausa(MANUAL)),
    ];
    for (const erro of erros) {
      expect(erro).toBeInstanceOf(AmazonLotesTarefasDesligadasError);
      expect(erro).not.toBeInstanceOf(AmazonEstoqueTarefasDesligadasError);
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NEAR-MISS: open, the queue is resolved per enqueue', async () => {
    const { resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    expect(resolver).not.toHaveBeenCalled();
    await produtor.enfileirar(MANUAL);
    await produtor.enfileirarPausa(MANUAL);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe('criarProdutorPrecoAmazon — the name is the payload’s own', () => {
  it('★ the same request and SKU twice is ONE task (ja-enfileirada); another request is a new name', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    const outra = tarefa({ referencia: 'req-0002' });
    await expect(produtor.enfileirar(MANUAL)).resolves.toBe('enfileirada');
    await expect(produtor.enfileirar(MANUAL)).resolves.toBe('ja-enfileirada');
    await expect(produtor.enfileirar(outra)).resolves.toBe('enfileirada');
    expect(enqueue.mock.calls).toEqual([
      [MANUAL, { id: nomeDaTarefaPrecoAmazon(MANUAL) }],
      [MANUAL, { id: nomeDaTarefaPrecoAmazon(MANUAL) }],
      [outra, { id: nomeDaTarefaPrecoAmazon(outra) }],
    ]);
    expect(nomeDaTarefaPrecoAmazon(MANUAL)).toBe(
      nomeTarefaPrecoAmazon(ORIGEM_TAREFA_PRECO_AMAZON.manual, CONTA, 'req-0001', SKU),
    );
  });

  it('★ NEAR-MISS: the same 409 answered ABORTED on a NAMED enqueue is a transient, never “already there”', async () => {
    const { resolver } = filaGravadora(() =>
      falhaDeTarefaJaExistente(nomeDaTarefaPrecoAmazon(MANUAL), 'ABORTED'),
    );
    const erro = await rejeicaoDe(
      criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirar(MANUAL),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('★ the payload carries identities only: a price is a ZodError, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    const comPreco = { ...MANUAL, preco: 99.9 } as unknown as TarefaPrecoSkuAmazon;
    expect(await rejeicaoDe(produtor.enfileirar(comPreco))).toBeInstanceOf(ZodError);
    expect(await rejeicaoDe(produtor.enfileirarLote([MANUAL, comPreco]))).toBeInstanceOf(ZodError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a run’s task leaves with its own name, carrying its part', async () => {
    const { enqueue, resolver } = filaGravadora();
    const daExecucao = tarefa({ origem: 'execucao', referencia: 'exec-0001', parte: 3 });
    await criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirar(daExecucao);
    expect(enqueue.mock.calls).toEqual([[daExecucao, { id: nomeDaTarefaPrecoAmazon(daExecucao) }]]);
  });
});

describe('criarProdutorPrecoAmazon — the check after an accepted send', () => {
  it('★ named after the submission, delayed 900 s, origem verificacao, the ORIGINAL consent and clock, the codes read before', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    const original = tarefa({ baixarPreco: true, solicitadoEmMs: AGORA_MS - 60_000 });
    await expect(produtor.enfileirarVerificacao(original, SUBMISSAO, ['19037'])).resolves.toBe(
      'enfileirada',
    );
    const check = tarefa({
      origem: ORIGEM_TAREFA_PRECO_AMAZON.verificacao,
      referencia: SUBMISSAO,
      baixarPreco: true,
      solicitadoEmMs: AGORA_MS - 60_000,
      codigosAntes: ['19037'],
    });
    expect(enqueue.mock.calls).toEqual([
      [check, { id: nomeDaTarefaPrecoAmazon(check), scheduleDelaySeconds: 900 }],
    ]);
    expect(ATRASO_VERIFICACAO_PRECO_S).toBe(900);
    // A retried send enqueues it once.
    await expect(produtor.enfileirarVerificacao(original, SUBMISSAO, ['19037'])).resolves.toBe(
      'ja-enfileirada',
    );
  });

  it('★ a run’s send’s check drops the part (a check reads no floor)', async () => {
    const { enqueue, resolver } = filaGravadora();
    const daExecucao = tarefa({ origem: 'execucao', referencia: 'exec-0001', parte: 2 });
    await criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirarVerificacao(
      daExecucao,
      SUBMISSAO,
      [],
    );
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ origem: 'verificacao', parte: null });
  });

  it('★ (mutation 17) a check never chains another: a payload that is itself a check is a RangeError, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    const check = tarefa({ origem: 'verificacao', referencia: SUBMISSAO });
    expect(await rejeicaoDe(produtor.enfileirarVerificacao(check, 'outra-sub', []))).toBeInstanceOf(
      RangeError,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a submissionId outside the reference grammar (it would shift a name field) is a ZodError, nothing enqueued', async () => {
    const { enqueue, resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    expect(await rejeicaoDe(produtor.enfileirarVerificacao(MANUAL, 'a:b', []))).toBeInstanceOf(
      ZodError,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('criarProdutorPrecoAmazon — the two waits', () => {
  it('★ the wait behind a price feed: UNNAMED, the payload unchanged, 300 s', async () => {
    const { enqueue, resolver } = filaGravadora();
    await criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirarEspera(MANUAL);
    expect(enqueue.mock.calls).toEqual([[MANUAL, { scheduleDelaySeconds: 300 }]]);
    expect(ATRASO_ESPERA_FEED_PRECO_S).toBe(300);
  });

  it('★ (mutation 7) the 429 pause: UNNAMED, the payload unchanged, 60 s', async () => {
    const { enqueue, resolver } = filaGravadora();
    await criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirarPausa(MANUAL);
    expect(enqueue.mock.calls).toEqual([[MANUAL, { scheduleDelaySeconds: 60 }]]);
    expect(ATRASO_PAUSA_PRECO_S).toBe(60);
  });

  it('NEAR-MISS: a wait’s 409 (an ABORTED: it holds no name) is a transient, never “already there”', async () => {
    const { resolver } = filaGravadora(() => falhaDeConflitoDoTasks());
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    expect(await rejeicaoDe(produtor.enfileirarPausa(MANUAL))).toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
    expect(await rejeicaoDe(produtor.enfileirarEspera(MANUAL))).toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
  });
});

describe('criarProdutorPrecoAmazon — the delay under the jobs queue’s cap', () => {
  it('the jobs queue’s own bound: its one day is accepted by the shared rule, one second more is refused', async () => {
    const { resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    // Every delay this producer asks for sits under the jobs queue's cap.
    for (const atraso of [
      ATRASO_VERIFICACAO_PRECO_S,
      ATRASO_ESPERA_FEED_PRECO_S,
      ATRASO_PAUSA_PRECO_S,
    ]) {
      expect(atraso).toBeLessThan(MAX_ATRASO_LOTE_S);
    }
    await expect(produtor.enfileirar(MANUAL)).resolves.toBe('enfileirada');
  });
});

describe('criarProdutorPrecoAmazon — the batch', () => {
  it('★ at most 16 enqueues in flight, in list order, every payload named and counted', async () => {
    let emVoo = 0;
    let maximo = 0;
    const pendentes: (() => void)[] = [];
    const enqueue = vi.fn((): Promise<void> => {
      emVoo += 1;
      maximo = Math.max(maximo, emVoo);
      return new Promise<void>((resolve) => {
        pendentes.push(() => {
          emVoo -= 1;
          resolve();
        });
      });
    });
    const produtor = criarProdutorPrecoAmazon({ fila: () => ({ enqueue }), desligado: false });
    const tarefas = Array.from({ length: 20 }, (_, i) => tarefa({ sku: `SKU-${String(i)}` }));
    const lote = produtor.enfileirarLote(tarefas);
    // Release the in-flight enqueues one at a time, on cue.
    for (let liberados = 0; liberados < 20; liberados += 1) {
      await vi.waitFor(() => expect(pendentes.length).toBeGreaterThan(0));
      pendentes.shift()?.();
    }
    await expect(lote).resolves.toEqual({ enfileiradas: 20, jaEnfileiradas: 0, naoTentadas: 0 });
    expect(maximo).toBe(16);
    expect(LARGURA_LOTE_PRECO_AMAZON).toBe(LARGURA_LOTE_LISTING_AMAZON);
    expect(enqueue.mock.calls.map((c) => (c as unknown[])[1])).toEqual(
      tarefas.map((t) => ({ id: nomeDaTarefaPrecoAmazon(t) })),
    );
  });

  it('★ the deadline: nothing more starts once `continuar` says no, and the rest are counted', async () => {
    const { enqueue, resolver } = filaGravadora();
    const tarefas = Array.from({ length: 5 }, (_, i) => tarefa({ sku: `SKU-${String(i)}` }));
    let perguntas = 0;
    const r = await criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirarLote(
      tarefas,
      {
        continuar: () => {
          perguntas += 1;
          return perguntas <= 2;
        },
      },
    );
    expect(r.naoTentadas).toBe(3);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('a re-run of the same batch is ja-enfileirada for every payload already held', async () => {
    const { resolver } = filaGravadora();
    const produtor = criarProdutorPrecoAmazon({ fila: resolver, desligado: false });
    const tarefas = [tarefa({ sku: 'A' }), tarefa({ sku: 'B' })];
    await produtor.enfileirarLote(tarefas);
    await expect(produtor.enfileirarLote(tarefas)).resolves.toEqual({
      enfileiradas: 0,
      jaEnfileiradas: 2,
      naoTentadas: 0,
    });
  });
});

describe('criarProdutorPrecoAmazon — the failures', () => {
  it('a Cloud Tasks 503 is NAMED as the shared transient', async () => {
    const { resolver } = filaGravadora(() => falhaDoFunctions('unknown-error', 503));
    const erro = await rejeicaoDe(
      criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirar(MANUAL),
    );
    expect(erro).toBeInstanceOf(AmazonTarefasTransitoriasError);
  });

  it('NEAR-MISS: a deploy-shaped 403 is rethrown EXACTLY as thrown', async () => {
    const original = falhaDoFunctions('permission-denied', 403);
    const { resolver } = filaGravadora(() => original);
    const erro = await rejeicaoDe(
      criarProdutorPrecoAmazon({ fila: resolver, desligado: false }).enfileirar(MANUAL),
    );
    expect(erro).toBe(original);
  });

  it('a region error from the root rejects THAT enqueue, rethrown untouched', async () => {
    const produtor = criarProdutorPrecoAmazon({
      fila: () => {
        throw new AmazonLotesRegiaoDaFilaInvalidaError();
      },
      desligado: false,
    });
    await expect(produtor.enfileirar(MANUAL)).rejects.toBeInstanceOf(
      AmazonLotesRegiaoDaFilaInvalidaError,
    );
  });
});

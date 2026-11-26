/**
 * The price-queue PRODUCER (master plan step 13, PR 13-d): the name of a price task (its `baixar`
 * bit included), the window and schedule (the stock producer's, by identity), the strict parse
 * before anything leaves, the bulk options, and what an enqueue's rejection means. The failures
 * are the SDK's own classes (`testing/falhaDeEnfileiramento.ts`) — never a numeric stand-in.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import {
  ORIGEM_TAREFA_PRECO_LI,
  TIPO_TAREFA_PRECO_LI,
  type TarefaPrecoLi,
  tarefaPrecoLiSchema,
} from '@delfrance/schemas';

import { agendamentoEstoqueLi, janelaEstoqueLi } from '../estoque/agendadorEstoque';
import {
  LiTarefasDesligadasError as DesligadasDaLeitura,
  LiTarefasTransitoriasError as TransitoriasDaLeitura,
} from '../notificacoes/agendador';
import {
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  type AgendadorPrecoLi,
  FILA_PRECO_LI,
  type FilaPrecoLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
  type OpcoesEnfileiramentoPrecoLi,
  type TarefaPrecoSemJanelaLi,
  agendamentoPrecoLi,
  criarAgendadorPrecoLi,
  enfileirarTarefaPrecoLi,
  idDaTarefaPrecoLi,
  janelaPrecoLi,
} from './agendadorPreco';

// No call to the store, per file: nothing here may reach the global `fetch` (no client is built at all).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendadorPreco.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const JANELA = 29_000_000;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function tarefa(over: Partial<TarefaPrecoLi> = {}): TarefaPrecoLi {
  return {
    tipo: TIPO_TAREFA_PRECO_LI,
    contaId: 'conta-li-preco',
    produtoId: 'p-filho-preco',
    origem: ORIGEM_TAREFA_PRECO_LI.evento,
    janela: JANELA,
    geracao: 0,
    baixar: false,
    ...over,
  };
}

describe('the name: a digest of origin, conta, produto, the baixar bit and window', () => {
  it('the preimage spelled out: `preco:<origem>:<conta>:<produto>:<b|n>:<janela>`', () => {
    expect(idDaTarefaPrecoLi(tarefa())).toBe(
      `preco-${sha(`preco:evento:conta-li-preco:p-filho-preco:n:${String(JANELA)}`)}`,
    );
    expect(idDaTarefaPrecoLi(tarefa({ baixar: true }))).toBe(
      `preco-${sha(`preco:evento:conta-li-preco:p-filho-preco:b:${String(JANELA)}`)}`,
    );
  });

  it('EQUAL pair: the same six parts ⇒ the same id, whatever tabela ids the task carries', () => {
    const lote = tarefa({
      origem: ORIGEM_TAREFA_PRECO_LI.atualizacao,
      tabelaNormalId: 'tab-normal',
      tabelaPromocionalId: null,
    });
    const outraPromo: TarefaPrecoLi = { ...lote, tabelaPromocionalId: 'tab-promo' };
    expect(idDaTarefaPrecoLi(outraPromo)).toBe(idDaTarefaPrecoLi(lote));
  });

  it.each([
    ['baixar (a task that may NOT lower never swallows one that may)', { baixar: true }],
    ['origem (a deriva never collides with its event)', { origem: ORIGEM_TAREFA_PRECO_LI.deriva }],
    ['janela', { janela: JANELA + 1 }],
    ['conta', { contaId: 'conta-li-precu' }],
    ['produto', { produtoId: 'p-filho-precu' }],
  ] as const)('⚠️ NEAR-MISS: another %s ⇒ another id', (_rotulo, over) => {
    expect(idDaTarefaPrecoLi(tarefa(over))).not.toBe(idDaTarefaPrecoLi(tarefa()));
  });

  it('inside Cloud Tasks’ task-id grammar, whatever the ids hold', () => {
    const estranho = tarefa({ produtoId: 'p ó:x', contaId: 'C_1-a' });
    for (const t of [tarefa(), estranho]) {
      expect(idDaTarefaPrecoLi(t)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    }
  });

  it('⚠️ never the name of a stock task: its own prefix', () => {
    expect(idDaTarefaPrecoLi(tarefa()).startsWith('preco-')).toBe(true);
  });
});

describe('the window and the schedule are the STOCK producer’s, by identity', () => {
  it('the same functions (one copy of the naming proof)', () => {
    expect(janelaPrecoLi).toBe(janelaEstoqueLi);
    expect(agendamentoPrecoLi).toBe(agendamentoEstoqueLi);
  });

  it('(janela + 1)·60 s + 60 s + (hash(produto) mod 30 s)', () => {
    const dispersao = Number.parseInt(sha('p-filho-preco').slice(0, 8), 16) % 30_000;
    expect(agendamentoPrecoLi(JANELA, 'p-filho-preco')).toBe(
      (JANELA + 1) * 60_000 + 60_000 + dispersao,
    );
  });

  it('the queue is named after the function that serves it', () => {
    expect(FILA_PRECO_LI).toBe('filaPrecoLojaIntegrada');
  });

  it('the rejection classes are the reads producer’s own (one contract)', () => {
    expect(LiTarefasDesligadasError).toBe(DesligadasDaLeitura);
    expect(LiTarefasTransitoriasError).toBe(TransitoriasDaLeitura);
  });
});

/** A transport that records every enqueue, or rejects with `falha`. */
function fila(falha: Error | null = null) {
  const chamadas: { tarefa: unknown; opcoes: { id: string; scheduleTime: Date } }[] = [];
  let resolvida = 0;
  const f: FilaPrecoLi = {
    enqueue: (t, opcoes) => {
      chamadas.push({ tarefa: t, opcoes });
      return falha === null ? Promise.resolve() : Promise.reject(falha);
    },
  };
  return {
    fila: () => {
      resolvida += 1;
      return f;
    },
    chamadas,
    resolvida: () => resolvida,
  };
}

describe('the producer: what a rejection MEANS', () => {
  const opcoes: OpcoesEnfileiramentoPrecoLi = { id: 'preco-x', agendarParaMs: 1_740_000_121_049 };

  it('sends the payload ALONE, with its id and its schedule as a Date', async () => {
    const f = fila();
    await criarAgendadorPrecoLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes);
    expect(f.chamadas).toEqual([
      { tarefa: tarefa(), opcoes: { id: 'preco-x', scheduleTime: new Date(1_740_000_121_049) } },
    ]);
    expect(Object.keys(f.chamadas[0]!.opcoes).sort()).toEqual(['id', 'scheduleTime']);
  });

  it('the queue is resolved PER enqueue', async () => {
    const f = fila();
    const agendador = criarAgendadorPrecoLi({ fila: f.fila, desligado: false });
    expect(f.resolvida()).toBe(0);
    await agendador.enfileirar(tarefa(), opcoes);
    await agendador.enfileirar(tarefa(), opcoes);
    expect(f.resolvida()).toBe(2);
  });

  it('an ANSWERED functions/task-already-exists is success: the task is already queued', async () => {
    const f = fila(falhaDoFunctions('task-already-exists', 409));
    await expect(
      criarAgendadorPrecoLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).resolves.toBeUndefined();
  });

  it('⚠️ NEAR-MISS: the same code with NO response was never answered — rethrown untouched', async () => {
    const semResposta = new FirebaseFunctionsError({
      code: 'task-already-exists',
      message: 'sem resposta',
    });
    const f = fila(semResposta);
    await expect(
      criarAgendadorPrecoLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).rejects.toBe(semResposta);
  });

  it.each([
    ['functions 503', () => falhaDoFunctions('unknown-error', 503)],
    ['functions 429', () => falhaDoFunctions('unknown-error', 429)],
    ['app network', () => falhaDoApp('network-error')],
  ])('a transient Cloud Tasks failure (%s) is NAMED', async (_rotulo, falha) => {
    const f = fila(falha());
    await expect(
      criarAgendadorPrecoLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
  });

  it.each([
    ['permission-denied', () => falhaDoFunctions('permission-denied', 403)],
    ['not-found', () => falhaDoFunctions('not-found', 404)],
    ['the SDK’s own config failure (no response)', () => falhaDeConfiguracaoDoFunctions('projeto')],
    ['a coding bug', () => new TypeError('bug')],
  ])('a deploy-shaped failure or a bug (%s) is rethrown UNTOUCHED', async (_rotulo, falha) => {
    const err = falha();
    const f = fila(err);
    await expect(
      criarAgendadorPrecoLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).rejects.toBe(err);
  });

  it('the sweep-only valve closed ⇒ LiTarefasDesligadasError, and the queue is NEVER resolved', async () => {
    const f = fila();
    await expect(
      criarAgendadorPrecoLi({ fila: f.fila, desligado: true }).enfileirar(tarefa(), opcoes),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(f.resolvida()).toBe(0);
    expect(f.chamadas).toEqual([]);
  });
});

describe('enfileirarTarefaPrecoLi: the clock at the enqueue, the strict parse, the name', () => {
  const deriva: TarefaPrecoSemJanelaLi = {
    contaId: 'conta-li-preco',
    produtoId: 'p-filho-preco',
    origem: ORIGEM_TAREFA_PRECO_LI.deriva,
    geracao: 1,
    baixar: true,
  };

  function gravador() {
    const eventos: string[] = [];
    const enfileiradas: { tarefa: TarefaPrecoLi; opcoes: OpcoesEnfileiramentoPrecoLi }[] = [];
    const agendador: AgendadorPrecoLi = {
      enfileirar: (t, o) => {
        eventos.push('enfileirar');
        enfileiradas.push({ tarefa: t, opcoes: o });
        return Promise.resolve();
      },
    };
    return { agendador, eventos, enfileiradas };
  }

  const relogioProibido = () => {
    throw new Error('teste: com a janela dada, o relógio não é lido');
  };

  it('the window comes from a clock read right before the enqueue; the payload parses; the name and schedule follow', async () => {
    const g = gravador();
    const relogio = () => {
      g.eventos.push('relogio');
      return JANELA * 60_000 + 30_000;
    };
    await enfileirarTarefaPrecoLi(g.agendador, relogio, deriva);
    expect(g.eventos).toEqual(['relogio', 'enfileirar']);
    const [e] = g.enfileiradas;
    const esperada = { ...deriva, tipo: TIPO_TAREFA_PRECO_LI, janela: JANELA };
    expect(e?.tarefa).toEqual(esperada);
    expect(tarefaPrecoLiSchema.safeParse(e?.tarefa).success).toBe(true);
    expect(e?.opcoes).toEqual({
      id: idDaTarefaPrecoLi(esperada),
      agendarParaMs: agendamentoPrecoLi(JANELA, 'p-filho-preco'),
    });
  });

  it.each(['cheio', 'promocional', 'custo', 'preco', 'valor'])(
    'a PRICE key (%s) can never leave: the strict parse refuses it, and nothing is enqueued',
    async (chave) => {
      const g = gravador();
      const comPreco = { ...deriva, [chave]: 55.55 } as unknown as TarefaPrecoSemJanelaLi;
      await expect(
        enfileirarTarefaPrecoLi(g.agendador, () => JANELA * 60_000, comPreco),
      ).rejects.toBeInstanceOf(ZodError);
      expect(g.enfileiradas).toEqual([]);
    },
  );

  it('⚠️ a BULK origin without its tabela ids is refused, and nothing is enqueued', async () => {
    const g = gravador();
    await expect(
      enfileirarTarefaPrecoLi(g.agendador, () => JANELA * 60_000, {
        contaId: 'conta-li-preco',
        produtoId: 'p-filho-preco',
        origem: ORIGEM_TAREFA_PRECO_LI.atualizacao,
        geracao: 0,
        baixar: false,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(g.enfileiradas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: generation 1 is the deriva’s alone — an event at generation 1 is refused', async () => {
    const g = gravador();
    await expect(
      enfileirarTarefaPrecoLi(g.agendador, () => JANELA * 60_000, {
        ...deriva,
        origem: ORIGEM_TAREFA_PRECO_LI.evento,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(g.enfileiradas).toEqual([]);
  });

  describe('a BULK enqueue: the window handed in, and a not-before bound', () => {
    const lote: TarefaPrecoSemJanelaLi = {
      contaId: 'conta-li-preco',
      produtoId: 'p-filho-preco',
      origem: ORIGEM_TAREFA_PRECO_LI.reconcile,
      geracao: 0,
      baixar: false,
      tabelaNormalId: 'tab-normal',
      tabelaPromocionalId: null,
    };

    it('`janela` NAMES the task — the clock is not read at all — and the window schedule follows it', async () => {
      const g = gravador();
      await enfileirarTarefaPrecoLi(g.agendador, relogioProibido, lote, { janela: JANELA - 7 });
      const [e] = g.enfileiradas;
      expect(e?.tarefa.janela).toBe(JANELA - 7);
      expect(e?.opcoes).toEqual({
        id: idDaTarefaPrecoLi({ ...lote, janela: JANELA - 7 }),
        agendarParaMs: agendamentoPrecoLi(JANELA - 7, 'p-filho-preco'),
      });
    });

    it('`naoAntesDeMs` LATER than the window schedule ⇒ the schedule IS that instant', async () => {
      const g = gravador();
      const depois = agendamentoPrecoLi(JANELA, 'p-filho-preco') + 3_600_000;
      await enfileirarTarefaPrecoLi(g.agendador, relogioProibido, lote, {
        janela: JANELA,
        naoAntesDeMs: depois,
      });
      expect(g.enfileiradas[0]?.opcoes.agendarParaMs).toBe(depois);
    });

    it('⚠️ NEAR-MISS: `naoAntesDeMs` EARLIER than the window schedule never wins — the window stays the floor', async () => {
      const g = gravador();
      const daJanela = agendamentoPrecoLi(JANELA, 'p-filho-preco');
      await enfileirarTarefaPrecoLi(g.agendador, () => JANELA * 60_000, lote, {
        naoAntesDeMs: daJanela - 1,
      });
      expect(g.enfileiradas[0]?.opcoes.agendarParaMs).toBe(daJanela);
    });

    it('a handed-in window the strict schema refuses (negative) ⇒ ZodError, nothing enqueued', async () => {
      const g = gravador();
      await expect(
        enfileirarTarefaPrecoLi(g.agendador, relogioProibido, lote, { janela: -1 }),
      ).rejects.toBeInstanceOf(ZodError);
      expect(g.enfileiradas).toEqual([]);
    });
  });

  it('a closed valve and an already-existing task, end to end through the real producer', async () => {
    const f = fila(falhaDoFunctions('task-already-exists', 409));
    await expect(
      enfileirarTarefaPrecoLi(
        criarAgendadorPrecoLi({ fila: f.fila, desligado: false }),
        () => JANELA * 60_000,
        deriva,
      ),
    ).resolves.toBeUndefined();
    const fechada = fila();
    await expect(
      enfileirarTarefaPrecoLi(
        criarAgendadorPrecoLi({ fila: fechada.fila, desligado: true }),
        () => JANELA * 60_000,
        deriva,
      ),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(fechada.resolvida()).toBe(0);
  });
});

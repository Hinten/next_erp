/**
 * The stock-queue PRODUCER (master plan step 12, PR 12-e): the window, the name and the schedule
 * of a stock task, the strict parse before anything leaves, and what an enqueue's rejection
 * means. The failures are the SDK's own classes (`testing/falhaDeEnfileiramento.ts`) — never a
 * numeric gRPC stand-in.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import {
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueKitsLi,
  type TarefaEstoqueLi,
  tarefaEstoqueKitsLiSchema,
  tarefaEstoqueLiSchema,
} from '@delfrance/schemas';

import { LiTarefasDesligadasError, LiTarefasTransitoriasError } from '../notificacoes/agendador';
import {
  falhaDeConfiguracaoDoFunctions,
  falhaDoApp,
  falhaDoFunctions,
} from '../testing/falhaDeEnfileiramento';
import {
  type AgendadorEstoqueLi,
  DISPERSAO_ESTOQUE_LI_MS,
  FILA_ESTOQUE_LI,
  type FilaEstoqueLi,
  JANELA_ESTOQUE_LI_MS,
  MARGEM_AGENDAMENTO_ESTOQUE_LI_MS,
  type OpcoesEnfileiramentoEstoqueLi,
  type TarefaEstoqueSemJanelaLi,
  type TarefaEstoqueKitsSemJanelaLi,
  agendamentoEstoqueLi,
  criarAgendadorEstoqueLi,
  enfileirarTarefaEstoqueKitsLi,
  enfileirarTarefaEstoqueLi,
  idDaTarefaEstoqueKitsLi,
  idDaTarefaEstoqueLi,
  janelaEstoqueLi,
} from './agendadorEstoque';

// No call to the store, per file: nothing here may reach the global `fetch` (no client is built at all).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('agendadorEstoque.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const JANELA = 29_000_000;

function tarefa(over: Partial<TarefaEstoqueLi> = {}): TarefaEstoqueLi {
  return {
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
    contaId: 'conta-li-est',
    produtoId: 'prod-1',
    origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
    janela: JANELA,
    estoqueId: null,
    apagado: false,
    estoqueIds: null,
    geracao: 0,
    ...over,
  };
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('the name: a digest of origin, conta, produto, delete flag and window', () => {
  it('golden value, and the preimage spelled out', () => {
    expect(idDaTarefaEstoqueLi(tarefa())).toBe(
      'estoque-a527e39a69732f90a88f06c8b4d4c9c8940aba3e983d589f8a64e4ed9cd13ec5',
    );
    expect(idDaTarefaEstoqueLi(tarefa())).toBe(
      `estoque-${sha(`estoque:evento:conta-li-est:prod-1:w:${String(JANELA)}`)}`,
    );
    expect(idDaTarefaEstoqueLi(tarefa({ apagado: true }))).toBe(
      `estoque-${sha(`estoque:evento:conta-li-est:prod-1:d:${String(JANELA)}`)}`,
    );
  });

  it('EQUAL pair: the same five parts ⇒ the same id, whatever else the task carries', () => {
    expect(idDaTarefaEstoqueLi(tarefa({ estoqueId: 'x', estoqueIds: { c: 'y' } }))).toBe(
      idDaTarefaEstoqueLi(tarefa()),
    );
  });

  it.each([
    ['apagado', { apagado: true }],
    ['origem', { origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva, geracao: 1 as const }],
    ['janela', { janela: JANELA + 1 }],
    ['conta', { contaId: 'conta-li-esu' }],
    ['produto', { produtoId: 'prod-2' }],
  ] as const)('⚠️ NEAR-MISS: another %s ⇒ another id', (_rotulo, over) => {
    expect(idDaTarefaEstoqueLi(tarefa(over))).not.toBe(idDaTarefaEstoqueLi(tarefa()));
  });

  it('inside Cloud Tasks’ task-id grammar, whatever the ids hold', () => {
    const estranho = tarefa({ produtoId: 'p ó:/x'.replace('/', '_'), contaId: 'C_1-a' });
    for (const t of [tarefa(), estranho]) {
      expect(idDaTarefaEstoqueLi(t)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    }
  });
});

describe('the window and the schedule', () => {
  it('janela = ⌊agora / 60 s⌋', () => {
    expect(JANELA_ESTOQUE_LI_MS).toBe(60_000);
    expect(janelaEstoqueLi(JANELA * 60_000)).toBe(JANELA);
    expect(janelaEstoqueLi(JANELA * 60_000 + 59_999)).toBe(JANELA);
    expect(janelaEstoqueLi(JANELA * 60_000 - 1)).toBe(JANELA - 1);
  });

  it('golden value: (janela + 1)·60 s + 60 s + (hash(produto) mod 30 s)', () => {
    const dispersao = Number.parseInt(sha('prod-1').slice(0, 8), 16) % 30_000;
    expect(dispersao).toBe(1049);
    expect(agendamentoEstoqueLi(JANELA, 'prod-1')).toBe(1_740_000_121_049);
    expect(agendamentoEstoqueLi(JANELA, 'prod-1')).toBe((JANELA + 1) * 60_000 + 60_000 + 1049);
  });

  it('never before the window closed plus the margin, and within the spread after it', () => {
    expect(MARGEM_AGENDAMENTO_ESTOQUE_LI_MS).toBe(60_000);
    expect(DISPERSAO_ESTOQUE_LI_MS).toBe(30_000);
    for (const produtoId of ['prod-1', 'prod-2', 'x', 'kit-9', 'est-a-b']) {
      const quando = agendamentoEstoqueLi(JANELA, produtoId);
      expect(quando).toBeGreaterThanOrEqual((JANELA + 2) * 60_000);
      expect(quando).toBeLessThanOrEqual((JANELA + 2) * 60_000 + 29_999);
    }
  });
});

describe('the naming property: an enqueue never meets a task that could already have dispatched', () => {
  /** Every ms offset that sits on a window boundary, or one ms either side of it. */
  const BORDAS = [0, 1, 29_999, 30_000, 59_998, 59_999];
  const PRODUTOS = ['prod-1', 'prod-2', 'x', 'kit-9', 'est-a-b'];

  it('at every boundary of the window, the task an enqueue names dispatches more than the margin AFTER that enqueue', () => {
    for (const desvio of BORDAS) {
      for (const janela of [JANELA - 1, JANELA, JANELA + 1]) {
        const agora = janela * JANELA_ESTOQUE_LI_MS + desvio;
        expect(janelaEstoqueLi(agora)).toBe(janela);
        for (const produtoId of PRODUTOS) {
          const folga = agendamentoEstoqueLi(janelaEstoqueLi(agora), produtoId) - agora;
          // The tightest case is the window's LAST ms: still a margin and one ms ahead.
          expect(folga).toBeGreaterThan(MARGEM_AGENDAMENTO_ESTOQUE_LI_MS);
          expect(folga).toBeLessThanOrEqual(2 * JANELA_ESTOQUE_LI_MS + DISPERSAO_ESTOQUE_LI_MS - 1);
        }
      }
    }
    // ÂNCORA: the tightest gap, spelled out.
    expect(agendamentoEstoqueLi(JANELA, 'prod-1') - (JANELA * 60_000 + 59_999)).toBe(60_001 + 1049);
  });

  it('any two enqueues that share a name share a window — so the EARLIER one’s task has not dispatched when the later one is made', () => {
    // Every pair of instants across three windows, 7 919 ms apart (a prime: it walks every
    // offset class), boundaries included.
    const instantes: number[] = [];
    for (let t = (JANELA - 1) * 60_000; t < (JANELA + 2) * 60_000; t += 7_919) instantes.push(t);
    for (const desvio of BORDAS) instantes.push(JANELA * 60_000 + desvio);
    instantes.sort((a, b) => a - b);
    let colisoes = 0;
    for (const [i, antes] of instantes.entries()) {
      for (const depois of instantes.slice(i)) {
        const idAntes = idDaTarefaEstoqueLi(tarefa({ janela: janelaEstoqueLi(antes) }));
        const idDepois = idDaTarefaEstoqueLi(tarefa({ janela: janelaEstoqueLi(depois) }));
        if (idAntes !== idDepois) continue;
        colisoes += 1;
        const despachoDoAnterior = agendamentoEstoqueLi(janelaEstoqueLi(antes), 'prod-1');
        expect(despachoDoAnterior - depois).toBeGreaterThan(MARGEM_AGENDAMENTO_ESTOQUE_LI_MS);
      }
    }
    // ÂNCORA: the walk really met names it had to compare.
    expect(colisoes).toBeGreaterThan(instantes.length);
  });

  it('⚠️ NEAR-MISS: a name taken from the EVENT’s time instead of the enqueue’s DOES meet a task that already dispatched', () => {
    // A movement at `evento`, enqueued late (a retried trigger, a slow read) at `agora`. Named
    // by the event's window, it would collide with the task of that window — which already
    // dispatched, read the ERP before this movement, and so never sends it.
    const evento = JANELA * 60_000 + 10_000;
    const agora = (JANELA + 3) * 60_000;
    const doEvento = tarefa({ janela: janelaEstoqueLi(evento) });
    expect(agendamentoEstoqueLi(doEvento.janela, 'prod-1')).toBeLessThanOrEqual(agora);
    // Named by the clock at the enqueue, it is another task, scheduled after `agora`.
    const doRelogio = tarefa({ janela: janelaEstoqueLi(agora) });
    expect(idDaTarefaEstoqueLi(doRelogio)).not.toBe(idDaTarefaEstoqueLi(doEvento));
    expect(agendamentoEstoqueLi(doRelogio.janela, 'prod-1')).toBeGreaterThan(agora);
  });
});

/** A transport that records every enqueue, or rejects with `falha`. */
function fila(falha: Error | null = null) {
  const chamadas: { tarefa: unknown; opcoes: { id: string; scheduleTime: Date } }[] = [];
  let resolvida = 0;
  const f: FilaEstoqueLi = {
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
  const opcoes: OpcoesEnfileiramentoEstoqueLi = {
    id: 'estoque-x',
    agendarParaMs: 1_740_000_121_049,
  };

  it('sends the payload ALONE, with its id and its schedule as a Date', async () => {
    const f = fila();
    await criarAgendadorEstoqueLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes);
    expect(f.chamadas).toEqual([
      { tarefa: tarefa(), opcoes: { id: 'estoque-x', scheduleTime: new Date(1_740_000_121_049) } },
    ]);
    expect(Object.keys(f.chamadas[0]!.opcoes).sort()).toEqual(['id', 'scheduleTime']);
  });

  it('the queue is resolved PER enqueue', async () => {
    const f = fila();
    const agendador = criarAgendadorEstoqueLi({ fila: f.fila, desligado: false });
    expect(f.resolvida()).toBe(0);
    await agendador.enfileirar(tarefa(), opcoes);
    await agendador.enfileirar(tarefa(), opcoes);
    expect(f.resolvida()).toBe(2);
  });

  it('an ANSWERED functions/task-already-exists is success: the task is already queued', async () => {
    const f = fila(falhaDoFunctions('task-already-exists', 409));
    await expect(
      criarAgendadorEstoqueLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).resolves.toBeUndefined();
  });

  it('⚠️ NEAR-MISS: the same code with NO response was never answered — rethrown untouched', async () => {
    const semResposta = new FirebaseFunctionsError({
      code: 'task-already-exists',
      message: 'sem resposta',
    });
    const f = fila(semResposta);
    await expect(
      criarAgendadorEstoqueLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).rejects.toBe(semResposta);
  });

  it.each([
    ['functions 503', () => falhaDoFunctions('unknown-error', 503)],
    ['functions 429', () => falhaDoFunctions('unknown-error', 429)],
    ['app network', () => falhaDoApp('network-error')],
  ])('a transient Cloud Tasks failure (%s) is NAMED', async (_rotulo, falha) => {
    const f = fila(falha());
    await expect(
      criarAgendadorEstoqueLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
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
      criarAgendadorEstoqueLi({ fila: f.fila, desligado: false }).enfileirar(tarefa(), opcoes),
    ).rejects.toBe(err);
  });

  it('the sweep-only valve closed ⇒ LiTarefasDesligadasError, and the queue is NEVER resolved', async () => {
    const f = fila();
    await expect(
      criarAgendadorEstoqueLi({ fila: f.fila, desligado: true }).enfileirar(tarefa(), opcoes),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    expect(f.resolvida()).toBe(0);
    expect(f.chamadas).toEqual([]);
  });
});

describe('enfileirarTarefaEstoqueLi: the clock at the enqueue, the strict parse, the name', () => {
  const semJanela: TarefaEstoqueSemJanelaLi = {
    contaId: 'conta-li-est',
    produtoId: 'prod-1',
    origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva,
    estoqueId: 'est-prod-1-dep-1',
    apagado: true,
    estoqueIds: { c1: 'est-c1-dep-1', c2: null },
    geracao: 1,
  };

  function gravador() {
    const eventos: string[] = [];
    const enfileiradas: { tarefa: unknown; opcoes: OpcoesEnfileiramentoEstoqueLi }[] = [];
    const agendador: AgendadorEstoqueLi = {
      enfileirar: (t, o) => {
        eventos.push('enfileirar');
        enfileiradas.push({ tarefa: t, opcoes: o });
        return Promise.resolve();
      },
    };
    return { agendador, eventos, enfileiradas };
  }

  it('the window comes from a clock read right before the enqueue; the payload parses; the name and schedule follow', async () => {
    const g = gravador();
    const relogio = () => {
      g.eventos.push('relogio');
      return JANELA * 60_000 + 30_000;
    };
    await enfileirarTarefaEstoqueLi(g.agendador, relogio, semJanela);
    expect(g.eventos).toEqual(['relogio', 'enfileirar']);
    const [enfileirada] = g.enfileiradas;
    const esperada = { ...semJanela, tipo: TIPO_TAREFA_ESTOQUE_LI.estoque, janela: JANELA };
    expect(enfileirada?.tarefa).toEqual(esperada);
    expect(tarefaEstoqueLiSchema.safeParse(enfileirada?.tarefa).success).toBe(true);
    expect(enfileirada?.opcoes).toEqual({
      id: idDaTarefaEstoqueLi(esperada),
      agendarParaMs: agendamentoEstoqueLi(JANELA, 'prod-1'),
    });
  });

  it('a QUANTITY can never leave: the strict parse refuses it, and nothing is enqueued', async () => {
    const g = gravador();
    const comQuantidade = { ...semJanela, quantidade: 7 } as unknown as TarefaEstoqueSemJanelaLi;
    await expect(
      enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000, comQuantidade),
    ).rejects.toBeInstanceOf(ZodError);
    expect(g.enfileiradas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: generation 1 is the deriva’s alone — another origin at generation 1 is refused', async () => {
    const g = gravador();
    await expect(
      enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000, {
        ...semJanela,
        origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(g.enfileiradas).toEqual([]);
  });

  it('the queue is named after the function that serves it', () => {
    expect(FILA_ESTOQUE_LI).toBe('filaEstoqueLojaIntegrada');
  });
});

describe('a BULK enqueue (PR 12-f): the window handed in, and a not-before bound', () => {
  const kit: TarefaEstoqueSemJanelaLi = {
    contaId: 'conta-li-est',
    produtoId: 'kit-1',
    origem: ORIGEM_TAREFA_ESTOQUE_LI.kit,
    estoqueId: null,
    apagado: false,
    estoqueIds: { c1: 'est-c1-dep-1' },
    geracao: 0,
  };

  function gravador() {
    const enfileiradas: { tarefa: TarefaEstoqueLi; opcoes: OpcoesEnfileiramentoEstoqueLi }[] = [];
    const agendador: AgendadorEstoqueLi = {
      enfileirar: (t, o) => {
        if (t.tipo !== TIPO_TAREFA_ESTOQUE_LI.estoque) throw new TypeError('só estoque aqui');
        enfileiradas.push({ tarefa: t, opcoes: o });
        return Promise.resolve();
      },
    };
    return { agendador, enfileiradas };
  }

  const relogioProibido = () => {
    throw new Error('teste: com a janela dada, o relógio não é lido');
  };

  it('`janela` NAMES the task — the clock is not read at all — and the window schedule follows it', async () => {
    const g = gravador();
    await enfileirarTarefaEstoqueLi(g.agendador, relogioProibido, kit, { janela: JANELA - 7 });
    const [e] = g.enfileiradas;
    expect(e?.tarefa.janela).toBe(JANELA - 7);
    expect(e?.opcoes).toEqual({
      id: idDaTarefaEstoqueLi({ ...kit, janela: JANELA - 7 }),
      agendarParaMs: agendamentoEstoqueLi(JANELA - 7, 'kit-1'),
    });
  });

  it('EQUAL pair: a retry that hands in the same window names the same task, whenever it runs', async () => {
    const g = gravador();
    await enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000, kit, { janela: JANELA });
    await enfileirarTarefaEstoqueLi(g.agendador, () => (JANELA + 9) * 60_000, kit, {
      janela: JANELA,
    });
    expect(g.enfileiradas[0]?.opcoes.id).toBe(g.enfileiradas[1]?.opcoes.id);
    // ⚠️ NEAR-MISS: named by the clock instead, the retry is another task (a doubled fan-out).
    await enfileirarTarefaEstoqueLi(g.agendador, () => (JANELA + 9) * 60_000, kit);
    expect(g.enfileiradas[2]?.opcoes.id).not.toBe(g.enfileiradas[0]?.opcoes.id);
  });

  it('`naoAntesDeMs` LATER than the window schedule ⇒ the schedule IS that instant', async () => {
    const g = gravador();
    const depois = agendamentoEstoqueLi(JANELA, 'kit-1') + 3_600_000;
    await enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000, kit, {
      janela: JANELA,
      naoAntesDeMs: depois,
    });
    expect(g.enfileiradas[0]?.opcoes.agendarParaMs).toBe(depois);
  });

  it('⚠️ NEAR-MISS: `naoAntesDeMs` EARLIER than the window schedule never wins — the window stays the floor', async () => {
    const g = gravador();
    const janelaDoAgendamento = agendamentoEstoqueLi(JANELA, 'kit-1');
    await enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000, kit, {
      naoAntesDeMs: janelaDoAgendamento - 1,
    });
    expect(g.enfileiradas[0]?.opcoes.agendarParaMs).toBe(janelaDoAgendamento);
    expect(g.enfileiradas[0]?.opcoes.agendarParaMs).toBeGreaterThanOrEqual(
      (JANELA + 1) * JANELA_ESTOQUE_LI_MS + MARGEM_AGENDAMENTO_ESTOQUE_LI_MS,
    );
  });

  it('no options ⇒ byte-identical to before: the clock’s window, the window schedule', async () => {
    const g = gravador();
    await enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000 + 1, kit);
    await enfileirarTarefaEstoqueLi(g.agendador, () => JANELA * 60_000 + 1, kit, {});
    for (const e of g.enfileiradas) {
      expect(e.opcoes).toEqual({
        id: idDaTarefaEstoqueLi({ ...kit, janela: JANELA }),
        agendarParaMs: agendamentoEstoqueLi(JANELA, 'kit-1'),
      });
    }
  });

  it('a handed-in window the strict schema refuses (negative) ⇒ ZodError, nothing enqueued', async () => {
    const g = gravador();
    await expect(
      enfileirarTarefaEstoqueLi(g.agendador, relogioProibido, kit, { janela: -1 }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(g.enfileiradas).toEqual([]);
  });
});

describe('the fan-out task (estoque-kits): its own name, the same window and schedule', () => {
  const kits = (over: Partial<TarefaEstoqueKitsLi> = {}): TarefaEstoqueKitsLi => ({
    tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
    contaId: 'conta-li-est',
    componenteId: 'prod-1',
    janela: JANELA,
    ...over,
  });

  it('golden value, and the preimage spelled out', () => {
    expect(idDaTarefaEstoqueKitsLi(kits())).toBe(
      'estoque-kits-201c5be3fe3c947a86bbffb7e8d5ce8aef6b49fc54326be6707f1f55076e32ca',
    );
    expect(idDaTarefaEstoqueKitsLi(kits())).toBe(
      `estoque-kits-${sha(`estoque-kits:conta-li-est:prod-1:${String(JANELA)}`)}`,
    );
  });

  it('EQUAL pair: the same conta, component and window ⇒ the same id', () => {
    expect(idDaTarefaEstoqueKitsLi(kits())).toBe(idDaTarefaEstoqueKitsLi({ ...kits() }));
  });

  it.each([
    ['conta', { contaId: 'conta-li-esu' }],
    ['componente', { componenteId: 'prod-2' }],
    ['janela', { janela: JANELA + 1 }],
  ] as const)('⚠️ NEAR-MISS: another %s ⇒ another id', (_rotulo, over) => {
    expect(idDaTarefaEstoqueKitsLi(kits(over))).not.toBe(idDaTarefaEstoqueKitsLi(kits()));
  });

  it('⚠️ DISTINCT from every send task of the same ids, whatever the origin (own prefix AND own tag)', () => {
    const id = idDaTarefaEstoqueKitsLi(kits());
    for (const origem of Object.values(ORIGEM_TAREFA_ESTOQUE_LI)) {
      for (const apagado of [false, true]) {
        expect(
          idDaTarefaEstoqueLi(
            tarefa({
              origem,
              apagado,
              produtoId: 'prod-1',
              geracao: origem === ORIGEM_TAREFA_ESTOQUE_LI.deriva ? 1 : 0,
            }),
          ),
        ).not.toBe(id);
      }
    }
    expect(id.startsWith('estoque-kits-')).toBe(true);
    // The tag alone keeps the digests apart: the send preimage of the same parts is another one.
    expect(id.slice('estoque-kits-'.length)).not.toBe(
      sha(`estoque:conta-li-est:prod-1:${String(JANELA)}`),
    );
  });

  it('inside Cloud Tasks’ task-id grammar, whatever the ids hold', () => {
    for (const t of [kits(), kits({ componenteId: 'p ó~0', contaId: 'C_1-a' })]) {
      expect(idDaTarefaEstoqueKitsLi(t)).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    }
  });

  function gravador() {
    const eventos: string[] = [];
    const enfileiradas: { tarefa: unknown; opcoes: OpcoesEnfileiramentoEstoqueLi }[] = [];
    const agendador: AgendadorEstoqueLi = {
      enfileirar: (t, o) => {
        eventos.push('enfileirar');
        enfileiradas.push({ tarefa: t, opcoes: o });
        return Promise.resolve();
      },
    };
    return { agendador, eventos, enfileiradas };
  }

  const semJanela: TarefaEstoqueKitsSemJanelaLi = {
    contaId: 'conta-li-est',
    componenteId: 'prod-1',
  };

  it('enfileirarTarefaEstoqueKitsLi: the clock read right before the enqueue; parsed; named; scheduled over the component', async () => {
    const g = gravador();
    const relogio = () => {
      g.eventos.push('relogio');
      return JANELA * 60_000 + 59_999;
    };
    await enfileirarTarefaEstoqueKitsLi(g.agendador, relogio, semJanela);
    expect(g.eventos).toEqual(['relogio', 'enfileirar']);
    const esperada = kits();
    expect(g.enfileiradas).toEqual([
      {
        tarefa: esperada,
        opcoes: {
          id: idDaTarefaEstoqueKitsLi(esperada),
          agendarParaMs: agendamentoEstoqueLi(JANELA, 'prod-1'),
        },
      },
    ]);
    expect(tarefaEstoqueKitsLiSchema.safeParse(g.enfileiradas[0]?.tarefa).success).toBe(true);
  });

  it('an extra key (a quantity) is refused by the strict parse: ZodError, nothing enqueued', async () => {
    const g = gravador();
    const comQuantidade = {
      ...semJanela,
      disponivel: 0,
    } as unknown as TarefaEstoqueKitsSemJanelaLi;
    await expect(
      enfileirarTarefaEstoqueKitsLi(g.agendador, () => JANELA * 60_000, comQuantidade),
    ).rejects.toBeInstanceOf(ZodError);
    expect(g.enfileiradas).toEqual([]);
  });

  it('rejects as the agendador does: the closed valve, a transient failure', async () => {
    await expect(
      enfileirarTarefaEstoqueKitsLi(
        criarAgendadorEstoqueLi({ fila: fila().fila, desligado: true }),
        () => JANELA * 60_000,
        semJanela,
      ),
    ).rejects.toBeInstanceOf(LiTarefasDesligadasError);
    await expect(
      enfileirarTarefaEstoqueKitsLi(
        criarAgendadorEstoqueLi({
          fila: fila(falhaDoFunctions('unknown-error', 503)).fila,
          desligado: false,
        }),
        () => JANELA * 60_000,
        semJanela,
      ),
    ).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
  });
});

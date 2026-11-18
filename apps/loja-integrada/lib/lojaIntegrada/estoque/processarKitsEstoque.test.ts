/**
 * The `estoque-kits` FAN-OUT (master plan step 12, PR 12-f), pinned by COUNTING: the reads the
 * fake Firestore served (`leituras`, `consultas`), its writes (the slot's `proximoSlotMs` and
 * nothing else, ever — checked after every test), the enqueues the producer received (payloads,
 * names, schedules) and every line. The producer is the REAL pure one (`criarAgendadorEstoqueLi`)
 * over a fake Cloud Tasks queue that dedups by name and fails with the SDK's own classes.
 *
 * No call to Loja Integrada is reachable before the cutover — the global `fetch` throws in every test, and the
 * fan-out builds no client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { reconcileEstoqueLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import {
  ID_RECONCILE_ESTOQUE_LI,
  INTEGRACAO_TIPO,
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  type TarefaEstoqueKitsLi,
  type TarefaEstoqueLi,
  type TarefaFilaEstoqueLi,
  tarefaEstoqueLiSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import { type AmbienteLi, VALVULA_ENV_LI } from '../core/valvulas';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import { falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, espiarStdout } from '../testing/fixtures';
import {
  CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI,
  type FilaEstoqueLi,
  LiTarefasTransitoriasError,
  criarAgendadorEstoqueLi,
  idDaTarefaEstoqueLi,
  janelaEstoqueLi,
} from './agendadorEstoque';
import { TETO_ESTOQUE_ENV_LI } from './configEstoqueLi';
import {
  type DepsKitsEstoqueLi,
  LiMapaKitsEstoqueIncompletoError,
  type ResultadoKitsEstoqueLi,
  processarTarefaEstoqueKitsLi,
} from './processarKitsEstoque';
import {
  HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS,
  INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS,
  LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS,
  pisoDoSlotEstoqueLi,
} from './slotEstoqueLi';

/* -------------------------------------------------------------------------- */
/*                                  Fixtures                                   */
/* -------------------------------------------------------------------------- */

const T0 = AGORA_MS;
/** The fan-out task's own window: it ran a few minutes after the trigger enqueued it. */
const J = janelaEstoqueLi(T0) - 4;
const CONTA = 'conta-li-kits';
const DEP = 'dep-li-kits';
const DOC = `documents/depositos/${DEP}`;
const C = 'p-blank';
const EXEC = 'estoque-reconcile-20270115';
const I = INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS;
const PISO = pisoDoSlotEstoqueLi(T0);
const SLOT = 'reconcileEstoqueLojaIntegrada/atual';
const CONTA_PATH = `integracao/${CONTA}`;
const CABECALHO = `sincEstoqueLojaIntegrada/${CONTA}/kits/${C}`;
const CANONICO = `produtos/${C}/estoques/est-${C}-${DEP}`;
const fatiaPath = (n: number) => `sincEstoqueLojaIntegrada/${CONTA}/kitsFatias/${C}~${String(n)}`;

function seedConta(db: FakeDb, over: DocData = {}): void {
  db.seed(CONTA_PATH, {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja K',
    ativo: true,
    depositoOuterRef: DOC,
    ...over,
  });
}

/** The component's record at the depósito (canonical id unless named). */
function seedRegistro(db: FakeDb, quantidade: unknown, id = `est-${C}-${DEP}`, over: DocData = {}) {
  db.seed(`produtos/${C}/estoques/${id}`, {
    depositoOuterRef: DOC,
    quantidade,
    quantidadeReservada: 0,
    ...over,
  });
}

/** `n` kits needing `q` of the component each (and one of `outro`), ids `${prefixo}-<i>`. */
function kitsQuePrecisam(n: number, q: number, prefixo: string): Record<string, DocData> {
  return Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `${prefixo}-${String(i).padStart(4, '0')}`,
      { i: String(7000 + i), q: { [C]: q, 'p-print': 1 } },
    ]),
  );
}

/** A header with more kits than the eager ceiling, in `fatias.length` shards. */
function seedEmFatias(db: FakeDb, fatias: readonly Record<string, DocData>[], over: DocData = {}) {
  const F = fatias.reduce((n, f) => n + Object.keys(f).length, 0);
  db.seed(CABECALHO, {
    execucaoId: EXEC,
    F,
    qMax: 5,
    comps: { [C]: `est-${C}-${DEP}`, 'p-print': 'est-p-print-dep' },
    kits: null,
    fatias: fatias.length,
    ...over,
  });
  fatias.forEach((kits, n) => {
    db.seed(fatiaPath(n), { execucaoId: EXEC, kits });
  });
}

/** An inline header (at most 30 kits — the fan-out also reads one, e.g. under a ceiling of 0). */
function seedEmLinha(db: FakeDb, kits: Record<string, DocData>, over: DocData = {}) {
  db.seed(CABECALHO, {
    execucaoId: EXEC,
    F: Object.keys(kits).length,
    qMax: 5,
    comps: { [C]: `est-${C}-${DEP}`, 'p-print': 'auto-legado-print' },
    kits,
    fatias: 0,
    ...over,
  });
}

const kitsTarefa = (over: Partial<TarefaEstoqueKitsLi> = {}): TarefaEstoqueKitsLi => ({
  tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
  contaId: CONTA,
  componenteId: C,
  janela: J,
  ...over,
});

/* -------------------------------------------------------------------------- */
/*                                  Harness                                    */
/* -------------------------------------------------------------------------- */

interface Enviada {
  readonly tarefa: TarefaFilaEstoqueLi;
  readonly id: string;
  readonly scheduleTime: Date;
}

/** A fake Cloud Tasks queue: dedups by name (an answered already-exists), records, can fail. */
function filaFake(o: { readonly falhar?: (t: TarefaFilaEstoqueLi) => Error | null } = {}) {
  const nomes = new Set<string>();
  const enviadas: Enviada[] = [];
  let emVoo = 0;
  let maxEmVoo = 0;
  const fila: FilaEstoqueLi = {
    async enqueue(tarefa, { id, scheduleTime }) {
      emVoo += 1;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      await Promise.resolve();
      emVoo -= 1;
      const falha = o.falhar?.(tarefa) ?? null;
      if (falha !== null) throw falha;
      if (nomes.has(id)) throw falhaDoFunctions('task-already-exists', 409);
      nomes.add(id);
      enviadas.push({ tarefa, id, scheduleTime });
    },
  };
  return { fila, enviadas, nomes, maxEmVoo: () => maxEmVoo };
}

type Linha = readonly ['WARNING' | 'ERROR', string, Record<string, unknown> | undefined];

const fakes: FakeDb[] = [];
let stdout: ReturnType<typeof espiarStdout>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => T0);
  stdout = espiarStdout();
  vi.stubGlobal('fetch', () => {
    throw new Error('processarKitsEstoque.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  // The fan-out's ONLY write is the slot's proximoSlotMs, in every case.
  for (const f of fakes.splice(0)) {
    for (const e of f.escritas) {
      expect(e.caminho).toBe(SLOT);
      expect(Object.keys(e.dados ?? {})).toEqual(['proximoSlotMs']);
    }
  }
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

function montar(
  o: {
    readonly ambiente?: AmbienteLi;
    readonly tentativa?: number;
    readonly fila?: ReturnType<typeof filaFake>;
    readonly desligado?: boolean;
    readonly agora?: () => number;
  } = {},
) {
  const db = new FakeDb();
  fakes.push(db);
  const fila = o.fila ?? filaFake();
  const linhas: Linha[] = [];
  const deps: DepsKitsEstoqueLi = {
    ambiente: { [VALVULA_ENV_LI.estoque]: 'dry-run', ...o.ambiente },
    agoraMs: o.agora ?? (() => T0),
    tentativa: o.tentativa ?? 0,
    agendador: criarAgendadorEstoqueLi({ fila: () => fila.fila, desligado: o.desligado ?? false }),
    logger: {
      warn: (m, meta) => linhas.push(['WARNING', m, meta]),
      error: (m, meta) => linhas.push(['ERROR', m, meta]),
    },
  };
  const rodar = (dados: unknown = kitsTarefa()): Promise<ResultadoKitsEstoqueLi> =>
    processarTarefaEstoqueKitsLi(asDb(db), dados, deps);
  return { db, fila, linhas, deps, rodar };
}

/** The kit send tasks enqueued, as payloads. */
const tarefasEnviadas = (f: ReturnType<typeof filaFake>) =>
  f.enviadas.map((e) => e.tarefa as TarefaEstoqueLi);

/* -------------------------------------------------------------------------- */
/*                            Gates before the map                             */
/* -------------------------------------------------------------------------- */

describe('the gates before any read', () => {
  it('a payload the strict schema refuses (an extra key, a quantity) ⇒ payload-invalido, ZERO reads', async () => {
    const h = montar();
    seedConta(h.db);
    expect(await h.rodar({ ...kitsTarefa(), disponivel: 0 })).toEqual({ kind: 'payload-invalido' });
    expect(await h.rodar({ ...kitsTarefa(), tipo: 'estoque' })).toEqual({
      kind: 'payload-invalido',
    });
    expect(h.db.leituras).toEqual([]);
    expect(h.db.consultas).toEqual([]);
  });

  it.each([
    ['unset', undefined],
    ['blank', ''],
    ['off', 'off'],
  ])('the valve %s ⇒ desligado, ZERO reads, no line', async (_r, valor) => {
    const h = montar({ ambiente: { [VALVULA_ENV_LI.estoque]: valor } });
    seedConta(h.db);
    expect(await h.rodar()).toEqual({ kind: 'desligado' });
    expect(h.db.leituras).toEqual([]);
    expect(stdout.escritas()).toEqual([]);
  });

  it.each([['OFF'], [' on'], ['true']])(
    'an UNRECOGNISED valve (%j) ⇒ desligado, ZERO reads, ONE WARNING run-start line',
    async (valor) => {
      const h = montar({ ambiente: { [VALVULA_ENV_LI.estoque]: valor } });
      expect(await h.rodar()).toEqual({ kind: 'desligado' });
      expect(h.db.leituras).toEqual([]);
      const linhas = stdout.escritas().map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ severity: 'WARNING', evento: 'valvula' });
    },
  );

  it.each([['0'], ['abc'], ['-3']])(
    'an unreadable cap (%j) ⇒ teto-invalido, ZERO reads, ONE ERROR',
    async (valor) => {
      const h = montar({ ambiente: { [TETO_ESTOQUE_ENV_LI]: valor } });
      seedConta(h.db);
      expect(await h.rodar()).toEqual({ kind: 'teto-invalido' });
      expect(h.db.leituras).toEqual([]);
      expect(h.linhas.map(([s, , m]) => [s, m?.motivo])).toEqual([['ERROR', 'teto-invalido']]);
    },
  );

  it('dry-run and on proceed alike — both reach the conta', async () => {
    for (const modo of ['dry-run', 'on']) {
      const h = montar({ ambiente: { [VALVULA_ENV_LI.estoque]: modo } });
      expect(await h.rodar()).toEqual({ kind: 'pulado', motivo: 'conta-inexistente' });
      expect(h.db.leituras).toEqual([CONTA_PATH]);
    }
  });
});

describe('the conta (the send run’s cached reader)', () => {
  it.each([
    ['absent', null, 'conta-inexistente'],
    ['not a Loja Integrada conta', { tipo: 1 }, 'conta-inexistente'],
    ['inactive', { ativo: false }, 'conta-inativa'],
  ] as const)('%s ⇒ pulado, only the conta read', async (_r, over, motivo) => {
    const h = montar();
    if (over !== null) seedConta(h.db, over);
    expect(await h.rodar()).toEqual({ kind: 'pulado', motivo });
    expect(h.db.leituras).toEqual([CONTA_PATH]);
    expect(h.fila.enviadas).toEqual([]);
  });

  it('no depósito ⇒ pulado conta-sem-deposito with ONE WARNING, only the conta read', async () => {
    const h = montar();
    seedConta(h.db, { depositoOuterRef: null });
    expect(await h.rodar()).toEqual({ kind: 'pulado', motivo: 'conta-sem-deposito' });
    expect(h.db.leituras).toEqual([CONTA_PATH]);
    expect(h.linhas.map(([s, , m]) => [s, m?.motivo])).toEqual([['WARNING', 'conta-sem-deposito']]);
  });
});

describe('the header and the component’s own stock', () => {
  it('header NOT_FOUND ⇒ pulado sem-mapa: the conta, the header and the own record read, NO write, NO enqueue', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    expect(await h.rodar()).toEqual({ kind: 'pulado', motivo: 'sem-mapa' });
    expect(h.db.leituras.sort()).toEqual([CANONICO, CONTA_PATH, CABECALHO].sort());
    expect(h.db.escritas).toEqual([]);
    expect(h.fila.enviadas).toEqual([]);
  });

  it('a header off the refined schema ⇒ ONE WARNING (field names), pulado mapa-invalido', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'), { F: 3 });
    expect(await h.rodar()).toEqual({ kind: 'pulado', motivo: 'mapa-invalido' });
    expect(h.linhas).toHaveLength(1);
    expect(h.linhas[0]?.[2]).toMatchObject({ campos: ['kits'] });
    expect(h.db.escritas).toEqual([]);
  });

  it('the CANONICAL record answers by ONE point read — no query — whatever the header’s comps names', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 1);
    seedEmLinha(h.db, kitsQuePrecisam(1, 2, 'k'), {
      comps: { [C]: 'auto-legado-blank', 'p-print': null },
    });
    await h.rodar();
    expect(h.db.consultas.filter((q) => q.colecao.endsWith('/estoques'))).toEqual([]);
    expect(h.db.leituras).toContain(CANONICO);
  });

  it('no canonical record: the two-form `in` query finds a legacy one stored under the BARE form — its available decides', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 3, 'auto-legado-blank', { depositoOuterRef: `depositos/${DEP}` });
    seedEmLinha(h.db, { ...kitsQuePrecisam(1, 3, 'cabe'), ...kitsQuePrecisam(1, 4, 'zera') });
    const r = await h.rodar();
    expect(h.db.consultas.filter((q) => q.colecao === `produtos/${C}/estoques`)).toHaveLength(1);
    expect(r).toMatchObject({ kind: 'enfileirado', contagens: { zerados: 1 } });
    expect(tarefasEnviadas(h.fila).map((t) => t.produtoId)).toEqual(['zera-0000']);
  });

  it.each([
    [
      'no record at the depósito',
      (db: FakeDb) =>
        seedRegistro(db, 9, 'est-x', { depositoOuterRef: 'documents/depositos/outro' }),
    ],
    [
      'two legacy records (ambiguous)',
      (db: FakeDb) => {
        seedRegistro(db, 9, 'auto-1');
        seedRegistro(db, 9, 'auto-2');
      },
    ],
    ['an unreadable quantity', (db: FakeDb) => seedRegistro(db, 'muitos')],
  ])('fail open — %s ⇒ the available reads 0 ⇒ EVERY kit enqueued', async (_r, semear) => {
    const h = montar();
    seedConta(h.db);
    semear(h.db);
    seedEmLinha(h.db, { ...kitsQuePrecisam(2, 1, 'a'), ...kitsQuePrecisam(1, 5, 'b') });
    const r = await h.rodar();
    expect(r).toMatchObject({ kind: 'enfileirado', contagens: { zerados: 3, enfileirados: 3 } });
  });

  it('⚠️ NEAR-MISS: the same kits over a READABLE record at 5 ⇒ only the kits needing more than 5', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 5);
    seedEmLinha(h.db, { ...kitsQuePrecisam(2, 1, 'a'), ...kitsQuePrecisam(1, 6, 'b') });
    const r = await h.rodar();
    expect(r).toMatchObject({ kind: 'enfileirado', contagens: { zerados: 1 } });
    expect(tarefasEnviadas(h.fila).map((t) => t.produtoId)).toEqual(['b-0000']);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The kits, the slot, the sends                       */
/* -------------------------------------------------------------------------- */

describe('the happy path', () => {
  it('inline kits: exactly the kits this component holds at 0, likeliest first; each payload the kit send; ONE slot write; the cost contract', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 1);
    seedEmLinha(h.db, {
      'k-precisa-3': { i: '1', q: { [C]: 3, 'p-print': 1 } },
      'k-precisa-1': { i: '2', q: { [C]: 1, 'p-print': 1 } },
      'k-precisa-2': { i: '3', q: { [C]: 2, 'p-print': 1 } },
    });

    const r = await h.rodar();

    expect(r).toEqual({
      kind: 'enfileirado',
      contagens: {
        F: 3,
        kitsLidos: 3,
        zerados: 2,
        enfileirados: 2,
        recusados: 0,
        horizonteMs: PISO + 2 * I - T0,
      },
    });
    // Reads: the conta, the header and the own canonical record, then the slot. No sibling, no
    // produto, no credential; no query at all.
    expect(h.db.leituras.slice(0, 3).sort()).toEqual([CANONICO, CONTA_PATH, CABECALHO].sort());
    expect(h.db.leituras.slice(3)).toEqual([SLOT]);
    expect(h.db.consultas).toEqual([]);
    expect(h.db.escritas.map((e) => [e.verbo, e.dados])).toEqual([
      ['create', { proximoSlotMs: PISO + 2 * I }],
    ]);
    expect(tarefasEnviadas(h.fila)).toEqual([
      {
        tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
        contaId: CONTA,
        produtoId: 'k-precisa-2',
        origem: ORIGEM_TAREFA_ESTOQUE_LI.kit,
        janela: J,
        estoqueId: null,
        apagado: false,
        estoqueIds: { [C]: `est-${C}-${DEP}`, 'p-print': 'auto-legado-print' },
        geracao: 0,
      },
      expect.objectContaining({ produtoId: 'k-precisa-3', janela: J }),
    ]);
    // Every send scheduled at EXACTLY its reserved instant, one interval apart.
    expect(h.fila.enviadas.map((e) => e.scheduleTime.getTime())).toEqual([PISO, PISO + I]);
    expect(h.linhas).toEqual([]);
  });

  it('kits in SHARDS: exactly the header’s shards read in ONE getAll, every kit of them considered', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 2);
    // 1 002 kits over two shards: 998 + 1 needing 1 (bound 2), 3 needing 5 (bound 0).
    seedEmFatias(h.db, [
      { ...kitsQuePrecisam(998, 1, 'a'), ...kitsQuePrecisam(2, 5, 'z') },
      { ...kitsQuePrecisam(1, 1, 'b'), ...kitsQuePrecisam(1, 5, 'y') },
    ]);
    const getAll = vi.spyOn(h.db, 'getAll');

    const r = await h.rodar();

    expect(h.db.leituras.filter((l) => l.includes('/kitsFatias/'))).toEqual([
      fatiaPath(0),
      fatiaPath(1),
    ]);
    // The header (one getAll), the shards (one getAll of two refs), then the slot — one ref
    // masked to `proximoSlotMs` (PR 12-g: the run document may hold the reconcile's candidates).
    expect(getAll.mock.calls.map((c) => c.length)).toEqual([1, 2, 2]);
    expect(getAll.mock.calls[2]?.[1]).toEqual({ fieldMask: ['proximoSlotMs'] });
    expect(r).toMatchObject({
      kind: 'enfileirado',
      contagens: { F: 1002, kitsLidos: 1002, zerados: 3 },
    });
    expect(tarefasEnviadas(h.fila).map((t) => t.produtoId)).toEqual(['y-0000', 'z-0000', 'z-0001']);
  });

  it('⚠️ mutation guard: WITHOUT reading the shards the sharded kits would be missed — none of them is inline', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmFatias(h.db, [kitsQuePrecisam(31, 1, 's')]);
    const r = await h.rodar();
    expect(r).toMatchObject({ kind: 'enfileirado', contagens: { zerados: 31, enfileirados: 31 } });
  });

  it('nothing at 0 ⇒ nenhum: NO slot read, NO write, NO enqueue', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 50);
    seedEmLinha(h.db, kitsQuePrecisam(3, 2, 'k'));
    expect(await h.rodar()).toEqual({
      kind: 'nenhum',
      contagens: {
        F: 3,
        kitsLidos: 3,
        zerados: 0,
        enfileirados: 0,
        recusados: 0,
        horizonteMs: null,
      },
    });
    expect(h.db.leituras).not.toContain(SLOT);
    expect(h.db.escritas).toEqual([]);
    expect(h.fila.enviadas).toEqual([]);
  });
});

describe('an incomplete shard read (a map caught between two runs of its writer)', () => {
  function semearIncompleto(db: FakeDb) {
    seedConta(db);
    seedRegistro(db, 0);
    seedEmFatias(db, [kitsQuePrecisam(1000, 1, 'a'), kitsQuePrecisam(5, 1, 'b')]);
    // Shard 1 never landed.
    db.seed(fatiaPath(1), {
      execucaoId: 'estoque-reconcile-20270114',
      kits: kitsQuePrecisam(5, 1, 'b'),
    });
  }

  it.each(Array.from({ length: TASK_MAX_ATTEMPTS - 1 }, (_, tentativa) => tentativa))(
    'before the last attempt (tentativa %i) ⇒ ONE WARNING with the counts, then LiMapaKitsEstoqueIncompletoError: nothing reserved or enqueued',
    async (tentativa) => {
      const h = montar({ tentativa });
      semearIncompleto(h.db);
      await expect(h.rodar()).rejects.toBeInstanceOf(LiMapaKitsEstoqueIncompletoError);
      expect(h.linhas).toHaveLength(1);
      expect(h.linhas[0]?.[2]).toMatchObject({
        F: 1005,
        fatias: 2,
        kitsLidos: 1005,
        deOutraExecucao: 1,
        acao: 'tenta-de-novo',
      });
      expect(h.db.escritas).toEqual([]);
      expect(h.fila.enviadas).toEqual([]);
    },
  );

  it('the retry that follows (no reservation behind it) queues BEHIND a stored slot like a first attempt — never double-booked', async () => {
    const fila = filaFake();
    const primeira = montar({ tentativa: 0, fila });
    semearIncompleto(primeira.db);
    const armazenado = T0 + 30 * 60_000;
    primeira.db.seed(SLOT, { proximoSlotMs: armazenado });
    await expect(primeira.rodar()).rejects.toBeInstanceOf(LiMapaKitsEstoqueIncompletoError);
    expect(primeira.db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado });

    // The writer finished meanwhile: shard 1 now of the header's run.
    primeira.db.seed(fatiaPath(1), { execucaoId: EXEC, kits: kitsQuePrecisam(5, 1, 'b') });
    const r = await processarTarefaEstoqueKitsLi(asDb(primeira.db), kitsTarefa(), {
      ...primeira.deps,
      tentativa: 1,
    });

    expect(r).toMatchObject({ kind: 'enfileirado', contagens: { zerados: 1005 } });
    expect(fila.enviadas[0]?.scheduleTime.getTime()).toBe(armazenado);
    expect(primeira.db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado + 1005 * I });
  });

  it('on the LAST attempt ⇒ the WARNING, then the kits that WERE read go on (over-inclusive)', async () => {
    const h = montar({ tentativa: TASK_MAX_ATTEMPTS - 1 });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    // The header promises two shards; only shard 0 is there.
    seedEmFatias(h.db, [kitsQuePrecisam(1000, 1, 'a')], { F: 1005, fatias: 2 });
    const r = await h.rodar();
    expect(h.linhas[0]?.[2]).toMatchObject({ ausentes: 1, acao: 'segue-com-os-lidos' });
    expect(r).toMatchObject({ kind: 'enfileirado', contagens: { kitsLidos: 1000, zerados: 1000 } });
  });
});

describe('the slot: paced, advance-only, re-read on a lost race', () => {
  it('a stored slot 10 min ahead ⇒ the first kit starts AT it; the slot advances by n intervals', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(3, 1, 'k'));
    const armazenado = T0 + 10 * 60_000;
    h.db.seed(SLOT, { proximoSlotMs: armazenado, execucaoId: EXEC });

    await h.rodar();

    expect(h.fila.enviadas.map((e) => e.scheduleTime.getTime())).toEqual([
      armazenado,
      armazenado + I,
      armazenado + 2 * I,
    ]);
    expect(h.db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado + 3 * I, execucaoId: EXEC });
  });

  it('a NEWER slot lands between our read and our update ⇒ 9 ⇒ re-read: our kits start after IT', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'));
    h.db.seed(SLOT, { proximoSlotMs: T0 });
    const outro = T0 + 30 * 60_000;
    h.db.antesDaProximaEscrita(SLOT, async () => {
      await reconcileEstoqueLojaIntegradaCollection
        .docRef(asDb(h.db), {}, ID_RECONCILE_ESTOQUE_LI)
        .update({ proximoSlotMs: outro });
    });

    await h.rodar();

    expect(h.fila.enviadas.map((e) => e.scheduleTime.getTime())).toEqual([outro, outro + I]);
    expect(h.db.ler(SLOT)).toEqual({ proximoSlotMs: outro + 2 * I });
  });

  it('BEYOND the horizon ⇒ ONE ERROR (the backlog signal), and the kits STILL queue behind it: never double-booked', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'));
    const armazenado = T0 + HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS + 60_000;
    h.db.seed(SLOT, { proximoSlotMs: armazenado });

    const r = await h.rodar();

    expect(h.fila.enviadas.map((e) => e.scheduleTime.getTime())).toEqual([
      armazenado,
      armazenado + I,
    ]);
    expect(h.db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado + 2 * I });
    // The line's horizon counts this run's own reservation.
    expect(r).toMatchObject({ contagens: { horizonteMs: armazenado + 2 * I - T0 } });
    expect(h.linhas.map(([s, , m]) => [s, m?.horizonteArmazenadoMs])).toEqual([
      ['ERROR', armazenado - T0],
    ]);
  });

  it('a reservation past the schedule LIMIT ⇒ ONE ERROR, slot-esgotado: nothing written, nothing enqueued', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'));
    const armazenado = T0 + LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS;
    h.db.seed(SLOT, { proximoSlotMs: armazenado });

    const r = await h.rodar();

    expect(r).toEqual({
      kind: 'slot-esgotado',
      contagens: {
        F: 2,
        kitsLidos: 2,
        zerados: 2,
        enfileirados: 0,
        recusados: 0,
        horizonteMs: null,
      },
    });
    expect(h.db.escritas).toEqual([]);
    expect(h.fila.enviadas).toEqual([]);
    expect(h.linhas.map(([s, , m]) => [s, m?.horizonteArmazenadoMs])).toEqual([
      ['ERROR', armazenado - T0],
    ]);
  });

  it('a RETRIED attempt (tentativa > 0) reserves like a first one: behind a stored slot — ⚠️ NEAR-MISS of the floor', async () => {
    const h = montar({ tentativa: 1 });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'));
    const armazenado = T0 + 30 * 60_000;
    h.db.seed(SLOT, { proximoSlotMs: armazenado });

    await h.rodar();

    expect(PISO).toBeLessThan(armazenado);
    expect(h.fila.enviadas.map((e) => e.scheduleTime.getTime())).toEqual([
      armazenado,
      armazenado + I,
    ]);
    expect(h.db.ler(SLOT)).toEqual({ proximoSlotMs: armazenado + 2 * I });
  });

  it('a fan-out past the first round of 20: EVERY send at its own reserved instant, in order, one interval apart — none reuses a first-round instant', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmFatias(h.db, [kitsQuePrecisam(45, 1, 'k')]);

    await h.rodar();

    expect(tarefasEnviadas(h.fila).map((t) => t.produtoId)).toEqual(
      Object.keys(kitsQuePrecisam(45, 1, 'k')),
    );
    const agendas = h.fila.enviadas.map((e) => e.scheduleTime.getTime());
    expect(agendas).toEqual(Array.from({ length: 45 }, (_, k) => PISO + k * I));
    expect(new Set(agendas).size).toBe(45);
    expect(h.db.ler(SLOT)).toEqual({ proximoSlotMs: PISO + 45 * I });
  });

  it('the clock is read AFTER the slot’s read — never before the reads', async () => {
    const eventos: string[] = [];
    let h: ReturnType<typeof montar> | null = null;
    h = montar({
      agora: () => {
        eventos.push(`relogio:${String(h?.db.leituras.length ?? -1)}`);
        return T0;
      },
    });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(1, 1, 'k'));
    await h.rodar();
    // The conta, header and record (3), then the slot (4): the clock first runs after all four.
    expect(eventos[0]).toBe('relogio:4');
  });
});

describe('the names: by THIS task’s window, so a retry re-meets its own sends', () => {
  it('every send is named for the payload’s window J, though the clock is several windows later', async () => {
    const h = montar();
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'));
    await h.rodar();
    for (const e of h.fila.enviadas) {
      const t = e.tarefa as TarefaEstoqueLi;
      expect(t.janela).toBe(J);
      expect(e.id).toBe(idDaTarefaEstoqueLi(t));
    }
    expect(J).toBeLessThan(janelaEstoqueLi(T0));
  });

  it('a RETRY in a later window creates ZERO new names; it reserves again BEHIND the first (the stated gap: instants of sends that exist, reserved and unused)', async () => {
    const fila = filaFake();
    const primeira = montar({ fila });
    seedConta(primeira.db);
    seedRegistro(primeira.db, 0);
    seedEmLinha(primeira.db, kitsQuePrecisam(4, 1, 'k'));
    await primeira.rodar();
    expect(fila.nomes.size).toBe(4);
    const slotDaPrimeira = primeira.db.ler(SLOT)?.proximoSlotMs;

    // The same task, retried 5 min later against the same Firestore.
    const t1 = T0 + 5 * 60_000;
    const retry = processarTarefaEstoqueKitsLi(asDb(primeira.db), kitsTarefa(), {
      ...primeira.deps,
      tentativa: 1,
      agoraMs: () => t1,
    });
    await expect(retry).resolves.toMatchObject({
      kind: 'enfileirado',
      contagens: { enfileirados: 4 },
    });
    expect(fila.nomes.size).toBe(4);
    expect(fila.enviadas).toHaveLength(4);
    // Behind the first reservation (or the retry's own floor, here later): 4 more instants, none
    // of them used (every send already existed) — latency for later bulk sends, never a second
    // send per interval.
    expect(primeira.db.ler(SLOT)?.proximoSlotMs).toBe(
      Math.max(Number(slotDaPrimeira), pisoDoSlotEstoqueLi(t1)) + 4 * I,
    );
  });

  it('⚠️ the cost is per FIRING: two fan-outs of consecutive sale-minutes below qMax each enqueue the WHOLE at-0 set again, under their own names', async () => {
    const fila = filaFake();
    const h = montar({ fila });
    seedConta(h.db);
    // Kits needing 5 and 10 of the component (both at 0 at 4 and at 3) and one needing 1.
    seedEmLinha(h.db, {
      ...kitsQuePrecisam(1, 5, 'cinco'),
      ...kitsQuePrecisam(1, 10, 'dez'),
      ...kitsQuePrecisam(1, 1, 'um'),
    });
    seedRegistro(h.db, 4);
    await h.rodar(kitsTarefa({ janela: J }));
    seedRegistro(h.db, 3);
    await h.rodar(kitsTarefa({ janela: J + 1 }));

    expect(tarefasEnviadas(fila).map((t) => [t.produtoId, t.janela])).toEqual([
      ['cinco-0000', J],
      ['dez-0000', J],
      ['cinco-0000', J + 1],
      ['dez-0000', J + 1],
    ]);
    expect(fila.nomes.size).toBe(4);
  });
});

describe('what a rejection means (the real producer, a fake queue)', () => {
  it('an answered already-exists is success — counted as enqueued', async () => {
    const fila = filaFake({ falhar: () => falhaDoFunctions('task-already-exists', 409) });
    const h = montar({ fila });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(2, 1, 'k'));
    expect(await h.rodar()).toMatchObject({ kind: 'enfileirado', contagens: { enfileirados: 2 } });
  });

  it('the sweep-only valve closed ⇒ ONE WARNING, tarefas-desligadas (the slot already moved), no throw', async () => {
    const h = montar({ desligado: true });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(25, 1, 'k'));
    const r = await h.rodar();
    expect(r).toMatchObject({ kind: 'tarefas-desligadas', contagens: { enfileirados: 0 } });
    expect(h.linhas.filter(([s]) => s === 'WARNING')).toHaveLength(1);
    expect(h.db.escritas).toHaveLength(1);
  });

  it('a send the strict schema refuses is COUNTED, named in ONE WARNING (field names only), and the rest of the batch goes on', async () => {
    // Defence in depth: the map and the task share their id schemas, so a real map never makes
    // the producer refuse a kit's payload — a producer double stands in for one that would.
    const lida = tarefaEstoqueLiSchema.safeParse({
      tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
      contaId: 'conta.li',
      produtoId: 'k-0001',
      origem: ORIGEM_TAREFA_ESTOQUE_LI.kit,
      janela: J,
      estoqueId: null,
      apagado: false,
      estoqueIds: null,
      geracao: 0,
    });
    if (lida.success) throw new Error('teste: o payload devia ser recusado');
    const fila = filaFake();
    const h = montar({ fila });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(3, 1, 'k'));
    const real = h.deps.agendador;

    const r = await processarTarefaEstoqueKitsLi(asDb(h.db), kitsTarefa(), {
      ...h.deps,
      agendador: {
        enfileirar: (t, o) =>
          t.tipo === TIPO_TAREFA_ESTOQUE_LI.estoque && t.produtoId === 'k-0001'
            ? Promise.reject(lida.error)
            : real.enfileirar(t, o),
      },
    });

    expect(r).toMatchObject({
      kind: 'enfileirado',
      contagens: { zerados: 3, enfileirados: 2, recusados: 1 },
    });
    expect(tarefasEnviadas(fila).map((t) => t.produtoId)).toEqual(['k-0000', 'k-0002']);
    expect(h.linhas).toEqual([
      [
        'WARNING',
        expect.any(String) as unknown as string,
        { contaId: CONTA, componenteId: C, recusados: 1, campos: ['contaId'] },
      ],
    ]);
  });

  it('a TRANSIENT Cloud Tasks failure on one kit ⇒ the rest of the batch still goes out, then ONE LiTarefasTransitoriasError', async () => {
    const fila = filaFake({
      falhar: (t) =>
        t.tipo === TIPO_TAREFA_ESTOQUE_LI.estoque && t.produtoId === 'k-0003'
          ? falhaDoFunctions('unknown-error', 503)
          : null,
    });
    const h = montar({ fila });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(30, 1, 'k'));
    await expect(h.rodar()).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
    expect(fila.enviadas).toHaveLength(29);
  });

  it('any other failure (a deploy-shaped refusal) is rethrown UNTOUCHED at the end of its round — later rounds are not attempted', async () => {
    const recusa = falhaDoFunctions('permission-denied', 403);
    const fila = filaFake({ falhar: () => recusa });
    const h = montar({ fila });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmLinha(h.db, kitsQuePrecisam(30, 1, 'k'));
    let tentadas = 0;
    const enqueue = fila.fila.enqueue.bind(fila.fila);
    fila.fila.enqueue = (t, o) => {
      tentadas += 1;
      return enqueue(t, o);
    };
    await expect(h.rodar()).rejects.toBe(recusa);
    expect(tentadas).toBe(CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI);
  });

  it(`at most ${String(CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI)} enqueues in flight at once`, async () => {
    const fila = filaFake();
    const h = montar({ fila });
    seedConta(h.db);
    seedRegistro(h.db, 0);
    seedEmFatias(h.db, [kitsQuePrecisam(45, 1, 'k')]);
    await h.rodar();
    expect(fila.enviadas).toHaveLength(45);
    expect(fila.maxEmVoo()).toBe(CONCORRENCIA_ENFILEIRAMENTO_LOTE_ESTOQUE_LI);
  });
});

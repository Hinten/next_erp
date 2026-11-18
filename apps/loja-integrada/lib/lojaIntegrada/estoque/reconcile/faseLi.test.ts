/**
 * `faseLi.ts` (master plan step 12, PR 12-g): the daily reconcile's STORE phase, one unit at a
 * time, against `testing/fakeDb.ts` and the stateful store (`testing/plataformaEscritaLi.ts`, its
 * paged stock list and its stock details) — the REAL context loader, page reader, detail reader,
 * diff, lookups and park. Every case pins its cost: store calls, credential reads, ERP reads.
 *
 * No call to the store: the global `fetch` is stubbed to throw in every test of this file, and
 * the platform is the only `fetch` a context gets.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { LiNotFoundError } from '@delfrance/integrations-loja-integrada';
import {
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  MAX_PAUSAS_429_LI,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../core/contaCache';
import { CHAMADAS_ENV_LI } from '../../core/valvulas';
import { FakeDb, asDb, type DocData, grpc, increment } from '../../testing/fakeDb';
import { caminhoCredencial, gravadorDeLog, seedCredencial } from '../../testing/fixtures';
import {
  CAMINHO_LISTA_ESTOQUE_LI,
  chamadaDaListaLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
  naProxima,
  respostaJson,
} from '../../testing/plataformaEscritaLi';
import {
  AGORA_RECONCILE_MS,
  INICIO_RUN_RECONCILE_MS,
  RUN_A,
  loggerGravador,
  refDeposito,
  seedContaComDeposito,
  seedLinkFilho,
  seedProduto,
  seedRegistro,
  seedRunNaFaseLi,
} from '../../testing/reconcileEstoqueLi';
import { LIMITE_PAGINA_ESTOQUE_ENV_LI } from '../configEstoqueLi';
import { CAMPOS_INDICE_VINCULO_LI, GRUPO_VINCULO_LI } from '../leituraEstoqueErp';
import { DELTA_SEM_LIMITE_LI } from '../planoEstoqueLi';
import { ListaCandidatosReconcileLi } from './candidatosReconcile';
import {
  FaseLiReconcileLi,
  LIMITE_CONSULTA_VINCULOS_RECONCILE_LI,
  MAX_CONFIRMACOES_RECONCILE_LI,
  type PassoFaseLi,
  limiteForaDoSnapshotLi,
} from './faseLi';
import type { OrcamentoReconcileLi } from './orcamentoReconcile';
import { type EstadoContaReconcileLi, carregarEstadosReconcileLi } from './snapshotReconcile';

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_RECONCILE_MS);
  vi.stubGlobal('fetch', () => {
    throw new Error('faseLi.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllGlobals();
});

const CONTA = 'C1';
const DEP = 'dep-1';
const CONTA_DA_FASE = { idx: 0, contaId: CONTA } as const;
const CREDENCIAL = caminhoCredencial(CONTA);

const v = (p: string, s: number): EntradaSnapshotEstoqueLi => ({
  p,
  s,
  f: FLAG_ENTRADA_ESTOQUE_LI.valido,
});
const flag = (p: string, f: 'r' | 'par' | 'amb' | 'dup' | 'ns'): EntradaSnapshotEstoqueLi => ({
  p,
  s: null,
  f,
});
const semVinculo: EntradaSnapshotEstoqueLi = {
  p: null,
  s: null,
  f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo,
};

/** A row of the store in step with S (managed, 0/−1, quantidade = S + max(0, R)). */
const emDia = (id: number, s: number, over: DocData = {}) =>
  linhaEstoqueLi(id, { quantidade: s, ...over });

interface OpcoesCenario {
  readonly entradas?: Readonly<Record<string, EntradaSnapshotEstoqueLi>>;
  readonly pais?: readonly string[];
  readonly linhas?: readonly DocData[];
  readonly raiz?: Readonly<DocData>;
  readonly run?: Readonly<DocData>;
  readonly credencial?: Readonly<DocData>;
}

/** One conta at the store phase, its snapshot seeded, and the store. */
function cenario(o: OpcoesCenario = {}) {
  // The conta reader is a module-scope cache keyed by path: a second scenario in one test must
  // not read the first one's conta.
  __resetAllReadCaches();
  const db = new FakeDb();
  seedContaComDeposito(db, CONTA, refDeposito(DEP));
  seedCredencial(db, CONTA, o.credencial ?? {});
  seedRunNaFaseLi(
    db,
    [
      {
        contaId: CONTA,
        depositoId: DEP,
        entradas: o.entradas ?? {},
        pais: o.pais ?? [],
        raiz: o.raiz ?? {},
      },
    ],
    o.run ?? {},
  );
  const p = criarPlataformaEscritaLi({ estoque: o.linhas ?? [] });
  return { db, p };
}

interface OpcoesFase {
  readonly ambiente?: Readonly<Record<string, string | undefined>>;
  readonly tentativa?: number;
  readonly teto?: number;
  readonly orcamento?: OrcamentoReconcileLi;
  readonly contadores?: Record<string, number>;
  readonly orcamentoBytes?: number;
}

const SEMPRE: OrcamentoReconcileLi = { inicioMs: 0, cabe: () => true };

/** The store phase of one slice over `db`, recording everything. */
function montar(db: FakeDb, p: ReturnType<typeof criarPlataformaEscritaLi>, o: OpcoesFase = {}) {
  const contadores: Record<string, number> = { ...(o.contadores ?? {}) };
  const candidatos = new ListaCandidatosReconcileLi([], o.orcamentoBytes);
  const estados = new Map<string, EstadoContaReconcileLi>();
  const log = loggerGravador();
  const sink = gravadorDeLog();
  const fase = new FaseLiReconcileLi({
    db: asDb(db),
    deps: {
      ambiente: o.ambiente ?? {
        [CHAMADAS_ENV_LI]: 'on',
        [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '2',
      },
      agoraMs: () => AGORA_RECONCILE_MS,
      esperar: p.esperar,
      increment,
      tentativa: o.tentativa ?? 0,
      idTarefa: 'tarefa-1',
      logger: log.logger,
      fetch: p.fetch,
      escrever: sink.escrever,
    },
    execucaoId: RUN_A,
    runIniciadoEmMs: INICIO_RUN_RECONCILE_MS,
    teto: o.teto ?? Number.POSITIVE_INFINITY,
    orcamento: o.orcamento ?? SEMPRE,
    candidatos,
    contar: (nome, n = 1) => {
      contadores[nome] = (contadores[nome] ?? 0) + n;
    },
    contador: (nome) => contadores[nome] ?? 0,
    estadoDe: async (conta) => {
      const pronto = estados.get(conta.contaId);
      if (pronto !== undefined) return pronto;
      const lidos = await carregarEstadosReconcileLi(asDb(db), RUN_A, [conta.contaId], conta.idx);
      const lido = lidos?.get(conta.contaId) ?? null;
      if (lido !== null) estados.set(conta.contaId, lido);
      return lido;
    },
  });
  /** Units until one that is not `unidade` (the conta's end, a pause, a failure…). */
  const correr = async (): Promise<PassoFaseLi[]> => {
    const passos: PassoFaseLi[] = [];
    for (let n = 0; n < 1_000; n += 1) {
      const passo = await fase.unidade(CONTA_DA_FASE);
      passos.push(passo);
      if (passo.tipo !== 'unidade') return passos;
    }
    throw new Error('a fase não terminou');
  };
  const estado = (): EstadoContaReconcileLi => {
    const e = estados.get(CONTA);
    if (e === undefined) throw new Error('estado não carregado');
    return e;
  };
  const doConta = (nome: string): number =>
    contadores[`c0${nome.charAt(0).toUpperCase()}${nome.slice(1)}`] ?? 0;
  return { fase, contadores, candidatos, estados, log, sink, correr, estado, doConta };
}

/** The store's list calls, in order, with their query. */
const listas = (p: ReturnType<typeof criarPlataformaEscritaLi>) =>
  p.chamadasComBusca().filter((c) => c.startsWith(`GET ${CAMINHO_LISTA_ESTOQUE_LI}?`));
const detalhes = (p: ReturnType<typeof criarPlataformaEscritaLi>) =>
  p.chamadas().filter((c) => c.startsWith(`GET ${CAMINHO_LISTA_ESTOQUE_LI}/`));
const leiturasDaCredencial = (db: FakeDb) => db.leituras.filter((l) => l === CREDENCIAL).length;

/* -------------------------------------------------------------------------- */
/*                               The list walk                                 */
/* -------------------------------------------------------------------------- */

describe('the list walk, one page per call, through the context', () => {
  it('three pages (L = 2, five rows) all in step: exactly 3 list calls, 1 + 3 credential reads, one pacer wait each, the list complete', async () => {
    const { db, p } = cenario({
      entradas: { '101': v('a', 1), '102': v('b', 2), '103': v('c', 3), '104': v('d', 4) },
      pais: ['900'],
      linhas: [emDia(101, 1), emDia(102, 2), emDia(103, 3), emDia(104, 4), emDia(900, 0)],
    });
    const m = montar(db, p);
    const passos = await m.correr();
    expect(passos.map((x) => x.tipo)).toEqual(['unidade', 'unidade', 'unidade', 'conta-encerrada']);
    expect(listas(p)).toEqual([
      chamadaDaListaLi(0, 2),
      chamadaDaListaLi(2, 2),
      chamadaDaListaLi(4, 2),
    ]);
    expect(detalhes(p)).toEqual([]);
    expect(leiturasDaCredencial(db)).toBe(1 + 3);
    expect(p.esperas).toEqual([2_000, 2_000, 2_000]);
    expect(m.fase.chamadas).toBe(3);
    expect(m.candidatos.lista()).toEqual([]);
    expect(m.contadores).toMatchObject({
      c0Paginas: 3,
      c0Linhas: 5,
      c0EmDia: 4,
      c0LinhasPai: 1,
      c0ListaCompleta: 1,
      c0VerificacaoFeita: 1,
    });
    // No ERP produto or stock read, and no lookup: every row had an entry or was a parent.
    expect(db.consultas).toEqual([]);
    expect(db.leituras.filter((l) => l.startsWith('produtos/'))).toEqual([]);
    // The parent is never recorded as seen; every other row is.
    expect([...['101', '102', '103', '104', '900']].map((id) => m.estado().visto(id))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // The cursor stayed on the last page's offset, with the run's page size.
    expect(m.estado().cursor()).toEqual({
      offset: 4,
      limite: 2,
      iniciadoEmMs: AGORA_RECONCILE_MS,
    });
  });

  it('⚠️ the read switch off: the conta is skipped with ZERO calls and ZERO Firestore reads', async () => {
    const { db, p } = cenario({ linhas: [emDia(101, 1)] });
    const m = montar(db, p, { ambiente: { [CHAMADAS_ENV_LI]: 'off' } });
    expect(await m.correr()).toEqual([{ tipo: 'conta-encerrada' }]);
    expect(p.requisicoes).toEqual([]);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(m.contadores).toEqual({ c0ChamadasDesligadas: 1 });
    // The context's own line, and no WARNING of the phase's.
    expect(m.sink.linhas.map((l) => l.campos.evento)).toEqual(['chamada-bloqueada']);
    expect(m.log.linhas).toEqual([]);
    // NEAR-MISS: `ON` is not `on`.
    const outro = cenario({ linhas: [emDia(101, 1)] });
    const m2 = montar(outro.db, outro.p, { ambiente: { [CHAMADAS_ENV_LI]: 'ON' } });
    expect(await m2.correr()).toEqual([{ tipo: 'conta-encerrada' }]);
    expect(outro.p.requisicoes).toEqual([]);
  });

  it('a parked, an inactive and a gone conta are skipped (counted, one WARNING), with zero calls', async () => {
    const parada = cenario({
      credencial: {
        reconexaoPendente: { desdeMs: AGORA_RECONCILE_MS, status: 401, refCredencial: 'a.1' },
      },
    });
    const m1 = montar(parada.db, parada.p);
    expect(await m1.correr()).toEqual([{ tipo: 'conta-encerrada' }]);
    expect(m1.contadores).toEqual({ c0ContaParada: 1 });
    expect(m1.log.linhas.map((l) => [l.nivel, l.meta.motivo])).toEqual([['warn', 'contaParada']]);

    const inativa = cenario();
    seedContaComDeposito(inativa.db, CONTA, refDeposito(DEP), { ativo: false });
    const m2 = montar(inativa.db, inativa.p);
    await m2.correr();
    expect(m2.contadores).toEqual({ c0ContaInativa: 1 });

    const sem = cenario();
    sem.db.seed('integracao/C1', { tipo: 1, nome: 'outra', ativo: true });
    const m3 = montar(sem.db, sem.p);
    await m3.correr();
    expect(m3.contadores).toEqual({ c0ContaAusente: 1 });
    for (const x of [parada, inativa, sem]) expect(x.p.requisicoes).toEqual([]);
  });

  it('a page whose rows are ALL unreadable moves on to the next page; their ids are seen, nothing is diffed or looked up', async () => {
    const { db, p } = cenario({
      entradas: { '101': v('a', 1), '102': v('b', 2), '103': v('c', 3) },
      linhas: [
        linhaEstoqueLi(101, { gerenciado: 'sim' }),
        linhaEstoqueLi(102, { quantidade: 1.5 }),
        emDia(103, 3),
      ],
    });
    const m = montar(db, p);
    await m.correr();
    expect(listas(p)).toEqual([chamadaDaListaLi(0, 2), chamadaDaListaLi(2, 2)]);
    expect(m.contadores).toMatchObject({ c0Ilegiveis: 2, c0Linhas: 1, c0EmDia: 1 });
    // ⚠️ Never "no row in the store": the unseen check finds nothing to confirm.
    expect(detalhes(p)).toEqual([]);
    expect(m.doConta('semLinhaNaLoja')).toBe(0);
    expect(m.candidatos.lista()).toEqual([]);
    expect(db.consultas).toEqual([]);
    // One WARNING with the counts at the conta's end.
    expect(m.log.linhas.filter((l) => l.nivel === 'warn').map((l) => l.meta.ilegiveis)).toEqual([
      2,
    ]);
  });

  it('⚠️ NEAR-MISS: a row that reads but names no product (`/api/v1/produto/0123`) is unattributable — no confirmation and no sweep this run; `/api/v1/produto/123` is diffed', async () => {
    const { db, p } = cenario({
      entradas: { '123': v('a', 9), '301': v('b', 1), '777': semVinculo },
      linhas: [emDia(123, 1)],
    });
    p.inserirNaListaLi(1, { ...emDia(124, 1), produto: '/api/v1/produto/0123' });
    const m = montar(db, p);
    expect((await m.correr()).at(-1)).toEqual({ tipo: 'conta-encerrada' });
    // 123 diffed (S 9, store 1) ⇒ a candidate; the odd row counted, never diffed.
    expect(m.candidatos.lista()).toEqual([{ c: 0, i: '123', p: 'a', d: -8 }]);
    expect(m.contadores).toMatchObject({
      c0IlegiveisSemProduto: 1,
      c0Linhas: 1,
      c0VerificacaoIgnorada: 1,
    });
    // 301 unseen and 777 an unseen `x`: neither confirmed nor swept.
    expect(detalhes(p)).toEqual([]);
    expect(m.estado().entrada('777')).toEqual(semVinculo);
    expect(m.log.linhas.filter((l) => l.nivel === 'warn')).toHaveLength(1);
  });

  it('an unreadable row WITHOUT a produto skips the unseen check and the x sweep (0 detail GETs, one WARNING)', async () => {
    const { db, p } = cenario({
      entradas: { '301': v('b', 1), '777': semVinculo },
      linhas: [emDia(500, 0)],
    });
    p.estado.lista.push({ gerenciado: true });
    const m = montar(db, p);
    await m.correr();
    expect(detalhes(p)).toEqual([]);
    expect(m.doConta('ilegiveisSemProduto')).toBe(1);
    expect(m.doConta('semVinculoRemovidos')).toBe(0);
    expect(m.estado().entrada('777')).toEqual(semVinculo);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The diff                                    */
/* -------------------------------------------------------------------------- */

describe('one row against its entry — the plan’s one rule, the cap applied here', () => {
  it('in step (managed, 0/−1, quantidade − max(0, R) = min(S, cap)) ⇒ nothing; EQUAL with a reservation and with a negative one', async () => {
    const { db, p } = cenario({
      entradas: { '101': v('a', 5), '102': v('b', 5), '103': v('c', 5) },
      linhas: [
        emDia(101, 5),
        linhaEstoqueLi(102, { quantidade: 7, quantidade_reservada: 2 }),
        linhaEstoqueLi(103, { quantidade: 5, quantidade_reservada: -3 }),
      ],
    });
    const m = montar(db, p);
    await m.correr();
    expect(m.candidatos.lista()).toEqual([]);
    expect(m.doConta('emDia')).toBe(3);
  });

  it.each([
    ['gerenciado false', { gerenciado: false, quantidade: 5 }, DELTA_SEM_LIMITE_LI],
    ['situacao_em_estoque 1', { situacao_em_estoque: 1, quantidade: 5 }, 0],
    [
      'situacao_sem_estoque 0 (still sold at zero)',
      { situacao_sem_estoque: 0, quantidade: 5 },
      DELTA_SEM_LIMITE_LI,
    ],
    ['quantidade one above', { quantidade: 6 }, 1],
    ['quantidade one below', { quantidade: 4 }, -1],
    ['a negative row', { quantidade: -2 }, -7],
    [
      'a reservation not counted (R 2, quantidade 5)',
      { quantidade: 5, quantidade_reservada: 2 },
      -2,
    ],
  ])('⚠️ NEAR-MISS — %s ⇒ ONE candidate, d %d, and one INFO diff line', async (_nome, over, d) => {
    const { db, p } = cenario({
      entradas: { '101': v('a', 5) },
      linhas: [linhaEstoqueLi(101, over)],
    });
    const m = montar(db, p);
    await m.correr();
    expect(m.candidatos.lista()).toEqual([{ c: 0, i: '101', p: 'a', d }]);
    const linhas = m.log.linhas.filter((l) => l.msg.includes('diferença'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({
      execucaoId: RUN_A,
      contaId: CONTA,
      idLi: '101',
      produtoId: 'a',
      S: 5,
      d,
      descartado: false,
    });
  });

  it('a held, parity, ambiguous, duplicate, unsupported or unlinked entry is NEVER a candidate, however far off its row is; a parent’s row is not even diffed', async () => {
    const { db, p } = cenario({
      entradas: {
        '201': flag('a', 'r'),
        '202': flag('b', 'par'),
        '203': flag('c', 'amb'),
        '204': flag('d', 'dup'),
        '205': flag('e', 'ns'),
        '206': semVinculo,
      },
      pais: ['207'],
      linhas: [201, 202, 203, 204, 205, 206, 207].map((id) =>
        linhaEstoqueLi(id, { gerenciado: false, quantidade: 99 }),
      ),
    });
    const m = montar(db, p);
    await m.correr();
    expect(m.candidatos.lista()).toEqual([]);
    expect(m.contadores).toMatchObject({
      c0LinhasRetidas: 1,
      c0LinhasParidade: 1,
      c0LinhasAmbiguas: 1,
      c0LinhasDuplicadas: 1,
      c0LinhasNaoSuportadas: 1,
      c0LinhasSemVinculo: 1,
      c0LinhasPai: 1,
    });
    expect(db.consultas).toEqual([]);
  });

  it('⚠️ the cap is applied at diff time: a cap change moves a verdict with ZERO ERP reads', async () => {
    const semTeto = cenario({ entradas: { '101': v('a', 50) }, linhas: [emDia(101, 50)] });
    const m1 = montar(semTeto.db, semTeto.p);
    await m1.correr();
    expect(m1.candidatos.lista()).toEqual([]);

    const comTeto = cenario({ entradas: { '101': v('a', 50) }, linhas: [emDia(101, 50)] });
    const m2 = montar(comTeto.db, comTeto.p, { teto: 10 });
    await m2.correr();
    expect(m2.candidatos.lista()).toEqual([{ c: 0, i: '101', p: 'a', d: 40 }]);
    expect(m2.log.linhas.find((l) => l.msg.includes('diferença'))?.meta.S).toBe(10);
    expect(comTeto.db.consultas).toEqual([]);
    expect(comTeto.db.leituras.filter((l) => l.startsWith('produtos/'))).toEqual([]);
  });

  it('a row read twice (a shift across a page boundary) is ONE candidate, the newer reading', async () => {
    const { db, p } = cenario({
      entradas: { '100': v('z', 0), '101': v('a', 5), '102': v('b', 5), '103': v('c', 5) },
      linhas: [emDia(101, 5), linhaEstoqueLi(102, { quantidade: 1 }), emDia(103, 5)],
    });
    // Before page 2 is read, 102 changes and a product is created at the front: 102 shifts into
    // page 2 and is read again.
    let inserida = false;
    p.fila.push((r) => {
      if (!inserida && r.busca.includes('offset=2')) {
        inserida = true;
        const linha = p.estado.estoque.get(102);
        if (linha !== undefined) linha.quantidade = 2;
        p.inserirNaListaLi(0, emDia(100, 0));
      }
      return null;
    });
    const m = montar(db, p);
    await m.correr();
    expect(listas(p)).toEqual([chamadaDaListaLi(0, 2), chamadaDaListaLi(2, 2)]);
    expect(m.candidatos.lista()).toEqual([{ c: 0, i: '102', p: 'b', d: -3 }]);
    // Two INFO lines — one per reading — and one candidate.
    expect(m.log.linhas.filter((l) => l.msg.includes('diferença'))).toHaveLength(2);
    // 100 was never read in the list: its one GET finds it.
    expect(detalhes(p)).toEqual([`GET ${CAMINHO_LISTA_ESTOQUE_LI}/100`]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                The lookups                                  */
/* -------------------------------------------------------------------------- */

describe('a row no entry names is looked up — by its number AND its decimal text', () => {
  /** Two linked produtos (a number id, a text id), one orphan and one trashed link. */
  function comDesconhecidas() {
    const c = cenario({
      linhas: [emDia(201, 4), emDia(202, 3), emDia(203, 0), emDia(204, 0)],
    });
    seedProduto(c.db, 'pn');
    seedLinkFilho(c.db, 'pn', 'l1', CONTA, 201);
    seedRegistro(c.db, 'pn', DEP, 4);
    seedProduto(c.db, 'pt');
    seedLinkFilho(c.db, 'pt', 'l1', CONTA, '202', { contaLojaIntegrada: `integracao/${CONTA}` });
    seedRegistro(c.db, 'pt', DEP, 8);
    seedProduto(c.db, 'lixo');
    seedLinkFilho(c.db, 'lixo', 'l1', CONTA, 204, { removido: true });
    return c;
  }

  it('one query per stored form of the conta ref, `id in [n, "n", …]`; found ⇒ evaluated and diffed; none ⇒ `x`', async () => {
    const { db, p } = comDesconhecidas();
    const m = montar(db, p, {
      ambiente: { [CHAMADAS_ENV_LI]: 'on', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '4' },
    });
    await m.correr();
    const consultas = db.consultas.filter(
      (q) => q.colecao === GRUPO_VINCULO_LI && q.grupo === true,
    );
    expect(consultas.map((q) => q.filtros)).toEqual([
      [
        [CAMPOS_INDICE_VINCULO_LI[0], '==', `documents/integracao/${CONTA}`],
        [CAMPOS_INDICE_VINCULO_LI[1], 'in', [201, '201', 202, '202', 203, '203', 204, '204']],
      ],
      [
        [CAMPOS_INDICE_VINCULO_LI[0], '==', `integracao/${CONTA}`],
        [CAMPOS_INDICE_VINCULO_LI[1], 'in', [201, '201', 202, '202', 203, '203', 204, '204']],
      ],
    ]);
    expect(consultas.every((q) => q.limite === LIMITE_CONSULTA_VINCULOS_RECONCILE_LI)).toBe(true);
    const e = m.estado();
    expect(e.entrada('201')).toEqual({ p: 'pn', s: 4, f: 'v' });
    expect(e.entrada('202')).toEqual({ p: 'pt', s: 8, f: 'v' });
    // The orphan and the trashed link (it does not count) are cached as `x`.
    expect(e.entrada('203')).toEqual(semVinculo);
    expect(e.entrada('204')).toEqual(semVinculo);
    // 202 is out of step (store 3, S 8): a candidate; 201 is in step.
    expect(m.candidatos.lista()).toEqual([{ c: 0, i: '202', p: 'pt', d: -5 }]);
    expect(m.contadores).toMatchObject({
      c0ConsultasVinculo: 2,
      c0VinculosForaDoSnapshot: 2,
      c0SemVinculoNovos: 2,
      c0EmDia: 1,
    });
  });

  it('⚠️ the steady state: a row whose `x` was carried makes ZERO lookups', async () => {
    const { db, p } = cenario({
      entradas: { '203': semVinculo, '204': semVinculo },
      linhas: [emDia(203, 0), emDia(204, 0)],
    });
    const m = montar(db, p);
    await m.correr();
    expect(db.consultas).toEqual([]);
    expect(m.contadores).toMatchObject({ c0LinhasSemVinculo: 2 });
    expect(m.doConta('semVinculoRemovidos')).toBe(0);
  });

  it('20 unknown ids on one page ⇒ 2 forms × 2 chunks = 4 queries: 15 ids (30 values), then 5 (10 values)', async () => {
    const ids = Array.from({ length: 20 }, (_, n) => 1_000 + n);
    const { db, p } = cenario({ linhas: ids.map((id) => emDia(id, 0)) });
    const m = montar(db, p, {
      ambiente: { [CHAMADAS_ENV_LI]: 'on', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '20' },
    });
    await m.correr();
    const consultas = db.consultas.filter((q) => q.colecao === GRUPO_VINCULO_LI);
    expect(consultas).toHaveLength(4);
    expect(consultas.map((q) => (q.filtros[1]?.[2] as unknown[]).length)).toEqual([30, 30, 10, 10]);
    expect(m.doConta('semVinculoNovos')).toBe(20);
  });

  it('⚠️ a lookup finding counting links on TWO produtos for one id ⇒ dup, never a candidate, both sampled', async () => {
    const { db, p } = cenario({ linhas: [linhaEstoqueLi(301, { quantidade: 50 })] });
    for (const produto of ['d1', 'd2']) {
      seedProduto(db, produto);
      seedLinkFilho(db, produto, 'l1', CONTA, 301);
      seedRegistro(db, produto, DEP, 1);
    }
    const m = montar(db, p);
    await m.correr();
    expect(m.estado().entrada('301')).toEqual({ p: 'd1', s: null, f: 'dup' });
    expect(m.candidatos.lista()).toEqual([]);
    expect(m.estado().raiz.execucao.amostras.duplicado).toEqual(['d1', 'd2']);
  });

  it('a store kit found by a lookup gets its entry, but joins the kits map only at the next walk (counted)', async () => {
    const { db, p } = cenario({ linhas: [linhaEstoqueLi(401, { quantidade: 0 })] });
    seedProduto(db, 'kit', {
      ehKit: true,
      componentesKit: { comp: { quantidade: 1, limitarEstoque: true, timestamp: null } },
    });
    seedLinkFilho(db, 'kit', 'l1', CONTA, 401);
    seedRegistro(db, 'comp', DEP, 3);
    const m = montar(db, p);
    await m.correr();
    expect(m.estado().entrada('401')).toMatchObject({ p: 'kit', s: 3, f: 'v', k: true });
    expect(m.doConta('kitsForaDoMapa')).toBe(1);
    expect(m.candidatos.lista()).toEqual([{ c: 0, i: '401', p: 'kit', d: -3 }]);
    expect(db.idsEm(`sincEstoqueLojaIntegrada/${CONTA}/kits`)).toEqual([]);
  });

  it('a query that comes back FULL concludes nothing about its ids: no `x`', async () => {
    const { db, p } = cenario({ linhas: [emDia(501, 0)] });
    for (let n = 0; n < LIMITE_CONSULTA_VINCULOS_RECONCILE_LI; n += 1) {
      seedLinkFilho(db, `t${String(n)}`, 'l1', CONTA, 501, { removido: true });
    }
    const m = montar(db, p);
    await m.correr();
    expect(m.estado().entrada('501')).toBeUndefined();
    expect(m.doConta('consultasInconclusivas')).toBe(1);
  });

  describe('⚠️ the anomaly bound: a snapshot that misses linked children blocks the conta', () => {
    it('the bound: max(50, 2% of the rows read)', () => {
      expect(limiteForaDoSnapshotLi(0)).toBe(50);
      expect(limiteForaDoSnapshotLi(2_549)).toBe(50);
      expect(limiteForaDoSnapshotLi(2_550)).toBe(51);
      expect(limiteForaDoSnapshotLi(8_000)).toBe(160);
    });

    async function comEncontrados(n: number) {
      const ids = Array.from({ length: n }, (_, k) => 2_000 + k);
      const { db, p } = cenario({ linhas: ids.map((id) => emDia(id, 0)) });
      for (const id of ids) seedLinkFilho(db, `q${String(id)}`, 'l1', CONTA, id);
      const m = montar(db, p, {
        ambiente: { [CHAMADAS_ENV_LI]: 'on', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '100' },
      });
      await m.correr();
      return { db, m };
    }

    it('50 counting links found pass: every one evaluated', async () => {
      const { m } = await comEncontrados(50);
      expect(m.doConta('bloqueioForaDoSnapshot')).toBe(0);
      expect(m.doConta('vinculosForaDoSnapshot')).toBe(50);
      expect(m.log.linhas.filter((l) => l.nivel === 'error')).toEqual([]);
    });

    it('⚠️ NEAR-MISS: 51 trip it — BLOCKED, ONE ERROR, nothing evaluated, no `x` written', async () => {
      const { db, m } = await comEncontrados(51);
      expect(m.doConta('bloqueioForaDoSnapshot')).toBe(1);
      expect(m.doConta('consultasNaoAvaliadas')).toBe(51);
      expect(m.doConta('semVinculoNovos')).toBe(0);
      expect(m.estado().entrada('2000')).toBeUndefined();
      expect(m.log.linhas.filter((l) => l.nivel === 'error').map((l) => l.meta.motivo)).toEqual([
        'fora-do-snapshot',
      ]);
      // No produto of the found links was read.
      expect(db.leituras.filter((l) => l.startsWith('produtos/'))).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                     The unseen linked children, and the sweep               */
/* -------------------------------------------------------------------------- */

describe('a linked child the walk never saw is UNKNOWN: ONE detail GET each', () => {
  it('404 ⇒ "no row in the store" (counted, sampled); a row of that product ⇒ diffed, not reported; an unseen `x` is swept', async () => {
    const { db, p } = cenario({
      entradas: {
        '301': v('apagado', 1),
        '302': v('mudou', 6),
        '303': v('lido', 1),
        '304': semVinculo,
        '305': semVinculo,
      },
      linhas: [emDia(302, 2), emDia(303, 1), emDia(305, 0)],
    });
    // 302 answers its detail, but the list never shows it (it moved while the list was read).
    p.estado.lista = p.estado.lista.filter((l) => l.produto !== '/api/v1/produto/302');
    const m = montar(db, p);
    await m.correr();
    expect(detalhes(p)).toEqual([
      `GET ${CAMINHO_LISTA_ESTOQUE_LI}/301`,
      `GET ${CAMINHO_LISTA_ESTOQUE_LI}/302`,
    ]);
    expect(m.contadores).toMatchObject({
      c0Confirmacoes: 2,
      c0SemLinhaNaLoja: 1,
      c0ConfirmadosNaLoja: 1,
      c0SemVinculoRemovidos: 1,
      c0VerificacaoFeita: 1,
    });
    expect(m.estado().raiz.execucao.amostras['sem-linha-na-loja']).toEqual(['apagado']);
    // 302's row was diffed like a list row (store 2, S 6).
    expect(m.candidatos.lista()).toEqual([{ c: 0, i: '302', p: 'mudou', d: -4 }]);
    expect(m.estado().entrada('304')).toBeUndefined();
    expect(m.estado().entrada('305')).toEqual(semVinculo);
    // Both settled: a resumed slice never asks twice.
    expect(m.estado().visto('301')).toBe(true);
    expect(m.estado().visto('302')).toBe(true);
  });

  it('⚠️ a row shifted across a page boundary while the list was read is NOT reported: its one GET finds it', async () => {
    const { db, p } = cenario({
      entradas: { '101': v('a', 1), '102': v('b', 1), '103': v('c', 1), '104': v('d', 1) },
      linhas: [emDia(101, 1), emDia(102, 1), emDia(103, 1), emDia(104, 1)],
    });
    // After page 1 (101, 102), the store DELETES 101: 103 shifts into page 1 and is never read.
    let removida = false;
    p.fila.push((r) => {
      if (!removida && r.busca.includes('offset=2')) {
        removida = true;
        p.removerDaLojaLi(101);
      }
      return null;
    });
    const m = montar(db, p);
    await m.correr();
    expect(listas(p)).toEqual([chamadaDaListaLi(0, 2), chamadaDaListaLi(2, 2)]);
    expect(detalhes(p)).toEqual([`GET ${CAMINHO_LISTA_ESTOQUE_LI}/103`]);
    expect(m.doConta('semLinhaNaLoja')).toBe(0);
    expect(m.doConta('confirmadosNaLoja')).toBe(1);
  });

  it('a 200 naming ANOTHER product settles the id unread: neither reported nor diffed', async () => {
    const { db, p } = cenario({ entradas: { '301': v('a', 1) }, linhas: [] });
    p.fila.push(
      naProxima(`${CAMINHO_LISTA_ESTOQUE_LI}/301`, 'GET', () => respostaJson(200, emDia(999, 0))),
    );
    const m = montar(db, p);
    await m.correr();
    expect(m.contadores).toMatchObject({ c0ConfirmacoesDivergentes: 1, c0VerificacaoFeita: 1 });
    expect(m.doConta('semLinhaNaLoja')).toBe(0);
    expect(m.candidatos.lista()).toEqual([]);
  });

  it(`at most ${String(MAX_CONFIRMACOES_RECONCILE_LI)} confirmations per conta; the rest counted naoConfirmados, never reported`, async () => {
    const entradas: Record<string, EntradaSnapshotEstoqueLi> = {};
    for (let n = 0; n < MAX_CONFIRMACOES_RECONCILE_LI + 1; n += 1) {
      entradas[String(10_000 + n)] = v(`p${String(n)}`, 0);
    }
    const { db, p } = cenario({ entradas, linhas: [] });
    const m = montar(db, p);
    await m.correr();
    expect(detalhes(p)).toHaveLength(MAX_CONFIRMACOES_RECONCILE_LI);
    expect(m.contadores).toMatchObject({
      c0Confirmacoes: MAX_CONFIRMACOES_RECONCILE_LI,
      c0SemLinhaNaLoja: MAX_CONFIRMACOES_RECONCILE_LI,
      c0NaoConfirmados: 1,
    });
    expect(m.doConta('verificacaoFeita')).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                The failures                                 */
/* -------------------------------------------------------------------------- */

describe('the failures, each narrowed to its class', () => {
  const doisNaLista = () =>
    cenario({
      entradas: { '101': v('a', 1), '102': v('b', 1) },
      linhas: [emDia(101, 1), emDia(102, 1)],
    });

  it('a 429 PAUSES: the page is not kept, the cursor does not move, one pause counted', async () => {
    const { db, p } = doisNaLista();
    p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', () => respostaJson(429, {})));
    const m = montar(db, p);
    expect(await m.correr()).toEqual([{ tipo: 'pausa' }]);
    expect(m.contadores).toEqual({ c0Pausas429: 1 });
    expect(m.estado().cursor()?.offset).toBe(0);
  });

  it(`⚠️ with ${String(MAX_PAUSAS_429_LI)} pauses taken a 429 skips the conta (one WARNING) instead`, async () => {
    const { db, p } = doisNaLista();
    p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', () => respostaJson(429, {})));
    const m = montar(db, p, { contadores: { c0Pausas429: MAX_PAUSAS_429_LI } });
    expect(await m.correr()).toEqual([{ tipo: 'conta-encerrada' }]);
    expect(m.contadores).toEqual({ c0Pausas429: MAX_PAUSAS_429_LI, c0LimiteDeChamadas: 1 });
    expect(m.log.linhas.map((l) => [l.nivel, l.meta.motivo])).toEqual([
      ['warn', 'limite-de-chamadas'],
    ]);
  });

  it('a 401 PARKS the conta (the shared mapper) and skips it; a 403 parks like a 401', async () => {
    for (const status of [401, 403]) {
      const { db, p } = doisNaLista();
      p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', () => respostaJson(status, {})));
      const m = montar(db, p);
      expect(await m.correr()).toEqual([{ tipo: 'conta-encerrada' }]);
      expect(db.ler(CREDENCIAL)?.reconexaoPendente).toMatchObject({ status });
      expect(m.contadores).toEqual({ c0ContaParada: 1 });
      expect(listas(p)).toHaveLength(1);
    }
  });

  it('another flow parks the conta mid-walk: the next request is refused at the credential, the conta skipped', async () => {
    const { db, p } = cenario({
      entradas: { '101': v('a', 1), '102': v('b', 1), '103': v('c', 1) },
      linhas: [emDia(101, 1), emDia(102, 1), emDia(103, 1)],
    });
    const m = montar(db, p);
    expect(await m.fase.unidade(CONTA_DA_FASE)).toEqual({ tipo: 'unidade' });
    seedCredencial(db, CONTA, {
      reconexaoPendente: { desdeMs: AGORA_RECONCILE_MS, status: 401, refCredencial: 'a.1' },
    });
    expect(await m.fase.unidade(CONTA_DA_FASE)).toEqual({ tipo: 'conta-encerrada' });
    expect(listas(p)).toHaveLength(1);
    expect(m.doConta('contaParada')).toBe(1);
  });

  it.each([
    ['a 503', () => respostaJson(503, {})],
    ['a malformed envelope', () => respostaJson(200, { objects: 'x' })],
  ])(
    '%s is RETRIED: a `falha` carrying the original error, before the last attempt',
    async (_n, resposta) => {
      const { db, p } = doisNaLista();
      p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', resposta));
      const m = montar(db, p);
      const [passo] = await m.correr();
      expect(passo?.tipo).toBe('falha');
      expect(m.contadores).toEqual({});
    },
  );

  it(`⚠️ on the queue's LAST attempt the same failure ENDS the conta (one ERROR, counted) and the chain goes on`, async () => {
    const { db, p } = doisNaLista();
    p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', () => respostaJson(503, {})));
    const m = montar(db, p, { tentativa: TASK_MAX_ATTEMPTS - 1 });
    expect(await m.correr()).toEqual([{ tipo: 'conta-encerrada' }]);
    expect(m.contadores).toEqual({ c0TentativasEsgotadas: 1 });
    expect(m.log.linhas.map((l) => [l.nivel, l.meta.motivo, l.meta.classe])).toEqual([
      ['error', 'tentativas-esgotadas', 'LiHttpError'],
    ]);
  });

  it('⚠️ NEAR-MISS: a detail GET answered 503 is RETRIED — never read as "no row in the store"', async () => {
    const { db, p } = cenario({ entradas: { '301': v('a', 1) }, linhas: [] });
    p.fila.push(naProxima(`${CAMINHO_LISTA_ESTOQUE_LI}/301`, 'GET', () => respostaJson(503, {})));
    const m = montar(db, p);
    const passos = await m.correr();
    expect(passos.at(-1)?.tipo).toBe('falha');
    expect(m.doConta('semLinhaNaLoja')).toBe(0);
    expect(m.estado().visto('301')).toBe(false);
  });

  it('a lookup’s Firestore failure is retried like the store’s', async () => {
    const { db, p } = cenario({ linhas: [emDia(201, 0)] });
    db.falharConsulta(GRUPO_VINCULO_LI, grpc(14, 'UNAVAILABLE'));
    const m = montar(db, p);
    const [passo] = await m.correr();
    expect(passo).toMatchObject({ tipo: 'falha', erro: { code: 14 } });
    // The page was not kept.
    expect(m.contadores).toEqual({});
  });

  it('⚠️ NEAR-MISS: a 404 on the LIST is not the store’s answer to give — rethrown, loud, on every attempt', async () => {
    const { db, p } = doisNaLista();
    p.fila.push(naProxima(CAMINHO_LISTA_ESTOQUE_LI, 'GET', () => respostaJson(404, undefined)));
    const m = montar(db, p, { tentativa: TASK_MAX_ATTEMPTS - 1 });
    await expect(m.fase.unidade(CONTA_DA_FASE)).rejects.toBeInstanceOf(LiNotFoundError);
  });
});

/* -------------------------------------------------------------------------- */
/*                         The cursor and the page size                        */
/* -------------------------------------------------------------------------- */

describe('the cursor: resumed inside one run, restarted for another', () => {
  const quatro = () => ({
    entradas: { '101': v('a', 1), '102': v('b', 1), '103': v('c', 1), '104': v('d', 1) },
    linhas: [emDia(101, 1), emDia(102, 1), emDia(103, 1), emDia(104, 1)],
  });

  it('a cursor of THIS run resumes at its offset, with its stored page size whatever the environment says now', async () => {
    const { db, p } = cenario({
      ...quatro(),
      raiz: { reconcile: { offset: 2, limite: 2, iniciadoEmMs: INICIO_RUN_RECONCILE_MS } },
    });
    const m = montar(db, p, {
      ambiente: { [CHAMADAS_ENV_LI]: 'on', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '50' },
    });
    await m.correr();
    expect(listas(p)).toEqual([chamadaDaListaLi(2, 2)]);
  });

  it('⚠️ NEAR-MISS: a cursor that started 1 ms BEFORE the run is another run’s ⇒ the walk restarts at 0, with no id seen', async () => {
    const { db, p } = cenario({
      ...quatro(),
      raiz: {
        reconcile: { offset: 2, limite: 2, iniciadoEmMs: INICIO_RUN_RECONCILE_MS - 1 },
        execucao: { vistos: ['999'] },
      },
    });
    const m = montar(db, p);
    await m.correr();
    expect(listas(p)).toEqual([chamadaDaListaLi(0, 2), chamadaDaListaLi(2, 2)]);
    expect(m.estado().visto('999')).toBe(false);
  });

  it('an unreadable page size: the default, ONE WARNING per run however many contas start', async () => {
    const { db, p } = cenario(quatro());
    const m = montar(db, p, {
      ambiente: { [CHAMADAS_ENV_LI]: 'on', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '03' },
    });
    await m.correr();
    expect(listas(p)).toEqual([chamadaDaListaLi(0, 100)]);
    expect(m.contadores.limitePaginaIlegivel).toBe(1);
    expect(m.log.linhas.filter((l) => l.nivel === 'warn').map((l) => l.meta.limite)).toEqual([100]);
    // A second conta starting in the same run logs nothing more.
    const outro = cenario(quatro());
    const m2 = montar(outro.db, outro.p, {
      ambiente: { [CHAMADAS_ENV_LI]: 'on', [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '101' },
      contadores: { limitePaginaIlegivel: 1 },
    });
    await m2.correr();
    expect(listas(outro.p)).toEqual([chamadaDaListaLi(0, 100)]);
    expect(m2.log.linhas.filter((l) => l.nivel === 'warn')).toEqual([]);
  });
});

describe('the budget: a page whose lookups do not fit is dropped whole', () => {
  it('the lookups need their own unit: no room ⇒ the page is not kept and the cursor does not move', async () => {
    const { db, p } = cenario({ linhas: [emDia(201, 0), emDia(202, 0)] });
    const orcamento: OrcamentoReconcileLi = { inicioMs: 0, cabe: (u) => u === 'chamada' };
    const m = montar(db, p, { orcamento });
    expect(await m.fase.unidade(CONTA_DA_FASE)).toEqual({ tipo: 'sem-orcamento' });
    expect(listas(p)).toHaveLength(1);
    expect(m.contadores).toEqual({});
    expect(m.estado().cursor()?.offset).toBe(0);
    expect(db.consultas).toEqual([]);
    // NEAR-MISS: a page with nothing to look up needs only the call.
    const emDiaSo = cenario({ entradas: { '201': v('a', 0) }, linhas: [emDia(201, 0)] });
    const m2 = montar(emDiaSo.db, emDiaSo.p, { orcamento });
    expect(await m2.fase.unidade(CONTA_DA_FASE)).toEqual({ tipo: 'unidade' });
  });
});

describe('the lookup rides the declared index', () => {
  it('firestore.indexes.json declares COLLECTION_GROUP produtolojaintegrada (contaLojaIntegrada, id)', () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      if (dir === dirname(dir)) throw new Error('no pnpm-workspace.yaml above this test');
      dir = dirname(dir);
    }
    const { indexes } = JSON.parse(
      readFileSync(resolve(dir, 'firestore.indexes.json'), 'utf8'),
    ) as {
      indexes: {
        collectionGroup: string;
        queryScope: string;
        fields: { fieldPath: string; order?: string }[];
      }[];
    };
    const declarados = indexes.filter(
      (i) =>
        i.collectionGroup === GRUPO_VINCULO_LI &&
        i.queryScope === 'COLLECTION_GROUP' &&
        i.fields.map((f) => f.fieldPath).join(',') === CAMPOS_INDICE_VINCULO_LI.join(','),
    );
    expect(declarados).toHaveLength(1);
    expect(FLAG_ENTRADA_ESTOQUE_LI.semVinculo).toBe('x');
  });
});

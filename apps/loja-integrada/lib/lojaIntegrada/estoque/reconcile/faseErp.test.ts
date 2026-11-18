/**
 * `faseErp.ts` (master plan step 12, PR 12-g): one walk page evaluated for every conta of the run
 * — the send run's plan from the send run's reads, each verdict turned into its snapshot entry,
 * and the reads a page costs, counted on `testing/fakeDb.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAG_ENTRADA_ESTOQUE_LI, makeEstoqueUid } from '@delfrance/schemas';

import { FakeDb, asDb } from '../../testing/fakeDb';
import {
  RUN_A,
  componentesDoKit,
  seedLinkFilho,
  seedProduto,
  seedRegistro,
} from '../../testing/reconcileEstoqueLi';
import type { GrupoDeVinculosLi } from './caminhadaVinculos';
import { avaliarPaginaErpLi } from './faseErp';
import { type EstadoContaReconcileLi, carregarEstadosReconcileLi } from './snapshotReconcile';

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('faseErp.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const DEP = 'dep-1';

/** The run state of each conta (its depósito fixed), loaded as a slice loads it. */
async function estadosDe(
  db: FakeDb,
  contas: Record<string, string>,
): Promise<Map<string, EstadoContaReconcileLi>> {
  for (const [contaId, depositoId] of Object.entries(contas)) {
    db.seed(`sincEstoqueLojaIntegrada/${contaId}`, {
      execucao: { execucaoId: RUN_A, depositoId, vistos: [], amostras: {}, mapa: null },
    });
  }
  const estados = await carregarEstadosReconcileLi(asDb(db), RUN_A, Object.keys(contas));
  if (estados === null) throw new Error('fixture: estados');
  return estados;
}

/** Each produto's own links, as the walk hands them over (read whole from the fake). */
function grupos(db: FakeDb, produtoIds: readonly string[]): GrupoDeVinculosLi[] {
  return produtoIds.map((produtoId) => ({
    produtoId,
    links: db
      .idsEm(`produtos/${produtoId}/produtolojaintegrada`)
      .map((l) => db.ler(`produtos/${produtoId}/produtolojaintegrada/${l}`) ?? {}),
  }));
}

async function avaliar(
  db: FakeDb,
  produtoIds: readonly string[],
  contas: Record<string, string> = { C1: DEP },
) {
  const estados = await estadosDe(db, contas);
  const leiturasAntes = db.leituras.length;
  const consultasAntes = db.consultas.length;
  const getAll = vi.spyOn(db, 'getAll');
  const contadores = await avaliarPaginaErpLi(
    asDb(db),
    grupos(db, produtoIds),
    [...estados.values()].map((e) => e.conta),
    estados,
  );
  return {
    estados,
    contadores,
    c1: estados.get('C1'),
    leituras: db.leituras.slice(leiturasAntes),
    consultas: db.consultas.slice(consultasAntes),
    getAlls: getAll.mock.calls.length,
  };
}

describe('avaliarPaginaErpLi — the links alone decide first, and cost no produto read', () => {
  it('sem-vinculo (another conta’s link, one in the trash): no entry, NO produto read', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    seedLinkFilho(db, 'p1', 'l1', 'C9', 5);
    seedLinkFilho(db, 'p1', 'l2', 'C1', 6, { removido: true });
    const r = await avaliar(db, ['p1']);
    expect(r.c1?.entrada('5')).toBeUndefined();
    expect(r.c1?.entrada('6')).toBeUndefined();
    expect(r.leituras).toEqual([]);
    expect(r.consultas).toEqual([]);
  });

  it('pai ⇒ the store id in pais; nao-suportado ⇒ ns; vinculo-ambiguo ⇒ amb on EACH id, sampled — none read further', async () => {
    const db = new FakeDb();
    seedLinkFilho(db, 'pai', 'l1', 'C1', 900, { paiProdutoIntegradaId: null, grades: [1] });
    seedLinkFilho(db, 'raiz', 'l1', 'C1', 901, { paiProdutoIntegradaId: null, grades: [] });
    seedLinkFilho(db, 'dois', 'l1', 'C1', 5);
    seedLinkFilho(db, 'dois', 'l2', 'C1', '6');
    const r = await avaliar(db, ['pai', 'raiz', 'dois']);
    expect(r.c1?.pais.ids).toEqual(new Set(['900']));
    expect(r.c1?.entrada('901')).toEqual({
      p: 'raiz',
      s: null,
      f: FLAG_ENTRADA_ESTOQUE_LI.naoSuportado,
    });
    expect(r.c1?.entrada('5')).toEqual({ p: 'dois', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo });
    expect(r.c1?.entrada('6')).toEqual({ p: 'dois', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo });
    expect(r.c1?.raiz.execucao.amostras).toEqual({ ambiguo: ['dois'] });
    expect(r.leituras).toEqual([]);
    expect(Object.fromEntries(r.contadores.get('C1') ?? [])).toEqual({
      pais: 1,
      naoSuportados: 1,
      ambiguos: 1,
    });
  });

  it('⚠️ NEAR-MISS: a number id and its decimal text on ONE produto are one store product — v, never amb', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    seedLinkFilho(db, 'p1', 'l1', 'C1', 5);
    seedLinkFilho(db, 'p1', 'l2', 'C1', '5', { contaLojaIntegrada: '/documents/integracao/C1' });
    seedRegistro(db, 'p1', DEP, 4);
    const r = await avaliar(db, ['p1']);
    expect(r.c1?.entrada('5')).toEqual({ p: 'p1', s: 4, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
  });
});

describe('avaliarPaginaErpLi — the verdicts that read', () => {
  it('a produto that no longer exists ⇒ x (never looked up daily) and the ausente sample', async () => {
    const db = new FakeDb();
    seedLinkFilho(db, 'sumiu', 'l1', 'C1', 7);
    const r = await avaliar(db, ['sumiu']);
    expect(r.c1?.entrada('7')).toEqual({ p: null, s: null, f: FLAG_ENTRADA_ESTOQUE_LI.semVinculo });
    expect(r.c1?.raiz.execucao.amostras).toEqual({ ausente: ['sumiu'] });
  });

  it('parity ⇒ par, and its records are NEVER read', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1', { statusProdutosMarketplace: { C1_5: { enviarEstoque: false } } });
    seedLinkFilho(db, 'p1', 'l1', 'C1', 5);
    seedRegistro(db, 'p1', DEP, 4);
    const r = await avaliar(db, ['p1']);
    expect(r.c1?.entrada('5')).toEqual({ p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.paridade });
    expect(r.leituras).toEqual(['produtos/p1']);
    expect(r.consultas).toEqual([]);
  });

  it('⚠️ a record at ANOTHER depósito but none at the conta’s ⇒ v with the real 0 (zeroPorDeposito), after one listing', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    seedLinkFilho(db, 'p1', 'l1', 'C1', 5);
    seedRegistro(db, 'p1', 'dep-2', 40);
    const r = await avaliar(db, ['p1']);
    expect(r.c1?.entrada('5')).toEqual({ p: 'p1', s: 0, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
    const contadores = Object.fromEntries(r.contadores.get('C1') ?? []);
    expect(contadores).toMatchObject({ avaliados: 1, zeroPorDeposito: 1, validos: 1 });
    // The safety gate's aviso names it (the queue phase decides the gate).
    expect(r.c1?.raiz.execucao.amostras).toEqual({ 'deposito-sem-registros': ['p1'] });
  });

  it('⚠️ NEAR-MISS: NO record at any depósito ⇒ r (held, sampled) after EXACTLY one where-less limit-1 listing', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    seedLinkFilho(db, 'p1', 'l1', 'C1', 5);
    const r = await avaliar(db, ['p1']);
    expect(r.c1?.entrada('5')).toEqual({ p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.retido });
    expect(r.c1?.raiz.execucao.amostras).toEqual({ retido: ['p1'] });
    const listagens = r.consultas.filter(
      (c) => c.colecao === 'produtos/p1/estoques' && c.filtros.length === 0 && c.limite === 1,
    );
    expect(listagens).toHaveLength(1);
    expect(Object.fromEntries(r.contadores.get('C1') ?? [])).toMatchObject({
      avaliados: 1,
      retidos: 1,
    });
    expect(r.contadores.get('C1')?.has('zeroPorDeposito')).toBe(false);
  });

  it('the canonical record wins beside a legacy one; two legacy ones ⇒ amb (estoque-ambiguo, sampled)', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    seedLinkFilho(db, 'p1', 'l1', 'C1', 5);
    seedRegistro(db, 'p1', DEP, 4);
    seedRegistro(db, 'p1', DEP, 9, { id: 'auto-a' });
    seedProduto(db, 'p2');
    seedLinkFilho(db, 'p2', 'l1', 'C1', 6);
    seedRegistro(db, 'p2', DEP, 1, { id: 'auto-a' });
    seedRegistro(db, 'p2', DEP, 2, { id: 'auto-b', depositoOuterRef: `depositos/${DEP}` });
    const r = await avaliar(db, ['p1', 'p2']);
    expect(r.c1?.entrada('5')).toEqual({ p: 'p1', s: 4, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
    expect(r.c1?.entrada('6')).toEqual({ p: 'p2', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.ambiguo });
    expect(r.c1?.raiz.execucao.amostras).toEqual({ 'estoque-ambiguo': ['p2'] });
  });

  it('a legacy record WITHOUT parentId (invisible to the join) is found by the own-collection query', async () => {
    const db = new FakeDb();
    seedProduto(db, 'p1');
    seedLinkFilho(db, 'p1', 'l1', 'C1', 5);
    db.seed('produtos/p1/estoques/legado', { depositoOuterRef: `depositos/${DEP}`, quantidade: 3 });
    const r = await avaliar(db, ['p1']);
    expect(r.c1?.entrada('5')).toEqual({ p: 'p1', s: 3, f: FLAG_ENTRADA_ESTOQUE_LI.valido });
  });

  it('⚠️ a kit its components bound ⇒ v with k, its composition and each component’s resolved record — its OWN record never read', async () => {
    const db = new FakeDb();
    seedProduto(db, 'kit', {
      ehKit: true,
      componentesKit: componentesDoKit({ blank: 1, print: 2 }),
    });
    seedLinkFilho(db, 'kit', 'l1', 'C1', 50);
    seedRegistro(db, 'kit', DEP, 99);
    seedRegistro(db, 'blank', DEP, 5);
    seedRegistro(db, 'print', DEP, 6, { id: 'auto-p' });
    const r = await avaliar(db, ['kit']);
    expect(r.c1?.entrada('50')).toEqual({
      p: 'kit',
      s: 3,
      f: FLAG_ENTRADA_ESTOQUE_LI.valido,
      k: true,
      q: { blank: 1, print: 2 },
      e: { blank: makeEstoqueUid('blank', DEP), print: 'auto-p' },
    });
    expect(r.leituras).not.toContain(`produtos/kit/estoques/${makeEstoqueUid('kit', DEP)}`);
    // Not a child whose OWN record feeds S: outside the depósito gate's count.
    expect(r.contadores.get('C1')?.has('avaliados')).toBe(false);
  });

  it('two produtos linking one store id in one page ⇒ dup, both sampled and counted', async () => {
    const db = new FakeDb();
    for (const p of ['p1', 'p2']) {
      seedProduto(db, p);
      seedLinkFilho(db, p, 'l1', 'C1', 7);
      seedRegistro(db, p, DEP, 1);
    }
    const r = await avaliar(db, ['p1', 'p2']);
    expect(r.c1?.entrada('7')).toEqual({ p: 'p1', s: null, f: FLAG_ENTRADA_ESTOQUE_LI.duplicado });
    expect(r.c1?.raiz.execucao.amostras).toEqual({ duplicado: ['p1', 'p2'] });
    expect(r.contadores.get('C1')?.get('duplicados')).toBe(2);
  });
});

describe('avaliarPaginaErpLi — what one page costs', () => {
  it('two contas on two depósitos, six linked children (a kit of two components, a parity one, a never-stocked one): ONE produto getAll, ONE canonical getAll per depósito, one listing', async () => {
    const db = new FakeDb();
    // Conta C1 at dep-1: a, b (stocked), kit (blank + print), par (parity), nunca (never stocked).
    for (const p of ['a', 'b']) {
      seedProduto(db, p);
      seedLinkFilho(db, p, 'l1', 'C1', p === 'a' ? 1 : 2);
      seedRegistro(db, p, DEP, 3);
    }
    seedProduto(db, 'kit', {
      ehKit: true,
      componentesKit: componentesDoKit({ blank: 1, print: 1 }),
    });
    seedLinkFilho(db, 'kit', 'l1', 'C1', 3);
    seedRegistro(db, 'blank', DEP, 2);
    seedRegistro(db, 'print', DEP, 2);
    seedProduto(db, 'par', { statusProdutosMarketplace: { C1_4: { enviarEstoque: false } } });
    seedLinkFilho(db, 'par', 'l1', 'C1', 4);
    seedProduto(db, 'nunca');
    seedLinkFilho(db, 'nunca', 'l1', 'C1', 5);
    // Conta C2 at dep-2: one child.
    seedProduto(db, 'c');
    seedLinkFilho(db, 'c', 'l1', 'C2', 6);
    seedRegistro(db, 'c', 'dep-2', 8);
    const r = await avaliar(db, ['a', 'b', 'kit', 'par', 'nunca', 'c'], { C1: DEP, C2: 'dep-2' });
    // 1 masked produto getAll + 1 canonical getAll per depósito.
    expect(r.getAlls).toBe(3);
    // The parity child's records are never read.
    expect(r.leituras.filter((l) => l.startsWith('produtos/par/estoques'))).toEqual([]);
    // One never-had-stock listing, for the one that has no record anywhere.
    expect(r.consultas.filter((c) => c.limite === 1 && c.filtros.length === 0)).toHaveLength(1);
    expect(r.estados.get('C2')?.entrada('6')).toEqual({
      p: 'c',
      s: 8,
      f: FLAG_ENTRADA_ESTOQUE_LI.valido,
    });
    expect(r.c1?.entrada('3')).toMatchObject({ s: 2, k: true });
  });
});

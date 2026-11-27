/**
 * `paginaErpReconcile.ts` (master plan step 13, PR 13-f1): one walk page for both arms — the read
 * the page makes in each combination (its field mask EXACTLY), and the price arm's containment per
 * (page, conta): a bug or a schema refusal is counted on the conta with ONE ERROR and leaves the
 * stock evaluation as it was; anything else is rethrown. Against `testing/fakeDb.ts`.
 */
import { describe, expect, it } from 'vitest';

import { FakeDb, grpc } from '../../testing/fakeDb';
import { RUN_A, loggerGravador, seedProduto, seedRegistro } from '../../testing/reconcileEstoqueLi';
import { dbRastreadoLi } from '../../testing/reconcilePrecoLi';
import { avaliarPrecoDaPaginaLi } from './armaPrecoErp';
import type { GrupoDeVinculosLi } from './caminhadaVinculos';
import { carregarEstadosPrecoLi } from './estadoPrecoReconcile';
import { avaliarPaginaReconcileLi } from './paginaErpReconcile';
import { carregarEstadosReconcileLi } from './snapshotReconcile';

const MASCARA_ESTOQUE = ['ehKit', 'ehKitVirtual', 'componentesKit', 'statusProdutosMarketplace'];
const MASCARA_PRECO = ['paiId', 'precos', 'propagatePriceToChildren'];

const link = (conta: string, id: number, over: Record<string, unknown> = {}) => ({
  contaLojaIntegrada: `documents/integracao/${conta}`,
  id,
  paiProdutoIntegradaId: 900,
  removido: false,
  ...over,
});

/**
 * Two contas of the run with their stock and price states, and a page of four groups. Only C1 is
 * priced, unless `c2Precificada` (C2's one link, 2001, is then priced too, on the same page).
 */
async function mundo(o: { readonly c2Precificada?: boolean } = {}) {
  const fake = new FakeDb();
  for (const [conta, deposito] of [
    ['C1', 'dep-1'],
    ['C2', 'dep-2'],
  ] as const) {
    fake.seed(`sincEstoqueLojaIntegrada/${conta}`, {
      execucao: { execucaoId: RUN_A, depositoId: deposito, vistos: [], amostras: {}, mapa: null },
    });
  }
  for (const conta of o.c2Precificada === true ? ['C1', 'C2'] : ['C1']) {
    fake.seed(`sincPrecoLojaIntegrada/${conta}`, {
      execucaoPreco: {
        execucaoId: RUN_A,
        tabelas: { normal: 'tab-n', promocional: null },
        amostras: {},
        contadores: {},
        candidatos: [],
        mantidos: [],
      },
    });
  }
  seedProduto(fake, 'f1', { paiId: 'pai-1', precos: { 'tab-n': { valor: 11.11 } }, custo: 9 });
  seedProduto(fake, 'f2', { precos: { 'tab-n': { valor: 22.22 } } });
  seedProduto(fake, 'g1', { precos: { 'tab-n': { valor: 33.33 } } });
  seedRegistro(fake, 'f1', 'dep-1', 3);
  seedRegistro(fake, 'f2', 'dep-1', 4);
  seedRegistro(fake, 'g1', 'dep-2', 5);
  const grupos: GrupoDeVinculosLi[] = [
    { produtoId: 'f1', links: [link('C1', 1001)] },
    { produtoId: 'f2', links: [link('C1', 1002)] },
    { produtoId: 'g1', links: [link('C2', 2001)] },
    { produtoId: 'pai-1', links: [link('C1', 1000, { paiProdutoIntegradaId: null, grades: [1] })] },
  ];
  const { db, getAlls } = dbRastreadoLi(fake);
  const estados = await carregarEstadosReconcileLi(db, RUN_A, ['C1', 'C2']);
  if (estados === null) throw new Error('estado de estoque não carregado');
  const precos = await carregarEstadosPrecoLi(
    db,
    RUN_A,
    [
      { idx: 0, contaId: 'C1' },
      { idx: 1, contaId: 'C2' },
    ],
    { baldes: 'todos' },
  );
  const contas = [...estados.values()].map((e) => e.conta);
  const contasPreco = [...precos.values()].map((e) => e.conta);
  const marca = getAlls.length;
  const lidosDaPagina = () =>
    getAlls.slice(marca).filter((g) => g.caminhos.every((c) => /^produtos\/[^/]+$/.test(c)));
  return { fake, db, getAlls, estados, precos, contas, contasPreco, grupos, lidosDaPagina };
}

describe('the read of a page, in each combination of arms', () => {
  it('price NOT carried ⇒ the stock read exactly: the stock mask, never a price field', async () => {
    const w = await mundo();
    await avaliarPaginaReconcileLi(w.db, w.grupos, {
      estoque: { contas: w.contas, estados: w.estados },
      preco: null,
      global: new Map(),
      logger: loggerGravador().logger,
      execucaoId: RUN_A,
    });
    expect(w.lidosDaPagina().map((g) => g.mascara)).toEqual([MASCARA_ESTOQUE]);
  });

  it('BOTH carried ⇒ ONE getAll with the UNION mask exactly — the price arm reads nothing of its own', async () => {
    const w = await mundo();
    const global = new Map<string, number>();
    await avaliarPaginaReconcileLi(w.db, w.grupos, {
      estoque: { contas: w.contas, estados: w.estados },
      preco: { contas: w.contasPreco, estados: w.precos },
      global,
      logger: loggerGravador().logger,
      execucaoId: RUN_A,
    });
    const lidos = w.lidosDaPagina();
    expect(lidos.map((g) => g.mascara)).toEqual([[...MASCARA_ESTOQUE, ...MASCARA_PRECO]]);
    expect(lidos[0]?.caminhos).toEqual(['produtos/f1', 'produtos/f2', 'produtos/g1']);
    expect(global.get('erpProdutosLidos')).toBe(3);
    const c1 = w.precos.get('C1');
    expect(c1?.entrada('1001')).toEqual({ p: 'f1', f: 'v', pai: 'pai-1', n: 1111 });
    expect(c1?.entrada('1002')).toEqual({ p: 'f2', f: 'v', n: 2222 });
    expect(c1?.entrada('1000')).toEqual({ p: 'pai-1', f: 'pai' });
    expect(c1?.contador('validos')).toBe(2);
  });

  it('stock NOT carried ⇒ the price mask alone, of the produtos a PRICED conta links as a child', async () => {
    const w = await mundo();
    const global = new Map<string, number>();
    const r = await avaliarPaginaReconcileLi(w.db, w.grupos, {
      estoque: null,
      preco: { contas: w.contasPreco, estados: w.precos },
      global,
      logger: loggerGravador().logger,
      execucaoId: RUN_A,
    });
    expect(r.porContaEstoque.size).toBe(0);
    const lidos = w.lidosDaPagina();
    expect(lidos).toEqual([{ caminhos: ['produtos/f1', 'produtos/f2'], mascara: MASCARA_PRECO }]);
    expect(global.get('erpProdutosLidos')).toBe(2);
    expect(w.precos.get('C1')?.contador('validos')).toBe(2);
  });
});

describe('the price arm’s containment per (page, conta)', () => {
  async function comArma(
    arma: typeof avaliarPrecoDaPaginaLi,
    o: { readonly c2Precificada?: boolean } = {},
  ) {
    const w = await mundo(o);
    const log = loggerGravador();
    const semPreco = await mundo();
    const base = await avaliarPaginaReconcileLi(semPreco.db, semPreco.grupos, {
      estoque: { contas: semPreco.contas, estados: semPreco.estados },
      preco: null,
      global: new Map(),
      logger: loggerGravador().logger,
      execucaoId: RUN_A,
    });
    const r = avaliarPaginaReconcileLi(w.db, w.grupos, {
      estoque: { contas: w.contas, estados: w.estados },
      preco: { contas: w.contasPreco, estados: w.precos, arma },
      global: new Map(),
      logger: log.logger,
      execucaoId: RUN_A,
    });
    return { w, log, base, semPreco, r };
  }

  it.each([
    ['TypeError', () => new TypeError('x')],
    ['RangeError', () => new RangeError('x')],
  ] as const)(
    'a %s ⇒ counted `armaFalhou` with ONE ERROR; the stock evaluation is the stock-only one',
    async (classe, erro) => {
      const { w, log, base, semPreco, r } = await comArma(() => {
        throw erro();
      });
      const { porContaEstoque } = await r;
      expect(porContaEstoque).toEqual(base.porContaEstoque);
      for (const conta of ['C1', 'C2']) {
        expect(
          w.estados
            .get(conta)
            ?.escritas()
            .map((e) => e.ref.path),
        ).toEqual(
          semPreco.estados
            .get(conta)
            ?.escritas()
            .map((e) => e.ref.path),
        );
      }
      expect(w.precos.get('C1')?.contador('armaFalhou')).toBe(1);
      expect(
        log.linhas.map((l) => [l.nivel, l.meta.motivo, l.meta.contaId, l.meta.classe]),
      ).toEqual([['error', 'arma-preco-falhou', 'C1', classe]]);
      expect([...(w.precos.get('C1')?.entradas() ?? [])]).toEqual([]);
    },
  );

  it('a fault for the FIRST priced conta leaves the NEXT one on the same page priced — contained per conta, never the rest of the page', async () => {
    const { w, log, r } = await comArma(
      (a) => {
        if (a.conta.contaId === 'C1') throw new TypeError('x');
        return avaliarPrecoDaPaginaLi(a);
      },
      { c2Precificada: true },
    );
    await r;
    expect(w.precos.get('C1')?.contador('armaFalhou')).toBe(1);
    expect(w.precos.get('C2')?.entrada('2001')).toEqual({ p: 'g1', f: 'v', n: 3333 });
    expect(w.precos.get('C2')?.contador('validos')).toBe(1);
    expect(w.precos.get('C2')?.contador('armaFalhou')).toBe(0);
    expect(log.linhas.map((l) => l.meta.contaId)).toEqual(['C1']);
  });

  it('a COUNTER the root’s schema refuses (a fraction, a name off its form, a negative) ⇒ contained as a ZodError, nothing of the page applied', async () => {
    for (const ruim of [
      ['validos', 0.5],
      ['pai-invalido', 1],
      ['validos', -1],
    ] as const) {
      const { w, log, r } = await comArma((a) => ({
        ...avaliarPrecoDaPaginaLi(a),
        contadores: new Map([ruim]),
      }));
      await r;
      expect([...(w.precos.get('C1')?.entradas() ?? [])], ruim[0]).toEqual([]);
      expect(w.precos.get('C1')?.raiz.execucaoPreco.contadores, ruim[0]).toEqual({
        armaFalhou: 1,
      });
      expect(
        log.linhas.map((l) => [l.meta.motivo, l.meta.classe]),
        ruim[0],
      ).toEqual([['arma-preco-falhou', 'ZodError']]);
      expect(() => w.precos.get('C1')?.escritas()).not.toThrow();
    }
  });

  it('a conta that already faulted is skipped on the next page: its arm is not called again', async () => {
    const { w, r } = await comArma(() => {
      throw new TypeError('x');
    });
    await r;
    let chamadas = 0;
    await avaliarPaginaReconcileLi(w.db, w.grupos, {
      estoque: { contas: w.contas, estados: w.estados },
      preco: {
        contas: w.contasPreco,
        estados: w.precos,
        arma: (a) => {
          chamadas += 1;
          return avaliarPrecoDaPaginaLi(a);
        },
      },
      global: new Map(),
      logger: loggerGravador().logger,
      execucaoId: RUN_A,
    });
    expect(chamadas).toBe(0);
  });

  it('⚠️ NEAR-MISS: anything else is RETHROWN — a plain Error from the arm, and a Firestore failure of the shared read', async () => {
    const { r } = await comArma(() => {
      throw new Error('não contida');
    });
    await expect(r).rejects.toThrow('não contida');

    const w = await mundo();
    w.fake.falharLeitura('produtos/f2', grpc(14, 'UNAVAILABLE'));
    await expect(
      avaliarPaginaReconcileLi(w.db, w.grupos, {
        estoque: { contas: w.contas, estados: w.estados },
        preco: { contas: w.contasPreco, estados: w.precos },
        global: new Map(),
        logger: loggerGravador().logger,
        execucaoId: RUN_A,
      }),
    ).rejects.toMatchObject({ code: 14 });
  });

  it('an entry off its schema or a store id no bucket holds, after valid ones ⇒ the page is refused WHOLE for the conta', async () => {
    for (const ruim of [
      ['1999', { p: '', f: 'v' }],
      ['01', { p: 'x', f: 'v' }],
    ] as const) {
      const { w, log, r } = await comArma((a) => {
        const real = avaliarPrecoDaPaginaLi(a);
        return { ...real, entradas: [...real.entradas, ruim as never] };
      });
      await r;
      expect([...(w.precos.get('C1')?.entradas() ?? [])], ruim[0]).toEqual([]);
      expect(w.precos.get('C1')?.contador('validos'), ruim[0]).toBe(0);
      expect(log.linhas).toHaveLength(1);
    }
  });
});

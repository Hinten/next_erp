/**
 * `paisPrecoReconcile.ts` (master plan step 13, PR 13-f1): the parents phase — roots with no read,
 * at most 300 parents a unit, each read ONCE per conta per run (a resumed slice included), the
 * shared child rule through the rebuilt map, the end's counters, sample and carry clear. Against
 * `testing/fakeDb.ts`; invented ids and prices.
 */
import { describe, expect, it } from 'vitest';
import {
  type EntradaSnapshotPrecoLi,
  FLAG_ENTRADA_PRECO_LI,
  baldeSnapshotEstoqueLi,
} from '@delfrance/schemas';

import { CAMPOS_PRODUTO_PRECO_LI } from '../../preco/leituraPrecoErp';
import { FakeDb } from '../../testing/fakeDb';
import { RUN_A, loggerGravador } from '../../testing/reconcileEstoqueLi';
import { dbRastreadoLi } from '../../testing/reconcilePrecoLi';
import { type EstadoContaPrecoLi, carregarEstadosPrecoLi } from './estadoPrecoReconcile';
import {
  MAX_PAIS_POR_LEITURA_PRECO_LI,
  PaisPrecoReconcileLi,
  alvoDaEntradaPrecoLi,
} from './paisPrecoReconcile';

const TABELAS = { normal: 'tab-n', promocional: 'tab-p' };
const RAIZ = 'sincPrecoLojaIntegrada/C1';

const v = (p: string, extra: Partial<EntradaSnapshotPrecoLi> = {}): EntradaSnapshotPrecoLi => ({
  p,
  f: FLAG_ENTRADA_PRECO_LI.valido,
  ...extra,
});

/** C1's price root of this run and its buckets holding `entradas` (store id → entry). */
function semear(
  db: FakeDb,
  entradas: Readonly<Record<string, EntradaSnapshotPrecoLi>>,
  anteriores: Readonly<Record<string, unknown>> = {},
): void {
  db.seed(RAIZ, {
    execucaoPreco: {
      execucaoId: RUN_A,
      tabelas: TABELAS,
      amostras: {},
      contadores: {},
      candidatos: [],
      mantidos: [],
    },
  });
  const porBalde = new Map<
    string,
    { e: Record<string, unknown>; anteriores: Record<string, unknown> }
  >();
  for (let b = 0; b < 32; b += 1) {
    porBalde.set(String(b).padStart(2, '0'), { e: {}, anteriores: {} });
  }
  for (const [idLi, e] of Object.entries(entradas)) {
    const b = porBalde.get(baldeSnapshotEstoqueLi(idLi) ?? '');
    if (b !== undefined) b.e[idLi] = e;
  }
  for (const [idLi, a] of Object.entries(anteriores)) {
    const b = porBalde.get(baldeSnapshotEstoqueLi(idLi) ?? '');
    if (b !== undefined) b.anteriores[idLi] = a;
  }
  for (const [id, dados] of porBalde) {
    db.seed(`${RAIZ}/snapshot/${id}`, { execucaoId: RUN_A, ...dados });
  }
}

/** A slice's world: the traced db, the conta's state, the phase. */
async function fatia(fake: FakeDb) {
  const { db, getAlls } = dbRastreadoLi(fake);
  const estados = await carregarEstadosPrecoLi(db, RUN_A, [{ idx: 0, contaId: 'C1' }], {
    baldes: 'todos',
  });
  const estado = estados.get('C1');
  if (estado === undefined) throw new Error('C1 não carregada');
  const log = loggerGravador();
  const pais = new PaisPrecoReconcileLi({ db, execucaoId: RUN_A, logger: log.logger });
  const lidosDePais = () =>
    getAlls
      .filter((g) => JSON.stringify(g.mascara) === JSON.stringify(CAMPOS_PRODUTO_PRECO_LI))
      .map((g) => g.caminhos);
  return { estado, pais, log, getAlls, lidosDePais };
}

/** What the end-of-slice batch would leave stored (each write applied whole over the document). */
function persistir(fake: FakeDb, estado: EstadoContaPrecoLi): void {
  for (const w of estado.escritas()) {
    if (w.tipo !== 'gravar') continue;
    fake.seed(w.ref.path, { ...(fake.ler(w.ref.path) ?? {}), ...w.dados });
  }
}

describe('alvoDaEntradaPrecoLi — the shared rule over the rebuilt child and the raw parent', () => {
  it('a root prices from its own readings; the clear when the run has no promo reading', () => {
    expect(
      alvoDaEntradaPrecoLi({
        entrada: v('r1', { n: 2222, pr: 1111 }),
        pai: null,
        tabelas: TABELAS,
      }),
    ).toEqual({ c: 2222, q: 1111 });
    expect(
      alvoDaEntradaPrecoLi({ entrada: v('r1', { n: 2222 }), pai: null, tabelas: TABELAS }),
    ).toEqual({ c: 2222, q: null });
    expect(
      alvoDaEntradaPrecoLi({ entrada: v('r1', { n: 'il' }), pai: null, tabelas: TABELAS }),
    ).toEqual({ r: 'ilegivel' });
    expect(alvoDaEntradaPrecoLi({ entrada: v('r1'), pai: null, tabelas: TABELAS })).toEqual({
      r: 'sem-preco',
    });
  });

  it('a PROPAGATING parent prices the child from the parent — held without a parent price, even when the child has its own', () => {
    const paiComPreco = { precos: { 'tab-n': { valor: 33.33 } } };
    expect(
      alvoDaEntradaPrecoLi({
        entrada: v('f1', { pai: 'p', n: 1111 }),
        pai: paiComPreco,
        tabelas: TABELAS,
      }),
    ).toEqual({ c: 3333, q: null });
    expect(
      alvoDaEntradaPrecoLi({ entrada: v('f1', { pai: 'p', n: 1111 }), pai: {}, tabelas: TABELAS }),
    ).toEqual({ r: 'sem-preco' });
  });

  it('a NON-propagating parent leaves the child its own; a MISSING parent (`null`, never `{}`) holds it `pai-ausente`', () => {
    const naoPropaga = { propagatePriceToChildren: false, precos: { 'tab-n': { valor: 33.33 } } };
    expect(
      alvoDaEntradaPrecoLi({
        entrada: v('f1', { pai: 'p', n: 1111 }),
        pai: naoPropaga,
        tabelas: TABELAS,
      }),
    ).toEqual({ c: 1111, q: null });
    expect(
      alvoDaEntradaPrecoLi({
        entrada: v('f1', { pai: 'p', n: 1111 }),
        pai: null,
        tabelas: TABELAS,
      }),
    ).toEqual({ r: 'pai-ausente' });
  });
});

describe('one unit of the parents phase', () => {
  it('ROOTS need no read: a conta of roots only is done in one unit with no getAll', async () => {
    const fake = new FakeDb();
    semear(fake, { '1001': v('r1', { n: 2222 }), '1002': v('r2', { n: 'il' }) });
    const s = await fatia(fake);
    expect(await s.pais.unidade(s.estado)).toBe('conta-encerrada');
    expect(s.lidosDePais()).toEqual([]);
    expect(s.estado.entrada('1001')?.a).toEqual({ c: 2222, q: null });
    expect(s.estado.entrada('1002')?.a).toEqual({ r: 'ilegivel' });
  });

  it('the parents are read with the price mask EXACTLY; an absent one holds its children `pai-ausente`', async () => {
    const fake = new FakeDb();
    fake.seed('produtos/pai-a', {
      precos: { 'tab-n': { valor: 22.22 }, 'tab-p': { valor: 11.11 } },
      custo: 99,
      nome: 'x',
    });
    semear(fake, {
      '1001': v('f1', { pai: 'pai-a', n: 3333 }),
      '1002': v('f2', { pai: 'pai-sumiu', n: 3333 }),
    });
    const s = await fatia(fake);
    expect(await s.pais.unidade(s.estado)).toBe('conta-encerrada');
    expect(s.getAlls.filter((g) => g.caminhos.some((c) => c.startsWith('produtos/')))).toEqual([
      { caminhos: ['produtos/pai-a', 'produtos/pai-sumiu'], mascara: [...CAMPOS_PRODUTO_PRECO_LI] },
    ]);
    expect(s.estado.entrada('1001')?.a).toEqual({ c: 2222, q: 1111 });
    expect(s.estado.entrada('1002')?.a).toEqual({ r: 'pai-ausente' });
    expect(s.estado.contador('paisLidos')).toBe(2);
    expect(s.estado.contador('paisAusentes')).toBe(1);
  });

  it(
    '⚠️ 301 parents ⇒ two units of ≤ 300 — and, across a cut slice, each parent read EXACTLY once',
    // 301 families over two slices; CI runners are slower under load.
    { timeout: 30_000 },
    async () => {
      const fake = new FakeDb();
      const entradas: Record<string, EntradaSnapshotPrecoLi> = {};
      for (let n = 0; n < 301; n += 1) {
        const pai = `pai-${String(n).padStart(3, '0')}`;
        fake.seed(`produtos/${pai}`, { precos: { 'tab-n': { valor: 11.11 } } });
        entradas[String(1001 + 2 * n)] = v(`f${String(n)}`, { pai, n: 2222 });
        entradas[String(1002 + 2 * n)] = v(`g${String(n)}`, { pai, n: 2222 });
      }
      semear(fake, entradas);
      expect(MAX_PAIS_POR_LEITURA_PRECO_LI).toBe(300);

      const primeira = await fatia(fake);
      expect(await primeira.pais.unidade(primeira.estado)).toBe('unidade');
      expect(primeira.lidosDePais().map((c) => c.length)).toEqual([300]);
      persistir(fake, primeira.estado);

      // The slice is cut here; the next one re-derives what is left from the buckets.
      const segunda = await fatia(fake);
      expect(await segunda.pais.unidade(segunda.estado)).toBe('conta-encerrada');
      expect(segunda.lidosDePais()).toEqual([['produtos/pai-300']]);
      const todos = [...primeira.lidosDePais(), ...segunda.lidosDePais()].flat();
      expect(new Set(todos).size).toBe(301);
      expect(todos).toHaveLength(301);
      for (const [, e] of segunda.estado.entradas()) expect(e.a).toEqual({ c: 1111, q: null });
      expect(segunda.estado.contador('alvos')).toBe(602);
    },
  );

  it('the end: counters from every target, the `retido` sample, `anteriores` cleared, `paisConcluido`, ONE INFO', async () => {
    const fake = new FakeDb();
    fake.seed('produtos/pai-a', { precos: { 'tab-n': { valor: 22.22 } } });
    semear(
      fake,
      {
        '1001': v('r1', { n: 2222, pr: 1111 }),
        '1002': v('r2', { n: 2222, pr: 3333 }),
        '1003': v('r3', { n: 2222 }),
        '1004': v('r4'),
        '1005': v('r5', { n: 'il' }),
        '1006': v('f6', { pai: 'pai-sumiu', n: 2222 }),
        '1007': v('f7', { a: { r: 'pai-ausente' } }),
        '1008': v('f8', { pai: 'pai-a' }),
        '1009': { p: 'x9', f: FLAG_ENTRADA_PRECO_LI.pai },
      },
      { '1001': { ap: { c: 1, q: null } }, '1100': { tp: true } },
    );
    const s = await fatia(fake);
    expect(await s.pais.unidade(s.estado)).toBe('conta-encerrada');
    const c = s.estado.raiz.execucaoPreco.contadores;
    expect(c).toMatchObject({
      alvos: 4,
      limpezas: 2,
      promoNaoMenor: 1,
      retidos: 4,
      retidosSemPreco: 1,
      retidosIlegiveis: 1,
      retidosSemPai: 2,
      paisConcluido: 1,
    });
    expect(s.estado.amostra('retido')).toEqual(['f6', 'f7', 'r4', 'r5']);
    for (const w of s.estado.escritas()) {
      if (w.tipo === 'gravar' && w.ref.path.includes('/snapshot/')) {
        expect(w.dados.anteriores, w.ref.path).toEqual({});
      }
    }
    const linhas = s.log.linhas.filter((l) => l.msg.includes('alvos da conta calculados'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({ contaId: 'C1', alvos: 4, retidos: 4 });
    // NEAR-MISS: a finished conta is never priced again in the run.
    expect(await s.pais.unidade(s.estado)).toBe('conta-encerrada');
    expect(s.lidosDePais()).toHaveLength(1);
  });

  it('a state loaded WITHOUT its buckets is a caller bug (TypeError)', async () => {
    const fake = new FakeDb();
    semear(fake, {});
    const estados = await carregarEstadosPrecoLi(
      dbRastreadoLi(fake).db,
      RUN_A,
      [{ idx: 0, contaId: 'C1' }],
      { baldes: 'nenhum' },
    );
    const pais = new PaisPrecoReconcileLi({
      db: dbRastreadoLi(fake).db,
      execucaoId: RUN_A,
      logger: loggerGravador().logger,
    });
    const estado = estados.get('C1');
    if (estado === undefined) throw new Error('C1 não carregada');
    await expect(pais.unidade(estado)).rejects.toBeInstanceOf(TypeError);
  });
});

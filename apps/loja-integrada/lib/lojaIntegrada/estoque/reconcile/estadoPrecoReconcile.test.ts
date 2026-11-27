/**
 * `estadoPrecoReconcile.ts` (master plan step 13, PR 13-f1): the per-conta price state of one
 * slice — which contas are priced, the replace at load and its carry (`anteriores`), the entry
 * precedence, what the state writes back, and the commit's price share in bytes. Against
 * `testing/fakeDb.ts`; invented ids and prices.
 */
import { describe, expect, it } from 'vitest';
import { type EntradaSnapshotPrecoLi, FLAG_ENTRADA_PRECO_LI } from '@delfrance/schemas';

import { FakeDb, asDb } from '../../testing/fakeDb';
import { RUN_A, RUN_B } from '../../testing/reconcileEstoqueLi';
import { dbRastreadoLi } from '../../testing/reconcilePrecoLi';
import {
  type EstadoContaPrecoLi,
  bytesArmazenadosLi,
  bytesDaEscritaPrecoLi,
  carregarEstadosPrecoLi,
  conterBytesDoLotePrecoLi,
  mesclarEntradaPrecoLi,
} from './estadoPrecoReconcile';

const TABELAS = { normal: 'tab-n', promocional: null };
const raiz = (conta: string) => `sincPrecoLojaIntegrada/${conta}`;
const balde = (conta: string, id: string) => `${raiz(conta)}/snapshot/${id}`;

const v = (p: string, extra: Partial<EntradaSnapshotPrecoLi> = {}): EntradaSnapshotPrecoLi => ({
  p,
  f: FLAG_ENTRADA_PRECO_LI.valido,
  ...extra,
});

/** A price root of `execucaoId` for `conta`, and (when given) bucket contents. */
function semear(
  db: FakeDb,
  conta: string,
  execucaoId: string,
  baldes: Readonly<Record<string, unknown>> = {},
): void {
  db.seed(raiz(conta), {
    execucaoPreco: {
      execucaoId,
      tabelas: TABELAS,
      amostras: {},
      contadores: {},
      candidatos: [],
      mantidos: [],
    },
  });
  for (const [id, dados] of Object.entries(baldes)) db.seed(balde(conta, id), dados as never);
}

async function carregar(
  db: FakeDb,
  contas: readonly string[] = ['C1'],
  baldes: 'todos' | 'nenhum' = 'todos',
): Promise<Map<string, EstadoContaPrecoLi>> {
  return carregarEstadosPrecoLi(
    asDb(db),
    RUN_A,
    contas.map((contaId, idx) => ({ idx, contaId })),
    { baldes },
  );
}

/** The data of the state's write of `caminho` (whole fields), or `undefined`. */
function dadosEm(
  e: EstadoContaPrecoLi,
  caminho: string,
): Readonly<Record<string, unknown>> | undefined {
  const w = e.escritas().find((x) => x.ref.path === caminho);
  return w === undefined || w.tipo === 'apagar' ? undefined : w.dados;
}

async function estadoDeC1(db: FakeDb): Promise<EstadoContaPrecoLi> {
  const e = (await carregar(db)).get('C1');
  if (e === undefined) throw new Error('C1 não carregada');
  return e;
}

describe('mesclarEntradaPrecoLi — which entry wins', () => {
  it('EQUAL: the same produto again ⇒ the new entry (a re-evaluation), no duplicate', () => {
    expect(mesclarEntradaPrecoLi(v('p1', { n: 1111 }), v('p1', { n: 2222 }))).toEqual({
      entrada: v('p1', { n: 2222 }),
      novoDuplicado: false,
    });
    expect(mesclarEntradaPrecoLi(undefined, v('p1'))).toEqual({
      entrada: v('p1'),
      novoDuplicado: false,
    });
  });

  it('DISTINCT: another produto ⇒ `dup` of the FIRST, a new duplicate — from any flag; a `dup` stays `dup`', () => {
    expect(mesclarEntradaPrecoLi(v('p1'), v('p2'))).toEqual({
      entrada: { p: 'p1', f: 'dup' },
      novoDuplicado: true,
    });
    expect(mesclarEntradaPrecoLi({ p: 'p1', f: 'pai' }, v('p2'))).toEqual({
      entrada: { p: 'p1', f: 'dup' },
      novoDuplicado: true,
    });
    expect(mesclarEntradaPrecoLi({ p: 'p1', f: 'dup' }, v('p3'))).toEqual({
      entrada: { p: 'p1', f: 'dup' },
      novoDuplicado: false,
    });
  });
});

describe('the load — which contas are priced', () => {
  it('a root of THIS run ⇒ priced, with its tabelas; another run’s, one off its schema, or none ⇒ absent', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    semear(db, 'C2', RUN_B);
    db.seed(raiz('C3'), { execucaoPreco: { execucaoId: RUN_A } });
    const estados = await carregar(db, ['C1', 'C2', 'C3', 'C4']);
    expect([...estados.keys()]).toEqual(['C1']);
    expect(estados.get('C1')?.conta).toEqual({ idx: 0, contaId: 'C1', tabelas: TABELAS });
  });

  it('`todos` = ONE getAll of the roots, then ONE of the 32 buckets of the PRICED contas only; `nenhum` = the roots alone', async () => {
    const fake = new FakeDb();
    semear(fake, 'C1', RUN_A);
    semear(fake, 'C2', RUN_B);
    const { db, getAlls } = dbRastreadoLi(fake);
    const contas = [
      { idx: 0, contaId: 'C1' },
      { idx: 1, contaId: 'C2' },
    ];
    const estados = await carregarEstadosPrecoLi(db, RUN_A, contas, { baldes: 'todos' });
    expect(getAlls.map((g) => g.caminhos)).toEqual([
      [raiz('C1'), raiz('C2')],
      Array.from({ length: 32 }, (_, b) => balde('C1', String(b).padStart(2, '0'))),
    ]);
    expect(estados.get('C1')?.comBaldes).toBe(true);
    const so = getAlls.length;
    const raizes = await carregarEstadosPrecoLi(db, RUN_A, contas, { baldes: 'nenhum' });
    expect(getAlls.slice(so).map((g) => g.caminhos)).toEqual([[raiz('C1'), raiz('C2')]]);
    expect(raizes.get('C1')?.comBaldes).toBe(false);
    // No read at all for no conta, and none of the buckets when no conta is priced.
    const vazio = getAlls.length;
    await carregarEstadosPrecoLi(db, RUN_A, [], { baldes: 'todos' });
    await carregarEstadosPrecoLi(db, RUN_A, [{ idx: 0, contaId: 'C2' }], { baldes: 'todos' });
    expect(getAlls.slice(vazio).map((g) => g.caminhos)).toEqual([[raiz('C2')]]);
  });
});

describe('a bucket of another run is REPLACED at load, carrying `a`/`t` into `anteriores`', () => {
  it('another run’s bucket ⇒ `e` empty, every VALID entry’s `a` and `t` carried (absent keys omitted), marked to be written', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A, {
      '07': {
        execucaoId: RUN_B,
        e: {
          '7': v('p7', { a: { c: 1111, q: null } }),
          '39': v('p39', { t: true }),
          '71': v('p71', { a: { r: 'sem-preco' }, t: true }),
          '103': v('p103'),
          '135': { p: 'p135', f: 'pai' },
        },
      },
    });
    const e = await estadoDeC1(db);
    expect([...e.entradasDoBalde('07')]).toEqual([]);
    expect(dadosEm(e, balde('C1', '07'))).toEqual({
      execucaoId: RUN_A,
      e: {},
      anteriores: {
        '39': { tp: true },
        '7': { ap: { c: 1111, q: null } },
        '71': { ap: { r: 'sem-preco' }, tp: true },
      },
    });
  });

  it('this run’s bucket ⇒ kept as it is, not written; NEAR-MISS: a bucket off its schema ⇒ replaced with NOTHING carried', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A, {
      '07': {
        execucaoId: RUN_A,
        e: { '7': v('p7', { n: 1111 }) },
        anteriores: { '39': { tp: true } },
      },
      // Off its schema (a 0 reading) beside a VALID entry that does carry a target: nothing of
      // either is carried.
      '08': {
        execucaoId: RUN_B,
        e: { '8': { p: 'p8', f: 'v', n: 0 }, '40': v('p40', { a: { c: 1111, q: null }, t: true }) },
      },
    });
    const e = await estadoDeC1(db);
    expect(e.entrada('7')).toEqual(v('p7', { n: 1111 }));
    const caminhos = e.escritas().map((x) => x.ref.path);
    expect(caminhos).not.toContain(balde('C1', '07'));
    expect(dadosEm(e, balde('C1', '08'))).toEqual({
      execucaoId: RUN_A,
      e: {},
      anteriores: {},
    });
  });

  it('from a run that never priced an id (no `a`), its carried `ap` / `tp`; for an id it never re-wrote, its bucket’s own carry — NEAR-MISS: a priced entry’s old `tp` does not stick', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A, {
      '07': {
        execucaoId: RUN_B,
        e: {
          // Re-written by that run, which ended before its parents unit: the carry it took.
          '7': v('p7', { n: 2222, ap: { c: 1111, q: null }, tp: true }),
          // Priced by that run: ITS target; the deferral before it is not carried again.
          '39': v('p39', { a: { c: 3333, q: null }, ap: { c: 1111, q: null }, tp: true }),
          // A non-valid entry carries nothing, its own carry included.
          '71': { p: 'p71', f: 'pai' },
        },
        anteriores: {
          // Never re-written by that run: what its bucket still carried.
          '103': { ap: { c: 4444, q: 999 } },
          '71': { ap: { c: 5555, q: null } },
        },
      },
    });
    const e = await estadoDeC1(db);
    expect(dadosEm(e, balde('C1', '07'))?.anteriores).toEqual({
      '103': { ap: { c: 4444, q: 999 } },
      '39': { ap: { c: 3333, q: null } },
      '7': { ap: { c: 1111, q: null }, tp: true },
    });
  });

  it('one unfinished run between two never drops the carry: R1 prices, R2 faults on the conta, R3 still carries R1’s target', async () => {
    const R3 = 'estoque-reconcile-20270117';
    const db = new FakeDb();
    // R1 (RUN_B) finished: its targets stand in the bucket.
    semear(db, 'C1', RUN_A, {
      '07': {
        execucaoId: RUN_B,
        e: {
          '7': v('p7', { a: { c: 1111, q: null } }),
          '39': v('p39', { a: { c: 2222, q: null } }),
        },
      },
    });
    // R2 (RUN_A) re-writes id 7 and faults before its parents unit: no target of its own.
    const r2 = await estadoDeC1(db);
    r2.aplicar('7', v('p7', { n: 3333 }));
    for (const w of r2.escritas()) {
      if (w.tipo === 'gravar') db.seed(w.ref.path, { ...(db.ler(w.ref.path) ?? {}), ...w.dados });
    }
    // R3 loads R2's bucket.
    db.seed(raiz('C1'), {
      execucaoPreco: {
        execucaoId: R3,
        tabelas: TABELAS,
        amostras: {},
        contadores: {},
        candidatos: [],
        mantidos: [],
      },
    });
    const r3 = (
      await carregarEstadosPrecoLi(asDb(db), R3, [{ idx: 0, contaId: 'C1' }], { baldes: 'todos' })
    ).get('C1');
    if (r3 === undefined) throw new Error('C1 não carregada por R3');
    expect(dadosEm(r3, balde('C1', '07'))?.anteriores).toEqual({
      '39': { ap: { c: 2222, q: null } },
      '7': { ap: { c: 1111, q: null } },
    });
  });

  it('an ABSENT bucket ⇒ written too: the first ERP slice writes all 32', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    const e = await estadoDeC1(db);
    expect(e.escritas()).toHaveLength(32);
    expect(e.escritas().every((x) => x.tipo === 'gravar' && x.versao === null)).toBe(true);
  });
});

describe('aplicar — the carry is consumed by the id it belongs to', () => {
  async function comAnteriores(): Promise<EstadoContaPrecoLi> {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A, {
      '07': {
        execucaoId: RUN_B,
        e: {
          '7': v('p7', { a: { c: 1111, q: null }, t: true }),
          '39': v('p39', { a: { c: 2222, q: 999 } }),
        },
      },
    });
    return estadoDeC1(db);
  }

  it('a re-written `v` takes `ap` / `tp` and REMOVES its key; NEAR-MISS: another id’s `v` leaves the key', async () => {
    const e = await comAnteriores();
    e.aplicar('7', v('p7', { n: 3333 }));
    expect(e.entrada('7')).toEqual(v('p7', { n: 3333, ap: { c: 1111, q: null }, tp: true }));
    const dados = dadosEm(e, balde('C1', '07'));
    expect(dados?.anteriores).toEqual({ '39': { ap: { c: 2222, q: 999 } } });
  });

  it('a non-`v` entry carries nothing and leaves the key', async () => {
    const e = await comAnteriores();
    e.aplicar('7', { p: 'p7', f: FLAG_ENTRADA_PRECO_LI.pai });
    expect(e.entrada('7')).toEqual({ p: 'p7', f: 'pai' });
    expect(dadosEm(e, balde('C1', '07'))?.anteriores).toEqual({
      '39': { ap: { c: 2222, q: 999 } },
      '7': { ap: { c: 1111, q: null }, tp: true },
    });
  });

  it('the SAME produto re-evaluated on a later page keeps the `ap` / `tp` it took; it is no duplicate', async () => {
    const e = await comAnteriores();
    expect(e.aplicar('7', v('p7', { n: 3333 }))).toBe(false);
    expect(e.aplicar('7', v('p7', { n: 4444 }))).toBe(false);
    expect(e.entrada('7')).toEqual(v('p7', { n: 4444, ap: { c: 1111, q: null }, tp: true }));
    expect(e.contador('duplicados')).toBe(0);
  });

  it('two produtos on one store id ⇒ `dup` (counted once); a third adds nothing', async () => {
    const e = await comAnteriores();
    e.aplicar('71', v('pa'));
    expect(e.aplicar('71', v('pb'))).toBe(true);
    expect(e.aplicar('71', v('pc'))).toBe(false);
    expect(e.entrada('71')).toEqual({ p: 'pa', f: 'dup' });
    expect(e.contador('duplicados')).toBe(1);
  });

  it('`anteriores` is ALWAYS written whole — an emptied one as `{}`, and `limparAnteriores` empties every bucket', async () => {
    const e = await comAnteriores();
    e.aplicar('7', v('p7'));
    e.aplicar('39', v('p39'));
    expect(dadosEm(e, balde('C1', '07'))?.anteriores).toEqual({});
    const outro = await comAnteriores();
    outro.limparAnteriores();
    expect(dadosEm(outro, balde('C1', '07'))?.anteriores).toEqual({});
  });
});

describe('counters, samples, targets and the write back', () => {
  it('counters and samples live in the conta’s root (`execucaoPreco`), deduplicated and capped', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    const e = await estadoDeC1(db);
    e.contar('validos', 2);
    e.contar('validos');
    e.contar('nada', 0);
    e.amostrar('retido', ['p2', 'p1', 'p2']);
    expect(dadosEm(e, raiz('C1'))).toMatchObject({
      execucaoPreco: { contadores: { validos: 3 }, amostras: { retido: ['p2', 'p1'] } },
    });
    expect(e.amostra('retido')).toEqual(['p1', 'p2']);
  });

  it('definirAlvo only on a valid entry (a RangeError otherwise); encerrar writes the end and clears the cursor', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    const e = await estadoDeC1(db);
    e.aplicar('7', v('p7', { n: 1111 }));
    e.aplicar('8', { p: 'p8', f: FLAG_ENTRADA_PRECO_LI.naoSuportado });
    e.definirAlvo('7', { c: 1111, q: null });
    expect(e.entrada('7')?.a).toEqual({ c: 1111, q: null });
    expect(() => {
      e.definirAlvo('8', { c: 1, q: null });
    }).toThrow(RangeError);
    e.encerrar({
      execucaoId: RUN_A,
      iniciadoEmMs: 1,
      concluidoEmMs: 2,
      tabelas: TABELAS,
      contadores: { validos: 1 },
    });
    expect(dadosEm(e, raiz('C1'))).toMatchObject({
      reconcilePreco: null,
      ultimoReconcilePreco: { execucaoId: RUN_A, tabelas: TABELAS, contadores: { validos: 1 } },
    });
  });

  it('`contar(nome, 0)` adds no key and dirties nothing: a slice that only counts zeros writes no price document', async () => {
    const db = new FakeDb();
    db.seed(raiz('C1'), {
      execucaoPreco: {
        execucaoId: RUN_A,
        tabelas: TABELAS,
        amostras: {},
        contadores: { validos: 2 },
        candidatos: [],
        mantidos: [],
      },
    });
    const e = (await carregar(db, ['C1'], 'nenhum')).get('C1');
    if (e === undefined) throw new Error('C1 não carregada');
    e.contar('paisAusentes', 0);
    expect(e.raiz.execucaoPreco.contadores).toEqual({ validos: 2 });
    expect(e.escritas()).toEqual([]);
  });

  it('after the batch lands nothing is left to write, and the next write is under the new stamp', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    const e = await estadoDeC1(db);
    e.contar('validos');
    const escritas = e.escritas();
    expect(escritas.length).toBeGreaterThan(0);
    const carimbo = db.seed('qualquer/coisa', {});
    e.gravado(new Map(escritas.map((x) => [x.ref.path, carimbo as never])));
    expect(e.escritas()).toEqual([]);
    e.contar('validos');
    const [proxima] = e.escritas();
    expect(proxima?.tipo === 'gravar' ? proxima.versao : null).toBe(carimbo);
  });
});

describe('the commit’s bytes — Firestore’s storage formula, and the price share of one commit', () => {
  it('bytesArmazenadosLi: null and a boolean 1, a number 8, a string UTF-8 + 1, an array its elements, a map its keys and values', () => {
    expect(bytesArmazenadosLi(null)).toBe(1);
    expect(bytesArmazenadosLi(true)).toBe(1);
    expect(bytesArmazenadosLi(1111)).toBe(8);
    expect(bytesArmazenadosLi(0.5)).toBe(8);
    expect(bytesArmazenadosLi('ab')).toBe(3);
    // Multi-byte text counts its UTF-8 bytes, never its length.
    expect(bytesArmazenadosLi('é')).toBe(3);
    expect(bytesArmazenadosLi([1, 'a'])).toBe(10);
    expect(bytesArmazenadosLi({ p: 'p7', f: 'v', n: 2222 })).toBe(2 + 3 + 2 + 2 + 2 + 8);
    expect(bytesArmazenadosLi({ a: { c: 1, q: null } })).toBe(2 + 2 + 8 + 2 + 1);
    expect(bytesArmazenadosLi(undefined)).toBe(0);
  });

  it('bytesDaEscritaPrecoLi: the whole document — its name (each segment + 1, plus 16), the fixed 32 and its fields', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    const e = await estadoDeC1(db);
    e.contar('validos');
    const w = e.escritas().find((x) => x.ref.path === raiz('C1'));
    if (w === undefined || w.tipo === 'apagar') throw new Error('sem escrita da raiz');
    const nome = 'sincPrecoLojaIntegrada'.length + 1 + 'C1'.length + 1 + 16;
    expect(bytesDaEscritaPrecoLi(w)).toBe(nome + 32 + bytesArmazenadosLi(w.dados));
  });

  it('conterBytesDoLotePrecoLi: in run order, EXACTLY the budget fits; one byte under drops the conta that passes it, whose root still counts', async () => {
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    semear(db, 'C2', RUN_A);
    const estados = await carregar(db, ['C1', 'C2']);
    const c1 = estados.get('C1');
    const c2 = estados.get('C2');
    if (c1 === undefined || c2 === undefined) throw new Error('contas não carregadas');
    c1.contar('validos');
    c2.contar('validos');
    const total = c1.bytesPendentes() + c2.bytesPendentes();
    const fora: string[] = [];
    const descartar = (e: EstadoContaPrecoLi): void => {
      fora.push(e.conta.contaId);
      e.descartarBaldesPendentes();
    };
    // Handed C2 first: the RUN's order (C1 at 0, C2 at 1) decides, never the iterable's.
    conterBytesDoLotePrecoLi([c2, c1], total, descartar);
    expect(fora).toEqual([]);
    conterBytesDoLotePrecoLi([c2, c1], total - 1, descartar);
    expect(fora).toEqual(['C2']);
    // C2 kept its root only: the 32 buckets are no longer written this slice.
    expect(c2.escritas().map((x) => x.ref.path)).toEqual([raiz('C2')]);
    expect(c1.escritas()).toHaveLength(33);
  });
});

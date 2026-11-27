/**
 * `estadoPrecoReconcile.ts` (master plan step 13, PR 13-f1): the per-conta price state of one
 * slice — which contas are priced, the replace at load and its carry (`anteriores`), the entry
 * precedence, and what the state writes back. Against `testing/fakeDb.ts`; invented ids and
 * prices.
 */
import { describe, expect, it } from 'vitest';
import { type EntradaSnapshotPrecoLi, FLAG_ENTRADA_PRECO_LI } from '@delfrance/schemas';

import { FakeDb, asDb } from '../../testing/fakeDb';
import { RUN_A, RUN_B } from '../../testing/reconcileEstoqueLi';
import {
  type EstadoContaPrecoLi,
  carregarEstadosPrecoLi,
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
    const db = new FakeDb();
    semear(db, 'C1', RUN_A);
    semear(db, 'C2', RUN_B);
    const antes = db.leituras.length;
    const estados = await carregar(db, ['C1', 'C2']);
    const lidas = db.leituras.slice(antes);
    expect(lidas.slice(0, 2)).toEqual([raiz('C1'), raiz('C2')]);
    expect(lidas.slice(2)).toEqual(
      Array.from({ length: 32 }, (_, b) => balde('C1', String(b).padStart(2, '0'))),
    );
    expect(estados.get('C1')?.comBaldes).toBe(true);
    const so = db.leituras.length;
    const raizes = await carregar(db, ['C1', 'C2'], 'nenhum');
    expect(db.leituras.slice(so)).toEqual([raiz('C1'), raiz('C2')]);
    expect(raizes.get('C1')?.comBaldes).toBe(false);
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
      '08': { execucaoId: RUN_B, e: { '8': { p: 'p8', f: 'v', n: 0 } } },
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

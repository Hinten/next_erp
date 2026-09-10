import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { resolverProdutoPorSku } from './resolveProdutoPorSku';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
/**
 * Same shape as the `produtos` half of
 * `apps/mercado-livre/lib/marketplace/pedidos/orderProdutoResolve.test.ts`,
 * where this stage lived until #1513 — packages/data cannot import from apps/,
 * and per-suite in-memory fakes are this repo's convention
 * (`findOrCreateCliente.test.ts`, `pedidoReconcile.test.ts`).
 *
 * ⚠️ `limit` is `hits.slice(0, n)` over an insertion-ordered `Map`, so `seed`
 * order IS index order. That is what makes the `it.each` pairs below
 * meaningful: under a `limit(1)` regression the two seed orders bind DIFFERENT
 * produtos, so they cannot both stay green.
 *
 * ⚠️ Clause matching folds an absent field into `null`, mirroring the ML
 * double. Real Firestore does not (`where('paiId','==',null)` matches a stored
 * null only), but `produtoSchema` stores `paiId` on every document, so the
 * difference is unreachable — and every fixture here sets it explicitly.
 */
type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  /** Every query issued, in order — lets a test assert the read COUNT and shape. */
  readonly queries: Array<{
    source: string;
    clauses: Array<[string, unknown]>;
    limit: number | null;
  }> = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(id: string, data: DocData): void {
    this.col('produtos').set(id, data);
  }

  private query(source: string, rows: Array<[string, DocData]>) {
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
    const self = this;
    const q = {
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async get() {
        self.queries.push({ source, clauses: [...clauses], limit: lim });
        let hits = rows.filter(([, d]) =>
          clauses.every(([f, v]) => (d[f] ?? null) === (v ?? null)),
        );
        if (lim != null) hits = hits.slice(0, lim);
        return {
          docs: hits.map(([id, d]) => ({ id, exists: true, data: () => d })),
          empty: hits.length === 0,
        };
      },
    };
    return q;
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      where: (field: string, op: string, value: unknown) =>
        self.query(path, [...col.entries()]).where(field, op, value),
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;
const consultas = (db: FakeDb) => db.queries.filter((q) => q.source === 'produtos');

/** The channel prefix is the only thing `canal` does; ML's is the pinned one. */
const ML = 'mercado-livre';

beforeEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                         rung 1 — sku-child (scoped)                        */
/* -------------------------------------------------------------------------- */

describe('resolverProdutoPorSku — rung sku-child', () => {
  it('binds the single child of the produto the caller already resolved', async () => {
    const db = new FakeDb();
    db.seed('filho-1', { sku: 'DUP', paiId: 'pai-1' });
    db.seed('raiz-outra', { sku: 'DUP', paiId: null });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'DUP', paiId: 'pai-1', canal: ML });

    expect(out).toEqual({ produtoId: 'filho-1', via: 'sku-child' });
    // ONE query: the rung hit, so nothing widened to the root that also carries `DUP`.
    expect(consultas(db)).toHaveLength(1);
    expect(consultas(db)[0]!.clauses).toEqual([
      ['sku', 'DUP'],
      ['paiId', 'pai-1'],
    ]);
    expect(consultas(db)[0]!.limit).toBe(2);
  });

  it.each([
    ['A primeiro', ['filho-A', 'filho-B']],
    ['B primeiro', ['filho-B', 'filho-A']],
  ] as const)(
    '⚠️ NEAR-MISS: dois filhos do mesmo pai com o MESMO sku não vinculam nada (%s)',
    async (_rotulo, ordemDeSeed) => {
      const db = new FakeDb();
      for (const id of ordemDeSeed) db.seed(id, { sku: 'DUP', paiId: 'pai-1' });
      // A root that WOULD match if the stage widened instead of ending.
      db.seed('raiz-dup', { sku: 'DUP', paiId: null });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const out = await resolverProdutoPorSku(asDb(db), { sku: 'DUP', paiId: 'pai-1', canal: ML });

      expect(out).toEqual({ produtoId: null, via: 'ambiguous-sku' });
      // ONE query: the stage ENDED here. Without the count a fall-through
      // implementation would look identical — the root rung would bind
      // `raiz-dup` and the verdict would differ, but a test that only asserted
      // "not bound" would pass either way.
      expect(consultas(db)).toHaveLength(1);
      expect(warn.mock.calls[0]![1]).toMatchObject({
        rung: 'sku-child',
        produtoIds: [...ordemDeSeed],
      });
    },
  );

  it('⚠️ NEAR-MISS: sem paiId o degrau nem roda — o filho de OUTRO pai não é candidato aqui', async () => {
    const db = new FakeDb();
    db.seed('filho-1', { sku: 'SO-FILHO', paiId: 'pai-1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'SO-FILHO', paiId: null, canal: ML });

    // It is the UNSCOPED rung that answers, and it says so — `sku-any` carries a
    // warning `sku-child` does not, because nothing verified the parent.
    expect(out).toEqual({ produtoId: 'filho-1', via: 'sku-any' });
    // root (miss) → unscoped (hit). The scoped rung contributed no query.
    expect(consultas(db)).toHaveLength(2);
    expect(consultas(db)[0]!.clauses).toEqual([
      ['sku', 'SO-FILHO'],
      ['paiId', null],
    ]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('apenas pelo SKU'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                    rung 2 — sku-root, and the family hop                   */
/* -------------------------------------------------------------------------- */

describe('resolverProdutoPorSku — rung sku-root', () => {
  it('reporta sku-root para uma raiz comum', async () => {
    const db = new FakeDb();
    db.seed('raiz', { sku: 'UNI', paiId: null, filhoUnicoId: null });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'UNI', paiId: null, canal: ML });

    // The `via` must stay `sku-root` when nothing was re-pointed — it is
    // persisted diagnostic and a reader distinguishes the two cases by it.
    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
    expect(consultas(db)).toHaveLength(1);
  });

  it('vincula o MEMBRO quando a raiz é uma família de um', async () => {
    const db = new FakeDb();
    db.seed('pai-1', { sku: 'BAN-1', paiId: null, filhoUnicoId: 'membro-unico' });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'BAN-1', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'membro-unico', via: 'sku-membro-unico' });
    // ⚠️ No extra read: the family fields ride along on the probe the rung already ran.
    expect(consultas(db)).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: um filhoUnicoId VAZIO não é um ponteiro', async () => {
    const db = new FakeDb();
    db.seed('raiz', { sku: 'UNI', paiId: null, filhoUnicoId: '' });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'UNI', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
  });

  it.each([
    ['A primeiro', ['raiz-A', 'raiz-B']],
    ['B primeiro', ['raiz-B', 'raiz-A']],
  ] as const)(
    '⚠️ NEAR-MISS: duas raízes com o mesmo sku não vinculam nada (%s)',
    async (_rotulo, ordemDeSeed) => {
      const db = new FakeDb();
      for (const id of ordemDeSeed) db.seed(id, { sku: 'RAIZ-DUP', paiId: null });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const out = await resolverProdutoPorSku(asDb(db), {
        sku: 'RAIZ-DUP',
        paiId: null,
        canal: ML,
      });

      expect(out).toEqual({ produtoId: null, via: 'ambiguous-sku' });
      // ONE query: the stage ended. `sku-any` would have seen the same two roots
      // and also declined, so only the count separates the two implementations.
      expect(consultas(db)).toHaveLength(1);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                       ⛔ the kit guard, both directions                     */
/* -------------------------------------------------------------------------- */

/**
 * A kit's sole member is a MIRROR of the parent, and the three-way merge
 * deliberately leaves a field the operator diverged alone — so parent and member
 * can legitimately disagree, and the parent is the document that owns the
 * composition an operator edits. Binding the member reads a copy.
 */
describe('resolverProdutoPorSku — um KIT fica no pai', () => {
  it('⛔ vincula o KIT, não o seu membro único', async () => {
    const db = new FakeDb();
    db.seed('kit-1', {
      sku: 'KIT-SKU',
      paiId: null,
      ehKit: true,
      filhoUnicoId: 'membro-1',
      componentesKit: { 'comp-a': { quantidade: 6 } },
    });
    db.seed('membro-1', { sku: 'KIT-SKU', paiId: 'kit-1', ehKit: true });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'KIT-SKU', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'kit-1', via: 'sku-root' });
  });

  it('⚠️ NEAR-MISS: a MESMA forma sem ehKit continua redirecionando', async () => {
    const db = new FakeDb();
    db.seed('p-1', { sku: 'SKU-1', paiId: null, ehKit: false, filhoUnicoId: 'membro-1' });
    db.seed('membro-1', { sku: 'SKU-1', paiId: 'p-1', ehKit: false });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'SKU-1', paiId: null, canal: ML });

    // Without this half the kit guard would have swallowed the fix it guards.
    expect(out).toEqual({ produtoId: 'membro-1', via: 'sku-membro-unico' });
  });

  it('⚠️ NEAR-MISS: ehKit só é verdadeiro para o booleano true, não para uma string', async () => {
    const db = new FakeDb();
    db.seed('p-1', { sku: 'SKU-1', paiId: null, ehKit: 'true', filhoUnicoId: 'membro-1' });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'SKU-1', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'membro-1', via: 'sku-membro-unico' });
  });
});

/* -------------------------------------------------------------------------- */
/*             rung 3 — the stripped probe, and the fold's SCOPE              */
/* -------------------------------------------------------------------------- */

/**
 * ⛔ A sole member's sku is DERIVED (`<paiSku>-UN`) and the member is what
 * publish sends, so for a família de um the incoming string matches NO root.
 *
 * The fold here is `skuPaiDoMembroUnico` — an inverse string transform. It is a
 * CANDIDATE, never the decision: the gate is `ehFamiliaDeUm`, i.e. `filhoUnicoId`.
 */
describe('resolverProdutoPorSku — o sufixo do membro único', () => {
  it('vincula o FILHO de uma família de um, pelo degrau guardado', async () => {
    const db = new FakeDb();
    db.seed('pai-1', { sku: 'BAN-1', paiId: null, filhoUnicoId: 'membro-unico' });
    db.seed('membro-unico', { sku: 'BAN-1-UN', paiId: 'pai-1' });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'BAN-1-UN', paiId: null, canal: ML });

    // ⚠️ The `via` is the assertion that matters, not the id: the unscoped rung
    // reaches the SAME produto by matching the member's own sku and reports
    // `sku-any`. A test asserting only `produtoId` passes with this rung deleted.
    expect(out).toEqual({ produtoId: 'membro-unico', via: 'sku-pai-do-membro' });
  });

  it('⛔ mantém um KIT no pai, para a venda ainda expandir componentesKit', async () => {
    const db = new FakeDb();
    db.seed('pai-kit', { sku: 'KIT-1', paiId: null, ehKit: true, filhoUnicoId: 'membro-kit' });
    // The member EXISTS and carries the sku the marketplace sent, so the
    // unscoped rung would happily bind it — the wrong answer being guarded.
    db.seed('membro-kit', { sku: 'KIT-1-UN', paiId: 'pai-kit', ehKit: true });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'KIT-1-UN', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'pai-kit', via: 'sku-pai-do-membro' });
  });

  /**
   * ⛔ THE near-miss, and the one the rung was originally shipped without.
   *
   * `cartesianVariations` builds a variation child as `parentSku + codigo`, so a
   * variante whose código is `-UN` produces a sku byte-identical to what a sole
   * member of the same parent would carry. Stripping cannot tell them apart —
   * only `filhoUnicoId` can.
   */
  it('⛔ NEAR-MISS: NÃO vincula o pai quando o sku é de uma variação de uma família de MUITOS', async () => {
    const db = new FakeDb();
    db.seed('pai-muitos', { sku: 'CAM', paiId: null, filhoUnicoId: null });
    db.seed('filho-un', { sku: 'CAM-UN', paiId: 'pai-muitos' });
    db.seed('filho-p', { sku: 'CAM-P', paiId: 'pai-muitos' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'CAM-UN', paiId: null, canal: ML });

    // The unscoped rung finds the real variation child — the produto that holds
    // the stock — instead of the wrapper the stripped probe would have named.
    expect(out).toEqual({ produtoId: 'filho-un', via: 'sku-any' });
  });

  it('cai adiante quando o sku ESTRIPADO é ambíguo, em vez de recusar', async () => {
    const db = new FakeDb();
    db.seed('raiz-a', { sku: 'DUP', paiId: null, filhoUnicoId: null });
    db.seed('raiz-b', { sku: 'DUP', paiId: null, filhoUnicoId: null });
    // ⚠️ A CHILD, so the first root probe misses and the stripped one is really
    // the rung under test. As a root it would match directly.
    db.seed('exato', { sku: 'DUP-UN', paiId: 'raiz-a' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'DUP-UN', paiId: null, canal: ML });

    // The ambiguity would be about `DUP` — a string nobody sent.
    expect(out).toEqual({ produtoId: 'exato', via: 'sku-any' });
  });

  it('⚠️ NEAR-MISS (custo): um sku SEM o sufixo não paga a segunda leitura', async () => {
    const db = new FakeDb();
    db.seed('raiz', { sku: 'UNI', paiId: null, filhoUnicoId: null });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'UNI', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
    expect(consultas(db)).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: uma raiz que POSSUI um sku terminado no sufixo ganha antes da tira', async () => {
    const db = new FakeDb();
    db.seed('raiz-un', { sku: 'PARAFUSO-UN', paiId: null, filhoUnicoId: null });
    db.seed('pai-parafuso', { sku: 'PARAFUSO', paiId: null, filhoUnicoId: 'membro-parafuso' });

    const out = await resolverProdutoPorSku(asDb(db), {
      sku: 'PARAFUSO-UN',
      paiId: null,
      canal: ML,
    });

    // The unstripped root rung answered; `pai-parafuso` — a real família de um
    // whose derived member sku is exactly this string — is never asked about.
    expect(out).toEqual({ produtoId: 'raiz-un', via: 'sku-root' });
    expect(consultas(db)).toHaveLength(1);
  });

  it('⚠️ NEAR-MISS: um sku que é SÓ o sufixo não vira uma identidade vazia', async () => {
    const db = new FakeDb();
    db.seed('raiz-vazia', { sku: '', paiId: null, filhoUnicoId: 'membro-x' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: '-UN', paiId: null, canal: ML });

    // `skuPaiDoMembroUnico('-UN')` refuses rather than answering `''`, so the
    // stripped rung never runs and the empty-sku root is not claimed.
    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
    expect(consultas(db).map((q) => q.clauses)).toEqual([
      [
        ['sku', '-UN'],
        ['paiId', null],
      ],
      [['sku', '-UN']],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                   what the rungs do NOT fold: the sku itself               */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ The rungs compare the sku VERBATIM — no trim, no case fold, no accent fold.
 * That is deliberate and it is the ML behaviour being preserved: the sku is an
 * operator-typed identity, and folding it would let two distinct produtos claim
 * one marketplace line.
 */
describe('resolverProdutoPorSku — o sku vai VERBATIM para a consulta', () => {
  it.each([
    ['espaço à esquerda', ' BAN-1'],
    ['espaço à direita', 'BAN-1 '],
    ['caixa diferente', 'ban-1'],
  ] as const)('⚠️ NEAR-MISS: %s não casa com BAN-1', async (_rotulo, skuRecebido) => {
    const db = new FakeDb();
    db.seed('raiz', { sku: 'BAN-1', paiId: null, filhoUnicoId: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), {
      sku: skuRecebido,
      paiId: null,
      canal: ML,
    });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
    expect(consultas(db)[0]!.clauses[0]).toEqual(['sku', skuRecebido]);
  });

  it('o par que DEVE casar: a string idêntica', async () => {
    const db = new FakeDb();
    db.seed('raiz', { sku: 'BAN-1', paiId: null, filhoUnicoId: null });

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'BAN-1', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'raiz', via: 'sku-root' });
  });

  /**
   * ⚠️ The ONE place whitespace does something, and it is worth knowing before
   * someone "tidies" it: `skuPaiDoMembroUnico` trims INTERNALLY, so a padded sku
   * produces a stripped candidate that differs from the incoming string and the
   * third rung runs — with the trimmed value. Inherited from the ML original;
   * pinned so a future trim added to the rungs themselves shows up as a change
   * in verdict rather than only in read count.
   */
  it('⚠️ ESCOPO: o inverso APARA, os degraus não — um sku com espaço paga a terceira leitura', async () => {
    const db = new FakeDb();
    db.seed('pai-1', { sku: 'BAN-1', paiId: null, filhoUnicoId: 'membro-unico' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'BAN-1 ', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: 'membro-unico', via: 'sku-pai-do-membro' });
    expect(consultas(db).map((q) => q.clauses)).toEqual([
      [
        ['sku', 'BAN-1 '],
        ['paiId', null],
      ],
      [
        ['sku', 'BAN-1'],
        ['paiId', null],
      ],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                       rung 4 — unscoped, and the misses                    */
/* -------------------------------------------------------------------------- */

describe('resolverProdutoPorSku — degrau irrestrito e as recusas', () => {
  it('vincula o que casou e AVISA, porque nada verificou o vínculo', async () => {
    const db = new FakeDb();
    db.seed('estranho', { sku: 'ODD', paiId: 'algum-pai', filhoUnicoId: 'nao-seguir' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'ODD', paiId: null, canal: ML });

    // ⚠️ This rung binds what it matched WITHOUT resolving the family hop: it can
    // match a child, so `unidadeVendavel` would be reading a produto the probe
    // never projected `paiId` for. `filhoUnicoId: 'nao-seguir'` is the fixture
    // that makes a leaked hop visible.
    expect(out).toEqual({ produtoId: 'estranho', via: 'sku-any' });
    const aviso = warn.mock.calls.find((c) => String(c[0]).includes('apenas pelo SKU'));
    expect(aviso?.[1]).toMatchObject({ sku: 'ODD', produtoId: 'estranho' });
  });

  it('dois produtos de outros pais com o mesmo sku não vinculam nada', async () => {
    const db = new FakeDb();
    db.seed('orfao-A', { sku: 'SO-SKU', paiId: 'pai-desconhecido' });
    db.seed('orfao-B', { sku: 'SO-SKU', paiId: 'outro-pai' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'SO-SKU', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: null, via: 'ambiguous-sku' });
    // root (0 hits, fell through) → unscoped (stopped).
    expect(consultas(db)).toHaveLength(2);
    const ambiguo = warn.mock.calls.find((c) => String(c[0]).includes('mais de um produto'));
    expect(ambiguo?.[1]).toMatchObject({ rung: 'sku-any', produtoIds: ['orfao-A', 'orfao-B'] });
    // The single-hit warn must NOT fire: nothing bound.
    expect(warn.mock.calls.some((c) => String(c[0]).includes('apenas pelo SKU'))).toBe(false);
  });

  it('nada casa ⇒ unresolved, e nenhum aviso', async () => {
    const db = new FakeDb();
    db.seed('outro', { sku: 'X', paiId: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resolverProdutoPorSku(asDb(db), { sku: 'Y', paiId: null, canal: ML });

    expect(out).toEqual({ produtoId: null, via: 'unresolved' });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string vazia', ''],
  ] as const)(
    '⚠️ NEAR-MISS: sku %s não roda consulta nenhuma — o filtro vazio casaria com o catálogo inteiro',
    async (_rotulo, skuRecebido) => {
      const db = new FakeDb();
      db.seed('raiz', { sku: '', paiId: null });

      const out = await resolverProdutoPorSku(asDb(db), {
        sku: skuRecebido,
        paiId: null,
        canal: ML,
      });

      expect(out).toEqual({ produtoId: null, via: 'unresolved' });
      expect(consultas(db)).toHaveLength(0);
    },
  );

  it('⚠️ as duas recusas são estruturalmente IDÊNTICAS — os ids colidentes não vazam no valor', async () => {
    const db = new FakeDb();
    db.seed('a', { sku: 'DUP', paiId: null });
    db.seed('b', { sku: 'DUP', paiId: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ambiguo = await resolverProdutoPorSku(asDb(db), { sku: 'DUP', paiId: null, canal: ML });
    const semNada = await resolverProdutoPorSku(asDb(db), {
      sku: 'NAO-EXISTE',
      paiId: null,
      canal: ML,
    });

    // Same key set, different `via` — callers narrow on `produtoId` and read
    // `via`; a stray `ids` field would make one verdict non-comparable with the
    // other and break `toEqual` on the ML side.
    expect(Object.keys(ambiguo).sort()).toEqual(['produtoId', 'via']);
    expect(Object.keys(semNada).sort()).toEqual(['produtoId', 'via']);
  });
});

/* -------------------------------------------------------------------------- */
/*                        `canal` and `contexto`: logs only                    */
/* -------------------------------------------------------------------------- */

describe('resolverProdutoPorSku — canal e contexto', () => {
  it('o canal prefixa os DOIS avisos e nunca entra numa cláusula', async () => {
    const db = new FakeDb();
    db.seed('orfao-A', { sku: 'SO-SKU', paiId: 'p1' });
    db.seed('orfao-B', { sku: 'SO-SKU', paiId: 'p2' });
    db.seed('unico', { sku: 'OUTRO', paiId: 'p3' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await resolverProdutoPorSku(asDb(db), { sku: 'SO-SKU', paiId: null, canal: 'shopee' });
    await resolverProdutoPorSku(asDb(db), { sku: 'OUTRO', paiId: null, canal: 'shopee' });

    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      '[shopee] SKU do item corresponde a mais de um produto — não vinculado',
      '[shopee] produto do item resolvido apenas pelo SKU (sem vínculo)',
    ]);
    // ⚠️ NEAR-MISS: the channel is a LOG prefix, never a filter — a `canal`
    // clause would make every rung scan a field `produtos` does not have.
    for (const q of consultas(db)) {
      expect(q.clauses.map(([f]) => f)).not.toContain('canal');
    }
  });

  it('o contexto viaja nos dois avisos, sem substituir sku/rung/produtoIds', async () => {
    const db = new FakeDb();
    db.seed('orfao-A', { sku: 'SO-SKU', paiId: 'p1' });
    db.seed('orfao-B', { sku: 'SO-SKU', paiId: 'p2' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await resolverProdutoPorSku(asDb(db), {
      sku: 'SO-SKU',
      paiId: null,
      canal: ML,
      contexto: { itemId: 'MLB1', variationId: '456', sku: 'IGNORADO' },
    });

    // The contexto is spread FIRST, so the resolver's own fields win a collision
    // — a caller cannot make the log lie about which sku was queried.
    expect(warn.mock.calls[0]![1]).toEqual({
      itemId: 'MLB1',
      variationId: '456',
      sku: 'SO-SKU',
      rung: 'sku-any',
      produtoIds: ['orfao-A', 'orfao-B'],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                       the limit(2) ambiguity detector                      */
/* -------------------------------------------------------------------------- */

it('⚠️ TODO degrau roda sob limit(2) — o segundo documento é o SINAL, nunca um candidato', async () => {
  const db = new FakeDb();
  // Nothing matches, so every rung runs and every limit is observable.
  db.seed('irrelevante', { sku: 'ZZZ', paiId: null });

  await resolverProdutoPorSku(asDb(db), { sku: 'ABC-UN', paiId: 'pai-1', canal: ML });

  expect(consultas(db).map((q) => q.limit)).toEqual([2, 2, 2, 2]);
  expect(consultas(db).map((q) => q.clauses)).toEqual([
    [
      ['sku', 'ABC-UN'],
      ['paiId', 'pai-1'],
    ],
    [
      ['sku', 'ABC-UN'],
      ['paiId', null],
    ],
    [
      ['sku', 'ABC'],
      ['paiId', null],
    ],
    [['sku', 'ABC-UN']],
  ]);
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import {
  MAX_DRAFTS_PER_FAMILY,
  PLAN_PAGE_DRAFTS_CAP,
  PRICE_SYNC_FAILURES_CAP,
  PRICE_SYNC_MAX_PAUSES,
  PRICE_SYNC_SKIPS_CAP,
  type PrecoFamilyChild,
  type PrecoFamilyRow,
  type PrecoLinkRow,
  buildPrecoDrafts,
  fetchPrecoFamiliasByIds,
  fetchPrecoPage,
  podeEnviarPreco,
  precoItemsPerDispatch,
  precoPageLimit,
  precoRatePauseMin,
} from './precoPlan';

/* ------------------------------ fake Firestore ----------------------------- */
// fetchPrecoPage runs CLASSIC queries only (no pipelines — the module doc's
// point), so the fake needs just chained where/orderBy(documentId)/startAfter/
// limit/select/get over seeded docs. Mirrors itemsStatusSync.test.ts, plus the
// query surface the keyset paging uses.

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  /**
   * Every executed query's collection path + clauses.
   *
   * The fake APPLIES `where` clauses but used to swallow them, so a test could
   * only observe which docs came back — and "the right docs came back" is
   * satisfied by a query with an extra term as long as the fixtures happen to
   * pass it. #1072 turns on the anchor query carrying exactly two terms (a
   * third breaks the declared index and silently full-scans on Enterprise),
   * so that has to be assertable directly.
   */
  readonly queries: Array<{ path: string; clauses: Array<{ field: string; op: string }> }> = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  collection(path: string) {
    const self = this;
    const col = this.col(path);
    const clauses: Array<{ field: string; op: string; value: unknown }> = [];
    let byDocId = false;
    let after: string | null = null;
    let max: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        clauses.push({ field, op, value });
        return q;
      },
      // Field masks are a bandwidth detail — the fake serves full docs.
      select(..._fields: string[]) {
        return q;
      },
      // Only FieldPath.documentId() ordering is used in this module.
      orderBy(_fieldPath: unknown) {
        byDocId = true;
        return q;
      },
      startAfter(id: string) {
        after = id;
        return q;
      },
      limit(n: number) {
        max = n;
        return q;
      },
      // `fetchPrecoFamiliasByIds` reads anchors by KEY — the ref only has to
      // carry enough for this fake's `getAll` to find the doc again.
      doc(id: string) {
        return { id, __col: path, __id: id };
      },
      async get() {
        self.queries.push({
          path,
          clauses: clauses.map(({ field, op }) => ({ field, op })),
        });
        let rows = [...col.entries()].filter(([, d]) =>
          clauses.every(({ field, op, value }) => matches(d[field], op, value)),
        );
        if (byDocId) rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (after != null) rows = rows.filter(([id]) => id > after!);
        if (max != null) rows = rows.slice(0, max);
        return {
          docs: rows.map(([id, d]) => ({ id, data: () => d })),
          empty: rows.length === 0,
          size: rows.length,
        };
      },
    };
    return q;
  }

  /** Batch key read — a missing document is simply ABSENT-flagged, never thrown. */
  getAll(...args: unknown[]) {
    const refs = args.filter(
      (a): a is { __col: string; __id: string } =>
        a != null && typeof a === 'object' && '__id' in a,
    );
    return Promise.resolve(
      refs.map((ref) => {
        const data = this.col(ref.__col).get(ref.__id);
        return { id: ref.__id, exists: data != null, data: () => data };
      }),
    );
  }
}

function matches(stored: unknown, op: string, value: unknown): boolean {
  switch (op) {
    case '==':
      return stored === value;
    case 'array-contains':
      return Array.isArray(stored) && stored.includes(value);
    case 'in':
      return Array.isArray(value) && value.includes(stored);
    default:
      throw new Error(`FakeDb: unsupported operator ${op}`);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures -------------------------------- */

const CONTA = 'conta-A';
const TAB = 'tabNormal1';
const OPTS = { integracaoId: CONTA, tabelaNormalId: TAB };
const PARENT_LINK_REF = 'documents/produtos/PROD/produtoMercadoLivre/link1';

/** Every env var the tests mutate — cleared after each test. */
const TOUCHED_ENV = [
  'MERCADO_LIVRE_PRECO_PAGE_LIMIT',
  'MERCADO_LIVRE_PRECO_ITEMS_PER_DISPATCH',
  'MERCADO_LIVRE_PRECO_RATE_PAUSE_MIN',
];

/** Seed a published family anchor linked to the conta. */
function seedAnchor(db: FakeDb, id: string, data: DocData = {}): void {
  db.seed('produtos', id, {
    paiId: null,
    publicado: true,
    integracoesComProduto: [CONTA],
    precos: { [TAB]: { valor: 10 } },
    ...data,
  });
}

/** Seed one `produtoMercadoLivre` link doc under a produto. */
function seedLink(db: FakeDb, produtoId: string, linkId: string, data: DocData = {}): void {
  db.seed(`produtos/${produtoId}/produtoMercadoLivre`, linkId, {
    id: 'MLB111',
    contaOuterRef: `documents/integracao/${CONTA}`,
    estado: 'p',
    status: 'active',
    sub_status: null,
    isUserProductModel: false,
    ...data,
  });
}

function linkRow(over: Partial<PrecoLinkRow> = {}): PrecoLinkRow {
  return {
    linkDocId: 'link1',
    id: 'MLB111',
    estado: 'p',
    status: 'active',
    sub_status: null,
    isUserProductModel: false,
    ...over,
  };
}

function childRow(produtoId: string, over: Partial<PrecoFamilyChild> = {}): PrecoFamilyChild {
  return { produtoId, precos: { [TAB]: { valor: 5 } }, varLinks: [], ...over };
}

function varLink(itemId: string | null, ref: string = PARENT_LINK_REF) {
  return { docId: `var-${itemId ?? 'null'}`, itemId, produtoMercadoLivreOuterRef: ref };
}

function familyRow(over: Partial<PrecoFamilyRow> = {}): PrecoFamilyRow {
  return {
    produtoId: 'PROD',
    precos: { [TAB]: { valor: 10 } },
    propagatePriceToChildren: true,
    // A `fetchPrecoPage` row always carries these two (the query constrains
    // both); a `fetchPrecoFamiliasByIds` row carries whatever the produto
    // stores, which is what makes #804's excluded classes visible.
    publicado: true,
    paiId: null,
    links: [linkRow()],
    children: [],
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

/* ---------------------------------- tests ---------------------------------- */

describe('constants + env getters', () => {
  it('pure code constants keep their spec values', () => {
    expect(PRICE_SYNC_SKIPS_CAP).toBe(200);
    expect(PRICE_SYNC_FAILURES_CAP).toBe(100);
    expect(MAX_DRAFTS_PER_FAMILY).toBe(2000);
    expect(PLAN_PAGE_DRAFTS_CAP).toBe(2000);
    expect(PRICE_SYNC_MAX_PAUSES).toBe(50);
  });

  it('config getters expose the documented defaults and re-read lazily', () => {
    expect(precoPageLimit()).toBe(25);
    expect(precoItemsPerDispatch()).toBe(10);
    expect(precoRatePauseMin()).toBe(5);
    process.env.MERCADO_LIVRE_PRECO_PAGE_LIMIT = '5';
    process.env.MERCADO_LIVRE_PRECO_ITEMS_PER_DISPATCH = '3';
    process.env.MERCADO_LIVRE_PRECO_RATE_PAUSE_MIN = '9';
    expect(precoPageLimit()).toBe(5);
    expect(precoItemsPerDispatch()).toBe(3);
    expect(precoRatePauseMin()).toBe(9);
  });

  it('precoPageLimit floors at 1 — a 0 would plan nothing and self-enqueue forever', () => {
    process.env.MERCADO_LIVRE_PRECO_PAGE_LIMIT = '0';
    expect(precoPageLimit()).toBe(1);
  });

  it('precoItemsPerDispatch floors at 1 — a 0 would drain nothing and self-enqueue forever', () => {
    process.env.MERCADO_LIVRE_PRECO_ITEMS_PER_DISPATCH = '0';
    expect(precoItemsPerDispatch()).toBe(1);
  });
});

describe('podeEnviarPreco — the decision-6 truth table', () => {
  it('active / paused (ANY sub_status) / non-forbidden under_review send', () => {
    const ok: Array<[string, string[] | null]> = [
      ['active', null],
      ['active', ['whatever']],
      // Price differs from stock here: ANY paused listing accepts a price PUT.
      ['paused', null],
      ['paused', []],
      ['paused', ['paused_by_seller']],
      ['paused', ['out_of_stock']],
      ['under_review', null],
      ['under_review', []],
      ['under_review', ['warning']],
      ['under_review', ['waiting_for_patch', 'held']],
    ];
    for (const [status, sub] of ok) {
      expect(podeEnviarPreco(status, sub), `${status} ${JSON.stringify(sub)}`).toEqual({
        ok: true,
      });
    }
  });

  it('under_review + forbidden → FORBIDDEN (even among other sub_statuses)', () => {
    expect(podeEnviarPreco('under_review', ['forbidden'])).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(podeEnviarPreco('under_review', ['held', 'forbidden'])).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('closed → CLOSED regardless of sub_status', () => {
    for (const sub of [null, ['expired'], ['out_of_stock']]) {
      expect(podeEnviarPreco('closed', sub)).toEqual({ ok: false, code: 'CLOSED' });
    }
  });

  it('null / undefined / blank status → STATUS_desconhecido + warn', () => {
    for (const status of [null, undefined, ''] as const) {
      const warnSpy = vi.spyOn(console, 'warn').mockClear();
      expect(podeEnviarPreco(status, null)).toEqual({ ok: false, code: 'STATUS_desconhecido' });
      expect(warnSpy).toHaveBeenCalledOnce();
    }
  });

  it('documented non-sendable statuses → STATUS_<x>, NO warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    expect(podeEnviarPreco('inactive', null)).toEqual({ ok: false, code: 'STATUS_inactive' });
    expect(podeEnviarPreco('payment_required', null)).toEqual({
      ok: false,
      code: 'STATUS_payment_required',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('undocumented status → STATUS_<x> + loud warn (status tracking)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    expect(podeEnviarPreco('some_future_status', null)).toEqual({
      ok: false,
      code: 'STATUS_some_future_status',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('status'),
      expect.objectContaining({ status: 'some_future_status' }),
    );
  });
});

describe('buildPrecoDrafts — price source + skip ladder', () => {
  it('legacy childless happy path → ONE item draft with the anchor price', () => {
    expect(buildPrecoDrafts(familyRow(), OPTS)).toEqual({
      drafts: [
        {
          kind: 'item',
          itemId: 'MLB111',
          produtoId: 'PROD',
          variacaoProdutoId: null,
          linkDocId: 'link1',
          preco: 10,
        },
      ],
      skips: [],
    });
  });

  it('legacy WITH children still sends ONE anchor-priced draft, no variation ids', () => {
    // ML legacy variations only accept a uniform family price — the send step
    // reuses the fresh GET's variation ids, so the plan carries none.
    const row = familyRow({
      children: [
        childRow('CH1', { varLinks: [varLink('MLB-CH1')] }),
        childRow('CH2', { varLinks: [varLink('MLB-CH2')] }),
      ],
    });
    expect(buildPrecoDrafts(row, OPTS)).toEqual({
      drafts: [
        {
          kind: 'item',
          itemId: 'MLB111',
          produtoId: 'PROD',
          variacaoProdutoId: null,
          linkDocId: 'link1',
          preco: 10,
        },
      ],
      skips: [],
    });
  });

  it('the plan price is roundReais(valor) — the one sanctioned rounding', () => {
    const res = buildPrecoDrafts(familyRow({ precos: { [TAB]: { valor: 10.567 } } }), OPTS);
    expect(res.drafts[0]!.preco).toBe(10.57);
  });

  it('missing / non-positive / junk anchor valor → PRECO_NAO_ENCONTRADO (legacy)', () => {
    for (const precos of [
      null,
      {},
      { [TAB]: { valor: 0 } },
      { [TAB]: { valor: -5 } },
      { [TAB]: { valor: 'dez' } },
      { [TAB]: 'junk' },
    ] as Array<PrecoFamilyRow['precos']>) {
      expect(buildPrecoDrafts(familyRow({ precos }), OPTS), JSON.stringify(precos)).toEqual({
        drafts: [],
        skips: [{ itemId: 'MLB111', produtoId: 'PROD', code: 'PRECO_NAO_ENCONTRADO' }],
      });
    }
  });

  it('conta with no links at all → single SEM_LINK skip (denorm drift)', () => {
    expect(buildPrecoDrafts(familyRow({ links: [] }), OPTS)).toEqual({
      drafts: [],
      skips: [{ itemId: null, produtoId: 'PROD', code: 'SEM_LINK' }],
    });
  });

  it('link never published (id null) → SEM_ITEM_ID with itemId null', () => {
    expect(buildPrecoDrafts(familyRow({ links: [linkRow({ id: null })] }), OPTS).skips).toEqual([
      { itemId: null, produtoId: 'PROD', code: 'SEM_ITEM_ID' },
    ]);
  });

  it("estado 'am' (mid-UP-migration) → AGUARDANDO_MIGRACAO, siblings still draft", () => {
    const res = buildPrecoDrafts(
      familyRow({
        links: [linkRow({ estado: 'am' }), linkRow({ linkDocId: 'link2', id: 'MLB222' })],
      }),
      OPTS,
    );
    expect(res.skips).toEqual([
      { itemId: 'MLB111', produtoId: 'PROD', code: 'AGUARDANDO_MIGRACAO' },
    ]);
    expect(res.drafts).toEqual([
      {
        kind: 'item',
        itemId: 'MLB222',
        produtoId: 'PROD',
        variacaoProdutoId: null,
        linkDocId: 'link2',
        preco: 10,
      },
    ]);
  });

  it('the STORED status never gates the plan (fresh-GET gate at send time)', () => {
    const res = buildPrecoDrafts(
      familyRow({ links: [linkRow({ status: 'closed', sub_status: ['deleted'] })] }),
      OPTS,
    );
    expect(res.drafts).toHaveLength(1);
    expect(res.skips).toEqual([]);
  });

  it('UP propagate=true → one variationItem draft per child, all anchor-priced', () => {
    const row = familyRow({
      links: [linkRow({ isUserProductModel: true })],
      children: [
        childRow('CH1', { varLinks: [varLink('MLB-CH1')] }),
        childRow('CH2', { varLinks: [varLink('MLB-CH2')] }),
      ],
    });
    expect(buildPrecoDrafts(row, OPTS)).toEqual({
      drafts: [
        {
          kind: 'variationItem',
          itemId: 'MLB-CH1',
          produtoId: 'PROD',
          variacaoProdutoId: 'CH1',
          linkDocId: 'link1',
          preco: 10,
        },
        {
          kind: 'variationItem',
          itemId: 'MLB-CH2',
          produtoId: 'PROD',
          variacaoProdutoId: 'CH2',
          linkDocId: 'link1',
          preco: 10,
        },
      ],
      skips: [],
    });
  });

  it("UP propagate=false: child's OWN price; a price-less child skips, siblings ride", () => {
    const row = familyRow({
      propagatePriceToChildren: false,
      links: [linkRow({ isUserProductModel: true })],
      children: [
        childRow('CH1', { precos: { [TAB]: { valor: 7.891 } }, varLinks: [varLink('MLB-CH1')] }),
        childRow('CH2', { precos: {}, varLinks: [varLink('MLB-CH2')] }),
      ],
    });
    const res = buildPrecoDrafts(row, OPTS);
    expect(res.drafts).toEqual([
      {
        kind: 'variationItem',
        itemId: 'MLB-CH1',
        produtoId: 'PROD',
        variacaoProdutoId: 'CH1',
        linkDocId: 'link1',
        preco: 7.89,
      },
    ]);
    expect(res.skips).toEqual([
      { itemId: 'MLB-CH2', produtoId: 'CH2', code: 'PRECO_NAO_ENCONTRADO' },
    ]);
  });

  it('UP propagate=false: children self-price even when the ANCHOR has no price', () => {
    const row = familyRow({
      precos: null,
      propagatePriceToChildren: false,
      links: [linkRow({ isUserProductModel: true })],
      children: [childRow('CH1', { varLinks: [varLink('MLB-CH1')] })],
    });
    expect(buildPrecoDrafts(row, OPTS)).toEqual({
      drafts: [
        {
          kind: 'variationItem',
          itemId: 'MLB-CH1',
          produtoId: 'PROD',
          variacaoProdutoId: 'CH1',
          linkDocId: 'link1',
          preco: 5,
        },
      ],
      skips: [],
    });
  });

  it('UP per-child SEM_LINK (unmatched) / SEM_ITEM_ID (id-less varLink), siblings ride', () => {
    const row = familyRow({
      links: [linkRow({ isUserProductModel: true })],
      children: [
        childRow('CH1', { varLinks: [varLink('MLB-CH1')] }),
        // A stale link at ANOTHER parent listing must not match.
        childRow('CH2', {
          varLinks: [varLink('MLB-X', 'documents/produtos/OTHER/produtoMercadoLivre/linkX')],
        }),
        childRow('CH3', { varLinks: [varLink(null)] }),
      ],
    });
    const res = buildPrecoDrafts(row, OPTS);
    expect(res.drafts).toHaveLength(1);
    expect(res.drafts[0]!.itemId).toBe('MLB-CH1');
    expect(res.skips).toEqual([
      { itemId: null, produtoId: 'CH2', code: 'SEM_LINK' },
      { itemId: null, produtoId: 'CH3', code: 'SEM_ITEM_ID' },
    ]);
  });

  it('childless UP listing degenerates to a single anchor-priced item draft', () => {
    expect(
      buildPrecoDrafts(familyRow({ links: [linkRow({ isUserProductModel: true })] }), OPTS),
    ).toEqual({
      drafts: [
        {
          kind: 'item',
          itemId: 'MLB111',
          produtoId: 'PROD',
          variacaoProdutoId: null,
          linkDocId: 'link1',
          preco: 10,
        },
      ],
      skips: [],
    });
  });

  it('cross-listing dedup: an already-emitted ML item id drops silently', () => {
    // Two legacy listings sharing one MLB id → one draft, no skip spam.
    const legacy = buildPrecoDrafts(
      familyRow({ links: [linkRow(), linkRow({ linkDocId: 'link2' })] }),
      OPTS,
    );
    expect(legacy.drafts).toHaveLength(1);
    expect(legacy.skips).toEqual([]);

    // Two UP children pointing at the same variation item → one draft only.
    const up = buildPrecoDrafts(
      familyRow({
        links: [linkRow({ isUserProductModel: true })],
        children: [
          childRow('CH1', { varLinks: [varLink('MLB-CH1')] }),
          childRow('CH2', { varLinks: [varLink('MLB-CH1')] }),
        ],
      }),
      OPTS,
    );
    expect(up.drafts).toEqual([
      {
        kind: 'variationItem',
        itemId: 'MLB-CH1',
        produtoId: 'PROD',
        variacaoProdutoId: 'CH1',
        linkDocId: 'link1',
        preco: 10,
      },
    ]);
    expect(up.skips).toEqual([]);
  });

  it('a family past MAX_DRAFTS_PER_FAMILY → zero drafts, ONE skip + console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockClear();
    const children: PrecoFamilyChild[] = [];
    for (let i = 1; i <= MAX_DRAFTS_PER_FAMILY + 1; i++) {
      children.push(childRow(`CH${i}`, { varLinks: [varLink(`MLB-CH${i}`)] }));
    }
    const res = buildPrecoDrafts(
      familyRow({ links: [linkRow({ isUserProductModel: true })], children }),
      OPTS,
    );
    expect(res).toEqual({
      drafts: [],
      skips: [{ itemId: null, produtoId: 'PROD', code: 'FAMILIA_MUITO_GRANDE' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('drafts'),
      expect.objectContaining({
        integracaoId: CONTA,
        produtoId: 'PROD',
        drafts: MAX_DRAFTS_PER_FAMILY + 1,
        max: MAX_DRAFTS_PER_FAMILY,
      }),
    );
  });
});

describe('fetchPrecoPage — anchor filtering, keyset, joins, soft reads', () => {
  it('plans every family anchor linked to the conta', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1');
    seedAnchor(db, 'A3', { integracoesComProduto: ['outra-conta'] }); // other conta
    db.seed('produtos', 'C1', {
      // a variation child, never an anchor
      paiId: 'A1',
      publicado: true,
      integracoesComProduto: [CONTA],
    });

    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });
    expect(page.rows).toEqual([
      {
        produtoId: 'A1',
        precos: { [TAB]: { valor: 10 } },
        propagatePriceToChildren: true,
        publicado: true,
        paiId: null,
        links: [
          {
            linkDocId: 'link1',
            id: 'MLB111',
            estado: 'p',
            status: 'active',
            sub_status: null,
            isUserProductModel: false,
          },
        ],
        children: [{ produtoId: 'C1', precos: null, varLinks: [] }],
      },
    ]);
    expect(page.nextAfterAnchorId).toBeNull(); // short page — backlog drained
  });

  it('#1072: an UNPUBLISHED anchor with a live link is planned, not dropped', async () => {
    // #804 class 1. `publicado == true` used to drop this family server-side
    // with no skip row, so the job reported `completed` having never looked at
    // it. `integracoesComProduto` already answers the only question that
    // matters here — does ML have a live anúncio — so the family plans like any
    // other and the send-time status gate decides.
    const db = new FakeDb();
    seedAnchor(db, 'A2', { publicado: false });
    seedLink(db, 'A2', 'link1');

    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });

    expect(page.rows.map((r) => r.produtoId)).toEqual(['A2']);
    // The mask still carries the flag even though the query no longer filters
    // on it — `precoManual` rungs out on it, so a page row and a by-ids row
    // must stay the same shape.
    expect(page.rows[0]!.publicado).toBe(false);
    // ...and it plans real drafts, rather than reaching a skip rung.
    expect(buildPrecoDrafts(page.rows[0]!, OPTS)).toEqual({
      drafts: [
        {
          kind: 'item',
          itemId: 'MLB111',
          produtoId: 'A2',
          variacaoProdutoId: null,
          linkDocId: 'link1',
          preco: 10,
        },
      ],
      skips: [],
    });
  });

  it('#1072: the anchor query carries EXACTLY the two terms its index declares', async () => {
    // The structural guard. `produtos(paiId, integracoesComProduto, __name__)`
    // is the declared entry; a third term makes it unservable, and on
    // Enterprise that does not throw — it full-scans and bills the bytes. The
    // row assertions above would stay green with `publicado == true` back in
    // place, so this is the only thing standing between a re-added term and a
    // silent cost regression.
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1');

    await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });

    const anchorQuery = db.queries.find(
      (q) => q.path === 'produtos' && q.clauses.some((c) => c.op === 'array-contains'),
    );
    expect(anchorQuery?.clauses).toEqual([
      { field: 'paiId', op: '==' },
      { field: 'integracoesComProduto', op: 'array-contains' },
    ]);
  });

  it('keyset: a FULL page sets nextAfterAnchorId; the resumed page drains', async () => {
    const db = new FakeDb();
    for (const id of ['A1', 'A2', 'A3']) {
      seedAnchor(db, id);
      seedLink(db, id, 'link1');
    }

    const page1 = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 2 });
    expect(page1.rows.map((r) => r.produtoId)).toEqual(['A1', 'A2']);
    expect(page1.nextAfterAnchorId).toBe('A2');

    const page2 = await fetchPrecoPage(asDb(db), {
      integracaoId: CONTA,
      afterAnchorId: page1.nextAfterAnchorId,
      pageLimit: 2,
    });
    expect(page2.rows.map((r) => r.produtoId)).toEqual(['A3']);
    expect(page2.nextAfterAnchorId).toBeNull();
  });

  it('link matching accepts BOTH contaOuterRef forms, foreign contas excluded', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1'); // canonical documents/... form
    seedLink(db, 'A1', 'link2', { id: 'MLB222', contaOuterRef: `integracao/${CONTA}` }); // bare form
    seedLink(db, 'A1', 'link3', { contaOuterRef: 'documents/integracao/outra-conta' });

    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });
    expect(page.rows[0]!.links.map((l) => l.linkDocId)).toEqual(['link1', 'link2']);
  });

  it('joins children with their variação links per anchor', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1', { isUserProductModel: true });
    db.seed('produtos', 'C1', { paiId: 'A1', precos: { [TAB]: { valor: 5 } } });
    db.seed('produtos/C1/variacaoMercadoLivre', 'v1', {
      itemId: 'MLB-C1',
      produtoMercadoLivreOuterRef: 'documents/produtos/A1/produtoMercadoLivre/link1',
    });

    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });
    expect(page.rows[0]!.children).toEqual([
      {
        produtoId: 'C1',
        precos: { [TAB]: { valor: 5 } },
        varLinks: [
          {
            docId: 'v1',
            itemId: 'MLB-C1',
            produtoMercadoLivreOuterRef: 'documents/produtos/A1/produtoMercadoLivre/link1',
          },
        ],
      },
    ]);
  });

  it('soft-reads a malformed produto/link/varLink instead of throwing', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1', {
      precos: 'junk', // → null → PRECO_NAO_ENCONTRADO downstream
      propagatePriceToChildren: 'yes', // junk non-false → schema default TRUE
    });
    seedLink(db, 'A1', 'link1', {
      id: 123, // non-string ML id → null → SEM_ITEM_ID downstream
      estado: 7,
      status: null,
      sub_status: ['a', 5, 'b'],
      isUserProductModel: 'true',
    });
    db.seed('produtos', 'C1', { paiId: 'A1', precos: 42 });
    db.seed('produtos/C1/variacaoMercadoLivre', 'v1', {
      itemId: '', // blank → null
      produtoMercadoLivreOuterRef: 9,
    });

    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });
    expect(page.rows).toEqual([
      {
        produtoId: 'A1',
        precos: null,
        propagatePriceToChildren: true,
        publicado: true,
        paiId: null,
        links: [
          {
            linkDocId: 'link1',
            id: null,
            estado: null,
            status: null,
            sub_status: ['a', 'b'],
            isUserProductModel: null,
          },
        ],
        children: [
          {
            produtoId: 'C1',
            precos: null,
            varLinks: [{ docId: 'v1', itemId: null, produtoMercadoLivreOuterRef: null }],
          },
        ],
      },
    ]);
  });

  it('propagatePriceToChildren false is preserved (only literal false opts out)', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1', { propagatePriceToChildren: false });
    seedLink(db, 'A1', 'link1');
    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });
    expect(page.rows[0]!.propagatePriceToChildren).toBe(false);
  });
});

/**
 * #804 S7's three classes, from the by-ids side.
 *
 * ⚠️ The premise changed with #1072 and the difference is the whole point of
 * this block: class 1 is no longer one of them — `fetchPrecoPage` dropped
 * `publicado == true`, so the bulk job enumerates an unpublished produto like
 * any other. The remaining two still produce NO row from the anchor query
 * (`paiId` and the denorm term filter them out server-side), which is why the
 * manual push reads anchors by key and why the reconciliation phase reports
 * them.
 */
describe('fetchPrecoFamiliasByIds — the manual push target set', () => {
  it('returns an UNPUBLISHED produto that has a live link — as does fetchPrecoPage since #1072', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1', { publicado: false });
    seedLink(db, 'A1', 'link1');

    // The bulk query now sees it too — this used to be the silent drop.
    const page = await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 });
    expect(page.rows.map((r) => r.produtoId)).toEqual(['A1']);

    // The by-ids read still hands the caller the same row, same shape.
    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['A1'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.publicado).toBe(false);
    expect(rows[0]!.links).toHaveLength(1);
    // Both paths agree — the mask keeps them the same shape.
    expect(rows[0]).toEqual(page.rows[0]);
  });

  it('returns a produto whose integracoesComProduto denorm drifted (empty) but whose link is live', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1', { integracoesComProduto: [] });
    seedLink(db, 'A1', 'link1');

    expect((await fetchPrecoPage(asDb(db), { integracaoId: CONTA, pageLimit: 10 })).rows).toEqual(
      [],
    );

    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['A1'],
    });
    expect(rows.map((r) => r.produtoId)).toEqual(['A1']);
    expect(rows[0]!.links).toHaveLength(1);
  });

  it('surfaces paiId so a 2-deep chain is reportable rather than priced as a family', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'MID', { paiId: 'TOP' });
    seedLink(db, 'MID', 'link1');

    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['MID'],
    });
    expect(rows[0]!.paiId).toBe('TOP');
  });

  it('omits a missing document instead of throwing — the caller diffs against anchorIds', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1');

    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['A1', 'SUMIU'],
    });
    expect(rows.map((r) => r.produtoId)).toEqual(['A1']);
  });

  it('dedupes anchorIds and short-circuits on an empty selection', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1');

    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['A1', 'A1'],
    });
    expect(rows).toHaveLength(1);

    expect(await fetchPrecoFamiliasByIds(asDb(db), { integracaoId: CONTA, anchorIds: [] })).toEqual(
      [],
    );
  });

  it('joins the conta links and the variation children, same as a page row', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1', { isUserProductModel: true });
    db.seed('produtos', 'C1', { paiId: 'A1', precos: { [TAB]: { valor: 7 } } });
    db.seed('produtos/C1/variacaoMercadoLivre', 'v1', {
      itemId: 'MLB222',
      produtoMercadoLivreOuterRef: 'documents/produtos/A1/produtoMercadoLivre/link1',
    });

    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['A1'],
    });
    expect(rows[0]!.children).toEqual([
      {
        produtoId: 'C1',
        precos: { [TAB]: { valor: 7 } },
        varLinks: [
          {
            docId: 'v1',
            itemId: 'MLB222',
            produtoMercadoLivreOuterRef: 'documents/produtos/A1/produtoMercadoLivre/link1',
          },
        ],
      },
    ]);
  });

  it('matches the bare `integracao/<id>` contaOuterRef form too', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'A1');
    seedLink(db, 'A1', 'link1', { contaOuterRef: `integracao/${CONTA}` });

    const rows = await fetchPrecoFamiliasByIds(asDb(db), {
      integracaoId: CONTA,
      anchorIds: ['A1'],
    });
    expect(rows[0]!.links).toHaveLength(1);
  });
});

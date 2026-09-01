/**
 * The /produtos smart search box: reading a term as a marketplace id, and
 * resolving any term to the produtos the catalog list should show.
 *
 * The Firestore layer is mocked at the `@delfrance/data` helper boundary (same
 * shape as `resolveChaves.test.ts`), so constraints become inspectable literals
 * and `getDocs` routes on the fake base refs. `parseProdutoMercadoLivreOuterRef`
 * is deliberately NOT mocked — the anchor hop is half of what this module does,
 * and a stubbed parser would make every variation case vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDocMock, getDocsMock, getDocsByIdsMock } = vi.hoisted(() => ({
  getDocMock: vi.fn(),
  getDocsMock: vi.fn(),
  getDocsByIdsMock: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  getDoc: getDocMock,
  getDocs: getDocsMock,
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown, constraints: unknown[]) => ({ base, constraints }),
  groupQuery: (_db: unknown, groupId: string) => ({ kind: 'group', groupId }),
  whereEqual: (field: string, value: unknown) => ({ kind: 'eq', field, value }),
  whereOp: (field: string, op: string, value: unknown) => ({ kind: 'op', field, op, value }),
  limit: (n: number) => ({ kind: 'limit', n }),
}));

vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    converter: {},
    ref: () => ({ kind: 'produtos' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ kind: 'produtoDoc', id }),
  },
}));
vi.mock('@/lib/data/produtoMercadoLivreLinkCollection', () => ({
  produtoMercadoLivreLinkCollection: { converter: {} },
}));
vi.mock('@/lib/data/variacaoMercadoLivreLinkCollection', () => ({
  variacaoMercadoLivreLinkCollection: { converter: {} },
}));
vi.mock('@/lib/data/getDocsByIds', () => ({ getDocsByIds: getDocsByIdsMock }));

import type { Firestore } from 'firebase/firestore';
import {
  MAX_PRODUTOS_BUSCA,
  parseDocumentIdTerm,
  parseMarketplaceIdTerm,
  resolveProdutoIdsPorTermo,
} from './buscaProduto';

const db = {} as Firestore;

interface FakeQuery {
  base: { kind: string; groupId?: string };
  constraints: Array<{ kind: string; field?: string; op?: string; value?: unknown; n?: number }>;
}

/** The six queries this module can issue, named by what they look up. */
type Alvo = 'produtoSku' | 'pmlSku' | 'pmlId' | 'varSku' | 'varItemId' | 'varNumericId';

function alvoDe(q: FakeQuery): Alvo {
  const field = q.constraints.find((c) => c.kind === 'eq' || c.kind === 'op')?.field;
  if (q.base.kind === 'produtos') return 'produtoSku';
  if (q.base.groupId === 'produtoMercadoLivre') return field === 'sku' ? 'pmlSku' : 'pmlId';
  if (field === 'sku') return 'varSku';
  if (field === 'itemId') return 'varItemId';
  return 'varNumericId';
}

/** The two doc shapes the module reads: a parent id, or the doc's own id. */
interface FakeDoc {
  id?: string;
  data: () => Record<string, unknown>;
  ref: { parent: { parent: { id: string } | null } };
}

/** A collection-group doc: what matters is its PARENT document's id. */
function linkDoc(parentId: string, data: Record<string, unknown> = {}): FakeDoc {
  return { data: () => data, ref: { parent: { parent: { id: parentId } } } };
}
/** A `produtos` doc, which is addressed by its own id. */
function produtoDoc(id: string, data: Record<string, unknown> = {}): FakeDoc {
  return { id, data: () => data, ref: { parent: { parent: null } } };
}

/** Route `getDocs` per query target; anything unnamed comes back empty. */
function routeDocs(map: Partial<Record<Alvo, FakeDoc[]>>) {
  getDocsMock.mockImplementation((q: FakeQuery) => Promise.resolve({ docs: map[alvoDe(q)] ?? [] }));
}

/** Every target `getDocs` was actually called for. */
function alvosConsultados(): Alvo[] {
  return getDocsMock.mock.calls.map((c) => alvoDe(c[0] as FakeQuery));
}

const outerRef = (anchorId: string) => `documents/produtos/${anchorId}/produtoMercadoLivre/link-1`;

/**
 * Route the document-id point read.
 *
 * ⚠️ A `beforeEach` default, not a per-test opt-in. EVERY whitespace-free term
 * now probes the document id, so a bare `mockReset` would leave `getDoc`
 * returning `undefined` and `.then` on it would crash tests that have nothing
 * to do with this branch.
 */
function routeDoc(doc?: FakeDoc) {
  getDocMock.mockResolvedValue(
    doc ? { exists: () => true, id: doc.id, data: doc.data } : { exists: () => false },
  );
}

/** The doc ref the probe was built from, or undefined if it never ran. */
function idProbado(): string | undefined {
  return (getDocMock.mock.calls[0]?.[0] as { id: string } | undefined)?.id;
}

beforeEach(() => {
  routeDoc();
});

afterEach(() => {
  getDocMock.mockReset();
  getDocsMock.mockReset();
  getDocsByIdsMock.mockReset();
});

describe('parseMarketplaceIdTerm', () => {
  it.each([
    ['MLB1234567890', 'MLB1234567890'],
    ['MLB-1234567890', 'MLB1234567890'],
    ['mlb-1234567890', 'MLB1234567890'],
    ['  MLB-1234567890  ', 'MLB1234567890'],
    ['MLU-999888', 'MLU999888'],
    ['MLA123456789', 'MLA123456789'],
  ])('normalises %s to %s', (term, expected) => {
    expect(parseMarketplaceIdTerm(term)).toEqual({
      candidates: [expected],
      variationId: null,
      bareNumber: false,
    });
  });

  it.each([
    ['MOD-12'],
    ['MOD12'],
    ['MAX-3'],
    ['MIN-4'],
    ['MED-10'],
    // ⚠️ The discriminating pair: long enough to clear MIN_DIGITOS_ID, so ONLY
    // the site-code list can reject them. Without these the list is untested —
    // the digit floor alone kills every short case above.
    ['MOD-12345'],
    ['MAX123456'],
  ])('rejects %j — an ordinary catalog term, not a site code', (term) => {
    // These are why the prefix is matched against the real ML site-code list
    // rather than `M` + two letters. Claiming one is not a wasted query: it
    // used to make the miss FINAL, hiding a produto whose name was being typed.
    expect(parseMarketplaceIdTerm(term)).toBeNull();
  });

  it.each([['MLB-123'], ['MLB1234'], ['MLU-9']])(
    'rejects %j — a real site code, but too few digits for an item id',
    (term) => {
      expect(parseMarketplaceIdTerm(term)).toBeNull();
    },
  );

  it('prefixes a bare number for every configured site AND keeps it as a variation id', () => {
    expect(parseMarketplaceIdTerm('123456789')).toEqual({
      candidates: ['MLB123456789', 'MLU123456789'],
      variationId: 123456789,
      bareNumber: true,
    });
  });

  it('drops the variation id past the safe-integer boundary but keeps the candidates', () => {
    const grande = '9007199254740993'; // 2^53 + 1 — Number() rounds this silently
    expect(parseMarketplaceIdTerm(grande)).toEqual({
      candidates: [`MLB${grande}`, `MLU${grande}`],
      variationId: null,
      bareNumber: true,
    });
  });

  it.each([
    ['camiseta preta'],
    ['CAM-PRETA-M'],
    ['AB-1234'], // an SKU shaped like an id, but too short to be a site code
    ['ABC-1234'], // the discriminating case: site-code SHAPED, but no leading `M`
    ['XPT123456'],
    ['1234'], // too short to be an item id
    [''],
    ['   '],
    ['MLB'], // prefix with no digits
  ])('rejects %j', (term) => {
    expect(parseMarketplaceIdTerm(term)).toBeNull();
  });
});

/**
 * The four id shapes this catalog actually carries. Not decoration — a tidy
 * `^[A-Za-z0-9]{20}$` guard passes the first and silently refuses the other
 * three, which are the IMPORTED produtos an operator is most likely chasing.
 */
const AUTO_ID = '7u13Z9TlQGgsg8N9Jfk2';
const HEX_ID = '3f9731b6f257482a1956a11ffc028fbc288b7d05dc736174f90fcb9951dba8d6';
const ML_ID = 'XMLB0000000000000001000000000000000003921756196207441vMLBMLB5125183715';
const FIXTURE_ID = 'dev-camiseta-pai';

describe('parseDocumentIdTerm', () => {
  it.each([AUTO_ID, HEX_ID, ML_ID, FIXTURE_ID])('reads %s as a bare document id', (id) => {
    expect(parseDocumentIdTerm(id)).toEqual({ id, fromPath: false });
  });

  it.each([
    [`/produtos/${AUTO_ID}`, AUTO_ID],
    [`/produtos/${AUTO_ID}/`, AUTO_ID],
    [`produtos/${HEX_ID}`, HEX_ID],
    [`documents/produtos/${ML_ID}`, ML_ID],
    [`https://erp.example.com/produtos/${AUTO_ID}`, AUTO_ID],
    [`https://erp.example.com/produtos/${AUTO_ID}/editar?aba=precos#topo`, AUTO_ID],
  ])('reads the id out of the path %s', (termo, esperado) => {
    expect(parseDocumentIdTerm(termo)).toEqual({ id: esperado, fromPath: true });
  });

  // ⚠️ The near-miss that a "last segment" rule gets wrong, and it is the URL
  // every row on this screen links to. `idFromRef`/`parseRef` both return
  // `editar` here — a term that parses cleanly and matches nothing, which
  // reads exactly like "that produto does not exist".
  it('takes the segment AFTER produtos, never the last one — the last is the route', () => {
    expect(parseDocumentIdTerm(`/produtos/${AUTO_ID}/editar`)?.id).toBe(AUTO_ID);
    expect(parseDocumentIdTerm(`/produtos/${AUTO_ID}/editar`)?.id).not.toBe('editar');
  });

  it.each(['camiseta preta', '  duas palavras  ', 'a	b'])(
    'refuses %j — whitespace, so a multi-word name search pays for no read',
    (termo) => {
      expect(parseDocumentIdTerm(termo)).toBeNull();
    },
  );

  it.each([
    'clientes/abc',
    'documents/pedidos/p1',
    '/produtos',
    '/produtos/',
    'https://erp.example.com/',
    'https://www.mercadolivre.com.br/p/MLB123',
  ])('refuses %j — a path naming no produtos document', (termo) => {
    expect(parseDocumentIdTerm(termo)).toBeNull();
  });

  // ⚠️ None of these makes `doc()` throw — verified against the installed
  // client SDK, which only counts path segments. The BACKEND refuses them, so
  // without this the read itself rejects and the search box shows an error.
  it.each(['.', '..', '__proto__', '__name__'])(
    'refuses %j — an id the Firestore backend rejects, so the read never does',
    (termo) => {
      expect(parseDocumentIdTerm(termo)).toBeNull();
    },
  );

  it('refuses a term past the 1500-character id limit rather than paying for a rejected read', () => {
    expect(parseDocumentIdTerm('x'.repeat(1500))).not.toBeNull();
    expect(parseDocumentIdTerm('x'.repeat(1501))).toBeNull();
  });

  it('refuses an empty term', () => {
    expect(parseDocumentIdTerm('')).toBeNull();
    expect(parseDocumentIdTerm('   ')).toBeNull();
  });

  // ⚠️ Unlike the marketplace branch, which upper-cases the site prefix.
  // Document ids are case-sensitive, so folding one here would look up a
  // document that does not exist.
  it('keeps the id exactly as typed — document ids are case-sensitive', () => {
    expect(parseDocumentIdTerm('Dev-Camiseta-PAI')?.id).toBe('Dev-Camiseta-PAI');
  });

  // ⚠️ A route deny-list was considered and rejected: it drifts as routes are
  // added, and it would refuse a produto whose id genuinely IS `novo`. The cost
  // of allowing it is one point read that misses.
  it('accepts /produtos/novo, because a produto whose id is "novo" must stay findable', () => {
    expect(parseDocumentIdTerm('/produtos/novo')).toEqual({ id: 'novo', fromPath: true });
  });
});

describe('resolveProdutoIdsPorTermo', () => {
  it('declines a plain name term that matches no SKU, so the nome search runs', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, 'camiseta')).resolves.toBeNull();
  });

  it('probes the SKU fields for EVERY term, and the id fields only for an id term', async () => {
    routeDocs({});
    await resolveProdutoIdsPorTermo(db, 'camiseta');
    expect(alvosConsultados().sort()).toEqual(['pmlSku', 'produtoSku', 'varSku']);

    getDocsMock.mockClear();
    await resolveProdutoIdsPorTermo(db, 'MLB1234567890');
    expect(alvosConsultados().sort()).toEqual([
      'pmlId',
      'pmlSku',
      'produtoSku',
      'varItemId',
      'varSku',
    ]);
  });

  it('adds the numeric variation probe only when the term is a bare number', async () => {
    routeDocs({});
    await resolveProdutoIdsPorTermo(db, '123456789');
    expect(alvosConsultados()).toContain('varNumericId');
  });

  it('sends the normalised candidates, not the term as typed', async () => {
    routeDocs({});
    await resolveProdutoIdsPorTermo(db, 'MLB-1234567890');
    const idQuery = getDocsMock.mock.calls
      .map((c) => c[0] as FakeQuery)
      .find((q) => alvoDe(q) === 'pmlId')!;
    expect(idQuery.constraints).toContainEqual({
      kind: 'op',
      field: 'id',
      op: 'in',
      value: ['MLB1234567890'],
    });
  });

  it('resolves an anchor link hit to its parent produto', async () => {
    routeDocs({ pmlId: [linkDoc('prod-a')] });
    await expect(resolveProdutoIdsPorTermo(db, 'MLB1234567890')).resolves.toEqual({
      ids: ['prod-a'],
      truncated: false,
    });
  });

  it('resolves a User-Products member id to the family ANCHOR, not the variation child', async () => {
    // The doc lives under the CHILD; its outer ref names the anchor. Returning
    // `filho-1` would hand the list an id its `paiId == null` filter drops.
    routeDocs({
      varItemId: [linkDoc('filho-1', { produtoMercadoLivreOuterRef: outerRef('anchor-1') })],
    });
    await expect(resolveProdutoIdsPorTermo(db, 'MLB1234567890')).resolves.toEqual({
      ids: ['anchor-1'],
      truncated: false,
    });
  });

  it('falls back to a paiId read when a variation link carries no usable outer ref', async () => {
    routeDocs({ varSku: [linkDoc('filho-2', { produtoMercadoLivreOuterRef: null })] });
    getDocsByIdsMock.mockResolvedValue(new Map([['filho-2', { paiId: 'anchor-2' }]]));

    await expect(resolveProdutoIdsPorTermo(db, 'SKU-X')).resolves.toEqual({
      ids: ['anchor-2'],
      truncated: false,
    });
    expect(getDocsByIdsMock).toHaveBeenCalledWith(db, expect.anything(), ['filho-2']);
  });

  it('maps a produto matched by its own SKU to its parent when it is a variation child', async () => {
    routeDocs({
      produtoSku: [produtoDoc('filho-3', { paiId: 'anchor-3' }), produtoDoc('pai-4', {})],
    });
    const res = await resolveProdutoIdsPorTermo(db, 'SKU-Y');
    expect(res?.ids).toEqual(['anchor-3', 'pai-4']);
  });

  it('reports a SITE-PREFIXED term that matched nothing as HANDLED, skipping the nome search', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, 'MLB1234567890')).resolves.toEqual({
      ids: [],
      truncated: false,
    });
  });

  it('declines a BARE-NUMBER miss, so a produto named "10000 Lumens" stays reachable', async () => {
    // Typing `MLB1234567890` says "listing", so its miss is an answer. Typing
    // `10000` says nothing of the kind — the module itself calls a short number
    // "far more likely an SKU" — so its miss must not suppress the nome search.
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, '10000')).resolves.toBeNull();
  });

  it('dedupes across queries before capping, so one produto found twice counts once', async () => {
    routeDocs({
      pmlId: [linkDoc('prod-a')],
      pmlSku: [linkDoc('prod-a')],
      produtoSku: [produtoDoc('prod-a', {})],
    });
    await expect(resolveProdutoIdsPorTermo(db, 'MLB1234567890')).resolves.toEqual({
      ids: ['prod-a'],
      truncated: false,
    });
  });

  it('dedupes BEFORE capping, so duplicates neither displace matches nor fake a truncation', async () => {
    // Cap-then-dedupe would slice ['a','a'] off the front, lose 'b' entirely,
    // and then report truncated — wrong result AND wrong warning.
    routeDocs({ pmlSku: [linkDoc('a'), linkDoc('a'), linkDoc('b')] });
    await expect(resolveProdutoIdsPorTermo(db, 'SKU-DUP', 2)).resolves.toEqual({
      ids: ['a', 'b'],
      truncated: false,
    });
  });

  it('caps the result and says so', async () => {
    const demais = Array.from({ length: MAX_PRODUTOS_BUSCA + 1 }, (_, i) => linkDoc(`p-${i}`));
    routeDocs({ pmlSku: demais });
    const res = await resolveProdutoIdsPorTermo(db, 'SKU-COMPARTILHADO');
    expect(res?.ids).toHaveLength(MAX_PRODUTOS_BUSCA);
    expect(res?.truncated).toBe(true);
  });

  it('declines an empty term without querying anything', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, '   ')).resolves.toBeNull();
    expect(getDocsMock).not.toHaveBeenCalled();
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('resolves a produto by its own document id, so a pasted id finds its row', async () => {
    routeDocs({});
    routeDoc(produtoDoc(AUTO_ID));
    await expect(resolveProdutoIdsPorTermo(db, AUTO_ID)).resolves.toEqual({
      ids: [AUTO_ID],
      truncated: false,
    });
  });

  // ⚠️ The list filters `paiId == null`. Returning the CHILD id hands it an id
  // it silently drops — indistinguishable, on screen, from "does not exist".
  it("maps a variation child's document id to its family ANCHOR, so the row is not dropped", async () => {
    routeDocs({});
    routeDoc(produtoDoc('filho-1', { paiId: 'pai-1' }));
    await expect(resolveProdutoIdsPorTermo(db, 'filho-1')).resolves.toEqual({
      ids: ['pai-1'],
      truncated: false,
    });
  });

  it('reads the id out of a pasted /produtos/<id>/editar URL, the one every row links to', async () => {
    routeDocs({});
    routeDoc(produtoDoc(AUTO_ID));
    await expect(
      resolveProdutoIdsPorTermo(db, `https://erp.example.com/produtos/${AUTO_ID}/editar?aba=fotos`),
    ).resolves.toEqual({ ids: [AUTO_ID], truncated: false });
    expect(idProbado()).toBe(AUTO_ID);
  });

  it('reports a PATH-shaped miss as HANDLED, so a pasted URL never falls through to the nome search', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, `/produtos/${AUTO_ID}`)).resolves.toEqual({
      ids: [],
      truncated: false,
    });
  });

  // ⚠️ The legacy Flutter import wrote the seller's `seller_custom_field`
  // straight in as the produto document id, constrained only to
  // `^[a-zA-Z0-9]+$` — so in production a produto id can BE an SKU. A bare term
  // is never the operator unambiguously naming a document.
  it('declines a BARE-id miss, so a term that is equally a plausible SKU still reaches the nome search', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, FIXTURE_ID)).resolves.toBeNull();
  });

  // ⚠️⚠️ THE regression guard for this branch. Every whitespace-free term now
  // parses as a candidate document id, so writing the final condition as
  // `!idTerm && !docIdTerm` would make EVERY one-word miss final and silently
  // kill the nome search for terms like this one.
  it('still declines a one-word name term, now that every whitespace-free term is probed', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, 'camiseta')).resolves.toBeNull();
    expect(getDocMock).toHaveBeenCalled();
  });

  it('skips the document-id read entirely for a multi-word term, which can never be an id', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, 'camiseta polo preta')).resolves.toBeNull();
    expect(getDocMock).not.toHaveBeenCalled();
  });

  // ⚠️ `doc(db, 'produtos', 'a/b')` THROWS synchronously — and `'a/b/c'` does
  // not, silently resolving to a document two levels down. Refusing the
  // separator covers both, and the SKU lookups must still answer.
  it('never builds a doc ref from a slash term, and still runs the SKU lookups', async () => {
    routeDocs({});
    await expect(resolveProdutoIdsPorTermo(db, 'clientes/abc')).resolves.toBeNull();
    expect(getDocMock).not.toHaveBeenCalled();
    expect(alvosConsultados().sort()).toEqual(['pmlSku', 'produtoSku', 'varSku']);
  });

  it('unions a document-id hit with an SKU hit instead of choosing between them', async () => {
    routeDocs({ produtoSku: [produtoDoc('por-sku')] });
    routeDoc(produtoDoc('por-id'));
    const res = await resolveProdutoIdsPorTermo(db, 'ambiguo');
    expect([...(res?.ids ?? [])].sort()).toEqual(['por-id', 'por-sku']);
  });

  it('dedupes a produto found by BOTH its document id and its SKU', async () => {
    routeDocs({ produtoSku: [produtoDoc('mesmo')] });
    routeDoc(produtoDoc('mesmo'));
    await expect(resolveProdutoIdsPorTermo(db, 'mesmo')).resolves.toEqual({
      ids: ['mesmo'],
      truncated: false,
    });
  });

  // ⚠️ The Mercado Livre import mints produto ids like
  // `XMLB000…vMLBMLB5125183715`, so a marketplace-shaped term CAN be a document
  // id. Gating the probe on "not a marketplace term" would hide exactly those.
  it('probes the document id even for a marketplace-shaped term', async () => {
    routeDocs({});
    routeDoc(produtoDoc('MLB1234567890'));
    await expect(resolveProdutoIdsPorTermo(db, 'MLB1234567890')).resolves.toEqual({
      ids: ['MLB1234567890'],
      truncated: false,
    });
  });

  // ⚠️ `getDoc` REJECTS where `getDocs` degrades: verified in the installed
  // SDK, a point read of a MISSING document while offline hits
  // `if (!exists && snap.fromCache)` and rejects UNAVAILABLE. Uncaught, one
  // offline probe would fail the whole box — including name searches the
  // cached SKU queries would still have answered.
  it('treats a REJECTED document read as a miss, so the SKU search still answers', async () => {
    routeDocs({ produtoSku: [produtoDoc('achado-por-sku')] });
    getDocMock.mockRejectedValue(
      new Error('Failed to get document because the client is offline.'),
    );
    await expect(resolveProdutoIdsPorTermo(db, 'algum-termo')).resolves.toEqual({
      ids: ['achado-por-sku'],
      truncated: false,
    });
  });

  // ⚠️ The probe is task 0 so that `limitarIds`, which slices in INSERTION
  // order, cannot drop the most precise answer the box has. Reorder it and the
  // exact id is the hit that falls off the end.
  it('keeps the document-id hit when the SKU results alone already fill the cap', async () => {
    routeDocs({ produtoSku: [produtoDoc('sku-1'), produtoDoc('sku-2')] });
    routeDoc(produtoDoc('exato'));
    const res = await resolveProdutoIdsPorTermo(db, 'exato', 2);
    expect(res?.ids).toContain('exato');
    expect(res?.truncated).toBe(true);
  });
});

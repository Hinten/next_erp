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
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDocsMock, getDocsByIdsMock } = vi.hoisted(() => ({
  getDocsMock: vi.fn(),
  getDocsByIdsMock: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
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
  produtoCollection: { converter: {}, ref: () => ({ kind: 'produtos' }) },
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

afterEach(() => {
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
  });
});

import { describe, expect, it } from 'vitest';
import { colapsarPaiEFilhoUnico } from './familia';

/**
 * Both halves of the fold, deliberately.
 *
 * A test that the collapse APPLIES cannot show where it STOPS, and the gap is
 * silent: over-collapsing here binds a scanned SKU — or an incoming Mercado
 * Livre order line — to a produto nobody named, and then moves its stock. So
 * every "collapses" case has a near-miss beside it that must stay distinct.
 */

const pai = (id = 'p1') => ({ id, paiId: null });
const filho = (id: string, paiId: string) => ({ id, paiId });

describe('colapsarPaiEFilhoUnico — what IS one produto', () => {
  it('collapses a parent and its own sole member, to the CHILD', () => {
    const c = filho('c1', 'p1');
    expect(colapsarPaiEFilhoUnico([pai(), c])).toBe(c);
  });

  it('collapses regardless of which order the index returned them in', () => {
    const c = filho('c1', 'p1');
    expect(colapsarPaiEFilhoUnico([c, pai()])).toBe(c);
  });

  // The schema defaults `paiId` to null, but the legacy corpus and a raw
  // `.data()` read can both hand over an absent key. Both mean "root".
  it('treats an ABSENT paiId on the parent as root, like a stored null', () => {
    const c = filho('c1', 'p1');
    expect(colapsarPaiEFilhoUnico([{ id: 'p1', paiId: undefined }, c])).toBe(c);
  });

  // The callers pass a snapshot alongside the two fields, so the collapse has to
  // hand BACK what it was given rather than a reconstructed `{id, paiId}`.
  it('returns the caller’s own object, so a snapshot/doc pair survives the collapse', () => {
    const p = { id: 'p1', paiId: null as string | null, carga: 'pai' };
    const c = { id: 'c1', paiId: 'p1' as string | null, carga: 'filho' };
    expect(colapsarPaiEFilhoUnico([p, c])?.carga).toBe('filho');
  });
});

describe('colapsarPaiEFilhoUnico — what must stay DISTINCT', () => {
  // ⚠️ Legal in this corpus and a genuine ambiguity. Collapsing it would count a
  // scan against a produto the operator never named.
  it('refuses two unrelated roots sharing a SKU', () => {
    expect(colapsarPaiEFilhoUnico([pai('p1'), pai('p2')])).toBeNull();
  });

  // ⚠️ Also legal, and common: a child's SKU is `parentSku + variante.codigo`,
  // so two variantes without a `codigo` collide (importVariations.ts:352-355).
  it('refuses two siblings sharing a SKU', () => {
    expect(colapsarPaiEFilhoUnico([filho('c1', 'p1'), filho('c2', 'p1')])).toBeNull();
  });

  // ⚠️ The near-miss that a "one has a paiId, the other does not" test would
  // pass: the child's paiId names a THIRD document, not the parent in the pair.
  it('refuses a parent and some OTHER parent’s child', () => {
    expect(colapsarPaiEFilhoUnico([pai('p1'), filho('c1', 'p2')])).toBeNull();
  });

  it('refuses a grandparent and a grandchild', () => {
    expect(colapsarPaiEFilhoUnico([pai('avo'), filho('neto', 'pai-do-meio')])).toBeNull();
  });

  // ⚠️ The reason every caller probes with limit(3). Two documents cannot show
  // that a family has more members; three hits mean the pair is not the whole
  // story, and collapsing would bind stock to an arbitrary sibling.
  it('refuses anything that is not exactly two candidates', () => {
    expect(colapsarPaiEFilhoUnico([])).toBeNull();
    expect(colapsarPaiEFilhoUnico([pai()])).toBeNull();
    expect(colapsarPaiEFilhoUnico([pai('p1'), filho('c1', 'p1'), filho('c2', 'p1')])).toBeNull();
  });

  it('refuses a document that claims to be its own parent', () => {
    expect(
      colapsarPaiEFilhoUnico([
        { id: 'p1', paiId: null },
        { id: 'p1', paiId: 'p1' },
      ]),
    ).toBeNull();
  });

  // An empty id would make `filho.paiId === pai.id` true for every child whose
  // paiId is also empty, collapsing two unrelated junk documents.
  it('refuses empty ids rather than matching them against each other', () => {
    expect(
      colapsarPaiEFilhoUnico([
        { id: '', paiId: null },
        { id: 'c1', paiId: '' },
      ]),
    ).toBeNull();
  });
});

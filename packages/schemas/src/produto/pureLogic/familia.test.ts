import { describe, expect, it } from 'vitest';
import {
  colapsarPaiEFilhoUnico,
  derivarFilhoUnico,
  ehFamiliaDeUm,
  montarMembroUnico,
  unidadeVendavel,
} from './familia';

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

describe('derivarFilhoUnico', () => {
  it('names the child when there is exactly one', () => {
    expect(derivarFilhoUnico([{ id: 'c1' }])).toBe('c1');
  });

  // Both non-one cases, for opposite reasons: nothing to point at, and no
  // SINGLE thing to point at.
  it('is null for a childless produto and for a family of many', () => {
    expect(derivarFilhoUnico([])).toBeNull();
    expect(derivarFilhoUnico([{ id: 'c1' }, { id: 'c2' }])).toBeNull();
    expect(derivarFilhoUnico([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }])).toBeNull();
  });

  // An empty id would be written as a pointer that resolves to nothing, and
  // `ehFamiliaDeUm` would then report a family of one with no member.
  it('refuses an empty id rather than storing it as a pointer', () => {
    expect(derivarFilhoUnico([{ id: '' }])).toBeNull();
  });
});

describe('ehFamiliaDeUm / unidadeVendavel — both shapes tolerated', () => {
  it('a parent of a family of one resolves to its child', () => {
    const p = { id: 'p1', paiId: null, filhoUnicoId: 'c1' };
    expect(ehFamiliaDeUm(p)).toBe(true);
    expect(unidadeVendavel(p)).toBe('c1');
  });

  // ⚠️ The read-tolerance the whole rollout rests on: until a writer stamps the
  // field, every produto in the corpus takes this branch and behaves exactly as
  // it does today.
  it('a childless legacy produto resolves to ITSELF', () => {
    const p = { id: 'p1', paiId: null, filhoUnicoId: null };
    expect(ehFamiliaDeUm(p)).toBe(false);
    expect(unidadeVendavel(p)).toBe('p1');
  });

  it('a produto whose filhoUnicoId key is absent resolves to itself', () => {
    expect(unidadeVendavel({ id: 'p1' })).toBe('p1');
  });

  it('a variation child resolves to itself', () => {
    const c = { id: 'c1', paiId: 'p1', filhoUnicoId: null };
    expect(ehFamiliaDeUm(c)).toBe(false);
    expect(unidadeVendavel(c)).toBe('c1');
  });

  // ⚠️ A family of MANY must NOT resolve to a child: each variation sells
  // separately and the parent's stock is genuinely not their sum. That is the
  // scoping problem #1398 flagged, and `filhoUnicoId: null` is what settles it.
  it('a parent of MANY resolves to itself, never to one of its children', () => {
    const p = { id: 'p1', paiId: null, filhoUnicoId: null };
    expect(unidadeVendavel(p)).toBe('p1');
  });

  // ⚠️ The drift case the `paiId` guard exists for. `filhoUnicoId` has no trigger
  // keeping it honest, so a child could end up carrying a stale one; `paiId` is
  // authoritative by construction. Without the guard this child would resolve to
  // some OTHER produto and a stock read would land on the wrong document.
  it('a CHILD carrying a stale filhoUnicoId resolves to itself, not to the pointer', () => {
    const drift = { id: 'c1', paiId: 'p1', filhoUnicoId: 'algum-outro' };
    expect(ehFamiliaDeUm(drift)).toBe(false);
    expect(unidadeVendavel(drift)).toBe('c1');
  });

  // The guard must not change anything for a caller that does not project it.
  it('is unaffected when the caller does not project paiId', () => {
    expect(ehFamiliaDeUm({ id: 'p1', filhoUnicoId: 'c1' })).toBe(true);
    expect(unidadeVendavel({ id: 'p1', filhoUnicoId: 'c1' })).toBe('c1');
  });

  // A stored empty string is not a pointer. Treating it as one sends readers to
  // `produtos/` — a collection, not a document.
  it('treats a stored empty filhoUnicoId as absent', () => {
    const p = { id: 'p1', paiId: null, filhoUnicoId: '' };
    expect(ehFamiliaDeUm(p)).toBe(false);
    expect(unidadeVendavel(p)).toBe('p1');
  });
});

/**
 * The sole member is a MIRROR, not a stub. After #1398 it is the sellable unit,
 * so anything a stock or pricing surface reads off "the produto" has to be on it.
 */
describe('montarMembroUnico', () => {
  const pai = {
    nome: 'Bandeja Decorativa',
    sku: 'BAN-1',
    codPai: 'CP',
    gtin: '789',
    publicado: true,
    ehUsado: false,
    precos: { L1: { valor: 10 } },
    categoriaProdutoOuterRef: 'documents/categorias/c1',
    pesoLiquidoKg: 1.5,
    pesoBrutoKg: 2,
    alturaCm: 10,
    larguraCm: 20,
    profundidadeCm: 30,
  };

  it('points at its parent and carries no variation taxonomy', () => {
    expect(montarMembroUnico('p1', pai)).toMatchObject({
      paiId: 'p1',
      grupoDeVariacoesUid: null,
      variacoesUid: null,
    });
  });

  // Each of these is read off "the produto" by a surface that, after #1398,
  // reads the CHILD: precos by the pedido reprice, the dimensions by freight
  // quoting, the categoria by the NF-e tax cascade's tier 3.
  it('mirrors the fields a sellable unit is read for', () => {
    expect(montarMembroUnico('p1', pai)).toMatchObject({
      nome: 'Bandeja Decorativa',
      sku: 'BAN-1',
      codPai: 'CP',
      gtin: '789',
      publicado: true,
      precos: { L1: { valor: 10 } },
      categoriaProdutoOuterRef: 'documents/categorias/c1',
      pesoLiquidoKg: 1.5,
      pesoBrutoKg: 2,
      alturaCm: 10,
      larguraCm: 20,
      profundidadeCm: 30,
    });
  });

  // `produto.nome` is capped at 100; a child built from a 100-char parent name
  // plus anything would fail the schema on write.
  it('truncates the name to the schema cap', () => {
    const longo = 'x'.repeat(140);
    expect((montarMembroUnico('p1', { nome: longo }).nome as string).length).toBe(100);
  });

  // ⚠️ A kit's availability is `min` over its components, computed from the
  // produto a surface reads. A child with no map would report its own (empty)
  // stock, so EVERY kit would read 0 — #1398's harm from a third direction.
  it('copies the kit map and its sorted denorm', () => {
    const kit = montarMembroUnico('p1', {
      ...pai,
      ehKit: true,
      componentesKit: { b: { quantidade: 1 }, a: { quantidade: 2 } },
    });
    expect(kit).toMatchObject({ ehKit: true, componentesKitKeys: ['a', 'b'] });
    expect(kit.componentesKit).toEqual({ b: { quantidade: 1 }, a: { quantidade: 2 } });
  });

  // Same rule the create page's `deriveOnSave` applies to the parent, so the
  // denorm can never outlive the flag.
  it('drops the kit map when the parent is not a kit', () => {
    expect(
      montarMembroUnico('p1', { ...pai, ehKit: false, componentesKit: { a: { quantidade: 1 } } }),
    ).toMatchObject({ ehKit: false, componentesKit: null, componentesKitKeys: null });
  });

  it('nulls an EMPTY kit map rather than storing {}', () => {
    expect(montarMembroUnico('p1', { ...pai, ehKit: true, componentesKit: {} })).toMatchObject({
      componentesKit: null,
      componentesKitKeys: null,
    });
  });

  // `ehKitVirtual` only means anything on a kit.
  it('does not carry ehKitVirtual onto a non-kit', () => {
    expect(montarMembroUnico('p1', { ...pai, ehKit: false, ehKitVirtual: true })).toMatchObject({
      ehKitVirtual: false,
    });
  });

  // ⚠️ A child never points at a child. Writing one would make `ehFamiliaDeUm`
  // report a wrapper and send readers one level too deep.
  it('never writes filhoUnicoId onto the child', () => {
    expect(montarMembroUnico('p1', pai)).not.toHaveProperty('filhoUnicoId');
  });

  it('degrades a parent with nothing set to schema-shaped nulls', () => {
    expect(montarMembroUnico('p1', {})).toMatchObject({
      nome: '',
      sku: null,
      paiId: 'p1',
      publicado: false,
      ehKit: false,
      componentesKit: null,
      precos: null,
    });
  });
});

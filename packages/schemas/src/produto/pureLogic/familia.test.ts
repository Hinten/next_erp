import { describe, expect, it } from 'vitest';
import {
  colapsarPaiEFilhoUnico,
  derivarFilhoUnico,
  ehFamiliaDeUm,
  CAMPOS_ESPELHADOS_COM_COMPARADOR,
  espelhoArmazenadoDoMembro,
  espelhoDoMembroUnico,
  montarMembroUnico,
  planejarSincronizacaoDoMembroUnico,
  skuDoMembroUnico,
  skuPaiDoMembroUnico,
  SUFIXO_MEMBRO_UNICO,
  unidadeVendavel,
} from './familia';
import { produtoSchema } from '../collection/produto';

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
      // ⚠️ DERIVED, not copied. A verbatim copy put two documents behind one
      // code — see the `skuDoMembroUnico` block below.
      sku: 'BAN-1-UN',
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

/**
 * Keeping the sole member in step with its parent (#1398, PR 7b).
 *
 * ⚠️ Per the equivalence-fold rule, every comparison here is asserted from BOTH
 * sides: a pair that must read as the same (so the mirror stays quiet, or does
 * not mistake a stale value for a deliberate edit) and a near-miss that must
 * stay distinct. A test that the fold APPLIES cannot show where it STOPS.
 */
/**
 * Both directions of the fold, per the equivalence rule: a pair that must come
 * out EQUAL, and a near-miss that must stay DISTINCT.
 *
 * The scope being tested is "does the suffix come off exactly once" — a test
 * that the derivation APPLIES cannot show where it STOPS, and over-stripping
 * hands a produto one of its own children's identities.
 */
describe('skuDoMembroUnico / skuPaiDoMembroUnico', () => {
  it('derives `<paiSku>` + the suffix', () => {
    expect(skuDoMembroUnico('CAM-BR-P')).toBe(`CAM-BR-P${SUFIXO_MEMBRO_UNICO}`);
    expect(skuDoMembroUnico('CAM-BR-P')).toBe('CAM-BR-P-UN');
  });

  it('round-trips an ordinary sku', () => {
    for (const sku of ['CAM-BR-P', 'ABC123', 'a-b-c', '0001']) {
      expect(skuPaiDoMembroUnico(skuDoMembroUnico(sku))).toBe(sku);
    }
  });

  // ⚠️ A bare '-UN' would be an identity the ERP resolves produtos by, invented
  // out of nothing. Absent is honest; wrong is not.
  it('gives a parent with no sku no sku at all', () => {
    expect(skuDoMembroUnico(null)).toBeNull();
    expect(skuDoMembroUnico(undefined)).toBeNull();
    expect(skuDoMembroUnico('')).toBeNull();
    expect(skuDoMembroUnico('   ')).toBeNull();
    expect(skuPaiDoMembroUnico(null)).toBeNull();
    expect(skuPaiDoMembroUnico('')).toBeNull();
  });

  // The near-miss that keeps the inverse honest: exactly ONE suffix comes off,
  // however many are there.
  it('strips at most one suffix', () => {
    expect(skuDoMembroUnico('PARAFUSO-UN')).toBe('PARAFUSO-UN-UN');
    expect(skuPaiDoMembroUnico('PARAFUSO-UN-UN')).toBe('PARAFUSO-UN');
  });

  // ...and a sku that never carried one passes through untouched, which is what
  // lets ONE call serve both the legacy and the current shape.
  it('leaves a sku that carries no suffix alone', () => {
    expect(skuPaiDoMembroUnico('CAM-BR-P')).toBe('CAM-BR-P');
  });

  // Byte-exact, no folding — the same discipline `skuPaiPorSufixo` keeps.
  it('keeps near-misses distinct', () => {
    expect(skuPaiDoMembroUnico('CAM-UNI')).toBe('CAM-UNI');
    expect(skuPaiDoMembroUnico('CAM-un')).toBe('CAM-un');
    expect(skuPaiDoMembroUnico('CAMUN')).toBe('CAMUN');
    expect(skuPaiDoMembroUnico('CAM-UN')).toBe('CAM');
  });

  // ⛔ The documented ambiguity, PINNED rather than hidden. A legacy member
  // storing 'PARAFUSO-UN' verbatim — its parent's own sku ends in the suffix —
  // is byte-identical to a current member derived from parent 'PARAFUSO', so the
  // inverse answers 'PARAFUSO' and is wrong for the legacy one. Reachable only
  // on an ML re-import of a família of one where rungs 1 and 2 both failed.
  it('cannot tell a legacy member from a derived one when the parent sku ends in the suffix', () => {
    expect(skuPaiDoMembroUnico('PARAFUSO-UN')).toBe('PARAFUSO');
  });

  // A member whose whole sku IS the suffix leaves no parent behind it.
  it('refuses to answer with an empty identity', () => {
    expect(skuPaiDoMembroUnico(SUFIXO_MEMBRO_UNICO)).toBe(SUFIXO_MEMBRO_UNICO);
  });

  // ⚠️ `montarMembroUnico`'s output is written WITHOUT a `produtoSchema.parse`
  // by the migration, ML publish and `buildMembroUnicoWriteOps`, so nothing
  // downstream would catch an over-long sku.
  it('truncates so the derived sku still fits the schema', () => {
    const derivado = skuDoMembroUnico('X'.repeat(255))!;
    expect(derivado).toHaveLength(255);
    expect(derivado.endsWith(SUFIXO_MEMBRO_UNICO)).toBe(true);
    expect(produtoSchema.shape.sku.safeParse(derivado).success).toBe(true);
  });
});

/**
 * ⛔ Why the mirror is TWO functions.
 *
 * Every mirrored field used to be a plain copy, so "what the parent projects"
 * and "how a stored member is normalised for comparison" coincided and one
 * function served both. `sku` is derived, so they diverge — and collapsing them
 * back does not fail loudly, it makes the merge report a permanent operator
 * divergence.
 */
describe('espelhoDoMembroUnico vs espelhoArmazenadoDoMembro — the split', () => {
  it('the parent PROJECTION derives the sku', () => {
    expect(espelhoDoMembroUnico({ nome: 'Bandeja', sku: 'BAN-1' }).sku).toBe('BAN-1-UN');
  });

  it('the stored NORMALISATION does not re-derive', () => {
    const membro = { nome: 'Bandeja', sku: 'BAN-1-UN' };
    expect(espelhoArmazenadoDoMembro(membro).sku).toBe('BAN-1-UN');
    // ...which is exactly what the projection would get WRONG on the same input.
    expect(espelhoDoMembroUnico(membro).sku).toBe('BAN-1-UN-UN');
  });

  // The consequence, end to end: a member holding the derived sku is in sync, so
  // an unrelated parent edit moves only what actually changed.
  it('a member already holding the derived sku is IN SYNC', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { nome: 'Bandeja', sku: 'BAN-1' },
        { nome: 'Bandeja Nova', sku: 'BAN-1' },
        { nome: 'Bandeja', sku: 'BAN-1-UN' },
      ),
    ).toEqual({ nome: 'Bandeja Nova' });
  });

  it('propagates a parent sku rename as the DERIVED value', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { nome: 'Bandeja', sku: 'BAN-1' },
        { nome: 'Bandeja', sku: 'BAN-2' },
        { nome: 'Bandeja', sku: 'BAN-1-UN' },
      ),
    ).toEqual({ sku: 'BAN-2-UN' });
  });

  // ⚠️ A LEGACY member — sku copied verbatim before this rule — reads as
  // diverged and is left alone, so it does NOT self-heal.
  //
  // Deliberate. The tolerant comparator that would heal it (accept the raw
  // parent value as "in sync") also answers "unchanged" when a parent's sku is
  // edited FROM 'X' TO 'X-UN', which silently loses a real rename. Production
  // has no converted produtos yet and staging is re-seeded, so the population
  // this would help is ~0 — not worth a directional comparator.
  it('leaves a LEGACY member holding the raw parent sku alone', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { nome: 'Bandeja', sku: 'BAN-1' },
        { nome: 'Bandeja', sku: 'BAN-2' },
        { nome: 'Bandeja', sku: 'BAN-1' },
      ),
    ).toBeNull();
  });
});

describe('planejarSincronizacaoDoMembroUnico', () => {
  const kit = (quantidade: number, limitarEstoque = true, timestamp: number | null = 1) => ({
    quantidade,
    limitarEstoque,
    timestamp,
  });

  const pai = (over: Record<string, unknown> = {}) => ({
    nome: 'Bandeja',
    sku: 'BAN-1',
    codPai: null,
    gtin: null,
    publicado: true,
    ehKit: false,
    ehKitVirtual: false,
    ehUsado: false,
    componentesKit: null,
    categoriaProdutoOuterRef: 'categorias/cat-1',
    pesoLiquidoKg: 1,
    pesoBrutoKg: 2,
    alturaCm: 3,
    larguraCm: 4,
    profundidadeCm: 5,
    ...over,
  });

  it('moves a field the parent changed while the member still held the old value', () => {
    const patch = planejarSincronizacaoDoMembroUnico(
      pai(),
      pai({ nome: 'Bandeja Decorativa' }),
      pai(),
    );
    expect(patch).toEqual({ nome: 'Bandeja Decorativa' });
  });

  it('is null when the parent moved nothing the member mirrors', () => {
    expect(planejarSincronizacaoDoMembroUnico(pai(), pai(), pai())).toBeNull();
  });

  // ⚠️ The whole reason this is a three-way merge. The sole member is an
  // ordinary produto and shows up as a row in the Variações tab, so an operator
  // can rename it — and a straight copy would undo that on the parent's next
  // save, silently, with the parent as a second writer that always wins.
  it('leaves a field the operator diverged alone', () => {
    const patch = planejarSincronizacaoDoMembroUnico(
      pai(),
      pai({ nome: 'Bandeja Decorativa' }),
      pai({ nome: 'nome escolhido pelo operador' }),
    );
    expect(patch).toBeNull();
  });

  // Per FIELD, not per document: one diverged field must not freeze the rest.
  it('still moves the other fields when ONE of them was diverged', () => {
    const patch = planejarSincronizacaoDoMembroUnico(
      pai(),
      pai({ nome: 'Bandeja Decorativa', sku: 'BAN-2' }),
      // ⚠️ The member holds the DERIVED sku, which is what a real one stores.
      // `pai()` in this slot would model a LEGACY member, whose sku reads as
      // diverged — pinned separately in "the split" block below.
      pai({ nome: 'nome escolhido pelo operador', sku: 'BAN-1-UN' }),
    );
    expect(patch).toEqual({ sku: 'BAN-2-UN' });
  });

  // ⚠️ This IS the concurrency guard (rule 7 tier 0). Two rapid parent edits
  // produce two trigger runs with no ordering guarantee; the older one must
  // decline rather than revert the newer state, and it declines for exactly the
  // same reason a human edit is respected — the child no longer holds `before`.
  it('declines to revert a newer value written by a run that landed first', () => {
    const patch = planejarSincronizacaoDoMembroUnico(
      pai({ nome: 'A' }), // this run saw A → B
      pai({ nome: 'B' }),
      pai({ nome: 'C' }), // but a later edit already wrote C
    );
    expect(patch).toBeNull();
  });

  it('propagates nothing on a create, where the member was written by the same writer', () => {
    expect(planejarSincronizacaoDoMembroUnico(null, pai({ nome: 'novo' }), pai())).toBeNull();
  });

  // A legacy member missing a key must not read as a deliberate divergence:
  // both sides go through the same normalisation before they are compared.
  it('treats an ABSENT boolean on the member as the false the mirror writes', () => {
    const patch = planejarSincronizacaoDoMembroUnico(
      pai({ ehUsado: false }),
      pai({ ehUsado: true }),
      pai({ ehUsado: undefined }),
    );
    expect(patch).toEqual({ ehUsado: true });
  });

  describe('componentesKit — what the fold treats as the same kit', () => {
    const comKit = (mapa: Record<string, unknown> | null) =>
      pai({ ehKit: true, componentesKit: mapa });

    // ⚠️ EQUAL. The editor restamps `timestamp` on save, so folding it in would
    // report a difference on a save that changed no component — and that reads
    // as "the operator diverged this child", silencing the mirror for good.
    it('ignores a restamped timestamp', () => {
      const patch = planejarSincronizacaoDoMembroUnico(
        comKit({ 'comp-1': kit(2, true, 111) }),
        comKit({ 'comp-1': kit(2, true, 999) }),
        comKit({ 'comp-1': kit(2, true, 111) }),
      );
      expect(patch).toBeNull();
    });

    // ⚠️ NEAR-MISS. Everything else about an entry changes what the kit
    // assembles from, and therefore what `kitEstoqueDisponivel` computes.
    it('keeps a changed quantidade distinct', () => {
      const patch = planejarSincronizacaoDoMembroUnico(
        comKit({ 'comp-1': kit(2) }),
        comKit({ 'comp-1': kit(3) }),
        comKit({ 'comp-1': kit(2) }),
      );
      expect(patch).toMatchObject({ componentesKit: { 'comp-1': { quantidade: 3 } } });
    });

    it('keeps a flipped limitarEstoque distinct', () => {
      const patch = planejarSincronizacaoDoMembroUnico(
        comKit({ 'comp-1': kit(2, true) }),
        comKit({ 'comp-1': kit(2, false) }),
        comKit({ 'comp-1': kit(2, true) }),
      );
      expect(patch).toMatchObject({ componentesKit: { 'comp-1': { limitarEstoque: false } } });
    });

    it('keeps an added component distinct', () => {
      const patch = planejarSincronizacaoDoMembroUnico(
        comKit({ 'comp-1': kit(1) }),
        comKit({ 'comp-1': kit(1), 'comp-2': kit(1) }),
        comKit({ 'comp-1': kit(1) }),
      );
      expect(patch).toMatchObject({ componentesKitKeys: ['comp-1', 'comp-2'] });
    });

    // ⚠️ A kit that stops being a kit must drop BOTH the map and its key array,
    // or an `array-contains` query keeps finding the member as a component of
    // something it no longer assembles.
    it('clears the map AND the keys when the parent stops being a kit', () => {
      const patch = planejarSincronizacaoDoMembroUnico(
        comKit({ 'comp-1': kit(1) }),
        pai({ ehKit: false, componentesKit: { 'comp-1': kit(1) } }),
        comKit({ 'comp-1': kit(1) }),
      );
      // ⚠️ `ehKitVirtual` rides along even though it did not move on its own.
      // The four kit fields are ONE unit — see "the kit group is atomic" below —
      // and writing a subset is exactly how a member ended up with a flag whose
      // map had been declined.
      expect(patch).toEqual({
        ehKit: false,
        ehKitVirtual: false,
        componentesKit: null,
        componentesKitKeys: null,
      });
    });
  });

  // ⚠️ `precos` is the one mirrored-looking field with an operator OPT-OUT
  // (`propagatePriceToChildren`), owned by the trigger's own propagation since
  // 2026-07-21. Sweeping it in here would defeat that checkbox on the very save
  // where the operator ticked it.
  it('never carries precos, even when the parent changed them', () => {
    // ⚠️ ONE object, shared by the `before` parent and the member. An earlier
    // version of this test built two structurally-identical literals — and it
    // passed with `precos` PUT BACK in the mirror, because the default
    // comparator is `===` and two literals are never identical, so the merge
    // declined as "the operator diverged it". The mutation survived. Sharing the
    // reference removes that escape: with `precos` mirrored, this patch is
    // `{ precos: { l1: { valor: 99 } } }`.
    const precosAntigos = { l1: { valor: 10 } };
    const patch = planejarSincronizacaoDoMembroUnico(
      { ...pai(), precos: precosAntigos },
      { ...pai(), precos: { l1: { valor: 99 } } },
      { ...pai(), precos: precosAntigos },
    );
    expect(patch).toBeNull();
  });

  // ⚠️ The structural half of the same finding. An object-valued mirrored field
  // with no comparator compares by IDENTITY, so it reads as diverged on every
  // save and never propagates again — silently, and permanently. This fails the
  // moment such a field is added, rather than the moment someone notices the
  // sellable half of a produto has been stale for months.
  it('has a comparator for every mirrored field that is not a primitive', () => {
    const preenchido = espelhoDoMembroUnico({
      ...pai({ ehKit: true, componentesKit: { 'comp-1': kit(1) } }),
      precos: { l1: { valor: 10 } },
    });
    const semComparador = Object.entries(preenchido)
      .filter(([campo]) => !CAMPOS_ESPELHADOS_COM_COMPARADOR.includes(campo))
      .filter(([, valor]) => valor !== null && typeof valor === 'object')
      .map(([campo]) => campo);
    expect(semComparador).toEqual([]);
  });

  it('montarMembroUnico still carries precos, because a create has no propagation to race', () => {
    expect(montarMembroUnico('p1', { ...pai(), precos: { l1: { valor: 10 } } })).toMatchObject({
      precos: { l1: { valor: 10 } },
      paiId: 'p1',
    });
  });
});

/**
 * ⛔ The kit group moves as ONE unit (found by adversarial review of #1427).
 *
 * `componentesKitKeys` is derived from `componentesKit` and `ehKit` gates both,
 * so deciding them independently produces states the schema forbids — and
 * `calcularAlteracoesEstoque` reads "kit with no components" as a line that moves
 * NOTHING. Both shapes below were reproduced against the shipped function before
 * the fix.
 */
describe('planejarSincronizacaoDoMembroUnico — the kit group is atomic', () => {
  const k = (quantidade: number) => ({ quantidade, limitarEstoque: true, timestamp: 1 });
  const base = { nome: 'Cesta', sku: 'CES-1', paiId: null };

  // ⛔ Was: `{ componentesKitKeys: ['c1'] }` — the map declined, the keys moved.
  it('declines the KEYS too when the member diverged the map (narrowing)', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { ...base, ehKit: true, componentesKit: { c1: k(1), c2: k(1) } },
        { ...base, ehKit: true, componentesKit: { c1: k(1) } },
        { ...base, ehKit: true, componentesKit: { c1: k(5), c2: k(1) } },
      ),
    ).toBeNull();
  });

  // ⛔ Was: `{ componentesKitKeys: ['c1','c2'] }` — keys widened past the map, so
  // the member matched `componentesKitKeys array-contains` for a component it
  // does not assemble and the rollup fanned out to it for nothing.
  it('declines the KEYS too when the member diverged the map (widening)', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { ...base, ehKit: true, componentesKit: { c1: k(1) } },
        { ...base, ehKit: true, componentesKit: { c1: k(1), c2: k(1) } },
        { ...base, ehKit: true, componentesKit: { c1: k(5) } },
      ),
    ).toBeNull();
  });

  // ⛔ Was: `{ ehKit: false, componentesKitKeys: null }` — the flag moved and the
  // MAP survived, contradicting this file's own "a non-kit carries no map".
  it('never moves the flag without the map it gates', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { ...base, ehKit: true, componentesKit: { c1: k(1) } },
        { ...base, ehKit: false, componentesKit: { c1: k(1) } },
        { ...base, ehKit: true, componentesKit: { c1: k(5) } },
      ),
    ).toBeNull();
  });

  // ...and the near-miss that keeps the group ALIVE: an in-sync member still
  // takes the whole group, all four fields together.
  it('moves all four together when the member is in sync', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { ...base, ehKit: true, componentesKit: { c1: k(1) } },
        { ...base, ehKit: true, componentesKit: { c1: k(1), c2: k(2) } },
        { ...base, ehKit: true, componentesKit: { c1: k(1) } },
      ),
    ).toEqual({
      ehKit: true,
      ehKitVirtual: false,
      componentesKit: { c1: k(1), c2: k(2) },
      componentesKitKeys: ['c1', 'c2'],
    });
  });

  // ⚠️ Sync is required on ALL FOUR, not just on the map. A member whose
  // `ehKitVirtual` the operator flipped owns the group: moving the map over it
  // would take the flag with it and undo that edit. Keying the check on
  // `componentesKit` alone passes every other test here — this is the one that
  // tells the two rules apart.
  it('declines when the member diverged only the VIRTUAL flag', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { ...base, ehKit: true, ehKitVirtual: false, componentesKit: { c1: k(1) } },
        { ...base, ehKit: true, ehKitVirtual: false, componentesKit: { c1: k(2) } },
        { ...base, ehKit: true, ehKitVirtual: true, componentesKit: { c1: k(1) } },
      ),
    ).toBeNull();
  });

  // A divergence in the GROUP must not freeze the fields outside it.
  it('still moves a non-kit field when only the kit group is diverged', () => {
    expect(
      planejarSincronizacaoDoMembroUnico(
        { ...base, nome: 'Cesta', ehKit: true, componentesKit: { c1: k(1) } },
        { ...base, nome: 'Cesta Grande', ehKit: true, componentesKit: { c1: k(2) } },
        { ...base, nome: 'Cesta', ehKit: true, componentesKit: { c1: k(5) } },
      ),
    ).toEqual({ nome: 'Cesta Grande' });
  });
});

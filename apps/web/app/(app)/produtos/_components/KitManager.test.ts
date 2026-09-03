import { describe, expect, it } from 'vitest';
import type { DimensoesKit } from '@delfrance/schemas';
import { decidirComponente, kitDimensoesFormPatches, stripKitForSave } from './KitManager';
import type { ProdutoComponenteBruto } from './KitManager';

describe('stripKitForSave', () => {
  it('drops _delete entries and the transient marker, keeping a clean record', () => {
    const out = stripKitForSave({
      a: { quantidade: 2, limitarEstoque: true, timestamp: null },
      b: { quantidade: 1, limitarEstoque: false, timestamp: null, _delete: true },
    });
    expect(out).toEqual({ a: { quantidade: 2, limitarEstoque: true, timestamp: null } });
  });

  it('returns null for an empty or fully-deleted map', () => {
    expect(stripKitForSave(null)).toBeNull();
    expect(stripKitForSave({})).toBeNull();
    expect(
      stripKitForSave({
        a: { quantidade: 1, limitarEstoque: true, timestamp: null, _delete: true },
      }),
    ).toBeNull();
  });
});

describe('kitDimensoesFormPatches', () => {
  const current = {
    pesoBrutoKg: 1,
    pesoLiquidoKg: 0.8,
    alturaCm: 5,
    larguraCm: 10,
    profundidadeCm: 10,
  };
  const rollup = (over: Partial<DimensoesKit> = {}): DimensoesKit => ({
    pesoBrutoKg: 1,
    pesoLiquidoKg: 0.8,
    alturaCm: 5,
    larguraCm: 10,
    profundidadeCm: 10,
    ...over,
  });

  it('returns no patches when syncPesoToForm is off (variation-child editor)', () => {
    expect(kitDimensoesFormPatches(false, true, rollup({ pesoBrutoKg: 2 }), current)).toEqual([]);
  });

  it('returns no patches when the produto is not a kit', () => {
    expect(kitDimensoesFormPatches(true, false, rollup({ pesoBrutoKg: 2 }), current)).toEqual([]);
  });

  it('returns no patches while the rollup has not resolved yet', () => {
    expect(kitDimensoesFormPatches(true, true, null, current)).toEqual([]);
  });

  it('returns no patches when the form already matches (no needless dirtying)', () => {
    expect(kitDimensoesFormPatches(true, true, rollup(), current)).toEqual([]);
  });

  it('patches only the fields that differ', () => {
    expect(
      kitDimensoesFormPatches(true, true, rollup({ pesoBrutoKg: 2, alturaCm: 7 }), current),
    ).toEqual([
      { field: 'pesoBrutoKg', value: 2 },
      { field: 'alturaCm', value: 7 },
    ]);
  });

  it('SKIPS a null field rather than writing it', () => {
    // `null` means either "reads still in flight" or "not derivable" — both must
    // leave the stored value alone. Writing the estimator's DIMENSOES_PADRAO
    // fallback would turn a guess into a stored measurement.
    expect(
      kitDimensoesFormPatches(
        true,
        true,
        rollup({ pesoBrutoKg: null, alturaCm: null, larguraCm: null, profundidadeCm: null }),
        { ...current, pesoLiquidoKg: 9 },
      ),
    ).toEqual([{ field: 'pesoLiquidoKg', value: 0.8 }]);
  });

  it('patches every derived field when the form is empty', () => {
    // Pins that all FIVE fields are covered — a field added to DimensoesKit but
    // forgotten in the patch builder shows up here as a missing entry.
    expect(kitDimensoesFormPatches(true, true, rollup(), {})).toEqual([
      { field: 'pesoBrutoKg', value: 1 },
      { field: 'pesoLiquidoKg', value: 0.8 },
      { field: 'alturaCm', value: 5 },
      { field: 'larguraCm', value: 10 },
      { field: 'profundidadeCm', value: 10 },
    ]);
  });
});

/**
 * `decidirComponente` — which produto a picked component actually becomes, and
 * every reason it can be refused.
 *
 * The corpus: `pai` is a family of one whose sellable unit is `filho`; `avulso`
 * is a childless produto (or a family of MANY — `unidadeVendavel` answers the
 * same for both, and for the same reason: there is no single unit to point at).
 */
const PAI: ProdutoComponenteBruto = { paiId: null, filhoUnicoId: 'filho' };
const FILHO: ProdutoComponenteBruto = { paiId: 'pai', filhoUnicoId: null };
const AVULSO: ProdutoComponenteBruto = { paiId: null, filhoUnicoId: null };

function decidir(over: Partial<Parameters<typeof decidirComponente>[0]> = {}) {
  return decidirComponente({
    id: 'pai',
    produtoId: 'kit-1',
    excludeIds: [],
    componentes: {},
    doc: PAI,
    docAlvo: AVULSO,
    ...over,
  });
}

describe('decidirComponente — the id it stores', () => {
  it('stores the SOLE MEMBER when a family-of-one parent is picked', () => {
    expect(decidir()).toEqual({ tipo: 'adicionar', alvo: 'filho', reaproveitarDe: null });
  });

  // ⚠️ The near-miss. A childless produto — and a family of MANY, which
  // `unidadeVendavel` answers identically — owns its own stock, so moving the id
  // would name a produto that does not exist or pick one arbitrary variation.
  it('leaves a childless produto exactly as picked', () => {
    expect(decidir({ id: 'avulso', doc: AVULSO, docAlvo: undefined })).toEqual({
      tipo: 'adicionar',
      alvo: 'avulso',
      reaproveitarDe: null,
    });
  });

  // ...and the fixpoint: a child picked directly resolves to itself, which is
  // what makes the migration's rewrite and this screen agree on one answer.
  it('leaves a sole member picked directly as itself', () => {
    expect(decidir({ id: 'filho', doc: FILHO, docAlvo: undefined })).toEqual({
      tipo: 'adicionar',
      alvo: 'filho',
      reaproveitarDe: null,
    });
  });

  /**
   * ⛔ A pointer naming a document that is gone. `unidadeVendavel` never proves
   * the child exists and nothing in the repo repairs a dangling `filhoUnicoId`,
   * so adopting it anyway would file a component under an id with no custo, no
   * weight and no estoque row — reading 0 for ever. It stays itself.
   */
  it('falls back to the picked produto when the sole member cannot be read', () => {
    expect(decidir({ docAlvo: undefined })).toEqual({
      tipo: 'adicionar',
      alvo: 'pai',
      reaproveitarDe: null,
    });
  });
});

describe('decidirComponente — what it refuses', () => {
  it('refuses a produto it could not read', () => {
    expect(decidir({ doc: undefined })).toMatchObject({ tipo: 'recusar' });
  });

  it('refuses the produto being edited', () => {
    expect(decidir({ id: 'kit-1', doc: AVULSO, docAlvo: undefined })).toMatchObject({
      tipo: 'recusar',
      motivo: 'Um produto não pode ser componente de si mesmo.',
    });
  });

  /**
   * ⛔ The self-reference that only the RESOLVED id can catch, and the reason
   * every guard runs twice.
   *
   * In the per-variation editor `produtoId` is the CHILD. Picking its parent
   * resolves straight onto `produtoId` — and nothing checked that before, because
   * the raw-id guard sees two different strings and the `excludeIds` guard reads
   * the PROP, which never contains `produtoId`. The kit would contain itself, and
   * the dimensions rollup's cycle bound would be load-bearing for real.
   */
  it('refuses a parent that RESOLVES onto the produto being edited', () => {
    expect(decidir({ produtoId: 'filho', excludeIds: [] })).toMatchObject({
      tipo: 'recusar',
      motivo: 'Um produto não pode ser componente de si mesmo.',
    });
  });

  it('refuses a kit picked directly', () => {
    expect(decidir({ id: 'k', doc: { ...AVULSO, ehKit: true }, docAlvo: undefined })).toMatchObject(
      { tipo: 'recusar', motivo: 'Um kit não pode ser componente de outro kit.' },
    );
  });

  // ⚠️ The mirror freezes the four kit fields the moment an operator diverges
  // one, so a member that is a kit under a parent that is not is a state the
  // code allows. Checking only the picked parent would let it in.
  it('refuses when the SOLE MEMBER is a kit even though the parent is not', () => {
    expect(decidir({ docAlvo: { ...AVULSO, ehKit: true } })).toMatchObject({
      tipo: 'recusar',
      motivo: 'Um kit não pode ser componente de outro kit.',
    });
  });

  // `buildChildrenComponentesKitOps` writes a child's `componentesKit` WITHOUT
  // writing `ehKit`, so "not flagged a kit" is not the same as "has no
  // composition".
  it('refuses a sole member carrying a composition with no ehKit flag', () => {
    expect(
      decidir({ docAlvo: { ...AVULSO, componentesKit: { x: { quantidade: 1 } } } }),
    ).toMatchObject({ tipo: 'recusar' });
  });

  it('refuses a variation of the produto being edited', () => {
    expect(
      decidir({ id: 'v', doc: { paiId: 'kit-1', filhoUnicoId: null }, docAlvo: undefined }),
    ).toMatchObject({ tipo: 'recusar' });
  });

  it('refuses when the RESOLVED id is excluded, not just the picked one', () => {
    expect(decidir({ excludeIds: ['filho'] })).toMatchObject({
      tipo: 'recusar',
      motivo: 'Este produto não pode ser componente deste kit.',
    });
  });

  it('refuses a component already in the map under its resolved id', () => {
    expect(decidir({ componentes: { filho: {} } })).toMatchObject({
      tipo: 'recusar',
      motivo: 'Este componente já foi adicionado.',
    });
  });

  /**
   * ⛔ The duplicate the resolution would otherwise create. A legacy map still
   * names the PARENT, so guarding only the resolved id lets one physical produto
   * occupy two keys — and `kitEstoqueDisponivel` takes the MIN over entries, so
   * the parent (no estoque row of its own) scores 0 and the whole kit reads 0.
   * The fix producing the bug.
   */
  it('refuses a component already in the map under its OLD parent id', () => {
    expect(decidir({ componentes: { pai: {} } })).toMatchObject({
      tipo: 'recusar',
      motivo: 'Este componente já foi adicionado.',
    });
  });

  it('allows adding in create mode, where there is no produto to be self', () => {
    expect(decidir({ produtoId: null })).toMatchObject({ tipo: 'adicionar', alvo: 'filho' });
  });
});

describe('decidirComponente — reviving a staged deletion', () => {
  it('reuses the entry filed under the resolved id', () => {
    expect(decidir({ componentes: { filho: { _delete: true } } })).toEqual({
      tipo: 'adicionar',
      alvo: 'filho',
      reaproveitarDe: 'filho',
    });
  });

  // ⚠️ The entry sits under the OLD parent key, and the caller drops that key
  // when it writes the revived one under `alvo` — otherwise the un-delete leaves
  // BOTH, which is the same min-over-two-keys zero as above.
  it('reuses an entry filed under the OLD parent id, and names it for removal', () => {
    expect(decidir({ componentes: { pai: { _delete: true } } })).toEqual({
      tipo: 'adicionar',
      alvo: 'filho',
      reaproveitarDe: 'pai',
    });
  });
});

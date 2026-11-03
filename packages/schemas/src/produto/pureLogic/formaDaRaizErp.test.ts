import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that the root `src/index.ts` reaches it.
import { FORMA_RAIZ_ERP, ehFamiliaDeUm, formaDaRaizErp, type MembroDeFamilia } from '../../index';

/**
 * The ERP root's shape, read from its MEMBER (the product import, step 9). The pointer alone
 * cannot tell the two one-child shapes apart — `ehFamiliaDeUm` is true for both — so every
 * one-child case is pinned beside the other.
 */

const raiz = (filhoUnicoId: string | null = null) => ({ id: 'r1', paiId: null, filhoUnicoId });
const membro = (taxonomia: Partial<MembroDeFamilia> = {}): MembroDeFamilia => ({
  id: 'm1',
  paiId: 'r1',
  variacoesUid: null,
  grupoDeVariacoesUid: null,
  ...taxonomia,
});

describe('formaDaRaizErp — one-child roots are told apart by the member', () => {
  it('EQUAL: a pointer + a member with no taxonomy ⇒ familia-de-um (the "Novo produto" shape)', () => {
    expect(formaDaRaizErp({ raiz: raiz('m1'), membro: membro(), contagemDeFilhos: null })).toBe(
      FORMA_RAIZ_ERP.familiaDeUm,
    );
    expect(
      formaDaRaizErp({
        raiz: raiz('m1'),
        membro: membro({ variacoesUid: [], grupoDeVariacoesUid: [] }),
        contagemDeFilhos: 1,
      }),
    ).toBe(FORMA_RAIZ_ERP.familiaDeUm);
  });

  it('⚠️ NEAR-MISS: a pointer + a member WITH taxonomy ⇒ familia-de-uma-variacao, never familia-de-um', () => {
    for (const taxonomia of [
      { variacoesUid: ['azul'] },
      { grupoDeVariacoesUid: ['cor'] },
      { variacoesUid: ['azul'], grupoDeVariacoesUid: ['cor'] },
    ]) {
      expect(
        formaDaRaizErp({ raiz: raiz('m1'), membro: membro(taxonomia), contagemDeFilhos: null }),
      ).toBe(FORMA_RAIZ_ERP.familiaDeUmaVariacao);
    }
    // The pointer reads the same for both: that is why the member is read.
    expect(ehFamiliaDeUm(raiz('m1'))).toBe(true);
  });

  it('EQUAL: no pointer — no child ⇒ raiz-simples; two or more ⇒ familia-de-muitas', () => {
    expect(formaDaRaizErp({ raiz: raiz(), membro: null, contagemDeFilhos: 0 })).toBe(
      FORMA_RAIZ_ERP.raizSimples,
    );
    expect(formaDaRaizErp({ raiz: raiz(), membro: null, contagemDeFilhos: 2 })).toBe(
      FORMA_RAIZ_ERP.familiaDeMuitas,
    );
  });

  it('⚠️ NEAR-MISS: one child and no pointer ⇒ forma-ilegivel, never familia-de-um', () => {
    expect(formaDaRaizErp({ raiz: raiz(), membro: null, contagemDeFilhos: 1 })).toBe(
      FORMA_RAIZ_ERP.formaIlegivel,
    );
  });

  it.each([
    ['a pointer naming no document', raiz('m1'), null, null],
    ['a pointer naming another document', raiz('m2'), membro(), null],
    ['a member that is another root’s child', raiz('m1'), membro({ paiId: 'r9' }), null],
    ['a pointer beside two or more children', raiz('m1'), membro(), 2],
    ['a pointer beside no child at all', raiz('m1'), membro(), 0],
    ['no pointer and no children read', raiz(), null, null],
    ['a "root" that is itself a child', { id: 'r1', paiId: 'p0', filhoUnicoId: null }, null, 0],
  ] as const)('⚠️ drift — %s ⇒ forma-ilegivel', (_r, r, m, contagem) => {
    expect(formaDaRaizErp({ raiz: r, membro: m, contagemDeFilhos: contagem })).toBe(
      FORMA_RAIZ_ERP.formaIlegivel,
    );
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeApp } from 'firebase/app';
import { getFirestore, type QueryDocumentSnapshot } from 'firebase/firestore';
import { PRODUTO_SUBCOLLECTION_NAMES } from '@delfrance/schemas';

import { produtoShopeeLinkCollection } from './produtoShopeeLinkCollection';

const db = getFirestore(
  initializeApp({ projectId: 'demo-prodshopee-handle' }, 'prodshopee-handle'),
  'default',
);

/** The converter's input: only `data()` and `ref.path` are read. */
function snapDe(data: Record<string, unknown>): QueryDocumentSnapshot {
  return {
    data: () => data,
    ref: { path: 'produtos/p1/prodshopee/l1' },
  } as unknown as QueryDocumentSnapshot;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('produtoShopeeLinkCollection', () => {
  it('addresses the produto’s own prodshopee subcollection, which the rules cover', () => {
    const ref = produtoShopeeLinkCollection.ref(db, { produtoId: 'p1' });
    expect(ref.path).toBe('produtos/p1/prodshopee');
    expect(produtoShopeeLinkCollection.docRef(db, { produtoId: 'p1' }, 'l1').path).toBe(
      'produtos/p1/prodshopee/l1',
    );
    // Covered by the loose marketplace domain, so no ruleset regeneration.
    expect(PRODUTO_SUBCOLLECTION_NAMES).toContain(ref.id);
  });

  it('reads a well-formed link typed, with the step-11+ fields defaulted', () => {
    const lido = produtoShopeeLinkCollection.converter.fromFirestore(
      snapDe({ contaProdutoShopeeOuterRef: 'documents/integracao/int-1', item_name: 'Camiseta' }),
    );
    expect(lido.item_id).toBeNull();
    expect(lido.estadoAnuncio).toBeNull();
    expect(lido.violations).toBeNull();
  });

  it('hands back the RAW document when it does not parse — what the tab’s total readers are for', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A migrated row with no `item_name` and an `estadoAnuncio` this build does
    // not know: the soft-read keeps every key verbatim instead of throwing.
    const cru = {
      contaProdutoShopeeOuterRef: 'integracao/int-1',
      item_id: 1000001,
      estadoAnuncio: 'arquivado',
    };
    expect(produtoShopeeLinkCollection.converter.fromFirestore(snapDe(cru))).toEqual(cru);
  });
});

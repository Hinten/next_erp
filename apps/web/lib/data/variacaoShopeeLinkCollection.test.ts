import { describe, expect, it } from 'vitest';
import { initializeApp } from 'firebase/app';
import { getFirestore, type QueryDocumentSnapshot } from 'firebase/firestore';
import { PRODUTO_SUBCOLLECTION_NAMES } from '@delfrance/schemas';

import { variacaoShopeeLinkCollection } from './variacaoShopeeLinkCollection';

const db = getFirestore(
  initializeApp({ projectId: 'demo-variashopee-handle' }, 'variashopee-handle'),
  'default',
);

describe('variacaoShopeeLinkCollection', () => {
  it('addresses the CHILD produto’s variashopee subcollection, which the rules cover', () => {
    const ref = variacaoShopeeLinkCollection.ref(db, { produtoId: 'filho-1' });
    expect(ref.path).toBe('produtos/filho-1/variashopee');
    expect(PRODUTO_SUBCOLLECTION_NAMES).toContain(ref.id);
  });

  it('reads a model row typed, keeping the listing ref the attribution needs', () => {
    const lido = variacaoShopeeLinkCollection.converter.fromFirestore({
      data: () => ({
        contaVariacaoShopeeOuterRef: 'documents/integracao/int-1',
        produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
        model_id: 2000001,
      }),
      ref: { path: 'produtos/filho-1/variashopee/v1' },
    } as unknown as QueryDocumentSnapshot);
    expect(lido.produtoShopeeOuterRef).toBe('documents/produtos/p1/prodshopee/l1');
    expect(lido.precoRecusaEm).toBeNull();
    expect(lido.modeloAusenteEm).toBeNull();
  });
});

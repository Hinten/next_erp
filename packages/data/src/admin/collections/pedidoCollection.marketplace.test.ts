import { ESTADO_PEDIDO, MARKETPLACE_PEDIDO_TIPO } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { pedidoCollection } from './pedidoCollection';

/**
 * The pedido handle's WRITE path over the `marketplace` block (Amazon step 5,
 * #1931). `packages/schemas/src/pedido.test.ts` pins the Zod schema; this pins
 * what a channel importer actually hands Firestore: `parse` (`parseForWrite`,
 * the full write behind a `tx.create`/`set`) and `parseMerge`
 * (`parseMergePatch`, the patch behind a `tx.update`/`merge`). Neither runs the
 * schema the way the schemas test does — `parseForWrite` re-parses strictly
 * only when a key was dropped, and `parseMergePatch` parses a `.partial()` — so
 * the "absent stays absent" contract of the three Amazon keys is pinned on both.
 */
const CHAVES_AMAZON = ['invoiceStatus', 'fulfilledBy', 'programs'] as const;

/** What the Shopee importer writes: none of the Amazon keys. */
const BLOCO_SHOPEE = {
  tipo: MARKETPLACE_PEDIDO_TIPO.shopee,
  status: 'READY_TO_SHIP',
  statusEm: 1_788_973_354_000_000,
  pendingTerms: [],
  completedScenario: null,
  cancelReason: null,
  cancelBy: null,
};

/** What the Amazon importer hands the parse: no `cancelReason` / `pendingTerms` / `completedScenario`. */
const BLOCO_AMAZON = {
  tipo: MARKETPLACE_PEDIDO_TIPO.amazon,
  status: 'UNSHIPPED',
  statusEm: 1_788_973_354_000_000,
  cancelBy: null,
  invoiceStatus: 'PENDING',
  fulfilledBy: 'MERCHANT',
  programs: ['DELIVERY_BY_AMAZON', 'PRIME'],
};

const PEDIDO_BASE = {
  estado: ESTADO_PEDIDO.pago,
  integracaoPedidoOuterRef: 'documents/integracao/x',
};

describe('pedidoCollection — the marketplace block on the write path (Amazon step 5)', () => {
  it('★ a full write (`parse`) of a Shopee block gains NO Amazon key — absent stays absent', () => {
    const out = pedidoCollection.parse({ ...PEDIDO_BASE, marketplace: BLOCO_SHOPEE });
    expect(out.marketplace).toEqual(BLOCO_SHOPEE);
    for (const chave of CHAVES_AMAZON) {
      expect(Object.hasOwn(out.marketplace ?? {}, chave), chave).toBe(false);
    }
  });

  it('★ a merge patch (`parseMerge`) of a Shopee block gains NO Amazon key — absent stays absent', () => {
    const out = pedidoCollection.parseMerge({ marketplace: BLOCO_SHOPEE });
    expect(Object.keys(out)).toEqual(['marketplace']);
    expect(out.marketplace).toEqual(BLOCO_SHOPEE);
    for (const chave of CHAVES_AMAZON) {
      expect(Object.hasOwn(out.marketplace ?? {}, chave), chave).toBe(false);
    }
  });

  it('an Amazon block keeps its three keys on both paths, and the three Shopee-shaped keys are STORED as null', () => {
    // A comparator over a stored Amazon block must read `cancelReason`,
    // `pendingTerms` and `completedScenario` as `null`, never as absent: the
    // schema defaults write them on every parse, full write and patch alike.
    const esperado = {
      ...BLOCO_AMAZON,
      pendingTerms: null,
      completedScenario: null,
      cancelReason: null,
    };
    const completo = pedidoCollection.parse({ ...PEDIDO_BASE, marketplace: BLOCO_AMAZON });
    const patch = pedidoCollection.parseMerge({ marketplace: BLOCO_AMAZON });
    for (const out of [completo, patch]) {
      expect(out.marketplace).toEqual(esperado);
      expect(out.marketplace?.programs).toEqual(['DELIVERY_BY_AMAZON', 'PRIME']);
    }
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@delfrance/data/admin';
import {
  migracaoUptinMercadoLivreCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  idLocalMercadoLivre,
  UPTIN_DESTINATION_TAG,
  UPTIN_SOURCE_TAG,
} from '@delfrance/integrations-mercado-livre';
import { toOuterRef } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { handleUptinMigration, startUptinMigration } from './importMigration';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('UPtin Firestore handoff', () => {
  it('commits a single claim and replaces legacy links on the existing products', async () => {
    const db = getAdminFirestore();
    const suffix = randomUUID().replaceAll('-', '');
    const produtoId = `parent-${suffix}`;
    const childIds = [`left-${suffix}`, `right-${suffix}`];
    const integracaoId = `conta-${suffix}`;
    const numeric = BigInt(`0x${suffix.slice(0, 12)}`) * 10n;
    const itemId = `MLB${numeric}`;
    const memberIds = [`MLB${numeric + 1n}`, `MLB${numeric + 2n}`];
    const familyId = String(numeric + 3n);
    const contaOuterRef = toOuterRef(`integracao/${integracaoId}`);
    const linkDocId = 'old';
    const source = produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId);
    const productRefs = [produtoId, ...childIds].map((id) => produtoCollection.docRef(db, {}, id));
    const oldLinks = childIds.map((id) =>
      variacaoMercadoLivreLinkCollection.docRef(db, { produtoId: id }, 'old'),
    );
    const operation = migracaoUptinMercadoLivreCollection.docRef(
      db,
      {},
      sha256Hex(`${integracaoId}|${itemId}`),
    );
    const newParent = produtoMercadoLivreLinkCollection.docRef(
      db,
      { produtoId },
      `100000000000000000${familyId}`,
    );
    const active = {
      id: itemId,
      seller_id: 42,
      status: 'active',
      variations: [{ id: 111 }, { id: 222 }],
    };
    const api = {
      getItem: vi.fn(async () => active),
      validateUptin: vi.fn(async () => ({ is_valid: true })),
      startUptin: vi.fn(async () => {}),
      getMigrationLiveListing: vi.fn(async () => ({
        item_id: itemId,
        activation_completed: '2026-10-01T12:00:00Z',
        new_items: memberIds.map((id, index) => ({
          new_item_id: id,
          variation_id: active.variations[index]!.id,
        })),
      })),
      getItemsByIds: vi.fn(async () =>
        memberIds.map((id) => ({
          code: 200,
          body: {
            id,
            seller_id: 42,
            family_id: familyId,
            family_name: 'Família UP',
            user_product_id: `UP-${id}`,
            status: 'active',
            tags: [UPTIN_DESTINATION_TAG],
          },
        })),
      ),
      getLastModeration: vi.fn(async () => []),
    };
    const deps = { db, api, integracaoId, sellerUserId: 42 };
    const target = { produtoId, linkDocId };
    const arm = vi.fn(async () => {});
    const memberRefs = childIds.map((id, index) =>
      variacaoMercadoLivreLinkCollection.docRef(
        db,
        { produtoId: id },
        idLocalMercadoLivre(newParent.id, memberIds[index]!),
      ),
    );
    try {
      const seed = db.batch();
      seed.set(productRefs[0]!, { nome: 'Produto pai' });
      seed.set(source, { title: 'Legado', id: itemId, contaOuterRef, estado: 'p' });
      for (const [index, id] of childIds.entries()) {
        seed.set(productRefs[index + 1]!, { nome: 'Variação', paiId: produtoId });
        seed.set(oldLinks[index]!, {
          id: active.variations[index]!.id,
          produtoMercadoLivreOuterRef: index === 0 ? source.path : toOuterRef(source.path),
          produtoVariacaoOuterRef: toOuterRef(`produtos/${id}`),
        });
      }
      await seed.commit();
      await Promise.all([
        startUptinMigration(deps, itemId, target, arm),
        startUptinMigration(deps, itemId, target, arm),
      ]);
      expect(api.startUptin).toHaveBeenCalledTimes(1);
      expect((await source.get()).data()?.estado).toBe('am');
      await expect(
        handleUptinMigration(deps, itemId, target, {
          ...active,
          status: 'closed',
          tags: [UPTIN_SOURCE_TAG],
        }),
      ).resolves.toBe('concluida');
      expect((await db.getAll(source, ...oldLinks)).every((doc) => !doc.exists)).toBe(true);
      expect((await newParent.get()).data()).toMatchObject({
        id: familyId,
        isUserProductModel: true,
      });
      expect((await db.getAll(...memberRefs)).map((doc) => doc.data()?.itemId)).toEqual(memberIds);
    } finally {
      const cleanup = db.batch();
      for (const ref of [source, newParent, operation, ...productRefs, ...oldLinks, ...memberRefs])
        cleanup.delete(ref);
      await cleanup.commit();
    }
  });
});

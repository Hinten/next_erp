import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { applyFamilyStatusAndFold, syncItemStatus } from '../anuncios/itemsStatusSync';
import { processStockSendTask, type MlStockSendTask, type StockSendDeps } from './estoqueSend';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';

const db = () => getAdminFirestore();
const prefix = `e2e-ml1285-${randomUUID()}`;
const parent = `${prefix}-parent`;
const child = `${prefix}-child`;
const sibling = `${prefix}-sibling`;
const conta = `${prefix}-conta`;
const parentPath = `produtos/${parent}/produtoMercadoLivre/link`;
const memberPath = `produtos/${child}/variacaoMercadoLivre/member`;
const siblingPath = `produtos/${sibling}/variacaoMercadoLivre/member`;
const pmlOuterRef = `documents/${parentPath}`;
const family = { produtoId: parent, linkDocId: 'link', pmlOuterRef };

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'member stock failure — real Firestore',
  () => {
    beforeEach(async () => {
      await db()
        .doc(parentPath)
        .set({
          id: '6264141844942250',
          estado: 'p',
          status: 'active',
          isUserProductModel: true,
          contaOuterRef: `documents/integracao/${conta}`,
        });
      await Promise.all(
        [
          [memberPath, 'MLB1285A'],
          [siblingPath, 'MLB1285B'],
        ].map(([path, itemId]) =>
          db().doc(path!).set({
            itemId,
            status: 'active',
            sub_status: [],
            produtoMercadoLivreOuterRef: pmlOuterRef,
          }),
        ),
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all(
        [parent, child, sibling].map((id) => db().recursiveDelete(db().doc(`produtos/${id}`))),
      );
      await db().doc(`estoqueMercadoLivreSync/${conta}`).delete();
    });

    async function observe(clear = false, failure = false) {
      const snap = await db().doc(memberPath).get();
      return {
        memberProdutoId: child,
        memberDocId: 'member',
        expectedUpdateTime: snap.updateTime,
        expectedItemId: 'MLB1285A',
        status: 'active',
        subStatus: [],
        moderacoes: [],
        userProductId: null,
        categoryId: null,
        clearStockFailure: clear,
        ...(failure ? { stockFailure: { errors: ['refused'], causas: [] } } : {}),
      };
    }

    it('records final refusal on the member atomically; sibling webhook cannot clear it', async () => {
      const updateItem = vi.fn(async () => {
        throw new MercadoLivreHttpError('refused', 400, null);
      });
      const getItem = vi.fn(async (id: string) => ({ id, status: 'active', sub_status: [] }));
      const deps: StockSendDeps = {
        nowMs: Date.now(),
        retryCount: 2,
        refreshStockOnRetry: false,
        ignoreSyncFlag: true,
        scheduler: { enqueue: vi.fn() },
        contextLoader: async () => ({
          conta: { depositoOuterRef: 'documents/depositos/DEP' },
          resolveChannelContext: async () => ({
            getAccessToken: async () => 'test',
            invalidateAccessToken: () => {},
            accessToken: 'test',
          }),
        }),
        apiFactory: () => ({
          updateItem,
          getItem,
          getUserProductStock: vi.fn(),
          putUserProductSellerWarehouseStock: vi.fn(),
        }),
      };
      const task: MlStockSendTask = {
        integracaoId: conta,
        produtoId: parent,
        linkDocId: 'link',
        kind: 'variationItem',
        itemId: 'MLB1285A',
        userProductId: null,
        variacaoProdutoId: child,
        varLinkDocId: 'member',
        quantidade: 7,
        variations: null,
        estoqueSnapshot: null,
        sweepComputedAtMs: Date.now(),
        sweepId: prefix,
        reenqueues: 0,
      };
      expect(await processStockSendTask(db(), task, deps)).toEqual({
        outcome: 'erro-registrado',
        reason: 'payload-rejeitado',
      });
      expect(updateItem).toHaveBeenCalledTimes(2);
      expect((await db().doc(memberPath).get()).data()).toMatchObject({
        estado: 'E',
        errors: ['refused'],
        causas: [],
        status: 'active',
      });
      expect((await db().doc(parentPath).get()).data()).toMatchObject({
        estado: 'p',
        status: 'active',
      });
      const api = { getItem, getLastModeration: vi.fn() };
      await syncItemStatus(db(), conta, 'MLB1285B', async () => api);
      expect((await db().doc(memberPath).get()).get('estado')).toBe('E');
      await syncItemStatus(db(), conta, 'MLB1285A', async () => api);
      expect((await db().doc(memberPath).get()).data()).toMatchObject({
        estado: null,
        errors: [],
        causas: [],
        status: 'active',
      });
    });

    it('an unchanged healthy status still clears its own failure', async () => {
      await db()
        .doc(memberPath)
        .update({ estado: 'E', errors: ['old'], causas: [] });
      const result = await applyFamilyStatusAndFold(db(), conta, family, [await observe()]);
      expect(result.membros?.[0]).toMatchObject({ estado: null, aplicado: true });
      expect((await db().doc(memberPath).get()).data()).toMatchObject({
        estado: null,
        errors: [],
        causas: [],
      });
    });

    it.each([true, false])(
      'stale external observation cannot overwrite a later member write (clear=%s)',
      async (clear) => {
        const old = await observe(clear, !clear);
        const winner = clear
          ? { estado: 'E', errors: ['newer'], status: 'paused' }
          : { estado: null, errors: [], status: 'paused' };
        await db().doc(memberPath).update(winner);
        const result = await applyFamilyStatusAndFold(db(), conta, family, [old], {
          limparFalhaSempre: clear,
        });
        expect(result.membros?.[0]).toMatchObject({ aplicado: false });
        expect((await db().doc(memberPath).get()).data()).toMatchObject(winner);
      },
    );

    it.each(['delete', 'reassociate'])(
      'a member removed during ML I/O is not recreated or changed (%s)',
      async (action) => {
        const old = await observe(false, true);
        if (action === 'delete') await db().doc(memberPath).delete();
        else
          await db().doc(memberPath).update({
            produtoMercadoLivreOuterRef: 'documents/produtos/other/produtoMercadoLivre/other',
          });
        await applyFamilyStatusAndFold(db(), conta, family, [old]);
        const snap = await db().doc(memberPath).get();
        if (action === 'delete') expect(snap.exists).toBe(false);
        else {
          expect(snap.exists).toBe(true);
          expect(snap.get('estado')).toBeUndefined();
        }
        expect((await db().doc(parentPath).get()).get('estado')).toBe('p');
      },
    );
  },
);

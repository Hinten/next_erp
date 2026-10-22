import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  produtoCollection,
  estoqueCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import { STAGING } from '@/vitest.staging.setup';
import { buildSendTasks, fetchStockFamilies, fetchStockFamiliesByIds } from './bulkEstoquePlan';

// No integration/account is created: the real scheduled senders cannot discover
// these fixtures. Both discovery queries below use their production pipelines.
const prefix = `e2e-ml1285-${randomUUID()}`;
const parent = `${prefix}-parent`;
const children = [`${prefix}-a`, `${prefix}-b`];
const conta = `${prefix}-conta`;
const deposito = `${prefix}-dep`;
const parentRef = `documents/produtos/${parent}/produtoMercadoLivre/link`;
const db = () => getAdminFirestore();

describe.skipIf(!STAGING)('member stock gate — production Enterprise pipelines', () => {
  beforeAll(async () => {
    for (const [id, paiId] of [[parent, null], ...children.map((id) => [id, parent])] as const) {
      await produtoCollection.docRef(db(), {}, String(id)).set({
        nome: String(id),
        paiId,
        ehKit: false,
        ehKitVirtual: false,
        publicado: true,
        componentesKit: null,
        componentesKitKeys: [],
        integracoesComProduto: [conta],
        timestamp: Date.now(),
      });
      await estoqueCollection.docRef(db(), { produtoId: String(id) }, 'stock').set({
        parentId: id,
        depositoOuterRef: `documents/depositos/${deposito}`,
        quantidade: 12,
        quantidadeReservada: 0,
        ultimaModificacao: Date.now(),
      });
    }
    await produtoMercadoLivreLinkCollection.docRef(db(), { produtoId: parent }, 'link').set({
      id: '6264141844942250',
      estado: 'p',
      status: 'active',
      sub_status: [],
      isUserProductModel: true,
      contaOuterRef: `documents/integracao/${conta}`,
    });
    for (const [i, id] of children.entries()) {
      await variacaoMercadoLivreLinkCollection.docRef(db(), { produtoId: id }, 'member').set({
        itemId: `MLB1285${i}`,
        estado: i === 0 ? 'E' : null,
        status: 'active',
        sub_status: [],
        userProductId: `MLBU1285${i}`,
        produtoMercadoLivreOuterRef: parentRef,
        errors: i === 0 ? ['refused'] : [],
        causas: [],
      });
    }
  });

  afterAll(async () => {
    await Promise.all(
      [parent, ...children].map((id) =>
        db().recursiveDelete(produtoCollection.docRef(db(), {}, String(id))),
      ),
    );
    for (const id of [parent, ...children])
      expect((await produtoCollection.docRef(db(), {}, String(id)).get()).exists).toBe(false);
  });

  it.each(['sweep', 'manual'] as const)(
    '%s projects the real member block and sends only the sibling',
    async (source) => {
      const args = { integracaoId: conta, depositoId: deposito };
      const rows =
        source === 'manual'
          ? await fetchStockFamiliesByIds(db(), { ...args, anchorIds: [parent] })
          : (await fetchStockFamilies(db(), { ...args, changedSinceMs: -1, pageLimit: 10 })).rows;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.anchorId).toBe(parent);
      expect(row.children.find((c) => c.produtoId === children[0])?.varLinks[0]).toMatchObject({
        estado: 'E',
        varLinkDocId: 'member',
      });
      for (const modo of [undefined, 'userProduct'] as const) {
        const result = buildSendTasks(row, new Map(children.map((id) => [id, 12])), {
          ...args,
          sweepId: prefix,
          sweepComputedAtMs: Date.now(),
          modo,
        });
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0]).toMatchObject({
          itemId: 'MLB12851',
          variacaoProdutoId: children[1],
          quantidade: 12,
        });
        expect(result.skips).toEqual([
          {
            produtoId: children[0],
            reason: 'membro-com-falha-estoque',
            itemId: 'MLB12850',
            linkDocId: 'link',
          },
        ]);
      }
    },
  );
});

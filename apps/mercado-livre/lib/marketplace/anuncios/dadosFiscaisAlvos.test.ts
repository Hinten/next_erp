import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

// The two reads this module makes — a produto by id and the family-member group
// query — are served from these maps; the shape decisions run for real.
const h = vi.hoisted(() => ({
  produtos: new Map<string, Record<string, unknown>>(),
  membros: [] as Array<{ id: string; parentId: string; data: Record<string, unknown> }>,
  consultas: [] as unknown[],
}));

vi.mock('@delfrance/data/admin/collections', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/data/admin/collections')>();
  return {
    ...actual,
    produtoCollection: {
      ...actual.produtoCollection,
      docRef: (_db: unknown, _ctx: unknown, id: string) => ({
        get: async () => ({ exists: h.produtos.has(id), data: () => h.produtos.get(id) }),
      }),
    },
    variacaoMercadoLivreLinkCollection: {
      ...actual.variacaoMercadoLivreLinkCollection,
      groupQuery: () => ({
        where: (_campo: string, _op: string, valor: unknown) => {
          h.consultas.push(valor);
          return {
            get: async () => ({
              empty: h.membros.length === 0,
              docs: h.membros.map((m) => ({
                id: m.id,
                data: () => m.data,
                ref: { parent: { parent: { id: m.parentId } } },
              })),
            }),
          };
        },
      }),
    },
  };
});

const { alvosFiscaisArmazenados } = await import('./dadosFiscaisAlvos');

const db = {} as Firestore;
const PAI = 'prod-1';
const LINK = 'link-1';

beforeEach(() => {
  h.produtos.clear();
  h.membros = [];
  h.consultas = [];
  h.produtos.set(PAI, { nome: 'Camiseta', sku: 'SKU-PAI', pesoBrutoKg: 0.3 });
  h.produtos.set('filho-m', { nome: 'Camiseta M', sku: 'SKU-M', paiId: PAI });
  h.produtos.set('filho-g', { nome: 'Camiseta G', sku: 'SKU-G', paiId: PAI });
});

describe('alvosFiscaisArmazenados — the SKUs of an existing anúncio (#745)', () => {
  it('asks the members of THIS parent link, by its canonical outer ref', async () => {
    await alvosFiscaisArmazenados(db, { produtoId: PAI, linkDocId: LINK, link: { id: 'MLB1' } });
    expect(h.consultas).toEqual([`documents/produtos/${PAI}/produtoMercadoLivre/${LINK}`]);
  });

  it('no member link: a simple item — the parent’s own SKU on the parent link’s item', async () => {
    const alvos = await alvosFiscaisArmazenados(db, {
      produtoId: PAI,
      linkDocId: LINK,
      link: {
        id: 'MLB1',
        title: 'Camiseta básica',
        dadosFiscaisSku: 'SKU-PAI',
        dadosFiscaisItemId: 'MLB1',
      },
    });
    expect(alvos).toEqual([
      expect.objectContaining({
        produtoId: PAI,
        itemId: 'MLB1',
        variationId: null,
        titulo: 'Camiseta básica',
        pai: null,
        link: { colecao: 'produtoMercadoLivre', produtoId: PAI, docId: LINK },
        registrado: { sku: 'SKU-PAI', itemId: 'MLB1' },
      }),
    ]);
  });

  it('User-Products members: each child on its OWN item, no variation id', async () => {
    h.membros = [
      { id: 'v-m', parentId: 'filho-m', data: { itemId: 'MLB901' } },
      { id: 'v-g', parentId: 'filho-g', data: { itemId: 'MLB902', dadosFiscaisSku: 'SKU-G' } },
    ];
    const alvos = await alvosFiscaisArmazenados(db, {
      produtoId: PAI,
      linkDocId: LINK,
      link: { id: '4260899048783356' },
    });
    expect(alvos.map((a) => [a.produtoId, a.itemId, a.variationId, a.link.docId])).toEqual([
      ['filho-m', 'MLB901', null, 'v-m'],
      ['filho-g', 'MLB902', null, 'v-g'],
    ]);
    // The pai rides along for the weight/cost fallback.
    expect(alvos[0]!.pai).toMatchObject({ sku: 'SKU-PAI' });
    expect(alvos[1]!.registrado).toEqual({ sku: 'SKU-G', itemId: null });
  });

  it('legacy variations[]: the PARENT link’s item, with each child’s ML variation id', async () => {
    h.membros = [{ id: 'v-m', parentId: 'filho-m', data: { id: 555, itemId: null } }];
    const alvos = await alvosFiscaisArmazenados(db, {
      produtoId: PAI,
      linkDocId: LINK,
      link: { id: 'MLB777' },
    });
    expect(alvos).toEqual([
      expect.objectContaining({ produtoId: 'filho-m', itemId: 'MLB777', variationId: 555 }),
    ]);
  });

  it('⚠️ a numeric FAMILY id is never addressed as an item', async () => {
    // A UP family whose members this ERP does not hold: no member links, and the
    // parent `id` is ML's family key — `GET /items/{it}` would 404.
    expect(
      await alvosFiscaisArmazenados(db, {
        produtoId: PAI,
        linkDocId: LINK,
        link: { id: '4260899048783356' },
      }),
    ).toEqual([]);
    // …nor as a legacy variation's item.
    h.membros = [{ id: 'v-m', parentId: 'filho-m', data: { id: 555 } }];
    expect(
      await alvosFiscaisArmazenados(db, {
        produtoId: PAI,
        linkDocId: LINK,
        link: { id: '4260899048783356' },
      }),
    ).toEqual([]);
  });

  it('a member link never published (no itemId, no variation id) is skipped', async () => {
    h.membros = [
      { id: 'v-m', parentId: 'filho-m', data: { itemId: null, id: null } },
      { id: 'v-g', parentId: 'filho-g', data: { itemId: 'MLB902' } },
    ];
    const alvos = await alvosFiscaisArmazenados(db, {
      produtoId: PAI,
      linkDocId: LINK,
      link: { id: '4260899048783356' },
    });
    expect(alvos.map((a) => a.produtoId)).toEqual(['filho-g']);
  });

  it('a missing produto yields nothing to send', async () => {
    h.produtos.delete(PAI);
    expect(
      await alvosFiscaisArmazenados(db, { produtoId: PAI, linkDocId: LINK, link: { id: 'MLB1' } }),
    ).toEqual([]);
  });
});

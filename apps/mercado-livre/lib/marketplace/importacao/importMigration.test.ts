import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  UPTIN_DESTINATION_TAG,
  UPTIN_SOURCE_TAG,
} from '@delfrance/integrations-mercado-livre';
import { toOuterRef } from '@delfrance/schemas';
import {
  handleUptinMigration,
  startUptinMigration,
  type UptinMigrationDeps,
} from './importMigration';

type Data = Record<string, unknown>;

class Db {
  docs = new Map<string, Data>();
  failCommit = false;
  private queue: Promise<unknown> = Promise.resolve();

  collection(path: string) {
    return { doc: (id: string) => this.ref(`${path}/${id}`) };
  }

  ref(path: string) {
    const parts = path.split('/');
    const id = parts.at(-1)!;
    const ref = {
      path,
      id,
      parent: { parent: { id: parts.at(-3) } },
      get: async () => {
        const value = this.docs.get(path);
        return { id, ref, exists: value != null, data: () => value };
      },
    };
    return ref;
  }

  collectionGroup(group: string) {
    return {
      where: (field: string, op: string, value: unknown) => ({
        get: async () => {
          const paths = [...this.docs].filter(
            ([path, data]) =>
              path.split('/').at(-2) === group &&
              (op === 'in' && Array.isArray(value)
                ? value.includes(data[field])
                : data[field] === value),
          );
          return { docs: await Promise.all(paths.map(([path]) => this.ref(path).get())) };
        },
      }),
    };
  }

  runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const writes: Array<() => void> = [];
      const set = (ref: { path: string }, data: Data) =>
        writes.push(() => {
          this.docs.set(ref.path, data);
        });
      const get = (ref: { get: () => Promise<unknown> }) => ref.get();
      const result = await fn({
        get,
        getAll: (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map(get)),
        set,
        create: set,
        update: (ref: { path: string }, data: Data) =>
          set(ref, { ...this.docs.get(ref.path), ...data }),
        delete: (ref: { path: string }) =>
          writes.push(() => {
            this.docs.delete(ref.path);
          }),
      });
      if (this.failCommit && writes.length > 0) {
        this.failCommit = false;
        throw new Error('commit failed');
      }
      for (const write of writes) write();
      return result;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}

const itemId = 'MLB100';
const target = { produtoId: 'base', linkDocId: 'old' };
const parent = 'produtos/base/produtoMercadoLivre/old';
const left = 'produtos/left/variacaoMercadoLivre/old-left';
const right = 'produtos/right/variacaoMercadoLivre/old-right';
const variations = [{ id: 111 }, { id: 222 }];
const active = { id: itemId, seller_id: 42, status: 'active', variations };
const closed = { ...active, status: 'closed', tags: [UPTIN_SOURCE_TAG] };
const completed = {
  item_id: itemId,
  activation_completed: '2026-10-01T12:00:00Z',
  new_items: [
    { variation_id: 111, new_item_id: 'MLB201' },
    { variation_id: '222', new_item_id: 'MLB202' },
  ],
};

function fixture() {
  const store = new Db();
  store.docs.set('produtos/base', { nome: 'Base' });
  store.docs.set('produtos/left', { paiId: 'base', sku: 'mesmo-sku', precos: { tabela: 12 } });
  store.docs.set('produtos/right', { paiId: 'base', sku: 'mesmo-sku' });
  store.docs.set(parent, {
    id: itemId,
    title: 'Original',
    contaOuterRef: 'integracao/conta',
    estado: 'p',
    descricao: 'Texto do operador',
    crossdocking: 2,
  });
  store.docs.set(left, {
    id: 111,
    produtoMercadoLivreOuterRef: parent,
    produtoVariacaoOuterRef: 'produtos/left',
  });
  store.docs.set(right, {
    id: 222,
    produtoMercadoLivreOuterRef: toOuterRef(parent),
    produtoVariacaoOuterRef: 'produtos/right',
  });
  const api = {
    getItem: vi.fn(async () => active),
    validateUptin: vi.fn(async () => ({ is_valid: true, cause: [] as Array<{ message: string }> })),
    startUptin: vi.fn(async () => {}),
    getLastModeration: vi.fn(async () => []),
    getMigrationLiveListing: vi.fn(async () => completed),
    getItemsByIds: vi.fn(async () =>
      ['MLB202', 'MLB201'].map((id) => ({
        code: 200,
        body: {
          id,
          seller_id: 42,
          family_id: '18446744000000000615',
          family_name: 'Família nova',
          user_product_id: `UP-${id}`,
          status: id === 'MLB201' ? 'paused' : 'active',
          tags: [UPTIN_DESTINATION_TAG],
        },
      })),
    ),
  };
  const deps: UptinMigrationDeps = {
    db: store as unknown as Firestore,
    api,
    sellerUserId: 42,
    integracaoId: 'conta',
  };
  const arm = vi.fn(async () => {});
  return { store, api, deps, arm };
}

function destination(store: Db, produtoId: string) {
  return [...store.docs].find(([path]) =>
    path.startsWith(`produtos/${produtoId}/variacaoMercadoLivre/`),
  )?.[1];
}

describe('startUptinMigration', () => {
  it('arms recovery before dispatch and coalesces concurrent starts', async () => {
    const { deps, store, arm, api } = fixture();
    const results = await Promise.all([
      startUptinMigration(deps, itemId, target, arm),
      startUptinMigration(deps, itemId, target, arm),
    ]);
    expect(results).toEqual(expect.arrayContaining(['iniciada', 'pendente']));
    expect(arm).toHaveBeenCalledBefore(api.startUptin);
    expect(api.startUptin).toHaveBeenCalledExactlyOnceWith(itemId);
    expect(store.docs.get(parent)?.estado).toBe('am');
  });

  it('reports eligibility causes and never claims a missing ERP variation', async () => {
    const { deps, store, arm, api } = fixture();
    api.validateUptin.mockResolvedValueOnce({
      is_valid: false,
      cause: [{ message: 'Categoria não habilitada' }],
    });
    await expect(startUptinMigration(deps, itemId, target, arm)).rejects.toThrow(
      'Categoria não habilitada',
    );
    store.docs.delete(right);
    await expect(startUptinMigration(deps, itemId, target, arm)).rejects.toThrow('222');
    expect(arm).not.toHaveBeenCalled();
    expect(api.startUptin).not.toHaveBeenCalled();
    expect(store.docs.get(parent)?.estado).toBe('p');
  });

  it('rejects a different seller before validating or submitting', async () => {
    const { deps, arm, api } = fixture();
    api.getItem.mockResolvedValueOnce({ ...active, seller_id: 99 });
    await expect(startUptinMigration(deps, itemId, target, arm)).rejects.toThrow('vendedor');
    expect(api.validateUptin).not.toHaveBeenCalled();
    expect(api.startUptin).not.toHaveBeenCalled();
  });

  it('keeps a lost POST response pending and recovers without resubmitting', async () => {
    const { deps, store, arm, api } = fixture();
    api.startUptin.mockRejectedValueOnce(new MercadoLivreNetworkError('socket lost', null));
    expect(await startUptinMigration(deps, itemId, target, arm)).toBe('incerta');
    expect(await startUptinMigration(deps, itemId, target, arm)).toBe('pendente');
    expect(api.startUptin).toHaveBeenCalledTimes(1);
    expect(await handleUptinMigration(deps, itemId, target, closed)).toBe('concluida');
    expect(store.docs.has(parent)).toBe(false);
  });

  it('releases a definitively refused request and restores the prior state', async () => {
    const { deps, store, arm, api } = fixture();
    api.startUptin.mockRejectedValueOnce(new MercadoLivreHttpError('refusado', 422, {}));
    api.getMigrationLiveListing.mockRejectedValueOnce(
      new MercadoLivreHttpError('sem migração', 404, {}),
    );
    await expect(startUptinMigration(deps, itemId, target, arm)).rejects.toThrow('refusado');
    expect(store.docs.get(parent)?.estado).toBe('p');
    expect(await startUptinMigration(deps, itemId, target, arm)).toBe('iniciada');
  });
});

describe('handleUptinMigration', () => {
  it('keeps provider families separate when a migration splits the listing', async () => {
    const { deps, store, api } = fixture();
    const members = await api.getItemsByIds();
    api.getItemsByIds.mockResolvedValueOnce(
      members.map((row, index) => ({
        ...row,
        body: { ...row.body, family_id: `900${index}` },
      })),
    );
    await expect(handleUptinMigration(deps, itemId, target, closed)).resolves.toBe('concluida');
    const links = [...store.docs].filter(([path]) => path.includes('/produtoMercadoLivre/'));
    expect(links.map(([, data]) => data.id)).toEqual(expect.arrayContaining(['9000', '9001']));
    expect(links.every(([, data]) => data.uptinSomenteMembros === true)).toBe(true);
    expect(destination(store, 'left')?.produtoMercadoLivreOuterRef).not.toBe(
      destination(store, 'right')?.produtoMercadoLivreOuterRef,
    );
  });

  it('links the exact children, folds actual status, preserves ERP data and makes duplicate delivery a no-op', async () => {
    const { deps, store, api } = fixture();
    expect(await handleUptinMigration(deps, itemId, target, closed)).toBe('concluida');
    expect(store.docs.has(parent)).toBe(false);
    expect(store.docs.has(left)).toBe(false);
    expect(store.docs.has(right)).toBe(false);
    expect(
      store.docs.get('produtos/base/produtoMercadoLivre/10000000000000000018446744000000000615'),
    ).toMatchObject({
      id: '18446744000000000615',
      isUserProductModel: true,
      status: 'active',
      descricao: 'Texto do operador',
      crossdocking: 2,
    });
    expect(destination(store, 'left')).toMatchObject({ itemId: 'MLB201', status: 'paused' });
    expect(destination(store, 'right')).toMatchObject({ itemId: 'MLB202', status: 'active' });
    expect(store.docs.get('produtos/left')?.precos).toEqual({ tabela: 12 });
    expect(await handleUptinMigration(deps, itemId, target, closed)).toBe('concluida');
    expect(api.getItemsByIds).toHaveBeenCalledTimes(1);
  });

  it('preserves all source links on partial results or conflicting destination links', async () => {
    const { deps, store, api } = fixture();
    api.getMigrationLiveListing.mockResolvedValueOnce({
      ...completed,
      new_items: completed.new_items.slice(0, 1),
    });
    await expect(handleUptinMigration(deps, itemId, target, closed)).rejects.toThrow();
    expect([parent, left, right].every((path) => store.docs.has(path))).toBe(true);
    store.docs.set('produtos/other/variacaoMercadoLivre/conflict', { itemId: 'MLB202' });
    await expect(handleUptinMigration(deps, itemId, target, closed)).rejects.toThrow(
      'incompatível',
    );
    expect([parent, left, right].every((path) => store.docs.has(path))).toBe(true);
  });

  it('can retry a failed atomic completion commit', async () => {
    const { deps, store } = fixture();
    store.docs.set(parent, { ...store.docs.get(parent), estado: 'am' });
    store.failCommit = true;
    await expect(handleUptinMigration(deps, itemId, target, closed)).rejects.toThrow(
      'commit failed',
    );
    expect([parent, left, right].every((path) => store.docs.has(path))).toBe(true);
    expect(await handleUptinMigration(deps, itemId, target, closed)).toBe('concluida');
  });
});

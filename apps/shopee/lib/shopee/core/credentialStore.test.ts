import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopeeAuthSubject, ShopeeTokenPair } from '@delfrance/integrations-shopee';

import {
  EXPIRY_GUARD_MS,
  SHOPEE_CREDENCIAL_DOC_ID,
  ShopeeCredencialInvalidaError,
  createShopeeCredentialStore,
  credentialFromTokenPair,
} from './credentialStore';

/**
 * The collection handle stays REAL so `save()` runs the actual
 * `credenciaisIntegracaoSchema` validation — which is the whole point of the
 * `ShopeeCredencialInvalidaError` arm. Only Firestore itself is faked.
 */
const set = vi.fn<(data: unknown) => Promise<void>>();
const get = vi.fn<() => Promise<{ exists: boolean; data: () => unknown }>>();
let lastDocPath: string[] = [];

function fakeDb(): Firestore {
  return {
    collection: (path: string) => {
      lastDocPath = [path];
      return {
        doc: (id: string) => {
          lastDocPath = [path, id];
          return { set, get };
        },
      };
    },
  } as unknown as Firestore;
}

const PAIR: ShopeeTokenPair = {
  accessToken: 'at-fake',
  refreshToken: 'rt-fake',
  expiresAtMs: 1_700_000_000_000,
  requestId: 'req-1',
  shopIdList: [111, 222],
  merchantIdList: null,
};

const SHOP: ShopeeAuthSubject = { kind: 'shop', shopId: 111 };
const MAIN: ShopeeAuthSubject = { kind: 'main_account', mainAccountId: 999 };

beforeEach(() => {
  vi.clearAllMocks();
  set.mockResolvedValue(undefined);
  lastDocPath = [];
});

describe('credentialFromTokenPair', () => {
  it('subtracts the expiry guard from the ms expiry the package computed', () => {
    // ⚠️ ms in, ms out. The seconds→ms conversion lives in the package
    // (`expiresAtFrom`); a second conversion here is how a cross-unit
    // comparison becomes a guard that never fires (rule 7).
    const doc = credentialFromTokenPair(PAIR, SHOP, 1_699_999_000_000);
    expect(doc.expirationDate).toBe(PAIR.expiresAtMs - EXPIRY_GUARD_MS);
    expect(EXPIRY_GUARD_MS).toBe(5_000);
  });

  it('records the token pair, the provider and the capture instant', () => {
    const doc = credentialFromTokenPair(PAIR, SHOP, 1_699_999_000_000);
    expect(doc).toMatchObject({
      access_token: 'at-fake',
      refresh_token: 'rt-fake',
      provider: 'shopee',
      obtidoEm: 1_699_999_000_000,
      shop_id_list: [111, 222],
      merchant_id_list: null,
    });
  });

  it('keys a shop consent on shop_id and leaves main_account_id null', () => {
    const doc = credentialFromTokenPair(PAIR, SHOP, 1);
    expect(doc.shop_id).toBe(111);
    expect(doc.main_account_id).toBeNull();
  });

  it('keys a main-account consent on main_account_id and leaves shop_id null', () => {
    // The two id classes are refreshed separately (step 2), so which one the
    // pair belongs to has to survive on the document.
    const doc = credentialFromTokenPair(PAIR, MAIN, 1);
    expect(doc.main_account_id).toBe(999);
    expect(doc.shop_id).toBeNull();
  });
});

describe('createShopeeCredentialStore.save', () => {
  it('writes the fixed `current` doc id', async () => {
    const store = createShopeeCredentialStore(fakeDb(), 'int-1');
    await store.save(credentialFromTokenPair(PAIR, SHOP, 1));

    expect(lastDocPath).toEqual(['integracao/int-1/credenciais', SHOPEE_CREDENCIAL_DOC_ID]);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toMatchObject({ access_token: 'at-fake' });
  });

  it('raises ShopeeCredencialInvalidaError when Shopee omitted the refresh token', async () => {
    // Shopee's refresh token is single-use and rotating: a pair without one is
    // a conta that can never be refreshed. It has to fail HERE — at the write —
    // rather than become a document nobody can renew.
    const store = createShopeeCredentialStore(fakeDb(), 'int-1');
    const semRefresh = credentialFromTokenPair({ ...PAIR, refreshToken: '' }, SHOP, 1) as Record<
      string,
      unknown
    >;

    await expect(store.save(semRefresh)).rejects.toBeInstanceOf(ShopeeCredencialInvalidaError);
    expect(set).not.toHaveBeenCalled();
  });

  it('names the failing FIELD and never the token value', async () => {
    // #1015: the value under inspection here IS a credential. `campos` carries
    // paths only, and the message is built from those paths alone.
    const store = createShopeeCredentialStore(fakeDb(), 'int-1');
    const semRefresh = credentialFromTokenPair({ ...PAIR, refreshToken: '' }, SHOP, 1);

    try {
      await store.save(semRefresh);
      expect.unreachable('save deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeCredencialInvalidaError)) throw err;
      expect(err.campos.join(' ')).toContain('refresh_token');
      expect(err.message).toContain('refresh_token');
      expect(err.message).not.toContain('at-fake');
      expect(JSON.stringify(err.campos)).not.toContain('at-fake');
    }
  });

  it('rethrows a non-Zod failure from Firestore untouched (rule 6)', async () => {
    const boom = new Error('UNAVAILABLE');
    set.mockRejectedValue(boom);
    const store = createShopeeCredentialStore(fakeDb(), 'int-1');
    await expect(store.save(credentialFromTokenPair(PAIR, SHOP, 1))).rejects.toBe(boom);
  });
});

describe('createShopeeCredentialStore.load', () => {
  it('returns null when the conta was never connected', async () => {
    get.mockResolvedValue({ exists: false, data: () => undefined });
    const store = createShopeeCredentialStore(fakeDb(), 'int-1');
    await expect(store.load()).resolves.toBeNull();
  });

  it('reads the fixed `current` doc, never the newest by expiry', async () => {
    // Picking "newest" could resurrect a stray doc whose rotated refresh token
    // Shopee has already invalidated.
    get.mockResolvedValue({
      exists: true,
      data: () => ({ access_token: 'a', refresh_token: 'r', expirationDate: 42 }),
    });
    const store = createShopeeCredentialStore(fakeDb(), 'int-1');

    await expect(store.load()).resolves.toMatchObject({ access_token: 'a', expirationDate: 42 });
    expect(lastDocPath).toEqual(['integracao/int-1/credenciais', 'current']);
  });
});

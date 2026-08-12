import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenResponse } from '@delfrance/integrations-mercado-pago';

// Mock the admin collection handle so the store's Firestore calls run against
// in-memory fakes (vi.hoisted keeps the fns referenceable before the import).
const h = vi.hoisted(() => ({
  ref: vi.fn(),
  docRef: vi.fn(),
  parse: vi.fn((data: unknown) => data),
  parseRead: vi.fn((data: unknown) => data),
  docPath: vi.fn((_ctx: unknown, id: string) => `metodo_pgto/m1/credenciais/${id}`),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  credenciaisMetodoPgtoCollection: {
    ref: h.ref,
    docRef: h.docRef,
    parse: h.parse,
    parseRead: h.parseRead,
    docPath: h.docPath,
  },
}));

const { createCredentialStore, credentialFromResponse } = await import('./credentialStore');

const NOW = 1_700_000_000_000;

const RESP: TokenResponse = {
  access_token: 'AT',
  token_type: 'bearer',
  expires_in: 15_552_000, // ~180d, the MP long-lived token
  scope: 'offline_access read write',
  user_id: 7,
  refresh_token: 'RT',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.parse.mockImplementation((data: unknown) => data);
  h.parseRead.mockImplementation((data: unknown) => data);
  h.docPath.mockImplementation((_ctx: unknown, id: string) => `metodo_pgto/m1/credenciais/${id}`);
});

describe('credentialFromResponse', () => {
  it('maps a token response to an absolute ms-since-epoch expiry (−5s guard)', () => {
    expect(credentialFromResponse(RESP, NOW)).toEqual({
      access_token: 'AT',
      refresh_token: 'RT',
      expirationDate: NOW + 15_552_000 * 1000 - 5000,
    });
  });

  it('persists only the credential dimension — not the MP user_id / OAuth extras', () => {
    const cred = credentialFromResponse(RESP, NOW) as Record<string, unknown>;
    expect(Object.keys(cred).sort()).toEqual(['access_token', 'expirationDate', 'refresh_token']);
  });
});

describe('createCredentialStore', () => {
  it('load() reads the fixed `current` doc (never a stray)', async () => {
    const getFn = vi.fn(async () => ({
      exists: true,
      data: () => ({ access_token: 'AT', refresh_token: 'RT', expirationDate: NOW }),
    }));
    h.docRef.mockReturnValue({ get: getFn });

    const store = createCredentialStore({} as never, 'm1');
    const cred = await store.load();

    expect(h.docRef).toHaveBeenCalledWith({} as never, { metodoId: 'm1' }, 'current');
    expect(cred).toEqual({ access_token: 'AT', refresh_token: 'RT', expirationDate: NOW });
  });

  it('load() returns null when the `current` doc does not exist', async () => {
    h.docRef.mockReturnValue({ get: vi.fn(async () => ({ exists: false })) });

    const store = createCredentialStore({} as never, 'm1');
    expect(await store.load()).toBeNull();
  });

  it('save() writes the `current` doc and deletes stray docs in one transaction', async () => {
    const collRef = {};
    h.ref.mockReturnValue(collRef);
    const currentRef = { id: 'current' };
    h.docRef.mockReturnValue(currentRef);

    const strayRef = { id: 'legacy-auto-id' };
    const tx = {
      get: vi.fn(async () => ({
        docs: [
          { id: 'current', ref: currentRef },
          { id: 'legacy-auto-id', ref: strayRef },
        ],
      })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const db = { runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) };

    const cred = { access_token: 'AT2', refresh_token: 'RT2', expirationDate: NOW };
    const store = createCredentialStore(db as never, 'm1');
    const saved = await store.save(cred);

    // Reads-before-writes: read the collection, set `current`, delete the stray.
    expect(tx.get).toHaveBeenCalledWith(collRef);
    expect(tx.set).toHaveBeenCalledWith(currentRef, cred);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledWith(strayRef);
    expect(saved).toBe(cred);
  });
});

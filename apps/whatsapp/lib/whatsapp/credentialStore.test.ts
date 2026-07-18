import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the admin collection handle so the store's Firestore calls run against
// in-memory fakes (vi.hoisted keeps the fns referenceable before the import).
const h = vi.hoisted(() => ({
  ref: vi.fn(),
  docRef: vi.fn(),
  parse: vi.fn((data: unknown) => data),
  parseRead: vi.fn((data: unknown) => data),
  docPath: vi.fn((_ctx: unknown, id: string) => `integracao/i1/credenciaisWhatsapp/${id}`),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  credenciaisWhatsappCollection: {
    ref: h.ref,
    docRef: h.docRef,
    parse: h.parse,
    parseRead: h.parseRead,
    docPath: h.docPath,
  },
}));

const { createCredentialStore } = await import('./credentialStore');

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  h.parse.mockImplementation((data: unknown) => data);
  h.parseRead.mockImplementation((data: unknown) => data);
  h.docPath.mockImplementation(
    (_ctx: unknown, id: string) => `integracao/i1/credenciaisWhatsapp/${id}`,
  );
});

describe('createCredentialStore', () => {
  it('load() reads the fixed `current` doc (never a stray)', async () => {
    const getFn = vi.fn(async () => ({
      exists: true,
      data: () => ({ permanent_token: 'TKN', phoneNumberId: 'PID', wa_id: 'PID', createdAt: NOW }),
    }));
    h.docRef.mockReturnValue({ get: getFn });

    const store = createCredentialStore({} as never, 'i1');
    const cred = await store.load();

    expect(h.docRef).toHaveBeenCalledWith({} as never, { integracaoId: 'i1' }, 'current');
    expect(cred).toEqual({
      permanent_token: 'TKN',
      phoneNumberId: 'PID',
      wa_id: 'PID',
      createdAt: NOW,
    });
  });

  it('load() returns null when the `current` doc does not exist', async () => {
    h.docRef.mockReturnValue({ get: vi.fn(async () => ({ exists: false })) });

    const store = createCredentialStore({} as never, 'i1');
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
          { id: 'current', ref: currentRef, data: () => ({ permanent_token: 'TKN1' }) },
          { id: 'legacy-auto-id', ref: strayRef },
        ],
      })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const db = { runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) };

    const cred = {
      permanent_token: 'TKN2',
      phoneNumberId: 'PID',
      wa_id: 'PID',
      pin: null,
      createdAt: NOW,
    };
    const store = createCredentialStore(db as never, 'i1');
    const saved = await store.save(cred);

    // Reads-before-writes: read the collection, set `current`, delete the stray.
    expect(tx.get).toHaveBeenCalledWith(collRef);
    expect(tx.set).toHaveBeenCalledWith(currentRef, cred);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledWith(strayRef);
    expect(saved).toBe(cred);
  });

  it('save() carries a previously-stored pin forward when the new cred has none', async () => {
    // A token replacement (POST /api/whatsapp/token) saves a cred with no pin —
    // the stored two-step registration pin must survive it.
    const collRef = {};
    h.ref.mockReturnValue(collRef);
    const currentRef = { id: 'current' };
    h.docRef.mockReturnValue(currentRef);

    const tx = {
      get: vi.fn(async () => ({
        docs: [
          {
            id: 'current',
            ref: currentRef,
            data: () => ({ permanent_token: 'OLD', pin: '123456' }),
          },
        ],
      })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const db = { runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) };

    const store = createCredentialStore(db as never, 'i1');
    const saved = await store.save({
      permanent_token: 'NEW',
      phoneNumberId: 'PID',
      wa_id: 'PID',
      pin: null,
      createdAt: NOW,
    });

    // The pin from the previous doc is merged into the write + the return value.
    expect(saved.pin).toBe('123456');
    expect(tx.set).toHaveBeenCalledWith(currentRef, expect.objectContaining({ pin: '123456' }));
    const written = tx.set.mock.calls[0]![1] as { permanent_token: string };
    expect(written.permanent_token).toBe('NEW');
  });

  it('save() drops an invalid stored pin instead of carrying it forward', async () => {
    // A corrupted / manually-edited pin that violates the schema's 6-digit
    // constraint must not be propagated — otherwise the parse would throw and
    // a plain token replacement could never succeed again.
    const collRef = {};
    h.ref.mockReturnValue(collRef);
    const currentRef = { id: 'current' };
    h.docRef.mockReturnValue(currentRef);

    const tx = {
      get: vi.fn(async () => ({
        docs: [
          {
            id: 'current',
            ref: currentRef,
            data: () => ({ permanent_token: 'OLD', pin: '12ab56' }),
          },
        ],
      })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const db = { runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) };

    const store = createCredentialStore(db as never, 'i1');
    const saved = await store.save({
      permanent_token: 'NEW',
      phoneNumberId: 'PID',
      wa_id: 'PID',
      pin: null,
      createdAt: NOW,
    });

    // The token replacement succeeds and the corrupt pin is gone.
    expect(saved.pin).toBeNull();
    expect(tx.set).toHaveBeenCalledWith(currentRef, expect.objectContaining({ pin: null }));
    const written = tx.set.mock.calls[0]![1] as { permanent_token: string };
    expect(written.permanent_token).toBe('NEW');
  });

  it('save() keeps an explicit pin (does not overwrite it with the stored one)', async () => {
    const collRef = {};
    h.ref.mockReturnValue(collRef);
    const currentRef = { id: 'current' };
    h.docRef.mockReturnValue(currentRef);

    const tx = {
      get: vi.fn(async () => ({
        docs: [
          {
            id: 'current',
            ref: currentRef,
            data: () => ({ permanent_token: 'OLD', pin: '111111' }),
          },
        ],
      })),
      set: vi.fn(),
      delete: vi.fn(),
    };
    const db = { runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) };

    const store = createCredentialStore(db as never, 'i1');
    const saved = await store.save({
      permanent_token: 'NEW',
      phoneNumberId: 'PID',
      wa_id: 'PID',
      pin: '999999',
      createdAt: NOW,
    });

    expect(saved.pin).toBe('999999');
  });

  it('revoke() deletes every credential doc in one transaction', async () => {
    const collRef = {};
    h.ref.mockReturnValue(collRef);

    const currentRef = { id: 'current' };
    const strayRef = { id: 'legacy-auto-id' };
    const tx = {
      get: vi.fn(async () => ({
        docs: [
          { id: 'current', ref: currentRef },
          { id: 'legacy-auto-id', ref: strayRef },
        ],
      })),
      delete: vi.fn(),
    };
    const db = { runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)) };

    const store = createCredentialStore(db as never, 'i1');
    await store.revoke();

    expect(tx.get).toHaveBeenCalledWith(collRef);
    expect(tx.delete).toHaveBeenCalledTimes(2);
    expect(tx.delete).toHaveBeenCalledWith(currentRef);
    expect(tx.delete).toHaveBeenCalledWith(strayRef);
  });
});

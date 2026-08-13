import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_TTL, __resetAllReadCaches } from '@delfrance/data/admin/cache';

import { __setWhatsappCacheClockForTests } from './contaCache';
import {
  DEFAULT_GRAPH_API_VERSION,
  GRAPH_BASE,
  WhatsAppClient,
} from '@delfrance/integrations-whatsapp-cloud-api';

// Mock the two seams: the integracao handle (Firestore) and the credential
// store. The WhatsAppClient + the error classes stay REAL so buildClient and
// the Graph-lookup mapping round-trip.
const h = vi.hoisted(() => ({
  docRef: vi.fn(),
  parseRead: vi.fn(),
  storeLoad: vi.fn(),
  storeSave: vi.fn(async (c: unknown) => c),
  storeRevoke: vi.fn(async () => undefined),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  integracaoCollection: {
    docRef: h.docRef,
    parseRead: h.parseRead,
    docPath: (_ctx: unknown, id: string) => `integracao/${id}`,
  },
}));

vi.mock('./credentialStore', async (importActual) => {
  const actual = await importActual<typeof import('./credentialStore')>();
  return {
    ...actual,
    createCredentialStore: () => ({
      load: h.storeLoad,
      save: h.storeSave,
      revoke: h.storeRevoke,
    }),
  };
});

const {
  loadWhatsappContext,
  fetchWhatsappPhoneNumber,
  WhatsappContaNotConfiguredError,
  WhatsappGraphError,
  WhatsappTokenInvalidError,
  WhatsappTokenMissingError,
} = await import('./whatsapp');

const NOW = 1_700_000_000_000;

/** Prime the loader to resolve a valid WhatsApp integracao doc. */
function contaDoc(over: Record<string, unknown> = {}): void {
  h.docRef.mockReturnValue({ get: async () => ({ exists: true, data: () => ({}) }) });
  h.parseRead.mockReturnValue({
    tipo: 6, // INTEGRACAO_TIPO.whatsapp
    nome: 'Loja WA',
    phoneNumberId: 'PID',
    wa_id: 'PID',
    ...over,
  });
}

function storedCred(over: Record<string, unknown> = {}) {
  return { permanent_token: 'TKN', phoneNumberId: 'PID', wa_id: 'PID', createdAt: NOW, ...over };
}

let now = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  // The conta reader is module-scope and every test here uses `i1`, so without
  // this the first test's absent-document entry serves the rest.
  __resetAllReadCaches();
  now = 1_700_000_000_000;
  __setWhatsappCacheClockForTests(() => now);
  h.storeSave.mockImplementation(async (c: unknown) => c);
});

afterEach(() => {
  __resetAllReadCaches();
  __setWhatsappCacheClockForTests();
});

describe('loadWhatsappContext', () => {
  it('throws WhatsappContaNotConfiguredError when the doc is missing', async () => {
    h.docRef.mockReturnValue({ get: async () => ({ exists: false }) });
    await expect(loadWhatsappContext({} as never, 'i1')).rejects.toBeInstanceOf(
      WhatsappContaNotConfiguredError,
    );
  });

  it('throws WhatsappContaNotConfiguredError when the account is not tipo whatsapp', async () => {
    h.docRef.mockReturnValue({ get: async () => ({ exists: true, data: () => ({}) }) });
    h.parseRead.mockReturnValue({ tipo: 1, nome: 'ML' });
    await expect(loadWhatsappContext({} as never, 'i1')).rejects.toBeInstanceOf(
      WhatsappContaNotConfiguredError,
    );
  });

  it('phoneNumberId() returns conta.phoneNumberId', async () => {
    contaDoc({ phoneNumberId: 'PID', wa_id: 'WID' });
    const ctx = await loadWhatsappContext({} as never, 'i1');
    expect(ctx.phoneNumberId()).toBe('PID');
  });

  it('phoneNumberId() throws when phoneNumberId is null — NEVER falls back to wa_id', async () => {
    // wa_id is a WhatsApp Business Account id (a different Graph node); legacy
    // getPhoneNumberId() throws rather than falling back, and so do we.
    contaDoc({ phoneNumberId: null, wa_id: 'WID' });
    const ctx = await loadWhatsappContext({} as never, 'i1');
    expect(() => ctx.phoneNumberId()).toThrow(WhatsappContaNotConfiguredError);
  });

  it('hasToken() reflects whether a credential is stored', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValueOnce(null);
    const ctx = await loadWhatsappContext({} as never, 'i1');
    expect(await ctx.hasToken()).toBe(false);
    h.storeLoad.mockResolvedValueOnce(storedCred());
    expect(await ctx.hasToken()).toBe(true);
  });

  it('resolveToken() returns the stored permanent token', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValue(storedCred());
    const ctx = await loadWhatsappContext({} as never, 'i1');
    expect(await ctx.resolveToken()).toBe('TKN');
  });

  it('resolveToken() throws WhatsappTokenMissingError when no token is stored', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValue(null);
    const ctx = await loadWhatsappContext({} as never, 'i1');
    await expect(ctx.resolveToken()).rejects.toBeInstanceOf(WhatsappTokenMissingError);
  });

  it('buildClient() constructs a WhatsAppClient once a token resolves', async () => {
    contaDoc();
    h.storeLoad.mockResolvedValue(storedCred());
    const ctx = await loadWhatsappContext({} as never, 'i1');
    const client = await ctx.buildClient();
    expect(client).toBeInstanceOf(WhatsAppClient);
  });
});

describe('fetchWhatsappPhoneNumber', () => {
  it('GETs the Graph phone-number node with a Bearer token and maps the fields', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ display_phone_number: '+55 11 90000-0000', verified_name: 'Loja WA' }),
    }));
    const info = await fetchWhatsappPhoneNumber('PID', 'TKN', {
      fetch: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      `${GRAPH_BASE}/${DEFAULT_GRAPH_API_VERSION}/PID?fields=display_phone_number,verified_name`,
      { headers: { authorization: 'Bearer TKN' } },
    );
    expect(info).toEqual({ display_phone_number: '+55 11 90000-0000', verified_name: 'Loja WA' });
  });

  it('maps absent fields to null', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const info = await fetchWhatsappPhoneNumber('PID', 'TKN', {
      fetch: fetchFn as unknown as typeof fetch,
    });
    expect(info).toEqual({ display_phone_number: null, verified_name: null });
  });

  it('throws WhatsappTokenInvalidError on a 401', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { code: 190, message: 'expired' } }),
    }));
    await expect(
      fetchWhatsappPhoneNumber('PID', 'BAD', { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(WhatsappTokenInvalidError);
  });

  it('throws WhatsappTokenInvalidError on Graph error code 190 (non-401 status)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 190 } }),
    }));
    await expect(
      fetchWhatsappPhoneNumber('PID', 'BAD', { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(WhatsappTokenInvalidError);
  });

  it('throws WhatsappGraphError (carrying the status) on other non-OK responses', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(
      fetchWhatsappPhoneNumber('PID', 'TKN', { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: 'WhatsappGraphError', status: 500 });
  });

  it('tolerates a non-JSON error body (falls through to WhatsappGraphError)', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => '<html>gateway</html>',
    }));
    await expect(
      fetchWhatsappPhoneNumber('PID', 'TKN', { fetch: fetchFn as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(WhatsappGraphError);
  });
});

describe('loadWhatsappContext — the integracao read cache', () => {
  /** Counts the underlying `.get()`s rather than `docRef` calls. */
  function countingConta(): { reads: number } {
    const counter = { reads: 0 };
    h.docRef.mockReturnValue({
      get: async () => {
        counter.reads += 1;
        return { exists: true, data: () => ({}) };
      },
    });
    h.parseRead.mockReturnValue({ tipo: 6, nome: 'Loja WA', phoneNumberId: 'PID', wa_id: 'PID' });
    return counter;
  }

  it('serves a repeated load from cache', async () => {
    const c = countingConta();

    await loadWhatsappContext({} as never, 'i1');
    await loadWhatsappContext({} as never, 'i1');

    expect(c.reads).toBe(1);
  });

  it('re-reads after ttlMs — the staleness contract, not just the hit', async () => {
    const c = countingConta();

    await loadWhatsappContext({} as never, 'i1');
    now += READ_CACHE_TTL.config - 1;
    await loadWhatsappContext({} as never, 'i1');
    expect(c.reads).toBe(1);

    // The boundary is EXCLUSIVE: at exactly `ttlMs` the entry is expired.
    now += 1;
    await loadWhatsappContext({} as never, 'i1');
    expect(c.reads).toBe(2);
  });

  it('never caches an absent document — a cached one turns an outbound TERMINAL', async () => {
    // `WhatsappContaNotConfiguredError` reaches the outbound dispatcher and marks
    // the message `estadoEnvio = erro`, which the stale-outbound sweep does not
    // re-drive. An operator would have to resend by hand.
    h.docRef.mockReturnValue({ get: async () => ({ exists: false }) });
    await expect(loadWhatsappContext({} as never, 'i1')).rejects.toBeInstanceOf(
      WhatsappContaNotConfiguredError,
    );

    countingConta();
    await expect(loadWhatsappContext({} as never, 'i1')).resolves.toBeDefined();
  });

  it('still throws on a wrong tipo when the value came from cache', async () => {
    const c = countingConta();
    h.parseRead.mockReturnValue({ tipo: 1, nome: 'ML' });

    await expect(loadWhatsappContext({} as never, 'i1')).rejects.toBeInstanceOf(
      WhatsappContaNotConfiguredError,
    );
    await expect(loadWhatsappContext({} as never, 'i1')).rejects.toBeInstanceOf(
      WhatsappContaNotConfiguredError,
    );
    expect(c.reads).toBe(1);
  });
});

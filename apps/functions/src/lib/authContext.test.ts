import { describe, expect, it } from 'vitest';

import { resolveUsuarioOuterRef } from './authContext';

const UID = 'AbCdEf0123456789AbCdEf01';

/**
 * Moved here from `../pedidos/registrarHistoricoPedido.test.ts` when the
 * modification-history factory became a second consumer. The pedido trails keep
 * re-exporting the function, and that re-export is pinned in the old file.
 */
describe('resolveUsuarioOuterRef', () => {
  it('maps a uid-shaped authId to the documents/usuarios outer-ref', () => {
    expect(resolveUsuarioOuterRef('api_key', UID)).toBe(`documents/usuarios/${UID}`);
    // A standard 28-char Firebase Auth uid.
    const uid28 = 'kJ8fL2mNp9QrS4tUvW6xY0zA1bC3';
    expect(resolveUsuarioOuterRef('unknown', uid28)).toBe(`documents/usuarios/${uid28}`);
  });

  it('accepts the _ and - a custom (Admin-SDK-set) uid may carry', () => {
    // `createUser({ uid })` and user imports allow these; dropping such an actor
    // to null would be a silent audit gap.
    const custom = 'tenant_acme-user-000042xyz';
    expect(resolveUsuarioOuterRef('api_key', custom)).toBe(`documents/usuarios/${custom}`);
  });

  it('returns null when there is no authId at all', () => {
    expect(resolveUsuarioOuterRef('api_key', undefined)).toBeNull();
    expect(resolveUsuarioOuterRef(undefined, undefined)).toBeNull();
    expect(resolveUsuarioOuterRef('unknown', '')).toBeNull();
  });

  it('returns null for auth types that can never be an end user', () => {
    // Admin SDK writes: the Mercado Pago webhook, ML import, other functions.
    expect(resolveUsuarioOuterRef('service_account', UID)).toBeNull();
    expect(resolveUsuarioOuterRef('system', UID)).toBeNull();
    expect(resolveUsuarioOuterRef('unauthenticated', UID)).toBeNull();
  });

  it('rejects anything that is not uid-shaped', () => {
    // The emulator hardcodes this one (firebase-tools#7609) — it must NOT
    // become a bogus usuário ref in the audit trail. It is also why neither the
    // pedido trails NOR the modification history can assert a real actor in the
    // emulator lane; that assertion belongs in a staging e2e.
    expect(resolveUsuarioOuterRef('unknown', 'fake-auth-id@gmail.com')).toBeNull();
    // Firebase-console writes report the operator's email.
    expect(resolveUsuarioOuterRef('unknown', 'someone@example.com')).toBeNull();
    // A service-account identifier.
    expect(resolveUsuarioOuterRef('unknown', 'my-app@appspot.gserviceaccount.com')).toBeNull();
    // Too short / illegal characters.
    expect(resolveUsuarioOuterRef('api_key', 'short')).toBeNull();
    expect(resolveUsuarioOuterRef('api_key', 'has spaces in it here')).toBeNull();
    expect(resolveUsuarioOuterRef('api_key', 'has/slashes/in/it/abcdef')).toBeNull();
  });
});

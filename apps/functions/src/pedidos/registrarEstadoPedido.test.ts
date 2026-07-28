import { describe, expect, it } from 'vitest';

import { buildEstadoHistoryEntry, resolveUsuarioOuterRef } from './registrarEstadoPedido';

const UID = 'abcDEF0123456789abcDEF01'; // 24 chars, uid-shaped

describe('resolveUsuarioOuterRef', () => {
  it('maps a uid-shaped authId to the documents/usuarios outer-ref', () => {
    expect(resolveUsuarioOuterRef('api_key', UID)).toBe(`documents/usuarios/${UID}`);
    // A standard 28-char Firebase Auth uid.
    const uid28 = 'kJ8fL2mNp9QrS4tUvW6xY0zA1bC3';
    expect(resolveUsuarioOuterRef('unknown', uid28)).toBe(`documents/usuarios/${uid28}`);
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
    // become a bogus usuário ref in the audit trail.
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

describe('buildEstadoHistoryEntry', () => {
  const base = {
    usuarioOuterRef: `documents/usuarios/${UID}`,
    eventId: 'evt-1',
    eventTimeMicros: 1_700_000_000_000_000,
  };

  it('records the opening estado on create', () => {
    expect(
      buildEstadoHistoryEntry({ ...base, before: undefined, after: { estado: 'iniciado' } }),
    ).toEqual({
      estado: 'iniciado',
      usuarioHistoricoEstadosPedidoOuterRef: `documents/usuarios/${UID}`,
      data: 1_700_000_000_000_000,
      eventId: 'evt-1',
    });
  });

  it('records a transition', () => {
    const entry = buildEstadoHistoryEntry({
      ...base,
      before: { estado: 'iniciado' },
      after: { estado: 'pago' },
    });
    expect(entry).toMatchObject({ estado: 'pago', eventId: 'evt-1' });
  });

  it('stores a null usuário when none could be resolved', () => {
    const entry = buildEstadoHistoryEntry({
      ...base,
      usuarioOuterRef: null,
      before: { estado: 'iniciado' },
      after: { estado: 'pago' },
    });
    expect(entry?.usuarioHistoricoEstadosPedidoOuterRef).toBeNull();
  });

  it('is a no-op when estado did not change', () => {
    // The overwhelmingly common case: any pedido edit that is not a state change.
    expect(
      buildEstadoHistoryEntry({
        ...base,
        before: { estado: 'pago', numero: 'A' },
        after: { estado: 'pago', numero: 'B' },
      }),
    ).toBeNull();
  });

  it('is a no-op on delete', () => {
    expect(
      buildEstadoHistoryEntry({ ...base, before: { estado: 'pago' }, after: undefined }),
    ).toBeNull();
  });

  it('is a no-op when estado is missing or not a known EstadoPedido', () => {
    expect(buildEstadoHistoryEntry({ ...base, before: undefined, after: {} })).toBeNull();
    expect(
      buildEstadoHistoryEntry({ ...base, before: undefined, after: { estado: 'inventado' } }),
    ).toBeNull();
    expect(
      buildEstadoHistoryEntry({ ...base, before: undefined, after: { estado: 42 } }),
    ).toBeNull();
  });
});

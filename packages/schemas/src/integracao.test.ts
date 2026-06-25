import { describe, expect, it } from 'vitest';
import {
  credenciaisIntegracaoMeta,
  credenciaisIntegracaoSchema,
  integracaoMeta,
} from './integracao';

/* -------------------------------------------------------------------------- */
/*                          CredenciaisIntegracao                             */
/* -------------------------------------------------------------------------- */

describe('credenciaisIntegracaoSchema', () => {
  it('parses an OAuth credential doc', () => {
    const doc = {
      access_token: 'jwt.abc.def',
      refresh_token: 'r-123',
      expirationDate: 1718003600000,
    };
    expect(credenciaisIntegracaoSchema.parse(doc)).toMatchObject(doc);
  });

  it('preserves channel-specific OAuth extras via passthrough', () => {
    // Fields each channel returns on top of the uniform core — never modeled
    // explicitly, carried verbatim (Mercado Livre token_type/scope/user_id,
    // Amazon revoked, Magalu created_at, Shopee isRefreshing).
    const parsed = credenciaisIntegracaoSchema.parse({
      access_token: 'a',
      refresh_token: 'r',
      expirationDate: 1718003600000,
      token_type: 'Bearer',
      scope: 'read write',
      user_id: 123456,
      revoked: false,
      created_at: 1718000000000,
      isRefreshing: false,
    }) as Record<string, unknown>;
    expect(parsed.token_type).toBe('Bearer');
    expect(parsed.scope).toBe('read write');
    expect(parsed.user_id).toBe(123456);
    expect(parsed.revoked).toBe(false);
    expect(parsed.created_at).toBe(1718000000000);
    expect(parsed.isRefreshing).toBe(false);
  });

  it('requires access_token and refresh_token (non-empty)', () => {
    expect(
      credenciaisIntegracaoSchema.safeParse({ refresh_token: 'r', expirationDate: 1 }).success,
    ).toBe(false);
    expect(
      credenciaisIntegracaoSchema.safeParse({ access_token: 'a', expirationDate: 1 }).success,
    ).toBe(false);
    expect(
      credenciaisIntegracaoSchema.safeParse({
        access_token: '',
        refresh_token: 'r',
        expirationDate: 1,
      }).success,
    ).toBe(false);
  });

  it('requires a parseable expirationDate', () => {
    expect(
      credenciaisIntegracaoSchema.safeParse({ access_token: 'a', refresh_token: 'r' }).success,
    ).toBe(false);
    expect(
      credenciaisIntegracaoSchema.safeParse({
        access_token: 'a',
        refresh_token: 'r',
        expirationDate: 'not-a-date',
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  Metas                                     */
/* -------------------------------------------------------------------------- */

describe('integracao metas', () => {
  it('integracaoMeta targets integracao and cascades credenciais', () => {
    expect(integracaoMeta.collectionPath).toBe('integracao');
    expect(integracaoMeta.cascade).toEqual([
      { path: 'integracao/{integracaoId}/credenciais', onDelete: 'cascade' },
    ]);
  });

  it('credenciaisIntegracaoMeta targets the subcollection', () => {
    expect(credenciaisIntegracaoMeta.collectionPath).toBe('integracao/{integracaoId}/credenciais');
  });

  it('reuses the PERM.integracao byte (56–58); token reads require write', () => {
    expect(integracaoMeta.permissions).toEqual({
      read: 1n << 56n,
      write: 1n << 57n,
      delete: 1n << 58n,
    });
    // Reads deliberately require integracao.write (live credentials); delete
    // uses the dedicated delete bit. No new PERM byte allocated.
    expect(credenciaisIntegracaoMeta.permissions).toEqual({
      read: 1n << 57n,
      write: 1n << 57n,
      delete: 1n << 58n,
    });
  });
});

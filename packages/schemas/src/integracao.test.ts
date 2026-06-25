import { describe, expect, it } from 'vitest';
import {
  credenciaisIntegracaoMeta,
  credenciaisIntegracaoSchema,
  integracaoMeta,
} from './integracao';
import { ALL_DOMAINS } from './registry';

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

  it('keeps the integracao parent on its own byte (56–58)', () => {
    expect(integracaoMeta.permissions).toEqual({
      read: 1n << 56n,
      write: 1n << 57n,
      delete: 1n << 58n,
    });
  });

  it('is admin-only / default-deny: zero perms (mirrors certificadoSecreto)', () => {
    // The credential doc holds live refresh tokens. No client domain grants
    // these bits; the domain is left out of ALL_DOMAINS so rules-gen emits no
    // block and Firestore default-denies every client. Only the Admin SDK reaches it.
    expect(credenciaisIntegracaoMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('is NOT registered in ALL_DOMAINS (server-only secret store)', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).not.toContain('integracao/{integracaoId}/credenciais');
  });
});

import { describe, expect, it } from 'vitest';
import { credenciaisMetodoPgtoMeta, credenciaisMetodoPgtoSchema } from './credenciaisMetodoPgto';
import { metodoPagamentoMeta } from './pedido';
import { ALL_DOMAINS } from './registry';

/* -------------------------------------------------------------------------- */
/*                          CredenciaisMetodoPgto                             */
/* -------------------------------------------------------------------------- */

describe('credenciaisMetodoPgtoSchema', () => {
  it('parses an OAuth credential doc', () => {
    const doc = {
      access_token: 'jwt.abc.def',
      refresh_token: 'r-123',
      expirationDate: 1718003600000,
    };
    expect(credenciaisMetodoPgtoSchema.parse(doc)).toMatchObject(doc);
  });

  it('preserves Mercado Pago OAuth extras via passthrough', () => {
    const parsed = credenciaisMetodoPgtoSchema.parse({
      access_token: 'a',
      refresh_token: 'r',
      expirationDate: 1718003600000,
      token_type: 'bearer',
      scope: 'read write',
      public_key: 'pk-abc',
      live_mode: true,
    }) as Record<string, unknown>;
    expect(parsed.token_type).toBe('bearer');
    expect(parsed.scope).toBe('read write');
    expect(parsed.public_key).toBe('pk-abc');
    expect(parsed.live_mode).toBe(true);
  });

  it('requires access_token and refresh_token (non-empty)', () => {
    expect(
      credenciaisMetodoPgtoSchema.safeParse({ refresh_token: 'r', expirationDate: 1 }).success,
    ).toBe(false);
    expect(
      credenciaisMetodoPgtoSchema.safeParse({ access_token: 'a', expirationDate: 1 }).success,
    ).toBe(false);
    expect(
      credenciaisMetodoPgtoSchema.safeParse({
        access_token: '',
        refresh_token: 'r',
        expirationDate: 1,
      }).success,
    ).toBe(false);
  });

  it('requires a parseable expirationDate', () => {
    expect(
      credenciaisMetodoPgtoSchema.safeParse({ access_token: 'a', refresh_token: 'r' }).success,
    ).toBe(false);
    expect(
      credenciaisMetodoPgtoSchema.safeParse({
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

describe('metodo_pgto metas', () => {
  it('metodoPagamentoMeta targets metodo_pgto and cascades credenciais', () => {
    expect(metodoPagamentoMeta.collectionPath).toBe('metodo_pgto');
    expect(metodoPagamentoMeta.cascade).toEqual([
      { path: 'metodo_pgto/{metodoId}/credenciais', onDelete: 'cascade' },
    ]);
  });

  it('credenciaisMetodoPgtoMeta targets the subcollection', () => {
    expect(credenciaisMetodoPgtoMeta.collectionPath).toBe('metodo_pgto/{metodoId}/credenciais');
  });

  it('is admin-only / default-deny: zero perms (mirrors credenciaisIntegracao)', () => {
    expect(credenciaisMetodoPgtoMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });

  it('is NOT registered in ALL_DOMAINS (server-only secret store)', () => {
    const paths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(paths).not.toContain('metodo_pgto/{metodoId}/credenciais');
  });
});

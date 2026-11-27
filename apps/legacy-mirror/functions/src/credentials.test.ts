import { describe, expect, it } from 'vitest';

import {
  InvalidCredentialPolicyError,
  credentialCollectionIds,
  credentialFieldsOf,
  isCredentialPath,
  parseCredentialPolicy,
  withoutCredentialFields,
} from './credentials';

describe('parseCredentialPolicy', () => {
  it('accepts exactly deny and copy', () => {
    expect(parseCredentialPolicy('deny')).toBe('deny');
    expect(parseCredentialPolicy(' copy ')).toBe('copy');
  });

  it.each(['', 'Deny', 'allow', 'true', 'none'])('refuses %j — no default, no guess', (raw) => {
    expect(() => parseCredentialPolicy(raw)).toThrow(InvalidCredentialPolicyError);
  });
});

describe('isCredentialPath', () => {
  it.each([
    'integracao/a/tokenDuravel/b',
    'integracao/a/token6h/b',
    'integracao/a/actokshopee/b',
    'integracao/a/tokenoaut/b',
    'integracao/a/credenciaisWhatsapp/b',
    'integracoes/a/token/b',
    'int_frete/a/tokenMelEnv/b',
    'metodo_pgto/a/tokenDuravelmp/b',
    'metodo_pgto/a/token6hmp/b',
    'filiais/a/certificados/b',
    'filiais/a/certificadoSecreto/default',
    'integracao/a/tokenDuravel/b/x/y',
  ])('denies %s', (path) => {
    expect(isCredentialPath(path)).toBe(true);
  });

  it.each([
    // The parent documents themselves carry ordinary data the app needs.
    'integracao/a',
    'int_frete/a',
    'filiais/a',
    // Same subcollection id under a different parent is not a credential.
    'pedidos/p/token/t',
    'produtos/p/certificados/c',
    // Sibling subcollections of a credential parent stay.
    'integracao/a/pagina/b',
    'integracao/a/pushshopee/b',
    'integracoes/a/whatsapp/b',
    'filiais/a/nfe/b',
    // A root collection that happens to share a credential id.
    'token/t',
  ])('keeps %s (near-miss)', (path) => {
    expect(isCredentialPath(path)).toBe(false);
  });
});

describe('credential fields', () => {
  const data = { nome: 'WhatsApp', permanent_token: 'EAAG…', pin: '123456', tipo: 'w' };

  it('finds and removes the WhatsApp token and PIN on an integracao document', () => {
    expect(credentialFieldsOf('integracao/a', data)).toEqual(['permanent_token', 'pin']);
    expect(withoutCredentialFields('integracao/a', data)).toEqual({ nome: 'WhatsApp', tipo: 'w' });
  });

  it('does not mutate the source data', () => {
    withoutCredentialFields('integracao/a', data);
    expect(data).toHaveProperty('permanent_token');
  });

  it('leaves the same field names alone anywhere else (near-miss)', () => {
    expect(credentialFieldsOf('pedidos/a', data)).toEqual([]);
    expect(credentialFieldsOf('integracao/a/pagina/b', data)).toEqual([]);
    expect(withoutCredentialFields('pedidos/a', data)).toBe(data);
  });
});

describe('credentialCollectionIds', () => {
  it('lists each denied subcollection id once', () => {
    const ids = credentialCollectionIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('tokenDuravel');
    expect(ids).toContain('tokenMelEnv');
    expect(ids).toContain('certificados');
  });
});

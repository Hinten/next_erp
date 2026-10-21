import { describe, expect, it } from 'vitest';
import { OauthStateError } from '@delfrance/data/admin/oauth-state';

import { FakeDb, asDb } from '../testing/fakeDb';
import { criarFakeOauthState } from '../testing/fakeOauthState';
import { AGORA_MS } from '../testing/fixtures';
import { amazonOauthState } from './oauthState';

/**
 * The binding only: WHERE the record lives. The redeem semantics (single use,
 * superseded, expired, the atomic stamp) are the shared seam's and its own tests
 * own them; the fake below mirrors that contract for the callback's suites.
 */
describe('amazonOauthState', () => {
  it('writes the attempt record at integracao/{id}/oauthState/current — a full overwrite, no PKCE', async () => {
    const db = new FakeDb();
    await amazonOauthState.put(asDb(db), 'conta-1', { nonce: 'n1', codeVerifier: null }, AGORA_MS);
    expect(db.ler('integracao/conta-1/oauthState/current')).toEqual({
      nonce: 'n1',
      codeVerifier: null,
      criadoEm: AGORA_MS,
      consumidoEm: null,
    });
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['set', 'integracao/conta-1/oauthState/current'],
    ]);
  });

  it('a second attempt supersedes the first (same document)', async () => {
    const db = new FakeDb();
    await amazonOauthState.put(asDb(db), 'c', { nonce: 'n1', codeVerifier: null }, AGORA_MS);
    await amazonOauthState.put(asDb(db), 'c', { nonce: 'n2', codeVerifier: null }, AGORA_MS + 1);
    expect(db.ler('integracao/c/oauthState/current')?.nonce).toBe('n2');
  });
});

describe('the in-memory fake mirrors the seam contract', () => {
  it('consumes once; a replay, a superseded nonce and an expired attempt are OauthStateError', async () => {
    const fake = criarFakeOauthState();
    const db = asDb(new FakeDb());
    await fake.put(db, 'c', { nonce: 'n1', codeVerifier: null }, AGORA_MS);
    await expect(fake.consume(db, 'c', 'n1', AGORA_MS)).resolves.toEqual({ codeVerifier: null });
    await expect(fake.consume(db, 'c', 'n1', AGORA_MS)).rejects.toBeInstanceOf(OauthStateError);
    await fake.put(db, 'c', { nonce: 'n2', codeVerifier: null }, AGORA_MS);
    await fake.put(db, 'c', { nonce: 'n3', codeVerifier: null }, AGORA_MS);
    await expect(fake.consume(db, 'c', 'n2', AGORA_MS)).rejects.toBeInstanceOf(OauthStateError);
    await expect(fake.consume(db, 'c', 'n3', AGORA_MS + 10 * 60 * 1000 + 1)).rejects.toBeInstanceOf(
      OauthStateError,
    );
    await expect(fake.consume(db, 'outra', 'n3', AGORA_MS)).rejects.toBeInstanceOf(OauthStateError);
    expect(fake.consumos).toHaveLength(5);
  });
});

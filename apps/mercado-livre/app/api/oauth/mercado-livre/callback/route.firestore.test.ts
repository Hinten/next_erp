/**
 * The Mercado Livre OAuth callback against a REAL Firestore, with ML's token
 * endpoint stubbed.
 *
 * The full OAuth round trip cannot be automated at all: ML has no sandbox, the
 * consent screen needs a human, the redirect URI must be static and publicly
 * registered, and the refresh_token is single-use — so a credentialed test
 * would rotate the credential the staging backend is holding. What IS
 * automatable is everything after the browser hands the `code` back, and that
 * is the half carrying the persistence bugs.
 *
 * The sibling `route.test.ts` stubs `loadMercadoLivreContext` wholesale, so
 * `exchangeAndPersist` — the function that actually writes the token — never
 * runs. Here it runs for real, against a real subcollection under a real
 * parent, and this is the only place in the repo that exercises
 * `packages/integrations/mercado-livre`'s real `exchangeCode` → `requestToken`
 * → `tokenResponseSchema` path. That is what makes #823's "a PR touching only
 * packages/integrations/mercado-livre runs an integration-level check"
 * substantive rather than a paths-filter entry.
 */
import { randomUUID } from 'node:crypto';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signState } from '@delfrance/data/admin/oauth-state';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { mercadoLivreOauthState } from '@/lib/marketplace/oauthState';

import { GET } from './route';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const STATE_SECRET = 'segredo-de-teste-do-state';
const WEB_APP_URL = 'https://erp.example.invalid';
const CLIENT_ID = '2069392825111111';

/** A canned ML token response — the shape `tokenResponseSchema` must accept. */
const ML_TOKEN_RESPONSE = {
  access_token: 'APP_USR-123456-090515-abc-1234567',
  token_type: 'bearer',
  expires_in: 21_600,
  scope: 'offline_access read write',
  user_id: 8_035_443,
  refresh_token: 'TG-rotacionado-1234567',
};

function db() {
  return getAdminFirestore();
}

let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('MERCADO_LIVRE_CLIENT_SECRET', 'client-secret-de-teste');
  vi.stubEnv('MERCADO_LIVRE_STATE_SECRET', STATE_SECRET);
  vi.stubEnv('MERCADO_LIVRE_PUBLIC_URL', 'https://ml.example.invalid');
  vi.stubEnv('WEB_APP_URL', WEB_APP_URL);

  fetchStub = vi.fn(
    async () =>
      new Response(JSON.stringify(ML_TOKEN_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchStub);

  const refs = await db().collection('integracao').listDocuments();
  await Promise.all(refs.map((r) => r.delete()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.skipIf(!EMULATED)('GET /api/oauth/mercado-livre/callback (Firestore emulator)', () => {
  it('exchanges the code and persists the token + the denormalized user_id', async () => {
    const integracaoId = `int${randomUUID().replace(/-/g, '')}`;
    const contaRef = db().collection('integracao').doc(integracaoId);
    await contaRef.set({
      nome: 'conta ML de teste',
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      ativo: true,
    });

    // #821: the signed state is no longer sufficient on its own — `/oauth/start`
    // RECORDS the attempt and the callback REDEEMS it, so the state is
    // single-use. Seed the record the same way the start route would.
    const { state, nonce } = signState(integracaoId, STATE_SECRET);
    await mercadoLivreOauthState.put(db(), integracaoId, { nonce, codeVerifier: null });

    const url = `https://ml.example.invalid/api/oauth/mercado-livre/callback?code=TG-code-123&state=${encodeURIComponent(state)}`;

    const before = Date.now();
    const res = await GET(new Request(url));
    const after = Date.now();

    // 1. The browser is sent back to the channel page in the connected state.
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `${WEB_APP_URL}/canais/mercado-livre/${integracaoId}?ml=connected`,
    );

    // 2. A real token document under a real parent, written through the strict
    //    write parser. `expires_in` is the OLD Flutter wire shape: an ABSOLUTE
    //    ms-since-epoch expiry (now + expires_in*1000 - 5s guard), NOT the
    //    seconds duration ML sends. Getting this wrong makes every token look
    //    expired — or never expire.
    const tokenSnap = await contaRef.collection('tokenDuravel').doc('current').get();
    expect(tokenSnap.exists).toBe(true);
    const token = tokenSnap.data()!;
    expect(token).toMatchObject({
      access_token: ML_TOKEN_RESPONSE.access_token,
      refresh_token: ML_TOKEN_RESPONSE.refresh_token,
      token_type: 'bearer',
      user_id: ML_TOKEN_RESPONSE.user_id,
    });
    expect(token.expires_in).toBeGreaterThanOrEqual(before + 21_600 * 1000 - 5_000);
    expect(token.expires_in).toBeLessThanOrEqual(after + 21_600 * 1000 - 5_000);

    // 3. The seller id is denormalized onto the parent MERGE-ONLY — the webhook
    //    receiver resolves an account by it. A converted `set(..., {merge:true})`
    //    would full-parse the patch and blow away the siblings, so assert they
    //    survived rather than only that `user_id` arrived.
    const conta = (await contaRef.get()).data()!;
    expect(conta).toMatchObject({
      user_id: ML_TOKEN_RESPONSE.user_id,
      nome: 'conta ML de teste',
      ativo: true,
      tipo: INTEGRACAO_TIPO.mercadoLivre,
    });

    // 4. The outbound request really was the documented token exchange.
    expect(fetchStub).toHaveBeenCalledOnce();
    const [reqUrl, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(String(reqUrl)).toBe('https://api.mercadolibre.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(String(init.body)).toContain('code=TG-code-123');
    expect(String(init.body)).toContain('client_id=2069392825111111');
  });

  it('#821: replaying a VALID state is rejected — the record is single-use', async () => {
    const integracaoId = `int${randomUUID().replace(/-/g, '')}`;
    const contaRef = db().collection('integracao').doc(integracaoId);
    await contaRef.set({
      nome: 'conta ML',
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      ativo: true,
    });

    const { state, nonce } = signState(integracaoId, STATE_SECRET);
    await mercadoLivreOauthState.put(db(), integracaoId, { nonce, codeVerifier: null });

    const url = `https://ml.example.invalid/api/oauth/mercado-livre/callback?code=TG-code-123&state=${encodeURIComponent(state)}`;

    const first = await GET(new Request(url));
    expect(first.headers.get('location')).toContain('ml=connected');

    // The HMAC is still perfectly valid on the second call — integrity was never
    // the question. Only the redeemed record distinguishes them, and
    // `consumeOauthState` stamps `consumidoEm` inside the transaction that read
    // it. Before #821 this replay overwrote the account's credential with
    // whoever drove the second callback.
    const second = await GET(new Request(url));
    expect(second.headers.get('location')).toContain('reason=bad_state');

    // The winner's token survived — a rejected replay must not disturb it.
    const token = await contaRef.collection('tokenDuravel').doc('current').get();
    expect(token.exists).toBe(true);
    expect(token.data()).toMatchObject({ access_token: ML_TOKEN_RESPONSE.access_token });
    // And the rejection happened BEFORE the exchange: only the first call
    // reached Mercado Livre.
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('a state signed with a DIFFERENT secret is rejected and writes nothing', async () => {
    const integracaoId = `int${randomUUID().replace(/-/g, '')}`;
    const contaRef = db().collection('integracao').doc(integracaoId);
    await contaRef.set({
      nome: 'conta ML',
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      ativo: true,
    });

    const { state: forged } = signState(integracaoId, 'outro-segredo-qualquer');
    const res = await GET(
      new Request(
        `https://ml.example.invalid/api/oauth/mercado-livre/callback?code=TG-code-123&state=${encodeURIComponent(forged)}`,
      ),
    );

    expect(res.headers.get('location')).toContain('reason=bad_state');
    // No token, no ML call — the HMAC is the only trust anchor on this public route.
    expect((await contaRef.collection('tokenDuravel').doc('current').get()).exists).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
    // Positive counterpart so the two "did not happen" assertions above cannot
    // pass against a wrong database: the parent we seeded IS readable here.
    expect((await contaRef.get()).exists).toBe(true);
  });
});

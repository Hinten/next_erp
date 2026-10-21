import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyState } from '@delfrance/data/admin/oauth-state';
import { URL_CONSENTIMENTO_BR } from '@delfrance/integrations-amazon-sp-api';

import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonNaoEncontradaError,
} from '../core/erros';
import { FakeDb, asDb } from '../testing/fakeDb';
import { type FakeOauthState, criarFakeOauthState } from '../testing/fakeOauthState';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  APPLICATION_ID,
  AUTORIZADO_EM_MS,
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  REFRESH_TOKEN_A,
  STATE_SECRET,
  loggerEspiao,
  refDe,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { type IniciarDeps, iniciarConexaoAmazon } from './iniciar';

const ID = 'conta-1';
let db: FakeDb;
let estado: FakeOauthState;

beforeEach(() => {
  db = new FakeDb();
  estado = criarFakeOauthState();
});

function deps(over: Partial<IniciarDeps> = {}) {
  const log = loggerEspiao();
  return {
    d: {
      ambiente: AMBIENTE_LIGADO,
      agoraMs: AGORA_MS,
      estado,
      logger: log.logger,
      ...over,
    } satisfies IniciarDeps,
    linhas: log.linhas,
  };
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma recusa');
    },
    (e: unknown) => e,
  );
}

describe('iniciarConexaoAmazon', () => {
  it('switch off → refused with NO Firestore operation, no attempt and one blocked line', async () => {
    seedConta(db, ID);
    const { d, linhas } = deps({ ambiente: AMBIENTE_DESLIGADO });
    expect(await falha(iniciarConexaoAmazon(asDb(db), ID, d))).toBeInstanceOf(
      ChamadasAmazonDesligadasError,
    );
    expect(db.operacoes).toBe(0);
    expect(estado.puts).toHaveLength(0);
    expect(linhas).toEqual([
      expect.objectContaining({
        nivel: 'info',
        meta: expect.objectContaining({ rota: 'oauth-start', valor: 'ausente' }) as unknown,
      }),
    ]);
  });

  it('the WHOLE callback config is checked here, naming keys — never values — before any read', async () => {
    seedConta(db, ID);
    const { d } = deps({
      ambiente: { ...AMBIENTE_LIGADO, WEB_APP_URL: undefined, AMAZON_LWA_CLIENT_SECRET: '' },
    });
    const err = await falha(iniciarConexaoAmazon(asDb(db), ID, d));
    expect(err).toBeInstanceOf(ConfigAmazonAusenteError);
    expect((err as ConfigAmazonAusenteError).chaves).toEqual([
      'AMAZON_LWA_CLIENT_SECRET',
      'WEB_APP_URL',
    ]);
    expect((err as Error).message).not.toContain(STATE_SECRET);
    expect(db.operacoes).toBe(0);
  });

  it.each([
    [
      'a client secret with a trailing newline',
      { AMAZON_LWA_CLIENT_SECRET: `${CLIENT_SECRET}\n` },
      ['AMAZON_LWA_CLIENT_SECRET'],
    ],
    [
      'a client secret with a trailing space',
      { AMAZON_LWA_CLIENT_SECRET: `${CLIENT_SECRET} ` },
      ['AMAZON_LWA_CLIENT_SECRET'],
    ],
    [
      'a client id with an interior space',
      { AMAZON_LWA_CLIENT_ID: 'cli TESTE' },
      ['AMAZON_LWA_CLIENT_ID'],
    ],
    [
      'both halves non-ASCII',
      { AMAZON_LWA_CLIENT_ID: `${CLIENT_ID}é`, AMAZON_LWA_CLIENT_SECRET: `${CLIENT_SECRET}é` },
      ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET'],
    ],
  ])(
    'an LWA pair the exchange would refuse (%s) → refused HERE, naming the key, nothing read or written',
    async (_c, over, chaves) => {
      seedConta(db, ID);
      const err = await falha(
        iniciarConexaoAmazon(asDb(db), ID, deps({ ambiente: { ...AMBIENTE_LIGADO, ...over } }).d),
      );
      expect(err).toBeInstanceOf(ConfigAmazonAusenteError);
      expect((err as ConfigAmazonAusenteError).chaves).toEqual(chaves);
      expect((err as Error).message).not.toContain(CLIENT_SECRET);
      expect(estado.puts).toHaveLength(0);
      expect(db.operacoes).toBe(0);
    },
  );

  it('near-miss: a pair with interior VISIBLE punctuation is usable — the consent starts', async () => {
    seedConta(db, ID);
    const ambiente = {
      ...AMBIENTE_LIGADO,
      AMAZON_LWA_CLIENT_ID: 'cli|TESTE~id!{0}',
      AMAZON_LWA_CLIENT_SECRET: 'sec|TESTE~x!{1}#$%',
    };
    await expect(iniciarConexaoAmazon(asDb(db), ID, deps({ ambiente }).d)).resolves.toHaveProperty(
      'authorizeUrl',
    );
    expect(estado.puts).toHaveLength(1);
  });

  it('a missing conta → 404 class, nothing written', async () => {
    expect(await falha(iniciarConexaoAmazon(asDb(db), ID, deps().d))).toBeInstanceOf(
      ContaAmazonNaoEncontradaError,
    );
    expect(estado.puts).toHaveLength(0);
  });

  it('answers the consent URL with exactly application_id, state, version=beta and redirect_uri', async () => {
    seedConta(db, ID);
    const { authorizeUrl } = await iniciarConexaoAmazon(asDb(db), ID, deps().d);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(URL_CONSENTIMENTO_BR);
    expect([...url.searchParams.keys()]).toEqual([
      'application_id',
      'state',
      'version',
      'redirect_uri',
    ]);
    expect(url.searchParams.get('application_id')).toBe(APPLICATION_ID);
    expect(url.searchParams.get('version')).toBe('beta');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    // No client id or secret anywhere in it.
    expect(authorizeUrl).not.toContain(CLIENT_ID);
    expect(authorizeUrl).not.toContain(CLIENT_SECRET);
    expect(authorizeUrl).not.toContain(STATE_SECRET);
  });

  it('the state is signed for THIS conta, and its nonce is PERSISTED (no PKCE) before answering', async () => {
    seedConta(db, ID);
    const { authorizeUrl } = await iniciarConexaoAmazon(asDb(db), ID, deps().d);
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const { id, nonce } = verifyState(state, STATE_SECRET, AGORA_MS);
    expect(id).toBe(ID);
    expect(estado.puts).toEqual([[ID, nonce]]);
    expect(estado.registro(ID)).toMatchObject({ codeVerifier: null, criadoEm: AGORA_MS });
  });

  it('a PARKED conta and an INACTIVE conta can both start (this is how they get fixed)', async () => {
    seedConta(db, ID, { ativo: false });
    seedCredencial(db, ID, {
      reconexaoPendente: {
        desdeMs: 1,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
      },
    });
    await expect(iniciarConexaoAmazon(asDb(db), ID, deps().d)).resolves.toHaveProperty(
      'authorizeUrl',
    );
  });

  it.each([
    ['AMAZON_APPLICATION_ID', { AMAZON_APPLICATION_ID: 'com espaço' }],
    ['AMAZON_OAUTH_REDIRECT_URI', { AMAZON_OAUTH_REDIRECT_URI: 'http://localhost:3011/cb' }],
  ])('a value the package refuses → %s named, and NOTHING written', async (chave, over) => {
    seedConta(db, ID);
    const err = await falha(
      iniciarConexaoAmazon(asDb(db), ID, deps({ ambiente: { ...AMBIENTE_LIGADO, ...over } }).d),
    );
    expect(err).toBeInstanceOf(ConfigAmazonAusenteError);
    expect((err as ConfigAmazonAusenteError).chaves).toEqual([chave]);
    expect(estado.puts).toHaveLength(0);
    expect(db.escritas).toHaveLength(0);
  });

  it('never fetches: starting a consent does not call Amazon', async () => {
    seedConta(db, ID);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await iniciarConexaoAmazon(asDb(db), ID, deps().d);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

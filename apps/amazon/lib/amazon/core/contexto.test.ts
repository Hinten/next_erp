import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { AmazonAuthError, URL_TOKEN_LWA } from '@delfrance/integrations-amazon-sp-api';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { z } from 'zod';

import { avisarSegredoLwaRecusado, chaveSegredoRecusado } from '../avisos/avisos';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  ACCESS_TOKEN_NOVO,
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  AUTORIZADO_EM_MS,
  REFRESH_TOKEN_A,
  REFRESH_TOKEN_B,
  SPID_A,
  caminhoAviso,
  caminhoCredencial,
  erroLwa,
  espiaoDeFetch,
  loggerEspiao,
  refDe,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from '../testing/fixtures';
import { AGENTE_USUARIO_AMAZON } from './agente';
import { __setRelogioDoCacheParaTestes } from './contaCache';
import { MARGEM_RENOVACAO_ACESSO_MS, type ContextoAmazonDeps, loadAmazonContext } from './contexto';
import { removerCredencial, salvarConsentimento } from './credentialStore';
import {
  ChamadasAmazonDesligadasError,
  ConfigAmazonAusenteError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
} from './erros';
import { estacionarConta } from './estacionamento';

const ID = 'conta-1';
const CAMINHO = caminhoCredencial(ID);
const REF_ATUAL = refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS);
const CAMINHO_SP = '/sellers/v1/marketplaceParticipations';

let db: FakeDb;
let agora: number;

beforeEach(() => {
  __resetAllReadCaches();
  agora = AGORA_MS;
  __setRelogioDoCacheParaTestes(() => agora);
  db = new FakeDb();
});

afterEach(() => {
  __setRelogioDoCacheParaTestes();
  __resetAllReadCaches();
});

function deps(
  over: Partial<ContextoAmazonDeps> = {},
  responder?: Parameters<typeof espiaoDeFetch>[0],
) {
  const espiao = espiaoDeFetch(responder);
  const log = loggerEspiao();
  const d: ContextoAmazonDeps = {
    ambiente: AMBIENTE_LIGADO,
    agora: () => agora,
    logger: log.logger,
    fetch: espiao.fetch,
    ...over,
  };
  return { d, chamadas: espiao.chamadas, linhas: log.linhas };
}

function contaConectada(over: Parameters<typeof seedConta>[2] = {}) {
  seedConta(db, ID, { selling_partner_id: SPID_A, ...over });
}

const lwaChamadas = (c: { url: string }[]) => c.filter((x) => x.url === URL_TOKEN_LWA);

describe('loadAmazonContext — the refusal order', () => {
  it('1. switch off → refused with ZERO Firestore operations, zero fetches and one line', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d, chamadas, linhas } = deps({ ambiente: AMBIENTE_DESLIGADO });
    await expect(loadAmazonContext(asDb(db), ID, d)).rejects.toBeInstanceOf(
      ChamadasAmazonDesligadasError,
    );
    expect(db.operacoes).toBe(0);
    expect(chamadas).toHaveLength(0);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toMatchObject({ evento: 'chamada-bloqueada', rota: 'contexto' });
  });

  it('2. the LWA pair missing → ConfigAmazonAusenteError naming it, before any read', async () => {
    const { d } = deps({ ambiente: { ...AMBIENTE_LIGADO, AMAZON_LWA_CLIENT_SECRET: '' } });
    const err = await loadAmazonContext(asDb(db), ID, d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigAmazonAusenteError);
    expect((err as ConfigAmazonAusenteError).chaves).toEqual(['AMAZON_LWA_CLIENT_SECRET']);
    expect(db.operacoes).toBe(0);
  });

  it('2b. a flow does NOT need the connect-only keys', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d } = deps({
      ambiente: {
        AMAZON_CHAMADAS: 'on',
        AMAZON_LWA_CLIENT_ID: 'id',
        AMAZON_LWA_CLIENT_SECRET: 'segredo',
      },
    });
    await expect(loadAmazonContext(asDb(db), ID, d)).resolves.toMatchObject({ integracaoId: ID });
  });

  it('3. absent, or not an Amazon conta → ContaAmazonNaoEncontradaError', async () => {
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonNaoEncontradaError,
    );
    seedConta(db, ID, { tipo: INTEGRACAO_TIPO.shopee, selling_partner_id: SPID_A });
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonNaoEncontradaError,
    );
  });

  it('4. inactive wins over unconnected and parked — a deactivated conta never reads as "reconnect"', async () => {
    seedConta(db, ID, { ativo: false, selling_partner_id: null });
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: REF_ATUAL },
    });
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonInativaError,
    );
  });

  it('5. no seller id → ContaAmazonNaoConectadaError', async () => {
    seedConta(db, ID, { selling_partner_id: null });
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonNaoConectadaError,
    );
  });

  it('6. no / corrupt / parked credential → each its own class', async () => {
    contaConectada();
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      CredencialAmazonAusenteError,
    );
    seedCredencial(db, ID, { extra: 1 });
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      CredencialAmazonInvalidaError,
    );
    seedCredencial(db, ID, {
      reconexaoPendente: { desdeMs: 1, status: 400, codigoLwa: null, refCredencial: REF_ATUAL },
    });
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonParadaError,
    );
  });
});

describe('the conta cache, seen through the context', () => {
  it('an INACTIVE conta is never served from cache: reactivating it takes effect at once', async () => {
    contaConectada({ ativo: false });
    seedCredencial(db, ID);
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonInativaError,
    );
    contaConectada({ ativo: true });
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).resolves.toBeDefined();
  });

  it('a conta WITHOUT a seller id is never served from cache: a connect takes effect at once', async () => {
    seedConta(db, ID, { selling_partner_id: null });
    seedCredencial(db, ID);
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).rejects.toBeInstanceOf(
      ContaAmazonNaoConectadaError,
    );
    contaConectada();
    await expect(loadAmazonContext(asDb(db), ID, deps().d)).resolves.toBeDefined();
  });
});

describe('the access getter — the credential is re-read on EVERY request', () => {
  it('a fresh token with a matching acessoRef → returned, no LWA call', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d, chamadas } = deps();
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    expect(await ctx.obterAcesso()).toEqual({ accessToken: ACCESS_TOKEN_A, ref: REF_ATUAL });
    expect(chamadas).toHaveLength(0);
  });

  it('★ after a park, the next request throws with ZERO fetch calls (kills "credential read cached")', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d, chamadas } = deps({}, () => respostaJson(200, {}));
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    // A request SUCCEEDS first, so the park really lands MID-batch: a getter that
    // checked the park only on its first call, or kept the credential after its
    // first success, passes everything up to here.
    await ctx.cliente.get({ operacao: 'op', caminho: CAMINHO_SP, schema: z.unknown() });
    expect(chamadas).toHaveLength(1);
    // Another task parks the conta through the REAL tier-1 write.
    await expect(
      estacionarConta(
        asDb(db),
        ID,
        { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' },
        { agoraMs: () => agora },
      ),
    ).resolves.toMatchObject({ tipo: 'estacionado' });
    await expect(
      ctx.cliente.get({ operacao: 'op', caminho: CAMINHO_SP, schema: z.unknown() }),
    ).rejects.toBeInstanceOf(ContaAmazonParadaError);
    await expect(ctx.obterAcesso({ forcarRenovacao: true })).rejects.toBeInstanceOf(
      ContaAmazonParadaError,
    );
    // Not one more request — neither to SP-API nor to LWA.
    expect(chamadas).toHaveLength(1);
  });

  it('a consent saved mid-batch is picked up at the next request (new ref, new token)', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d, chamadas } = deps();
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    expect((await ctx.obterAcesso()).accessToken).toBe(ACCESS_TOKEN_A);
    const novaRef = refDe(REFRESH_TOKEN_B, agora);
    await salvarConsentimento(asDb(db), ID, {
      access_token: ACCESS_TOKEN_B,
      refresh_token: REFRESH_TOKEN_B,
      expirationDate: agora + 3_600_000,
      autorizadoEmMs: agora,
      acessoRef: novaRef,
    });
    expect(await ctx.obterAcesso()).toEqual({ accessToken: ACCESS_TOKEN_B, ref: novaRef });
    expect(chamadas).toHaveLength(0);
  });

  it('the client sends the CURRENT token in x-amz-access-token, with our user-agent', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d, chamadas } = deps({}, () => respostaJson(200, { payload: [] }));
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    const r = await ctx.cliente.get({ operacao: 'op', caminho: CAMINHO_SP, schema: z.unknown() });
    expect(r.refCredencial).toBe(REF_ATUAL);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.cabecalhos.get('x-amz-access-token')).toBe(ACCESS_TOKEN_A);
    expect(chamadas[0]?.cabecalhos.get('user-agent')).toBe(AGENTE_USUARIO_AMAZON);
  });

  it(`${String(MARGEM_RENOVACAO_ACESSO_MS / 1000)} s before expiry → ONE refresh, persisted as a 3-key patch`, async () => {
    contaConectada();
    seedCredencial(db, ID, { expirationDate: agora + MARGEM_RENOVACAO_ACESSO_MS });
    const { d, chamadas } = deps({}, () => tokenDeAcesso(ACCESS_TOKEN_NOVO, 3600));
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    expect(await ctx.obterAcesso()).toEqual({ accessToken: ACCESS_TOKEN_NOVO, ref: REF_ATUAL });
    expect(lwaChamadas(chamadas)).toHaveLength(1);
    const form = chamadas[0]?.formulario;
    expect(form?.get('grant_type')).toBe('refresh_token');
    expect(form?.get('refresh_token')).toBe(REFRESH_TOKEN_A);
    const escritas = db.escritasEm(CAMINHO);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.verbo).toBe('update');
    expect(escritas[0]?.dados).toEqual({
      access_token: ACCESS_TOKEN_NOVO,
      expirationDate: agora + 3_600_000,
      acessoRef: REF_ATUAL,
    });
    // The persisted token is served next, with no second exchange.
    expect((await ctx.obterAcesso()).accessToken).toBe(ACCESS_TOKEN_NOVO);
    expect(lwaChamadas(chamadas)).toHaveLength(1);
  });

  it('near-miss: one millisecond more than the margin → no refresh', async () => {
    contaConectada();
    seedCredencial(db, ID, { expirationDate: agora + MARGEM_RENOVACAO_ACESSO_MS + 1 });
    const { d, chamadas } = deps();
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    expect((await ctx.obterAcesso()).accessToken).toBe(ACCESS_TOKEN_A);
    expect(chamadas).toHaveLength(0);
  });

  it('an acessoRef of another grant → refresh (a stale-ref token is never served)', async () => {
    contaConectada();
    seedCredencial(db, ID, { acessoRef: refDe(REFRESH_TOKEN_B, AUTORIZADO_EM_MS) });
    const { d, chamadas } = deps({}, () => tokenDeAcesso());
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    expect((await ctx.obterAcesso()).accessToken).toBe(ACCESS_TOKEN_NOVO);
    expect(lwaChamadas(chamadas)).toHaveLength(1);
  });

  it('forcarRenovacao → refresh even when the stored token is fresh', async () => {
    contaConectada();
    seedCredencial(db, ID);
    const { d, chamadas } = deps({}, () => tokenDeAcesso());
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    expect((await ctx.obterAcesso({ forcarRenovacao: true })).accessToken).toBe(ACCESS_TOKEN_NOVO);
    expect(lwaChamadas(chamadas)).toHaveLength(1);
  });

  it('the credential removed DURING a refresh → CredencialAmazonAusenteError, nothing recreated', async () => {
    contaConectada();
    seedCredencial(db, ID, { expirationDate: agora });
    const { d } = deps({}, async () => {
      await removerCredencial(asDb(db), ID);
      return tokenDeAcesso();
    });
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    await expect(ctx.obterAcesso()).rejects.toBeInstanceOf(CredencialAmazonAusenteError);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('an LWA refusal is rethrown AS-IS — the context parks nothing', async () => {
    contaConectada();
    seedCredencial(db, ID, { expirationDate: agora });
    const { d } = deps({}, () => erroLwa(400, 'invalid_grant'));
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    const err = await ctx.obterAcesso().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmazonAuthError);
    expect((err as AmazonAuthError).refCredencial).toBe(REF_ATUAL);
    expect(db.escritasEm(CAMINHO)).toHaveLength(0);
  });

  it('an accepted refresh resolves a standing amazonSegredoLwaRecusado', async () => {
    contaConectada();
    seedCredencial(db, ID, { expirationDate: agora });
    await avisarSegredoLwaRecusado(
      asDb(db),
      { codigoLwa: 'invalid_client' },
      { increment, nowMs: agora },
    );
    const { d } = deps({}, () => tokenDeAcesso());
    const ctx = await loadAmazonContext(asDb(db), ID, d);
    await ctx.obterAcesso();
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))?.resolucaoMotivo).toBe('troca-aceita');
  });
});

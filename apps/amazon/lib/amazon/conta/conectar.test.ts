/**
 * The callback's fifteen steps, offline: the REAL state signing, seller guard,
 * credential store, avisos and package exchange, against the fake db, the fake
 * attempt store and a fetch spy. Nothing reaches Amazon (D11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { AmazonConfigError, URL_TOKEN_LWA } from '@delfrance/integrations-amazon-sp-api';
import { INTEGRACAO_TIPO, TIPO_AVISO } from '@delfrance/schemas';

import {
  avisarReautorizacao,
  avisarReconexaoPendente,
  avisarSegredoLwaRecusado,
  chaveReautorizacao,
  chaveReconexao,
  chaveSegredoRecusado,
} from '../avisos/avisos';
import { lerContaEmCache } from '../core/contaCache';
import { fingerprintDoRefreshToken } from '../core/refCredencial';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { type FakeOauthState, criarFakeOauthState } from '../testing/fakeOauthState';
import {
  ACCESS_TOKEN_B,
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  AUTORIZADO_EM_MS,
  CODIGO,
  DIA_MS,
  REDIRECT_URI,
  REFRESH_TOKEN_A,
  REFRESH_TOKEN_B,
  SEGREDOS,
  SPID_A,
  SPID_B,
  WEB_APP_URL,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  erroLwa,
  espiaoDeFetch,
  loggerEspiao,
  nuncaResponde,
  refDe,
  respostaJson,
  seedConta,
  seedCredencial,
  textoDe,
  tokensDeAutorizacao,
} from '../testing/fixtures';
import {
  type CallbackDeps,
  type RetornoCallback,
  motivoDaFalhaDeTroca,
  tratarCallbackAmazon,
} from './conectar';
import { iniciarConexaoAmazon } from './iniciar';

const ID = 'conta-1';
const OUTRA = 'conta-2';
const CRED = caminhoCredencial(ID);
const CONTA = caminhoConta(ID);

let db: FakeDb;
let estado: FakeOauthState;
let agora: number;

beforeEach(() => {
  __resetAllReadCaches();
  db = new FakeDb();
  estado = criarFakeOauthState();
  agora = AGORA_MS;
});

afterEach(() => {
  vi.useRealTimers();
});

function montar(
  responder: Parameters<typeof espiaoDeFetch>[0] = () => tokensDeAutorizacao(),
  over: Partial<CallbackDeps> = {},
) {
  const espiao = espiaoDeFetch(responder);
  const log = loggerEspiao();
  const deps: CallbackDeps = {
    db: asDb(db),
    ambiente: AMBIENTE_LIGADO,
    agora: () => agora,
    estado,
    logger: log.logger,
    increment,
    fetch: espiao.fetch,
    ...over,
  };
  return { deps, chamadas: espiao.chamadas, linhas: log.linhas };
}

/** Start a real attempt: the signed state and its persisted record. */
async function iniciar(id = ID): Promise<{ state: string; authorizeUrl: string }> {
  const { authorizeUrl } = await iniciarConexaoAmazon(asDb(db), id, {
    ambiente: AMBIENTE_LIGADO,
    agoraMs: agora,
    estado,
    logger: loggerEspiao().logger,
  });
  return { state: new URL(authorizeUrl).searchParams.get('state') ?? '', authorizeUrl };
}

function query(state: string | null, over: Record<string, string | null> = {}): URLSearchParams {
  const base: Record<string, string | null> = {
    state,
    selling_partner_id: SPID_A,
    spapi_oauth_code: CODIGO,
    ...over,
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== null) p.set(k, v);
  return p;
}

function naConta(reason: string | null, id = ID): RetornoCallback {
  return {
    tipo: 'redirecionar',
    webBase: WEB_APP_URL,
    caminho: `/canais/amazon/${id}`,
    retorno:
      reason === null ? { amazon: 'connected' } : { amazon: 'error', reason: reason as never },
  };
}

function naLista(reason: string): RetornoCallback {
  return {
    tipo: 'redirecionar',
    webBase: WEB_APP_URL,
    caminho: '/canais/amazon',
    retorno: { amazon: 'error', reason: reason as never },
  };
}

const CONECTADO = naConta(null);
const lwa = <C extends { url: string }>(c: C[]) => c.filter((x) => x.url === URL_TOKEN_LWA);

/* -------------------------------------------------------------------------- */

describe('the happy path', () => {
  it('connects: one exchange, the seller written, the consent stored, the cache invalidated', async () => {
    seedConta(db, ID, { nome: 'Conta Um' });
    const { state } = await iniciar();
    agora += 1_000;
    const { deps, chamadas } = montar();
    expect(await tratarCallbackAmazon(query(state), deps)).toEqual(CONECTADO);

    expect(lwa(chamadas)).toHaveLength(1);
    expect(db.ler(CONTA)?.selling_partner_id).toBe(SPID_A);
    const cred = db.ler(CRED);
    expect(cred).toEqual({
      access_token: ACCESS_TOKEN_B,
      refresh_token: REFRESH_TOKEN_B,
      expirationDate: agora + 3_600_000,
      autorizadoEmMs: agora,
      acessoRef: `${fingerprintDoRefreshToken(REFRESH_TOKEN_B)}.${String(agora)}`,
      reconexaoPendente: null,
    });
    // Order: the seller (the guard's commit point) BEFORE the credential.
    const ordem = db.escritas.map((e) => e.caminho).filter((c) => c === CONTA || c === CRED);
    expect(ordem).toEqual([CONTA, CRED]);
  });

  it('sends the IDENTICAL redirect_uri the consent URL carried, byte for byte', async () => {
    seedConta(db, ID);
    const { state, authorizeUrl } = await iniciar();
    const { deps, chamadas } = montar();
    await tratarCallbackAmazon(query(state), deps);
    const enviado = lwa(chamadas)[0]?.formulario.get('redirect_uri');
    expect(enviado).toBe(new URL(authorizeUrl).searchParams.get('redirect_uri'));
    expect(enviado).toBe(REDIRECT_URI);
    expect(lwa(chamadas)[0]?.formulario.get('code')).toBe(CODIGO);
  });

  it('resolves the reconexão (clocked by the consent write), the reauthorization and the secret avisos', async () => {
    seedConta(db, ID, { nome: 'Conta Um' });
    await avisarReconexaoPendente(
      asDb(db),
      {
        integracaoId: ID,
        lojaNome: 'Conta Um',
        status: 400,
        codigoLwa: 'invalid_grant',
        relogioUs: 1,
      },
      { increment, nowMs: agora },
    );
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Conta Um', autorizadoEmMs: agora - 360 * DIA_MS },
      { increment, nowMs: agora },
    );
    await avisarSegredoLwaRecusado(
      asDb(db),
      { codigoLwa: 'invalid_client' },
      { increment, nowMs: agora },
    );
    const { state } = await iniciar();
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);

    const credEscrita = db.escritasEm(CRED)[0];
    const reconexao = db.ler(caminhoAviso(chaveReconexao(ID)));
    expect(reconexao?.resolucaoMotivo).toBe('consentimento');
    expect(reconexao?.relogioEvento).toBe(
      (credEscrita?.writeTime.seconds ?? 0) * 1_000_000 +
        Math.floor((credEscrita?.writeTime.nanoseconds ?? 0) / 1000),
    );
    expect(db.ler(caminhoAviso(chaveReautorizacao(ID)))?.resolucaoMotivo).toBe('consentimento');
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))?.resolucaoMotivo).toBe('troca-aceita');
  });

  it('a migrated/reauthorized conta with the SAME seller → connected, and the seller write is SKIPPED', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID);
    const { state } = await iniciar();
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
    expect(db.escritasEm(CONTA)).toHaveLength(0);
    expect(db.ler(CRED)?.refresh_token).toBe(REFRESH_TOKEN_B);
  });
});

describe('★ state replay refused', () => {
  it('the second callback with the same state → LIST bad_state, ZERO fetches and nothing written', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
    const escritasAntes = db.escritas.length;

    const replay = montar();
    expect(await tratarCallbackAmazon(query(state), replay.deps)).toEqual(naLista('bad_state'));
    expect(replay.chamadas).toHaveLength(0);
    expect(db.escritas).toHaveLength(escritasAntes);
  });

  it('a superseded attempt (a newer start) → bad_state, nothing fetched', async () => {
    seedConta(db, ID);
    const { state: velho } = await iniciar();
    await iniciar();
    const r = montar();
    expect(await tratarCallbackAmazon(query(velho), r.deps)).toEqual(naLista('bad_state'));
    expect(r.chamadas).toHaveLength(0);
  });

  it('an expired attempt (over 10 minutes) → bad_state', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    agora += 10 * 60 * 1000 + 1;
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(naLista('bad_state'));
  });

  it.each([
    ['absent', null],
    ['empty', ''],
    ['tampered', 'eyJpZCI6ImMxIn0.assinatura-forjada'],
    ['garbage', 'nao-e-um-state'],
  ])('a state %s → LIST bad_state, nothing read, nothing consumed', async (_c, state) => {
    seedConta(db, ID);
    const r = montar();
    expect(await tratarCallbackAmazon(query(state), r.deps)).toEqual(naLista('bad_state'));
    expect(estado.consumos).toHaveLength(0);
    expect(db.operacoes).toBe(0);
    expect(r.chamadas).toHaveLength(0);
  });
});

describe('consume placement — a refusal BEFORE consume never burns the attempt', () => {
  it('no code (a cancelled consent) → missing_params; then the same state WITH a code → connected', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    expect(
      await tratarCallbackAmazon(query(state, { spapi_oauth_code: null }), montar().deps),
    ).toEqual(naConta('missing_params'));
    expect(estado.consumos).toHaveLength(0);
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
  });

  it.each([
    ['an interior space', 'cod ruim'],
    ['a trailing newline', `${CODIGO}\n`],
    ['non-ASCII', `${CODIGO}é`],
    ['empty', ''],
  ])(
    'a code the exchange would refuse unsent (%s) → missing_params, NO consume, zero fetches; then a valid code → connected',
    async (_c, codigo) => {
      seedConta(db, ID);
      const { state } = await iniciar();
      const r = montar();
      expect(
        await tratarCallbackAmazon(query(state, { spapi_oauth_code: codigo }), r.deps),
      ).toEqual(naConta('missing_params'));
      expect(estado.consumos).toHaveLength(0);
      expect(r.chamadas).toHaveLength(0);
      expect(db.escritas).toHaveLength(0);
      expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
    },
  );

  it.each([
    ['empty', ''],
    ['with a leading space', ` ${SPID_A}`],
    ['with a trailing newline', `${SPID_A}\n`],
    ['too long', 'A'.repeat(65)],
    ['non-ASCII', 'AXXXXXXXXXXXXÉ'],
  ])(
    'an invalid seller id (%s) → vendedor_invalido; then a valid one → connected',
    async (_c, spid) => {
      seedConta(db, ID);
      const { state } = await iniciar();
      const r = montar();
      expect(
        await tratarCallbackAmazon(query(state, { selling_partner_id: spid }), r.deps),
      ).toEqual(naConta('vendedor_invalido'));
      expect(estado.consumos).toHaveLength(0);
      expect(r.chamadas).toHaveLength(0);
      expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
    },
  );

  it('no seller id at all → vendedor_invalido, nothing consumed', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    expect(
      await tratarCallbackAmazon(query(state, { selling_partner_id: null }), montar().deps),
    ).toEqual(naConta('vendedor_invalido'));
    expect(estado.consumos).toHaveLength(0);
  });

  it('a wrong seller → refused; then the right one → connected', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    const { state } = await iniciar();
    expect(
      await tratarCallbackAmazon(query(state, { selling_partner_id: SPID_B }), montar().deps),
    ).toEqual(naConta('vendedor_diferente'));
    expect(estado.consumos).toHaveLength(0);
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
  });

  it('the switch off → integracao_desligada with NO consume and NO fetch; switched on, the same state connects', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    const off = montar(undefined, { ambiente: AMBIENTE_DESLIGADO });
    expect(await tratarCallbackAmazon(query(state), off.deps)).toEqual(
      naConta('integracao_desligada'),
    );
    expect(estado.consumos).toHaveLength(0);
    expect(off.chamadas).toHaveLength(0);
    expect(off.linhas.map((l) => l.meta?.evento)).toEqual(['chamada-bloqueada']);
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
  });
});

describe('★ wrong seller refused', () => {
  it('a conta bound to AXXXXXXXXXXXXX and a callback for AYYYYYYYYYYYYY → vendedor_diferente, no consume, zero fetches', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    const { state } = await iniciar();
    const r = montar();
    expect(
      await tratarCallbackAmazon(query(state, { selling_partner_id: SPID_B }), r.deps),
    ).toEqual(naConta('vendedor_diferente'));
    expect(estado.consumos).toHaveLength(0);
    expect(r.chamadas).toHaveLength(0);
    expect(db.escritas).toHaveLength(0);
    // One WARNING line: the conta id and the decision — never either seller id.
    expect(r.linhas).toEqual([
      expect.objectContaining({
        nivel: 'warn',
        meta: { integracaoId: ID, decisao: 'vendedor-diferente' },
      }),
    ]);
    expect(textoDe(r.linhas)).not.toContain(SPID_A);
    expect(textoDe(r.linhas)).not.toContain(SPID_B);
  });

  it('near-miss: the same id in another CASE is still refused (exact compare)', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    const { state } = await iniciar();
    expect(
      await tratarCallbackAmazon(
        query(state, { selling_partner_id: SPID_A.toLowerCase() }),
        montar().deps,
      ),
    ).toEqual(naConta('vendedor_diferente'));
  });

  it('another ACTIVE Amazon conta holding the seller → vendedor_em_outra_conta', async () => {
    seedConta(db, ID);
    seedConta(db, OUTRA, { selling_partner_id: SPID_A });
    const { state } = await iniciar();
    const r = montar();
    expect(await tratarCallbackAmazon(query(state), r.deps)).toEqual(
      naConta('vendedor_em_outra_conta'),
    );
    expect(estado.consumos).toHaveLength(0);
    expect(r.chamadas).toHaveLength(0);
  });

  it('near-miss: an INACTIVE holder does not block (the routing shape; the residual is documented)', async () => {
    seedConta(db, ID);
    seedConta(db, OUTRA, { selling_partner_id: SPID_A, ativo: false });
    const { state } = await iniciar();
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
  });

  it('a holder of another TIPO does not block', async () => {
    seedConta(db, ID);
    seedConta(db, OUTRA, { selling_partner_id: SPID_A, tipo: INTEGRACAO_TIPO.shopee });
    const { state } = await iniciar();
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
  });

  it('a conta gone before the callback → conta, nothing consumed', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    db.apagar(CONTA);
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(naConta('conta'));
    expect(estado.consumos).toHaveLength(0);
  });
});

describe('write ordering', () => {
  it('an operator edits `nome` between the guard and the write → attempt 2 succeeds', async () => {
    seedConta(db, ID, { nome: 'Antes' });
    const { state } = await iniciar();
    db.antesDaProximaEscrita(CONTA, () => {
      seedConta(db, ID, { nome: 'Depois' });
    });
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
    expect(db.ler(CONTA)).toMatchObject({ nome: 'Depois', selling_partner_id: SPID_A });
  });

  it('3 lost preconditions → conflito, with NO credential written', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    let restantes = 3;
    const editar = (): void => {
      restantes -= 1;
      seedConta(db, ID, { nome: `Edição ${String(restantes)}` });
      if (restantes > 0) db.antesDaProximaEscrita(CONTA, editar);
    };
    db.antesDaProximaEscrita(CONTA, editar);
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(naConta('conflito'));
    expect(db.ler(CRED)).toBeUndefined();
  });

  it('the conta deleted between the exchange and the seller write → conta, no credential', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    const { deps } = montar(() => {
      db.apagar(CONTA);
      return tokensDeAutorizacao();
    });
    expect(await tratarCallbackAmazon(query(state), deps)).toEqual(naConta('conta'));
    expect(db.ler(CRED)).toBeUndefined();
    expect(db.ler(CONTA)).toBeUndefined();
  });

  it('the conta deleted while the credential lands → the credential is REMOVED, conta', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    db.antesDaProximaEscrita(CRED, () => {
      db.apagar(CONTA);
    });
    const r = montar();
    expect(await tratarCallbackAmazon(query(state), r.deps)).toEqual(naConta('conta'));
    expect(db.ler(CRED)).toBeUndefined();
    expect(db.escritasEm(CRED).map((e) => e.verbo)).toEqual(['set', 'delete']);
  });

  it('the step-12 re-read is UNCACHED: a warm cached copy cannot hide a conta deleted while the credential lands', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID);
    // Warm THIS instance's conta cache with a copy `isFresh` accepts (active and
    // connected) — exactly what a reconnect of a live conta finds.
    expect(await lerContaEmCache(asDb(db), ID)).toMatchObject({ selling_partner_id: SPID_A });
    const { state } = await iniciar();
    db.antesDaProximaEscrita(CRED, () => {
      db.apagar(CONTA);
    });
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(naConta('conta'));
    // Read through the cache, the deleted conta would look alive and the credential
    // would stay orphaned under it — the delete cascade never walks it again.
    expect(db.ler(CRED)).toBeUndefined();
  });

  it('a conta turned into ANOTHER tipo while the credential lands → removed too', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    db.antesDaProximaEscrita(CRED, () => {
      seedConta(db, ID, { tipo: INTEGRACAO_TIPO.shopee, selling_partner_id: SPID_A });
    });
    expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(naConta('conta'));
    expect(db.ler(CRED)).toBeUndefined();
  });
});

describe('the exchange', () => {
  it('is called EXACTLY once, and the consume precedes it', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    const r = montar(() => {
      expect(estado.consumos).toHaveLength(1);
      return tokensDeAutorizacao();
    });
    await tratarCallbackAmazon(query(state), r.deps);
    expect(r.chamadas).toHaveLength(1);
  });

  it('a timeout → tempo_esgotado and NO second call (the code may be spent)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    seedConta(db, ID);
    const { state } = await iniciar();
    const r = montar(nuncaResponde);
    const p = tratarCallbackAmazon(query(state), r.deps);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toEqual(naConta('tempo_esgotado'));
    expect(r.chamadas).toHaveLength(1);
    expect(db.ler(CRED)).toBeUndefined();
    expect(db.ler(CONTA)?.selling_partner_id).toBeNull();
  });

  it.each([
    ['invalid_grant (an expired or used code)', 400, 'invalid_grant', 'codigo_invalido'],
    ['a 401 with no code', 401, null, 'codigo_invalido'],
    ['invalid_client', 401, 'invalid_client', 'server_config'],
    ['unauthorized_client', 400, 'unauthorized_client', 'server_config'],
    ['a 429', 429, null, 'amazon_indisponivel'],
    ['a 503', 503, null, 'amazon_indisponivel'],
    ['an invalid_request 400', 400, 'invalid_request', 'exchange'],
    ['a 404', 404, null, 'exchange'],
  ])('%s → %s', async (_c, status, error, motivo) => {
    seedConta(db, ID);
    seedCredencial(db, ID);
    const { state } = await iniciar();
    const r = montar(() =>
      error === null ? new Response('', { status }) : erroLwa(status, error),
    );
    expect(await tratarCallbackAmazon(query(state), r.deps)).toEqual(naConta(motivo));
    expect(r.chamadas).toHaveLength(1);
    // Nothing written on a failed exchange — the stored credential is never parked here.
    expect(db.escritasEm(CRED)).toHaveLength(0);
    expect(db.escritasEm(CONTA)).toHaveLength(0);
  });

  it('invalid_client → server_config AND the secret aviso raised (never a park)', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    await tratarCallbackAmazon(query(state), montar(() => erroLwa(401, 'invalid_client')).deps);
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))).toMatchObject({
      tipo: TIPO_AVISO.amazonSegredoLwaRecusado,
      motivo: 'invalid_client',
      resolvidoEm: null,
    });
  });

  it('invalid_grant → codigo_invalido with NO park and no aviso', async () => {
    seedConta(db, ID, { selling_partner_id: SPID_A });
    seedCredencial(db, ID);
    const { state } = await iniciar();
    await tratarCallbackAmazon(query(state), montar(() => erroLwa(400, 'invalid_grant')).deps);
    expect(db.ler(CRED)?.reconexaoPendente).toBeNull();
    expect(db.caminhos().filter((c) => c.startsWith('avisos/'))).toEqual([]);
  });

  it.each([
    [
      'a 200 that is not JSON',
      () => new Response('<html>proxy</html>', { status: 200 }),
      'resposta_invalida',
    ],
    [
      'a 200 without refresh_token',
      () => respostaJson(200, { access_token: 'x', token_type: 'bearer', expires_in: 3600 }),
      'resposta_invalida',
    ],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed')), 'rede'],
  ] as const)('%s → %s', async (_c, responder, motivo) => {
    seedConta(db, ID);
    const { state } = await iniciar();
    expect(await tratarCallbackAmazon(query(state), montar(responder).deps)).toEqual(
      naConta(motivo),
    );
  });

  it.each([
    ['an interior space', 'segredo com espaço'],
    ['a trailing newline (a Secret Manager paste)', 'sec-TESTE-x\n'],
  ])(
    'a client secret with %s that changed AFTER the start → LIST config, NOTHING consumed, zero fetches; fixed, the same state connects',
    async (_c, segredo) => {
      seedConta(db, ID);
      const { state } = await iniciar();
      const r = montar(undefined, {
        ambiente: { ...AMBIENTE_LIGADO, AMAZON_LWA_CLIENT_SECRET: segredo },
      });
      expect(await tratarCallbackAmazon(query(state), r.deps)).toEqual(naLista('config'));
      expect(estado.consumos).toHaveLength(0);
      expect(r.chamadas).toHaveLength(0);
      expect(r.linhas[0]?.meta).toEqual({ invalidas: ['AMAZON_LWA_CLIENT_SECRET'] });
      expect(textoDe(r.linhas)).not.toContain(segredo);
      // The attempt was not burned.
      expect(await tratarCallbackAmazon(query(state), montar().deps)).toEqual(CONECTADO);
    },
  );

  it('the package refusing OUR input at exchange time still maps to server_config', () => {
    expect(
      motivoDaFalhaDeTroca(
        new AmazonConfigError('redirect-uri', {
          operacao: 'trocarCodigoAutorizacao',
          refCredencial: null,
        }),
      ),
    ).toBe('server_config');
  });

  it('a non-Amazon failure is RETHROWN (rule 6), never mapped to a slug', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    const r = montar(() => Promise.reject(new RangeError('bug')));
    await expect(tratarCallbackAmazon(query(state), r.deps)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('config', () => {
  it('WEB_APP_URL unset → sem-web (a plain 500 upstream), nothing read', async () => {
    const r = montar(undefined, { ambiente: { ...AMBIENTE_LIGADO, WEB_APP_URL: undefined } });
    expect(await tratarCallbackAmazon(query('x'), r.deps)).toEqual({ tipo: 'sem-web' });
    expect(db.operacoes).toBe(0);
  });

  it('another key unset → LIST config, naming keys and never values', async () => {
    const r = montar(undefined, {
      ambiente: { ...AMBIENTE_LIGADO, AMAZON_OAUTH_STATE_SECRET: '' },
    });
    expect(await tratarCallbackAmazon(query('x'), r.deps)).toEqual(naLista('config'));
    expect(r.linhas[0]?.meta).toEqual({ faltando: ['AMAZON_OAUTH_STATE_SECRET'] });
    expect(db.operacoes).toBe(0);
  });
});

describe('avisos after the consent are best effort', () => {
  it('a TRANSIENT gRPC failure is logged and the conta still connects', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), grpc(14, 'UNAVAILABLE'));
    const r = montar();
    expect(await tratarCallbackAmazon(query(state), r.deps)).toEqual(CONECTADO);
    expect(r.linhas.some((l) => l.meta?.passo === 'reconexao' && l.meta.code === 14)).toBe(true);
  });

  it('a NON-transient failure rethrows (loud)', async () => {
    seedConta(db, ID);
    const { state } = await iniciar();
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), grpc(7, 'PERMISSION_DENIED'));
    await expect(tratarCallbackAmazon(query(state), montar().deps)).rejects.toMatchObject({
      code: 7,
    });
  });
});

describe('hygiene', () => {
  it('no code, token, secret, state, seller id or ref in ANY log line or outcome, across every family', async () => {
    seedConta(db, ID);
    seedConta(db, OUTRA, { selling_partner_id: SPID_B });
    seedCredencial(db, ID);
    const linhas: unknown[] = [];
    const retornos: unknown[] = [];
    const proibidos: string[] = [
      ...SEGREDOS,
      SPID_A,
      SPID_B,
      refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS),
      refDe(REFRESH_TOKEN_B, agora),
      fingerprintDoRefreshToken(REFRESH_TOKEN_B),
    ];

    const cenarios: [Record<string, string | null>, Parameters<typeof espiaoDeFetch>[0]][] = [
      [{}, () => tokensDeAutorizacao()],
      [{}, () => erroLwa(401, 'invalid_client')],
      [{}, () => erroLwa(400, 'invalid_grant')],
      [{ selling_partner_id: SPID_B }, () => tokensDeAutorizacao()],
      [{ spapi_oauth_code: null }, () => tokensDeAutorizacao()],
    ];
    for (const [over, responder] of cenarios) {
      const { state } = await iniciar();
      proibidos.push(state);
      const r = montar(responder);
      retornos.push(await tratarCallbackAmazon(query(state, over), r.deps));
      // A replay too.
      retornos.push(await tratarCallbackAmazon(query(state, over), r.deps));
      linhas.push(...r.linhas);
    }
    const texto = textoDe([linhas, retornos]);
    for (const p of proibidos) expect(texto, p).not.toContain(p);
  });
});

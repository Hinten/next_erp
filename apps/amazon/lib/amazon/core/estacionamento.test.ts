import { beforeEach, describe, expect, it } from 'vitest';
import {
  AmazonAuthError,
  type CodigoErroLwa,
  type ContextoRequisicaoAmazon,
  type DestinoAmazon,
  trocarCodigoAutorizacao,
  trocarRefreshToken,
} from '@delfrance/integrations-amazon-sp-api';

import { chaveReconexao, chaveSegredoRecusado, relogioDoDocumentoUs } from '../avisos/avisos';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  ACCESS_TOKEN_NOVO,
  AGORA_MS,
  AUTORIZADO_EM_MS,
  CLIENT_ID,
  CLIENT_SECRET,
  CODIGO,
  REDIRECT_URI,
  REFRESH_TOKEN_A,
  REFRESH_TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  erroLwa,
  espiaoDeFetch,
  loggerEspiao,
  refDe,
  seedCredencial,
  textoDe,
} from '../testing/fixtures';
import { AGENTE_USUARIO_AMAZON } from './agente';
import { persistirAcesso, removerCredencial, salvarConsentimento } from './credentialStore';
import { EstacionamentoAmazonEmConflitoError } from './erros';
import {
  MAX_TENTATIVAS_ESTACIONAMENTO,
  OPERACAO_TROCA_CODIGO,
  OPERACAO_TROCA_REFRESH,
  classificarFalhaAmazon,
  decidirEstacionamento,
  estacionarConta,
  tratarFalhaDeAutenticacao,
} from './estacionamento';
import { REF_CONSENTIMENTO } from './refCredencial';

const ID = 'conta-1';
const CAMINHO = caminhoCredencial(ID);
/** The ref of the default fixture credential — the CURRENT grant. */
const REF_ATUAL = refDe(REFRESH_TOKEN_A, AUTORIZADO_EM_MS);
/** A ref of a grant a consent has since replaced. */
const REF_ANTIGA = refDe(REFRESH_TOKEN_B, AUTORIZADO_EM_MS - 1);

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

function authError(
  destino: DestinoAmazon,
  operacao: string,
  status: number,
  codigoLwa: CodigoErroLwa | null,
  refCredencial = REF_ATUAL,
): AmazonAuthError {
  const ctx: ContextoRequisicaoAmazon = {
    destino,
    operacao,
    metodo: destino === 'lwa' ? 'POST' : 'GET',
    caminho: destino === 'lwa' ? '/auth/o2/token' : '/orders/v0/orders',
    correlationId: 'corr',
    requestIdAmazon: null,
    refCredencial,
  };
  return new AmazonAuthError({ ...ctx, status, codigoLwa });
}

/** A REAL `AmazonAuthError`, raised by the package's refresh exchange against a fetch spy. */
async function recusaReal(
  ref: string,
  resposta: Response,
  refreshToken = REFRESH_TOKEN_A,
): Promise<AmazonAuthError> {
  const { fetch } = espiaoDeFetch(() => resposta);
  try {
    await trocarRefreshToken({
      aplicacao: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      ref,
      refreshToken,
      userAgent: AGENTE_USUARIO_AMAZON,
      fetch,
    });
  } catch (err) {
    if (err instanceof AmazonAuthError) return err;
    throw err;
  }
  throw new Error('esperava AmazonAuthError');
}

describe('classificarFalhaAmazon — the table, row by row', () => {
  it.each([
    ['lwa', OPERACAO_TROCA_REFRESH, 400, 'invalid_grant', 'estacionar'],
    ['lwa', OPERACAO_TROCA_REFRESH, 401, null, 'estacionar'],
    ['lwa', OPERACAO_TROCA_REFRESH, 403, null, 'estacionar'],
    ['lwa', OPERACAO_TROCA_REFRESH, 401, 'invalid_client', 'segredo-recusado'],
    ['lwa', OPERACAO_TROCA_REFRESH, 400, 'unauthorized_client', 'segredo-recusado'],
    ['lwa', OPERACAO_TROCA_CODIGO, 401, 'invalid_client', 'segredo-recusado'],
    ['lwa', OPERACAO_TROCA_CODIGO, 400, 'invalid_grant', 'nenhuma'],
    ['lwa', OPERACAO_TROCA_CODIGO, 401, null, 'nenhuma'],
    ['sp-api', 'getOrders', 401, null, 'renovar-acesso'],
    ['sp-api', 'getOrders', 403, null, 'renovar-acesso'],
    // Near-misses of the park rows: a 401/403 WITH a non-credential code, and
    // a refresh refusal with some other code.
    ['lwa', OPERACAO_TROCA_REFRESH, 401, 'outro', 'nenhuma'],
    ['lwa', OPERACAO_TROCA_REFRESH, 403, 'access_denied', 'nenhuma'],
    ['lwa', 'outraOperacao', 400, 'invalid_grant', 'nenhuma'],
  ] as const)('%s %s %i %s → %s', (destino, operacao, status, codigo, esperado) => {
    expect(classificarFalhaAmazon(authError(destino, operacao, status, codigo))).toBe(esperado);
  });

  it('pins the operation names against the PACKAGE (a renamed operation would park nothing)', async () => {
    const refresh = await recusaReal(REF_ATUAL, erroLwa(400, 'invalid_grant'));
    expect(refresh.operacao).toBe(OPERACAO_TROCA_REFRESH);
    const { fetch } = espiaoDeFetch(() => erroLwa(400, 'invalid_grant'));
    const codigo: unknown = await trocarCodigoAutorizacao({
      aplicacao: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      ref: REF_CONSENTIMENTO,
      codigo: CODIGO,
      redirectUri: REDIRECT_URI,
      userAgent: AGENTE_USUARIO_AMAZON,
      fetch,
    }).catch((e: unknown) => e);
    expect(codigo).toBeInstanceOf(AmazonAuthError);
    expect((codigo as AmazonAuthError).operacao).toBe(OPERACAO_TROCA_CODIGO);
    expect(classificarFalhaAmazon(codigo as AmazonAuthError)).toBe('nenhuma');
  });
});

describe('decidirEstacionamento (pure)', () => {
  const falha = { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' };
  const armazenada = {
    access_token: 'a',
    refresh_token: REFRESH_TOKEN_A,
    expirationDate: AGORA_MS,
    autorizadoEmMs: AUTORIZADO_EM_MS,
    acessoRef: REF_ATUAL,
    reconexaoPendente: null,
  };

  it('no credential → sem-credencial', () => {
    expect(decidirEstacionamento(null, falha, AGORA_MS).tipo).toBe('sem-credencial');
  });

  it('a refusal of a REPLACED grant → credencial-substituida', () => {
    expect(
      decidirEstacionamento(armazenada, { ...falha, refCredencial: REF_ANTIGA }, AGORA_MS).tipo,
    ).toBe('credencial-substituida');
  });

  it('the consent label never matches a stored grant', () => {
    expect(
      decidirEstacionamento(armazenada, { ...falha, refCredencial: REF_CONSENTIMENTO }, AGORA_MS)
        .tipo,
    ).toBe('credencial-substituida');
  });

  it('the current grant → estacionar, with exactly this block', () => {
    expect(decidirEstacionamento(armazenada, falha, AGORA_MS)).toEqual({
      tipo: 'estacionar',
      reconexaoPendente: {
        desdeMs: AGORA_MS,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: REF_ATUAL,
      },
    });
  });

  it('already parked → ja-estacionado, keeping the stored block', () => {
    const park = { desdeMs: 1, status: 401, codigoLwa: null, refCredencial: REF_ATUAL };
    expect(
      decidirEstacionamento({ ...armazenada, reconexaoPendente: park }, falha, AGORA_MS),
    ).toEqual({ tipo: 'ja-estacionado', reconexaoPendente: park });
  });

  it('the ref comes from refresh_token + autorizadoEmMs, never a stored field (acessoRef is ignored)', () => {
    expect(
      decidirEstacionamento({ ...armazenada, acessoRef: 'editado-a-mao' }, falha, AGORA_MS).tipo,
    ).toBe('estacionar');
    // …and moving either input of the derivation moves the ref.
    expect(
      decidirEstacionamento(
        { ...armazenada, autorizadoEmMs: AUTORIZADO_EM_MS + 1 },
        falha,
        AGORA_MS,
      ).tipo,
    ).toBe('credencial-substituida');
  });
});

describe('estacionarConta — tier 1', () => {
  const agoraMs = () => AGORA_MS;

  it('★ a 401/invalid_grant from the CURRENT ref parks; one from a STALE ref parks nothing', async () => {
    seedCredencial(db, ID);
    const antiga = await recusaReal(REF_ANTIGA, erroLwa(400, 'invalid_grant'), REFRESH_TOKEN_B);
    const r1 = await estacionarConta(
      asDb(db),
      ID,
      {
        refCredencial: antiga.refCredencial ?? '',
        status: antiga.status,
        codigoLwa: antiga.codigoLwa,
      },
      { agoraMs },
    );
    expect(r1).toEqual({ tipo: 'credencial-substituida' });
    expect(db.escritasEm(CAMINHO)).toHaveLength(0);

    // A bare 401 with no LWA body: the `null`-code park row.
    const atual = await recusaReal(REF_ATUAL, new Response('', { status: 401 }));
    expect(atual.codigoLwa).toBeNull();
    const r2 = await estacionarConta(
      asDb(db),
      ID,
      {
        refCredencial: atual.refCredencial ?? '',
        status: atual.status,
        codigoLwa: atual.codigoLwa,
      },
      { agoraMs },
    );
    expect(r2.tipo).toBe('estacionado');
    const [escrita] = db.escritasEm(CAMINHO);
    expect(escrita?.verbo).toBe('update');
    expect(escrita?.comPrecondicao).toBe(true);
    expect(Object.keys(escrita?.dados ?? {})).toEqual(['reconexaoPendente']);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toEqual({
      desdeMs: AGORA_MS,
      status: 401,
      codigoLwa: null,
      refCredencial: REF_ATUAL,
    });
    if (r2.tipo === 'estacionado') {
      expect(r2.relogioUs).toBe(
        relogioDoDocumentoUs(escrita?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
      );
    }
  });

  it('an already-parked conta → no write', async () => {
    seedCredencial(db, ID, {
      reconexaoPendente: {
        desdeMs: 1,
        status: 400,
        codigoLwa: 'invalid_grant',
        refCredencial: REF_ATUAL,
      },
    });
    const r = await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: REF_ATUAL, status: 401, codigoLwa: null },
      { agoraMs },
    );
    expect(r).toMatchObject({ tipo: 'ja-estacionado', desdeMs: 1, status: 400 });
    expect(db.escritas).toHaveLength(0);
  });

  it('a consent landing between the park’s read and write → no park (re-decided: replaced)', async () => {
    seedCredencial(db, ID);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await salvarConsentimento(asDb(db), ID, {
        access_token: ACCESS_TOKEN_NOVO,
        refresh_token: REFRESH_TOKEN_B,
        expirationDate: AGORA_MS + 3_600_000,
        autorizadoEmMs: AGORA_MS,
        acessoRef: refDe(REFRESH_TOKEN_B, AGORA_MS),
      });
    });
    const r = await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' },
      { agoraMs },
    );
    expect(r).toEqual({ tipo: 'credencial-substituida' });
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
    expect(db.ler(CAMINHO)?.refresh_token).toBe(REFRESH_TOKEN_B);
  });

  it('an hourly access-token persist costs one attempt; the next one parks', async () => {
    seedCredencial(db, ID);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await persistirAcesso(asDb(db), ID, {
        access_token: ACCESS_TOKEN_NOVO,
        expirationDate: AGORA_MS + 3_600_000,
        acessoRef: REF_ATUAL,
      });
    });
    const r = await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' },
      { agoraMs },
    );
    expect(r.tipo).toBe('estacionado');
    // The persist landed AND the park: the patch was re-derived, not re-applied blindly.
    expect(db.ler(CAMINHO)).toMatchObject({ access_token: ACCESS_TOKEN_NOVO });
    expect(db.ler(CAMINHO)?.reconexaoPendente).not.toBeNull();
  });

  it(`${String(MAX_TENTATIVAS_ESTACIONAMENTO)} lost preconditions → EstacionamentoAmazonEmConflitoError`, async () => {
    seedCredencial(db, ID);
    // Each attempt's write meets a persist that landed after its read. The next
    // interception is queued only AFTER the persist, so the persist itself is
    // never intercepted.
    let restantes = MAX_TENTATIVAS_ESTACIONAMENTO;
    const concorrer = async (): Promise<void> => {
      restantes -= 1;
      await persistirAcesso(asDb(db), ID, {
        access_token: `${ACCESS_TOKEN_NOVO}-${String(restantes)}`,
        expirationDate: AGORA_MS,
        acessoRef: REF_ATUAL,
      });
      if (restantes > 0) db.antesDaProximaEscrita(CAMINHO, concorrer);
    };
    db.antesDaProximaEscrita(CAMINHO, concorrer);
    await expect(
      estacionarConta(
        asDb(db),
        ID,
        { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' },
        { agoraMs },
      ),
    ).rejects.toBeInstanceOf(EstacionamentoAmazonEmConflitoError);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
  });

  it('a credential deleted between read and write is never resurrected', async () => {
    seedCredencial(db, ID);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await removerCredencial(asDb(db), ID);
    });
    const r = await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' },
      { agoraMs },
    );
    expect(r).toEqual({ tipo: 'sem-credencial' });
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('a non-precondition failure rethrows', async () => {
    seedCredencial(db, ID);
    db.falharEscrita(CAMINHO, grpc(14, 'UNAVAILABLE'));
    await expect(
      estacionarConta(
        asDb(db),
        ID,
        { refCredencial: REF_ATUAL, status: 400, codigoLwa: 'invalid_grant' },
        { agoraMs },
      ),
    ).rejects.toMatchObject({ code: 14 });
  });
});

describe('tratarFalhaDeAutenticacao', () => {
  const alvo = { integracaoId: ID, contaNome: 'Conta Um' };
  const deps = (logger = loggerEspiao().logger) => ({
    agoraMs: () => AGORA_MS,
    increment,
    logger,
  });

  it('estacionar → park + the reconexão aviso clocked by the park’s own commit', async () => {
    seedCredencial(db, ID);
    const r = await tratarFalhaDeAutenticacao(
      asDb(db),
      alvo,
      await recusaReal(REF_ATUAL, erroLwa(400, 'invalid_grant')),
      deps(),
    );
    expect(r.classe).toBe('estacionar');
    expect(r.aviso).toBe('criado');
    const park = db.escritasEm(CAMINHO)[0];
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      params: { loja: 'Conta Um', status: 400 },
      motivo: 'invalid_grant',
      relogioEvento: relogioDoDocumentoUs(park?.writeTime ?? { seconds: 0, nanoseconds: 0 }),
    });
  });

  it('invalid_client → the SECRET aviso, and NO park write', async () => {
    seedCredencial(db, ID);
    const r = await tratarFalhaDeAutenticacao(
      asDb(db),
      alvo,
      await recusaReal(REF_ATUAL, erroLwa(401, 'invalid_client')),
      deps(),
    );
    expect(r).toMatchObject({ classe: 'segredo-recusado', estacionamento: null, aviso: 'criado' });
    expect(db.escritasEm(CAMINHO)).toHaveLength(0);
    expect(db.ler(caminhoAviso(chaveSegredoRecusado()))?.motivo).toBe('invalid_client');
  });

  it('an SP-API 403 never parks (step 3 forces one refresh instead)', async () => {
    seedCredencial(db, ID);
    const r = await tratarFalhaDeAutenticacao(
      asDb(db),
      alvo,
      authError('sp-api', 'getOrders', 403, null),
      deps(),
    );
    expect(r).toEqual({ classe: 'renovar-acesso', estacionamento: null, aviso: null });
    expect(db.escritas).toHaveLength(0);
  });

  it('a stale ref raises nothing', async () => {
    seedCredencial(db, ID);
    const r = await tratarFalhaDeAutenticacao(
      asDb(db),
      alvo,
      authError('lwa', OPERACAO_TROCA_REFRESH, 400, 'invalid_grant', REF_ANTIGA),
      deps(),
    );
    expect(r).toMatchObject({ estacionamento: { tipo: 'credencial-substituida' }, aviso: null });
    expect(db.escritas).toHaveLength(0);
  });

  it('a null ref parks nothing, and its warning names conta + status + class — never a ref', async () => {
    seedCredencial(db, ID);
    const err = authError('lwa', OPERACAO_TROCA_REFRESH, 400, 'invalid_grant');
    Object.defineProperty(err, 'refCredencial', { value: null });
    const { logger, linhas } = loggerEspiao();
    const r = await tratarFalhaDeAutenticacao(asDb(db), alvo, err, deps(logger));
    expect(r).toEqual({ classe: 'estacionar', estacionamento: null, aviso: null });
    expect(db.escritas).toHaveLength(0);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.meta).toEqual({ integracaoId: ID, status: 400, classe: 'estacionar' });
    expect(textoDe(linhas)).not.toContain(REF_ATUAL);
  });
});

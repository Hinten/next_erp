/**
 * The tier-1 park, against the fake that models `lastUpdateTime` as the server
 * applies it (a removed document fails the stamp too: 9, not 5),
 * with the REAL `escreverAviso` / `resolverAviso` behind the aviso.
 */
import { describe, expect, it } from 'vitest';
import { LiAuthError } from '@delfrance/integrations-loja-integrada';
import type { CredenciaisLojaIntegrada } from '@delfrance/schemas';

import {
  avisarReconexaoPendente,
  chaveReconexao,
  relogioDoDocumentoUs,
  resolverReconexaoPendente,
} from '../avisos/avisos';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  DIA_MS,
  TOKEN_A,
  TOKEN_B,
  caminhoAviso,
  caminhoCredencial,
  credencialDoc,
  loggerEspiao,
  seedCredencial,
} from '../testing/fixtures';
import { fingerprintDoToken, refDaCredencial } from './credencial';
import { lerCredencial, removerCredencial, salvarCredencial } from './credentialStore';
import { LiCredencialInvalidaError, LiEstacionamentoEmConflitoError } from './erros';
import {
  MAX_TENTATIVAS_ESTACIONAMENTO,
  decidirEstacionamento,
  estacionarConta,
  tratarFalhaDeAutenticacao,
} from './estacionamento';

const ID = 'conta-li-1';
const CAMINHO = caminhoCredencial(ID);
const ATUALIZADO_MS = AGORA_MS - DIA_MS;
const REF_ATUAL = `${fingerprintDoToken(TOKEN_A)}.${String(ATUALIZADO_MS)}`;
const deps = { agoraMs: () => AGORA_MS };

function armazenada(over: Partial<CredenciaisLojaIntegrada> = {}): CredenciaisLojaIntegrada {
  return { ...(credencialDoc() as CredenciaisLojaIntegrada), ...over };
}

function erroAuth(ref: string, status = 401): LiAuthError {
  return new LiAuthError({
    operacao: 'teste',
    caminho: '/v1/pedido/search/',
    correlationId: 'corr-1',
    refCredencial: ref,
    status,
  });
}

describe('decidirEstacionamento (pure)', () => {
  const falha = { refCredencial: REF_ATUAL, status: 401 as const };

  it('no credential → sem-credencial', () => {
    expect(decidirEstacionamento(null, falha, AGORA_MS)).toEqual({ tipo: 'sem-credencial' });
  });

  it('the current ref → estacionar, with desdeMs = now and the refused ref', () => {
    expect(decidirEstacionamento(armazenada(), falha, AGORA_MS)).toEqual({
      tipo: 'estacionar',
      reconexaoPendente: { desdeMs: AGORA_MS, status: 401, refCredencial: REF_ATUAL },
    });
  });

  it('near-miss: a stale ref (another token) → credencial-substituida', () => {
    expect(
      decidirEstacionamento(armazenada({ personalToken: TOKEN_B }), falha, AGORA_MS).tipo,
    ).toBe('credencial-substituida');
  });

  it('near-miss: the SAME token re-saved (new tokenAtualizadoEmMs) → credencial-substituida', () => {
    expect(
      decidirEstacionamento(armazenada({ tokenAtualizadoEmMs: AGORA_MS }), falha, AGORA_MS).tipo,
    ).toBe('credencial-substituida');
  });

  it('already parked → ja-estacionado, keeping the stored block', () => {
    const bloco = { desdeMs: 123, status: 403 as const, refCredencial: REF_ATUAL };
    expect(
      decidirEstacionamento(armazenada({ reconexaoPendente: bloco }), falha, AGORA_MS),
    ).toEqual({ tipo: 'ja-estacionado', reconexaoPendente: bloco });
  });

  it('the guard ignores a hand-edited tokenFingerprint field', () => {
    expect(
      decidirEstacionamento(armazenada({ tokenFingerprint: '0000000000000000' }), falha, AGORA_MS)
        .tipo,
    ).toBe('estacionar');
  });

  it("the validator's fixed label never matches a stored ref", () => {
    expect(
      decidirEstacionamento(armazenada(), { refCredencial: 'candidato', status: 401 }, AGORA_MS)
        .tipo,
    ).toBe('credencial-substituida');
  });
});

describe('estacionarConta (tier 1)', () => {
  it('the current ref parks: one update of reconexaoPendente under the read stamp', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const r = await estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 403 }, deps);
    expect(r).toEqual({
      tipo: 'estacionado',
      desdeMs: AGORA_MS,
      status: 403,
      relogioUs: relogioDoDocumentoUs(db.carimboDe(CAMINHO)!),
    });
    const escritas = db.escritasEm(CAMINHO);
    expect(escritas.map((e) => [e.verbo, Object.keys(e.dados ?? {})])).toEqual([
      ['update', ['reconexaoPendente']],
    ]);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toEqual({
      desdeMs: AGORA_MS,
      status: 403,
      refCredencial: REF_ATUAL,
    });
  });

  it('near-miss: a 401 from a stale ref parks nothing and leaves updateTime unchanged', async () => {
    const db = new FakeDb();
    const carimbo = seedCredencial(db, ID, { personalToken: TOKEN_B });
    const r = await estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 401 }, deps);
    expect(r).toEqual({ tipo: 'credencial-substituida' });
    expect(db.escritas).toEqual([]);
    expect(db.carimboDe(CAMINHO)?.isEqual(carimbo)).toBe(true);
  });

  it('re-saving the same token, then an in-flight 401 with the OLD ref, parks nothing', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const antiga = await lerCredencial(asDb(db), ID);
    const refAntiga = refDaCredencial(antiga!.credencial);
    await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_A,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: antiga!.updateTime,
    });
    const carimbo = db.carimboDe(CAMINHO);
    const r = await estacionarConta(asDb(db), ID, { refCredencial: refAntiga, status: 401 }, deps);
    expect(r.tipo).toBe('credencial-substituida');
    expect(db.carimboDe(CAMINHO)?.isEqual(carimbo)).toBe(true);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
  });

  it('ja-estacionado writes nothing and desdeMs does not move', async () => {
    const db = new FakeDb();
    const bloco = { desdeMs: AGORA_MS - 5000, status: 401, refCredencial: REF_ATUAL };
    const carimbo = seedCredencial(db, ID, { reconexaoPendente: bloco });
    const r = await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: REF_ATUAL, status: 403 },
      { agoraMs: () => AGORA_MS + 999 },
    );
    expect(r).toEqual({
      tipo: 'ja-estacionado',
      desdeMs: AGORA_MS - 5000,
      status: 401,
      relogioUs: relogioDoDocumentoUs(carimbo),
    });
    expect(db.escritas).toEqual([]);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toEqual(bloco);
  });

  it('a save landing between the read and the write: the precondition fails, the re-read says credencial-substituida, nothing is written by the park', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      const lida = await lerCredencial(asDb(db), ID);
      await salvarCredencial(asDb(db), ID, {
        personalToken: TOKEN_B,
        tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
        agoraMs: AGORA_MS,
        versaoEsperada: lida!.updateTime,
      });
    });
    const r = await estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 401 }, deps);
    expect(r).toEqual({ tipo: 'credencial-substituida' });
    // Only the save landed; the park wrote nothing.
    expect(db.escritasEm(CAMINHO).map((e) => Object.keys(e.dados ?? {}).length)).toEqual([5]);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
    expect(db.ler(CAMINHO)?.personalToken).toBe(TOKEN_B);
  });

  it('a DELETE landing there: the stamp fails, the re-read says sem-credencial, and the doc stays absent', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await removerCredencial(asDb(db), ID);
    });
    const r = await estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 401 }, deps);
    expect(r).toEqual({ tipo: 'sem-credencial' });
    expect(db.escritasEm(CAMINHO).map((e) => e.verbo)).toEqual(['delete']);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('a removal the server answers with NOT_FOUND (5) is re-read too: sem-credencial, nothing written', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    // The fake answers a removal with 9 (what the SDK sends); this pins the
    // other code too, so the outcome never hinges on which one the server picks.
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await removerCredencial(asDb(db), ID);
      throw grpc(5, 'NOT_FOUND');
    });
    const r = await estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 401 }, deps);
    expect(r).toEqual({ tipo: 'sem-credencial' });
    expect(db.escritasEm(CAMINHO).map((e) => e.verbo)).toEqual(['delete']);
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('near-miss: any OTHER write failure propagates on the first attempt, never retried', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const falha = grpc(7, 'PERMISSION_DENIED');
    db.falharEscrita(CAMINHO, falha);
    let leituras = 0;
    await expect(
      estacionarConta(
        asDb(db),
        ID,
        { refCredencial: REF_ATUAL, status: 401 },
        {
          agoraMs: () => {
            leituras += 1;
            return AGORA_MS;
          },
        },
      ),
    ).rejects.toBe(falha);
    expect(leituras).toBe(1);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
  });

  it(`${String(MAX_TENTATIVAS_ESTACIONAMENTO)} lost preconditions in a row throw, re-deciding every time`, async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    // A writer that bumps the stamp WITHOUT changing the ref, before each attempt.
    for (let i = 0; i < MAX_TENTATIVAS_ESTACIONAMENTO; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        db.seed(CAMINHO, credencialDoc({ webhookPedido: null }));
      });
    }
    let leituras = 0;
    await expect(
      estacionarConta(
        asDb(db),
        ID,
        { refCredencial: REF_ATUAL, status: 401 },
        {
          agoraMs: () => {
            leituras += 1;
            return AGORA_MS;
          },
        },
      ),
    ).rejects.toBeInstanceOf(LiEstacionamentoEmConflitoError);
    expect(leituras).toBe(MAX_TENTATIVAS_ESTACIONAMENTO);
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
  });

  it('one lost precondition, then the park lands on the re-read', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    db.antesDaProximaEscrita(CAMINHO, () => {
      db.seed(CAMINHO, credencialDoc({ webhookPedido: null }));
    });
    const r = await estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 401 }, deps);
    expect(r.tipo).toBe('estacionado');
    expect(db.ler(CAMINHO)?.reconexaoPendente).toMatchObject({ refCredencial: REF_ATUAL });
  });

  it('a corrupt credential throws LiCredencialInvalidaError and writes nothing', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, { tokenExpiraEmMs: 'amanhã' });
    await expect(
      estacionarConta(asDb(db), ID, { refCredencial: REF_ATUAL, status: 401 }, deps),
    ).rejects.toBeInstanceOf(LiCredencialInvalidaError);
    expect(db.escritas).toEqual([]);
  });
});

describe('tratarFalhaDeAutenticacao (park, then the aviso)', () => {
  const alvo = { integracaoId: ID, lojaNome: 'Loja Teste' };

  it('raises the reconexão aviso clocked by the park commit, critico, without escalation', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const r = await tratarFalhaDeAutenticacao(asDb(db), alvo, erroAuth(REF_ATUAL, 401), {
      ...deps,
      increment,
    });
    expect(r.estacionamento?.tipo).toBe('estacionado');
    expect(r.aviso).toBe('criado');
    const aviso = db.ler(caminhoAviso(chaveReconexao(ID)));
    expect(aviso).toMatchObject({
      tipo: 'lojaIntegradaReconexaoPendente',
      severidade: 'critico',
      canal: 'lojaIntegrada',
      params: { loja: 'Loja Teste', status: 401 },
      relogioEvento: relogioDoDocumentoUs(db.carimboDe(CAMINHO)!),
      resolvidoEm: null,
      urlInterna: { rota: `/canais/loja-integrada/${ID}`, campo: null },
    });
  });

  it('a repeat (ja-estacionado) is dropped by the clock; nothing new is written', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const d = { ...deps, increment };
    await tratarFalhaDeAutenticacao(asDb(db), alvo, erroAuth(REF_ATUAL), d);
    const antes = db.escritas.length;
    const r = await tratarFalhaDeAutenticacao(asDb(db), alvo, erroAuth(REF_ATUAL, 403), d);
    expect(r.estacionamento?.tipo).toBe('ja-estacionado');
    expect(r.aviso).toBe('ignorado');
    expect(db.escritas.length).toBe(antes);
  });

  it('a stale ref raises nothing', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID, { personalToken: TOKEN_B });
    const r = await tratarFalhaDeAutenticacao(asDb(db), alvo, erroAuth(REF_ATUAL), {
      ...deps,
      increment,
    });
    expect(r).toEqual({ estacionamento: { tipo: 'credencial-substituida' }, aviso: null });
    expect(db.escritas).toEqual([]);
  });

  it('a null refCredencial warns (without the ref) and parks nothing', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    const err = erroAuth(REF_ATUAL);
    Object.defineProperty(err, 'refCredencial', { value: null });
    const { logger, chamadas } = loggerEspiao();
    const r = await tratarFalhaDeAutenticacao(asDb(db), alvo, err, {
      ...deps,
      increment,
      logger,
    });
    expect(r).toEqual({ estacionamento: null, aviso: null });
    expect(db.escritas).toEqual([]);
    expect(chamadas).toHaveLength(1);
    expect(JSON.stringify(chamadas)).not.toContain(fingerprintDoToken(TOKEN_A));
    expect(JSON.stringify(chamadas)).not.toContain(TOKEN_A);
  });

  it('park → save at T2 → late park raise: the conta ends unparked and the aviso resolved', async () => {
    const db = new FakeDb();
    seedCredencial(db, ID);
    // 1. The park lands, but its aviso raise is delayed.
    const park = await estacionarConta(
      asDb(db),
      ID,
      { refCredencial: REF_ATUAL, status: 401 },
      deps,
    );
    expect(park.tipo).toBe('estacionado');
    // 2. The operator saves a new token; the save resolves the aviso at ITS commit.
    const lida = await lerCredencial(asDb(db), ID);
    const save = await salvarCredencial(asDb(db), ID, {
      personalToken: TOKEN_B,
      tokenExpiraEmMs: AGORA_MS + 60 * DIA_MS,
      agoraMs: AGORA_MS,
      versaoEsperada: lida!.updateTime,
    });
    await resolverReconexaoPendente(
      asDb(db),
      ID,
      'token-validado',
      { nowMs: AGORA_MS + 5 },
      {
        relogioUs: save.versaoUs,
        lojaNome: alvo.lojaNome,
      },
    );
    // 3. The delayed raise arrives with the OLDER park clock.
    if (park.tipo !== 'estacionado') throw new Error('unreachable');
    const { resultado } = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 401, relogioUs: park.relogioUs },
      { increment, nowMs: AGORA_MS + 10 },
    );
    expect(resultado).toBe('ignorado');
    expect(db.ler(CAMINHO)?.reconexaoPendente).toBeNull();
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.resolvidoEm).not.toBeNull();
  });
});

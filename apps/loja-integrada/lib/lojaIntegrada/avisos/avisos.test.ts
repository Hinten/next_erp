/**
 * The µs boundary module, through the REAL `escreverAviso` / `resolverAviso`
 * against the fake.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { escreverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  MOTIVO_IMPORTACAO_PARADA_LI,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  chaveDeAviso,
  TIPO_AVISO,
} from '@delfrance/schemas';

import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import { AGORA_MS, DIA_MS, caminhoAviso } from '../testing/fixtures';
import {
  MOTIVO_AVISO_LI,
  TIPOS_AVISO_LI,
  agoraUsDe,
  avisarExpiracaoToken,
  avisarImportacaoParada,
  avisarReconexaoPendente,
  chaveExpiracao,
  chaveImportacaoParada,
  chaveReconexao,
  prazoUsDe,
  relogioDoDocumentoUs,
  resolverAvisoDeContaRemovida,
  resolverAvisosAposRemocao,
  resolverExpiracaoToken,
  resolverImportacaoParada,
  resolverReconexaoPendente,
  sincronizarAvisoDeExpiracao,
  sincronizarAvisosAposValidacao,
} from './avisos';

const ID = 'conta-li-1';
const deps = { increment, nowMs: AGORA_MS };
/** 23:59:59 São Paulo, 20 days after AGORA_MS's civil day (2027-01-15). */
const EXPIRA_20_DIAS = Date.UTC(2027, 1, 5, 2, 59, 59);

describe('the conversions', () => {
  it('relogioDoDocumentoUs pins the vector', () => {
    expect(relogioDoDocumentoUs({ seconds: 1_800_000_000, nanoseconds: 123_456_789 })).toBe(
      1_800_000_000_123_456,
    );
    expect(Number.isSafeInteger(1_800_000_000_123_456)).toBe(true);
  });

  it('agoraUsDe and prazoUsDe are ms × 1000, against fixed values', () => {
    expect(agoraUsDe({ nowMs: 1_790_000_000_123 })).toBe(1_790_000_000_123_000);
    expect(prazoUsDe(1_790_000_000_999)).toBe(1_790_000_000_999_000);
    expect(prazoUsDe(0)).toBe(0);
  });
});

describe('the keys', () => {
  it('producer key = resolver key, with no janela and no entidade', () => {
    expect(chaveExpiracao(ID)).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaTokenExpirando, conta: ID }),
    );
    expect(chaveReconexao(ID)).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente, conta: ID }),
    );
  });

  it('near-miss: two contas → two keys; two tipos → two keys', () => {
    expect(chaveExpiracao(ID)).not.toBe(chaveExpiracao('conta-li-2'));
    expect(chaveExpiracao(ID)).not.toBe(chaveReconexao(ID));
  });

  it('a raise is closed by the resolver of the SAME key', async () => {
    const db = new FakeDb();
    const { chave } = await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: EXPIRA_20_DIAS },
      deps,
    );
    expect(chave).toBe(chaveExpiracao(ID));
    expect(await resolverExpiracaoToken(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps)).toBe(
      true,
    );
    expect(db.ler(caminhoAviso(chave))?.resolucaoMotivo).toBe('token-validado');
  });
});

describe('the expiry aviso', () => {
  it('stores exactly loja, dias (a number) and expiraEm (the São Paulo civil date), prazo in µs, no clock', async () => {
    const db = new FakeDb();
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja Teste', tokenExpiraEmMs: EXPIRA_20_DIAS },
      deps,
    );
    const row = db.ler(caminhoAviso(chaveExpiracao(ID)));
    expect(row).toMatchObject({
      tipo: 'lojaIntegradaTokenExpirando',
      severidade: 'atencao',
      canal: 'lojaIntegrada',
      // 23:59:59 SP on 2027-02-04 — the UTC instant is already the 5th.
      params: { loja: 'Loja Teste', dias: 20, expiraEm: '2027-02-04' },
      prazo: EXPIRA_20_DIAS * 1000,
      relogioEvento: null,
      criadoEm: AGORA_MS * 1000,
      urlInterna: { rota: `/canais/loja-integrada/${ID}`, campo: null },
    });
  });

  it('a repeat refreshes dias without moving criadoEm', async () => {
    const db = new FakeDb();
    const evento = { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: EXPIRA_20_DIAS };
    await avisarExpiracaoToken(asDb(db), evento, deps);
    const r = await avisarExpiracaoToken(asDb(db), evento, {
      increment,
      nowMs: AGORA_MS + 2 * DIA_MS,
    });
    expect(r.resultado).toBe('repetido');
    const row = db.ler(caminhoAviso(chaveExpiracao(ID)));
    expect(row?.params).toMatchObject({ dias: 18 });
    expect(row?.criadoEm).toBe(AGORA_MS * 1000);
    expect(row?.ocorrencias).toBe(2);
  });

  it('sincronizarAvisoDeExpiracao: 30 days raises, 31 resolves (the threshold is <=)', async () => {
    const db = new FakeDb();
    const em = (dias: number) => AGORA_MS + dias * DIA_MS + 1000;
    const s30 = await sincronizarAvisoDeExpiracao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: em(30) },
      MOTIVO_AVISO_LI.tokenValidado,
      deps,
    );
    expect(s30).toMatchObject({ acao: 'avisado', dias: 30, resultado: 'criado' });
    const s31 = await sincronizarAvisoDeExpiracao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: em(31) },
      MOTIVO_AVISO_LI.tokenValidado,
      deps,
    );
    expect(s31).toEqual({ acao: 'resolvido', dias: 31, fechou: true });
  });
});

describe('the reconexão aviso clock (commit time, µs)', () => {
  const alvo = { integracaoId: ID, lojaNome: 'Loja' };

  it('after a clocked resolve, a late raise with an OLDER document clock stays resolved', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 1_000 }, deps);
    await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps, {
      relogioUs: 3_000,
      lojaNome: 'Loja',
    });
    const r = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 401, relogioUs: 2_000 },
      deps,
    );
    expect(r.resultado).toBe('ignorado');
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))?.resolvidoEm).not.toBeNull();
  });

  it('near-miss: a NEWER raise reopens', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 1_000 }, deps);
    await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps, {
      relogioUs: 3_000,
      lojaNome: 'Loja',
    });
    const r = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 403, relogioUs: 4_000 },
      deps,
    );
    expect(r.resultado).toBe('reaberto');
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 4_000,
      params: { loja: 'Loja', status: 403 },
    });
  });

  it('a clocked resolve with NO row seeds a resolved one, so an older raise arriving later is dropped', async () => {
    const db = new FakeDb();
    expect(
      await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.tokenValidado, deps, {
        relogioUs: 5_000,
        lojaNome: 'Loja',
      }),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      tipo: 'lojaIntegradaReconexaoPendente',
      severidade: 'critico',
      canal: 'lojaIntegrada',
      relogioEvento: 5_000,
    });
    const r = await avisarReconexaoPendente(
      asDb(db),
      { ...alvo, status: 401, relogioUs: 4_999 },
      deps,
    );
    expect(r.resultado).toBe('ignorado');
  });

  it('a resolve observed BEFORE a newer park leaves its row open — the resolve is the stale one', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 5_000 }, deps);
    expect(
      await resolverReconexaoPendente(asDb(db), ID, MOTIVO_AVISO_LI.credencialRemovida, deps, {
        relogioUs: 4_999,
        lojaNome: 'Loja',
      }),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 5_000,
    });
  });
});

describe('resolverAvisoDeContaRemovida (the orphan pass)', () => {
  const alvo = { integracaoId: ID, lojaNome: 'Loja' };

  it('a reconexão row is closed CLOCKED by the list read time, and stamped with it', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 1_000 }, deps);
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveReconexao(ID), 2_000, deps)).toBe(
      true,
    );
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: 2_000,
    });
  });

  it('near-miss: a reconexão row raised AFTER the list was read stays open', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(asDb(db), { ...alvo, status: 401, relogioUs: 3_000 }, deps);
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveReconexao(ID), 2_000, deps)).toBe(
      false,
    );
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 3_000,
    });
  });

  it('an expiry row is closed clockless — no relogioEvento is stamped on it', async () => {
    const db = new FakeDb();
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: EXPIRA_20_DIAS },
      deps,
    );
    expect(await resolverAvisoDeContaRemovida(asDb(db), chaveExpiracao(ID), 2_000, deps)).toBe(
      true,
    );
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: null,
    });
  });

  it('a reconexão-tipo id no producer here computes is closed clockless (nothing races it)', async () => {
    const db = new FakeDb();
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
      conta: ID,
      entidade: 'x',
    });
    // Not `chaveReconexao(anything)`: recomputing the key from the split fails.
    expect(chave.startsWith(`${chaveReconexao(ID)}:`)).toBe(true);
    db.seed(caminhoAviso(chave), {
      tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
      severidade: 'critico',
      canal: 'lojaIntegrada',
      params: {},
      criadoEm: 1,
      atualizadoEm: 1,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
      relogioEvento: 9_000,
    });
    expect(await resolverAvisoDeContaRemovida(asDb(db), chave, 2_000, deps)).toBe(true);
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: 9_000,
    });
  });
});

describe('the import-stopped tipo (step 3) in the orphan pass', () => {
  /** An open import-stopped row, raised at `relogioUs` — the poller's shape (PR 3-e). */
  function raise(db: FakeDb, relogioUs: number) {
    return escreverAviso(
      asDb(db),
      {
        tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
        conta: ID,
        severidade: SEVERIDADE_AVISO.critico,
        canal: CANAL_AVISO.lojaIntegrada,
        params: { loja: 'Loja', motivo: MOTIVO_IMPORTACAO_PARADA_LI.filtroIgnorado },
        urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build(ID), campo: null },
        relogioEvento: relogioUs,
      },
      { increment, agoraUs: agoraUsDe(deps) },
    );
  }

  it('its key is the conta alone, apart from the other two, and the tipo is listed', async () => {
    expect(chaveImportacaoParada(ID)).toBe(
      chaveDeAviso({ tipo: TIPO_AVISO.lojaIntegradaImportacaoParada, conta: ID }),
    );
    expect(new Set([chaveImportacaoParada(ID), chaveExpiracao(ID), chaveReconexao(ID)]).size).toBe(
      3,
    );
    expect(chaveImportacaoParada(ID)).not.toBe(chaveImportacaoParada('conta-li-2'));
    expect([...TIPOS_AVISO_LI].sort()).toEqual(
      [
        TIPO_AVISO.lojaIntegradaTokenExpirando,
        TIPO_AVISO.lojaIntegradaReconexaoPendente,
        TIPO_AVISO.lojaIntegradaImportacaoParada,
      ].sort(),
    );
    const { chave } = await raise(new FakeDb(), 1_000);
    expect(chave).toBe(chaveImportacaoParada(ID));
  });

  it('a row is closed CLOCKED by the list read time, and stamped with it', async () => {
    const db = new FakeDb();
    await raise(db, 1_000);
    expect(
      await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 2_000, deps),
    ).toBe(true);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: 2_000,
    });
  });

  it('near-miss: a row raised AFTER the list was read stays open', async () => {
    const db = new FakeDb();
    await raise(db, 3_000);
    expect(
      await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 2_000, deps),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      resolvidoEm: null,
      relogioEvento: 3_000,
    });
  });

  it('no row yet: the resolve SEEDS a resolved one, so a late, older raise is dropped', async () => {
    const db = new FakeDb();
    expect(
      await resolverAvisoDeContaRemovida(asDb(db), chaveImportacaoParada(ID), 2_000, deps),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: 'critico',
      canal: 'lojaIntegrada',
      relogioEvento: 2_000,
      resolucaoMotivo: 'conta-removida',
    });
    expect((await raise(db, 1_500)).resultado).toBe('ignorado');
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))?.resolvidoEm).not.toBeNull();
  });

  it('an import-stopped-tipo id no producer computes is closed clockless (nothing races it)', async () => {
    const db = new FakeDb();
    const chave = chaveDeAviso({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      conta: ID,
      entidade: 'x',
    });
    db.seed(caminhoAviso(chave), {
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: 'critico',
      canal: 'lojaIntegrada',
      params: {},
      criadoEm: 1,
      atualizadoEm: 1,
      ocorrencias: 1,
      resolvidoEm: null,
      resolucaoMotivo: null,
      relogioEvento: 9_000,
    });
    expect(await resolverAvisoDeContaRemovida(asDb(db), chave, 2_000, deps)).toBe(true);
    expect(db.ler(caminhoAviso(chave))).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: 9_000,
    });
  });
});

describe('the import-stopped aviso: producer and resolver of the order poller', () => {
  const evento = {
    integracaoId: ID,
    lojaNome: 'Loja',
    motivo: MOTIVO_IMPORTACAO_PARADA_LI.falhaTransitoria,
    relogioUs: 5_000,
  };

  it('raises critico, in-app, with exactly loja and motivo, at the given clock', async () => {
    const db = new FakeDb();
    const { chave, resultado } = await avisarImportacaoParada(asDb(db), evento, deps);

    expect(chave).toBe(chaveImportacaoParada(ID));
    expect(resultado).toBe('criado');
    const row = db.ler(caminhoAviso(chave));
    expect(row).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      urlInterna: { rota: ROTAS_AVISO.canalLojaIntegrada.build(ID), campo: null },
      relogioEvento: 5_000,
      resolvidoEm: null,
      criadoEm: AGORA_MS * 1000,
    });
    // A CODE, never a sentence: the web renders it.
    expect(row?.params).toEqual({ loja: 'Loja', motivo: 'falha-transitoria' });
  });

  it('a repeat at a later clock refreshes the motivo without moving criadoEm; an equal clock is dropped', async () => {
    const db = new FakeDb();
    await avisarImportacaoParada(asDb(db), evento, deps);
    const depois = await avisarImportacaoParada(
      asDb(db),
      { ...evento, motivo: MOTIVO_IMPORTACAO_PARADA_LI.janelaInstavel, relogioUs: 6_000 },
      { increment, nowMs: AGORA_MS + DIA_MS },
    );
    expect(depois.resultado).toBe('repetido');
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      params: { motivo: 'janela-instavel' },
      criadoEm: AGORA_MS * 1000,
      ocorrencias: 2,
    });
    // NEAR-MISS: the same clock again is the same observation.
    expect(
      (await avisarImportacaoParada(asDb(db), { ...evento, relogioUs: 6_000 }, deps)).resultado,
    ).toBe('ignorado');
  });

  it('the resolve is CLOCKED and stamped importacao-retomada; an older raise stays resolved, a newer one reopens', async () => {
    const db = new FakeDb();
    await avisarImportacaoParada(asDb(db), evento, deps);

    expect(
      await resolverImportacaoParada(asDb(db), ID, deps, { relogioUs: 7_000, lojaNome: 'Loja' }),
    ).toBe(true);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      resolucaoMotivo: 'importacao-retomada',
      relogioEvento: 7_000,
    });
    expect(MOTIVO_AVISO_LI.importacaoRetomada).toBe('importacao-retomada');

    // A run whose lease was taken over raises late, at an older clock: dropped.
    expect(
      (await avisarImportacaoParada(asDb(db), { ...evento, relogioUs: 6_500 }, deps)).resultado,
    ).toBe('ignorado');
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))?.resolvidoEm).not.toBeNull();

    // NEAR-MISS: a newer failure reopens it.
    expect(
      (await avisarImportacaoParada(asDb(db), { ...evento, relogioUs: 7_001 }, deps)).resultado,
    ).toBe('reaberto');
  });

  it('no row yet: the resolve SEEDS a resolved one with the store name and the clock', async () => {
    const db = new FakeDb();
    expect(
      await resolverImportacaoParada(asDb(db), ID, deps, { relogioUs: 7_000, lojaNome: 'Loja' }),
    ).toBe(false);
    expect(db.ler(caminhoAviso(chaveImportacaoParada(ID)))).toMatchObject({
      tipo: TIPO_AVISO.lojaIntegradaImportacaoParada,
      severidade: SEVERIDADE_AVISO.critico,
      canal: CANAL_AVISO.lojaIntegrada,
      params: { loja: 'Loja' },
      relogioEvento: 7_000,
      resolucaoMotivo: 'importacao-retomada',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*          The avisos a route syncs AFTER its credential write landed          */
/* -------------------------------------------------------------------------- */

describe('sincronizarAvisosAposValidacao', () => {
  const escrita = {
    integracaoId: ID,
    lojaNome: 'Loja',
    tokenExpiraEmMs: EXPIRA_20_DIAS,
    versaoUs: 9_000,
  };

  it('resolves the reconexão row at the write clock and raises the expiry row at ≤ 30 days', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', status: 401, relogioUs: 1_000 },
      deps,
    );
    const r = await sincronizarAvisosAposValidacao(asDb(db), escrita, deps);
    expect(r).toEqual({ reconexaoResolvida: true, sincronizado: true });
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolucaoMotivo: 'token-validado',
      relogioEvento: 9_000,
    });
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Loja', dias: 20, expiraEm: '2027-02-04' },
    });
  });

  it('a TRANSIENT gRPC failure is contained and reported; the warn names the conta, nothing else', async () => {
    const db = new FakeDb();
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), grpc(14, 'UNAVAILABLE'));
    const avisosLog: unknown[][] = [];
    const r = await sincronizarAvisosAposValidacao(asDb(db), escrita, {
      ...deps,
      logger: { warn: (...a: unknown[]) => avisosLog.push(a) },
    });
    expect(r).toEqual({ reconexaoResolvida: false, sincronizado: false });
    expect(avisosLog).toHaveLength(1);
    expect(avisosLog[0]?.[1]).toEqual({ integracaoId: ID, code: 14 });
  });

  it('near-miss: a deterministic gRPC failure, and a bug, still throw', async () => {
    const db = new FakeDb();
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), grpc(7, 'PERMISSION_DENIED'));
    await expect(sincronizarAvisosAposValidacao(asDb(db), escrita, deps)).rejects.toMatchObject({
      code: 7,
    });
    db.falharLeitura(caminhoAviso(chaveReconexao(ID)), new TypeError('bug'));
    await expect(sincronizarAvisosAposValidacao(asDb(db), escrita, deps)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('resolverAvisosAposRemocao', () => {
  it('resolves both rows as credencial-removida, the reconexão one at the delete clock', async () => {
    const db = new FakeDb();
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', status: 403, relogioUs: 1_000 },
      deps,
    );
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', tokenExpiraEmMs: EXPIRA_20_DIAS },
      deps,
    );
    const r = await resolverAvisosAposRemocao(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', versaoUs: 2_000 },
      deps,
    );
    expect(r).toEqual({ reconexaoResolvida: true, sincronizado: true });
    expect(db.ler(caminhoAviso(chaveReconexao(ID)))).toMatchObject({
      resolucaoMotivo: 'credencial-removida',
      relogioEvento: 2_000,
    });
    expect(db.ler(caminhoAviso(chaveExpiracao(ID)))).toMatchObject({
      resolucaoMotivo: 'credencial-removida',
    });
    // A late raise from a park OLDER than the removal stays resolved.
    const tarde = await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: ID, lojaNome: 'Loja', status: 401, relogioUs: 1_500 },
      deps,
    );
    expect(tarde.resultado).toBe('ignorado');
  });
});

/* -------------------------------------------------------------------------- */
/*            The µs promise, counted as raw source text                       */
/* -------------------------------------------------------------------------- */

const RAIZ_LIB = fileURLToPath(new URL('..', import.meta.url));
/** The routes: they receive µs from the store and hand it on, never convert. */
const RAIZ_ROTAS = fileURLToPath(new URL('../../../app', import.meta.url));

/** Every non-test `.ts` under `dir`, outside `testing/`. */
function fontes(dir: string): string[] {
  const saida: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'testing') saida.push(...fontes(caminho));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      saida.push(caminho);
    }
  }
  return saida;
}

function contar(texto: string, agulha: string): number {
  return texto.split(agulha).length - 1;
}

describe('⚠️ the µs boundary: two converting modules, every call counted', () => {
  const rotas = fontes(RAIZ_ROTAS);
  const arquivos = [...fontes(RAIZ_LIB), ...rotas];
  const avisos = fileURLToPath(new URL('./avisos.ts', import.meta.url));
  /** The order import's conversions (step 5): one stored-stamp coercion, one ms → µs. */
  const dataLi = fileURLToPath(new URL('../pedidos/dataLi.ts', import.meta.url));

  it('the scan found the lib and the conta routes', () => {
    expect(arquivos.length).toBeGreaterThan(5);
    expect(arquivos).toContain(avisos);
    expect(arquivos).toContain(dataLi);
    expect(rotas.filter((r) => r.includes('conta'))).toHaveLength(3);
  });

  it('this module calls the ms → µs converter exactly twice (agoraUsDe, prazoUsDe)', () => {
    expect(contar(readFileSync(avisos, 'utf8'), 'millisToMicros(')).toBe(2);
  });

  it('pedidos/dataLi.ts converts once each: microsDeMillisLi and microsArmazenadoLi', () => {
    const texto = readFileSync(dataLi, 'utf8');
    expect(contar(texto, 'millisToMicros(')).toBe(1);
    // The import line and the one call.
    expect(contar(texto, 'coerceToMicros')).toBe(2);
  });

  it('no other module converts: no ms → µs call, no nanosecond read, no toMillis, no coercion', () => {
    for (const arquivo of arquivos) {
      const texto = readFileSync(arquivo, 'utf8');
      const ehAvisos = arquivo === avisos;
      const ehDataLi = arquivo === dataLi;
      expect(contar(texto, 'millisToMicros('), arquivo).toBe(ehAvisos ? 2 : ehDataLi ? 1 : 0);
      expect(contar(texto, '.nanoseconds'), arquivo).toBe(ehAvisos ? 1 : 0);
      expect(contar(texto, 'toMillis('), arquivo).toBe(0);
      expect(contar(texto, 'coerceToMicros'), arquivo).toBe(ehDataLi ? 2 : 0);
    }
  });
});

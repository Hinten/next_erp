/**
 * The sweep body, offline, through the REAL `escreverAviso` / `resolverAviso`
 * against the fake.
 */
import { describe, expect, it } from 'vitest';

import {
  avisarExpiracaoToken,
  avisarReconexaoPendente,
  chaveExpiracao,
  chaveReconexao,
  relogioDoDocumentoUs,
} from '../avisos/avisos';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  DIA_MS,
  TOKEN_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  loggerEspiao,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import {
  MAX_PAGINAS_AVISOS_ABERTOS,
  PAGINA_AVISOS_ABERTOS,
  sweepLojaIntegradaTokenExpiry,
} from './expiracaoSweep';

/** An expiry exactly `dias` whole days (plus one second) ahead. */
const expiraEm = (dias: number) => AGORA_MS + dias * DIA_MS + 1000;

function sweep(db: FakeDb, logger = loggerEspiao().logger) {
  return sweepLojaIntegradaTokenExpiry(asDb(db), { increment, nowMs: AGORA_MS, logger });
}

function aviso(db: FakeDb, chave: string) {
  return db.ler(caminhoAviso(chave));
}

describe('pass (a): the expiry threshold', () => {
  it('29 raises, 30 raises, 31 resolves', async () => {
    const db = new FakeDb();
    for (const [id, dias] of [
      ['d29', 29],
      ['d30', 30],
      ['d31', 31],
    ] as const) {
      seedConta(db, id);
      seedCredencial(db, id, { tokenExpiraEmMs: expiraEm(dias) });
    }
    // d31 had an open row from an earlier date: it must close.
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: 'd31', lojaNome: 'x', tokenExpiraEmMs: expiraEm(10) },
      { increment, nowMs: AGORA_MS - DIA_MS },
    );

    const r = await sweep(db);
    expect(aviso(db, chaveExpiracao('d29'))).toMatchObject({
      resolvidoEm: null,
      params: { dias: 29 },
    });
    expect(aviso(db, chaveExpiracao('d30'))).toMatchObject({
      resolvidoEm: null,
      params: { dias: 30 },
    });
    expect(aviso(db, chaveExpiracao('d31'))).toMatchObject({ resolucaoMotivo: 'validade-em-dia' });
    expect(aviso(db, chaveExpiracao('d31'))?.resolvidoEm).not.toBeNull();
    expect(r.expiracao).toEqual({
      avisados: 2,
      resolvidos: 1,
      resultados: { criado: 2, repetido: 0, reaberto: 0, ignorado: 0 },
    });
    expect(r.erros).toEqual([]);
  });

  it('an INACTIVE conta at 20 days raises (deactivation does not stop the clock)', async () => {
    const db = new FakeDb();
    seedConta(db, 'inativa', { ativo: false, nome: 'Loja Inativa' });
    seedCredencial(db, 'inativa', { tokenExpiraEmMs: expiraEm(20) });
    await sweep(db);
    expect(aviso(db, chaveExpiracao('inativa'))).toMatchObject({
      resolvidoEm: null,
      params: { loja: 'Loja Inativa', dias: 20 },
    });
  });

  it('a conta with NO credential and open rows ends with both resolved (credencial-removida)', async () => {
    const db = new FakeDb();
    seedConta(db, 'sem');
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: 'sem', lojaNome: 'x', tokenExpiraEmMs: expiraEm(5) },
      { increment, nowMs: AGORA_MS },
    );
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'sem', lojaNome: 'x', status: 401, relogioUs: 1 },
      { increment, nowMs: AGORA_MS },
    );
    const r = await sweep(db);
    expect(r.semCredencial).toBe(1);
    for (const chave of [chaveExpiracao('sem'), chaveReconexao('sem')]) {
      expect(aviso(db, chave)?.resolvidoEm).not.toBeNull();
      expect(aviso(db, chave)?.resolucaoMotivo).toBe('credencial-removida');
    }
    expect(r.expiracao.resolvidos).toBe(1);
    expect(r.reconexao.resolvidos).toBe(1);
  });
});

describe('pass (a): the reconexão aviso', () => {
  it('a parked conta raises at the credential commit time; a re-run writes nothing more', async () => {
    const db = new FakeDb();
    seedConta(db, 'parada', { nome: 'Loja Parada' });
    const carimbo = seedCredencial(db, 'parada', {
      reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 403, refCredencial: 'a.1' },
    });
    const r1 = await sweep(db);
    expect(r1.estacionadas).toBe(1);
    expect(r1.reconexao.avisados).toBe(1);
    expect(aviso(db, chaveReconexao('parada'))).toMatchObject({
      resolvidoEm: null,
      severidade: 'critico',
      params: { loja: 'Loja Parada', status: 403 },
      relogioEvento: relogioDoDocumentoUs(carimbo),
    });
    const escritasAvisoAntes = db.escritasEm(caminhoAviso(chaveReconexao('parada'))).length;
    const r2 = await sweep(db);
    expect(r2.reconexao.avisados).toBe(0);
    expect(db.escritasEm(caminhoAviso(chaveReconexao('parada')))).toHaveLength(escritasAvisoAntes);
  });

  it('an UNPARKED conta resolves an open row, clocked by its credential commit time', async () => {
    const db = new FakeDb();
    seedConta(db, 'ok');
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'ok', lojaNome: 'x', status: 401, relogioUs: 1 },
      { increment, nowMs: AGORA_MS },
    );
    const carimbo = seedCredencial(db, 'ok');
    const r = await sweep(db);
    expect(r.reconexao.resolvidos).toBe(1);
    expect(aviso(db, chaveReconexao('ok'))).toMatchObject({
      resolucaoMotivo: 'sem-reconexao-pendente',
      relogioEvento: relogioDoDocumentoUs(carimbo),
    });
  });
});

describe('pass (a): per-conta containment', () => {
  it('conta A corrupt: B at 20 days still gets its aviso, and A is in erros[] (paths only)', async () => {
    const db = new FakeDb();
    seedConta(db, 'a', { nome: 'A' });
    seedCredencial(db, 'a', { tokenExpiraEmMs: 'quebrado' });
    seedConta(db, 'b', { nome: 'B' });
    seedCredencial(db, 'b', { tokenExpiraEmMs: expiraEm(20) });
    const espiao = loggerEspiao();
    const r = await sweep(db, espiao.logger);
    expect(r.erros).toEqual([{ etapa: 'conta', id: 'a', erro: expect.any(String) as string }]);
    expect(r.erros[0]?.erro).toContain('tokenExpiraEmMs');
    expect(aviso(db, chaveExpiracao('b'))).toMatchObject({ resolvidoEm: null });
    expect(JSON.stringify([r, espiao.chamadas])).not.toContain(TOKEN_A);
  });

  it('a gRPC failure on one conta is contained too', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedCredencial(db, 'a');
    seedConta(db, 'b');
    seedCredencial(db, 'b', { tokenExpiraEmMs: expiraEm(20) });
    db.falharLeitura(caminhoCredencial('a'), grpc(14, 'UNAVAILABLE'));
    const r = await sweep(db);
    expect(r.erros).toEqual([{ etapa: 'conta', id: 'a', erro: 'UNAVAILABLE' }]);
    expect(aviso(db, chaveExpiracao('b'))).toMatchObject({ resolvidoEm: null });
  });

  it('near-miss: an unclassified error is NOT contained — the tick fails loudly', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedCredencial(db, 'a');
    db.falharLeitura(caminhoCredencial('a'), new TypeError('bug'));
    await expect(sweep(db)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('pass (b): open rows of contas that no longer exist', () => {
  it('resolves a deleted conta’s rows as conta-removida, and leaves existing contas to pass (a)', async () => {
    const db = new FakeDb();
    seedConta(db, 'viva');
    seedCredencial(db, 'viva', { tokenExpiraEmMs: expiraEm(20) });
    const nowAntes = { increment, nowMs: AGORA_MS - DIA_MS };
    // The deleted conta left two open rows behind.
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: 'apagada', lojaNome: 'x', tokenExpiraEmMs: expiraEm(3) },
      nowAntes,
    );
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'apagada', lojaNome: 'x', status: 401, relogioUs: 7 },
      nowAntes,
    );
    // A conta that is no longer tipo 3 counts as gone too.
    seedConta(db, 'virou-shopee', { tipo: 5 });
    await avisarExpiracaoToken(
      asDb(db),
      { integracaoId: 'virou-shopee', lojaNome: 'x', tokenExpiraEmMs: expiraEm(3) },
      nowAntes,
    );
    // Another canal's open row is never ours.
    db.seed(caminhoAviso('shopeePushDegradado'), {
      tipo: 'shopeePushDegradado',
      severidade: 'atencao',
      canal: 'shopee',
      params: {},
      criadoEm: AGORA_MS * 1000,
      atualizadoEm: AGORA_MS * 1000,
      ocorrencias: 1,
      resolvidoEm: null,
    });

    const r = await sweep(db);
    expect(r.orfaos).toEqual({ lidos: 5, paginas: 1, truncado: false, resolvidos: 3 });
    for (const chave of [
      chaveExpiracao('apagada'),
      chaveReconexao('apagada'),
      chaveExpiracao('virou-shopee'),
    ]) {
      expect(aviso(db, chave)?.resolucaoMotivo).toBe('conta-removida');
    }
    expect(aviso(db, chaveExpiracao('viva'))).toMatchObject({ resolvidoEm: null });
    expect(aviso(db, 'shopeePushDegradado')).toMatchObject({ resolvidoEm: null });
    // The page query is the declared (resolvidoEm ASC, criadoEm DESC) shape.
    expect(db.consultas.find((c) => c.colecao === 'avisos')).toEqual({
      colecao: 'avisos',
      filtros: [['resolvidoEm', '==', null]],
      ordens: [['criadoEm', 'desc']],
      limite: PAGINA_AVISOS_ABERTOS,
      apos: null,
    });
    expect(db.leituras).not.toContain(caminhoConta('apagada'));
  });

  function seedAvisosDeOutroCanal(db: FakeDb, n: number): void {
    for (let i = 0; i < n; i += 1) {
      db.seed(caminhoAviso(`outro-${String(i).padStart(5, '0')}`), {
        tipo: 'shopeePushDegradado',
        canal: 'shopee',
        criadoEm: 1_000_000 + i,
        resolvidoEm: null,
      });
    }
  }

  it('pages with a document cursor and stops on a short page (truncado false)', async () => {
    const db = new FakeDb();
    seedAvisosDeOutroCanal(db, 450);
    const r = await sweep(db);
    expect(r.orfaos).toEqual({ lidos: 450, paginas: 3, truncado: false, resolvidos: 0 });
    const paginas = db.consultas.filter((c) => c.colecao === 'avisos');
    expect(paginas.map((c) => c.apos === null)).toEqual([true, false, false]);
  });

  it(`stops after ${String(MAX_PAGINAS_AVISOS_ABERTOS)} full pages and says truncado`, async () => {
    const db = new FakeDb();
    seedAvisosDeOutroCanal(db, PAGINA_AVISOS_ABERTOS * MAX_PAGINAS_AVISOS_ABERTOS + 1);
    const r = await sweep(db);
    expect(r.orfaos).toEqual({
      lidos: PAGINA_AVISOS_ABERTOS * MAX_PAGINAS_AVISOS_ABERTOS,
      paginas: MAX_PAGINAS_AVISOS_ABERTOS,
      truncado: true,
      resolvidos: 0,
    });
  });

  it('near-miss: a SHORT last page within the cap is not truncado', async () => {
    const db = new FakeDb();
    seedAvisosDeOutroCanal(db, PAGINA_AVISOS_ABERTOS * (MAX_PAGINAS_AVISOS_ABERTOS - 1) + 1);
    const r = await sweep(db);
    expect(r.orfaos.truncado).toBe(false);
    expect(r.orfaos.paginas).toBe(MAX_PAGINAS_AVISOS_ABERTOS);
  });

  it('a gRPC failure of the page query is contained; pass (a)’s work stands', async () => {
    const db = new FakeDb();
    seedConta(db, 'viva');
    seedCredencial(db, 'viva', { tokenExpiraEmMs: expiraEm(20) });
    db.falharConsulta('avisos', grpc(4, 'DEADLINE_EXCEEDED'));
    const r = await sweep(db);
    expect(r.erros).toEqual([{ etapa: 'orfaos', id: 'consulta', erro: 'DEADLINE_EXCEEDED' }]);
    expect(r.expiracao.avisados).toBe(1);
  });
});

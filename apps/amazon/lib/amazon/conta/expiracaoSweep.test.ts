import { beforeEach, describe, expect, it } from 'vitest';
import { escreverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  type MotivoContaAmazon,
} from '@delfrance/schemas';

import {
  avisarReautorizacao,
  avisarReconexaoPendente,
  avisarSegredoLwaExpirando,
  chaveContaPrecisaAtencao,
  chaveImportacaoParada,
  chaveReautorizacao,
  chaveReconexao,
  chaveSegredoExpirando,
  levantarImportacaoParadaAmazon,
  relogioDoDocumentoUs,
} from '../avisos/avisos';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_DESLIGADO,
  AMBIENTE_LIGADO,
  DIA_MS,
  REFRESH_TOKEN_A,
  caminhoAviso,
  caminhoConta,
  caminhoCredencial,
  loggerEspiao,
  refDe,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import type { AmbienteAmazon } from '../env';
import {
  MAX_PAGINAS_AVISOS_ABERTOS,
  PAGINA_AVISOS_ABERTOS,
  sweepAmazonExpiracoes,
} from './expiracaoSweep';

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

function varrer(ambiente: AmbienteAmazon = AMBIENTE_DESLIGADO, nowMs = AGORA_MS) {
  const log = loggerEspiao();
  return {
    r: sweepAmazonExpiracoes(asDb(db), { increment, nowMs, ambiente, logger: log.logger }),
    linhas: log.linhas,
  };
}

/** A credential with exactly `dias` São Paulo civil days left on the 365-day clock. */
function credencialComDias(id: string, dias: number) {
  const autorizadoEmMs = AGORA_MS - (365 - dias) * DIA_MS;
  return seedCredencial(db, id, {
    autorizadoEmMs,
    acessoRef: refDe(REFRESH_TOKEN_A, autorizadoEmMs),
  });
}

const reautorizacao = (id: string) => db.ler(caminhoAviso(chaveReautorizacao(id)));
const reconexao = (id: string) => db.ler(caminhoAviso(chaveReconexao(id)));

describe('pass (a) — the reauthorization clock', () => {
  it.each([
    [29, true],
    [30, true],
    [31, false],
    [0, true],
    [-1, true],
  ])('★ %i days left → warned: %s', async (dias, avisa) => {
    seedConta(db, 'c', { nome: 'Conta C' });
    credencialComDias('c', dias);
    const { r } = varrer();
    const res = await r;
    expect(res.reautorizacao.avisados).toBe(avisa ? 1 : 0);
    if (avisa) {
      expect(reautorizacao('c')).toMatchObject({
        resolvidoEm: null,
        params: { loja: 'Conta C', dias },
        canal: CANAL_AVISO.amazon,
      });
    } else {
      // Silent: no row is minted at 31.
      expect(reautorizacao('c')).toBeUndefined();
    }
  });

  it('★ at 31 days an OPEN row is RESOLVED (warned at 30 yesterday, reconnected today)', async () => {
    seedConta(db, 'c');
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: 'c', lojaNome: 'x', autorizadoEmMs: AGORA_MS - 335 * DIA_MS },
      { increment, nowMs: AGORA_MS },
    );
    credencialComDias('c', 31);
    const res = await varrer().r;
    expect(res.reautorizacao.resolvidos).toBe(1);
    expect(reautorizacao('c')?.resolucaoMotivo).toBe('autorizacao-em-dia');
  });

  it('a past date (−1) reads as "vencida": still warned, dias negative', async () => {
    seedConta(db, 'c');
    credencialComDias('c', -1);
    await varrer().r;
    expect(reautorizacao('c')?.params).toMatchObject({ dias: -1 });
  });

  it('an INACTIVE conta is still warned (Amazon’s clock does not stop)', async () => {
    seedConta(db, 'c', { ativo: false });
    credencialComDias('c', 10);
    const res = await varrer().r;
    expect(res.inativas).toBe(1);
    expect(reautorizacao('c')?.resolvidoEm).toBeNull();
  });

  it('a conta WITHOUT nome is excluded (pinned: the (tipo, nome) index filters existence)', async () => {
    db.seed(caminhoConta('sem-nome'), { tipo: INTEGRACAO_TIPO.amazon, ativo: true });
    credencialComDias('sem-nome', 1);
    const res = await varrer().r;
    expect(res.contas).toBe(0);
    expect(reautorizacao('sem-nome')).toBeUndefined();
  });
});

describe('pass (a) — the credential states', () => {
  it('no credential → both per-conta rows resolved; the reconexão one CLOCKED by the read time', async () => {
    seedConta(db, 'c', { nome: 'C' });
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'c', lojaNome: 'C', status: 400, codigoLwa: null, relogioUs: 1 },
      { increment, nowMs: AGORA_MS },
    );
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: 'c', lojaNome: 'C', autorizadoEmMs: AGORA_MS - 360 * DIA_MS },
      { increment, nowMs: AGORA_MS },
    );
    const res = await varrer().r;
    expect(res.semCredencial).toBe(1);
    expect(reautorizacao('c')?.resolucaoMotivo).toBe('credencial-ausente');
    expect(reconexao('c')).toMatchObject({ resolucaoMotivo: 'credencial-ausente' });
    expect(reconexao('c')?.relogioEvento).toBeGreaterThan(1);
  });

  it('no credential and no row → a RESOLVED reconexão row is seeded with the read clock (never clockless)', async () => {
    seedConta(db, 'c');
    await varrer().r;
    expect(reconexao('c')).toMatchObject({
      resolucaoMotivo: 'credencial-ausente',
      relogioEvento: expect.any(Number) as unknown,
    });
    // A park committed AFTER that read keeps its row: its clock is later.
    seedCredencial(db, 'c');
    const depois = relogioDoDocumentoUs(
      db.carimboDe(caminhoCredencial('c')) ?? { seconds: 0, nanoseconds: 0 },
    );
    const { resultado } = await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'c', lojaNome: 'x', status: 400, codigoLwa: null, relogioUs: depois },
      { increment, nowMs: AGORA_MS },
    );
    expect(resultado).toBe('reaberto');
  });

  it('parked → the reconexão row raised at the doc’s updateTime µs; a daily repeat writes nothing', async () => {
    seedConta(db, 'c', { nome: 'C' });
    const carimbo = seedCredencial(db, 'c', {
      reconexaoPendente: { desdeMs: 1, status: 401, codigoLwa: null, refCredencial: 'r' },
    });
    const r1 = await varrer().r;
    expect(r1.estacionadas).toBe(1);
    expect(r1.reconexao.avisados).toBe(1);
    expect(reconexao('c')).toMatchObject({
      relogioEvento: relogioDoDocumentoUs(carimbo),
      params: { loja: 'C', status: 401 },
    });
    const escritas = db.escritasEm(caminhoAviso(chaveReconexao('c'))).length;
    const r2 = await varrer().r;
    expect(r2.reconexao.avisados).toBe(0);
    expect(db.escritasEm(caminhoAviso(chaveReconexao('c')))).toHaveLength(escritas);
  });

  it('not parked → the reconexão row resolved with the updateTime clock', async () => {
    seedConta(db, 'c');
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'c', lojaNome: 'C', status: 400, codigoLwa: null, relogioUs: 1 },
      { increment, nowMs: AGORA_MS },
    );
    const carimbo = credencialComDias('c', 200);
    const res = await varrer().r;
    expect(res.reconexao.resolvidos).toBe(1);
    expect(reconexao('c')).toMatchObject({
      resolucaoMotivo: 'sem-reconexao-pendente',
      relogioEvento: relogioDoDocumentoUs(carimbo),
    });
  });

  it('a CORRUPT credential is contained per conta, and the next conta is still processed', async () => {
    seedConta(db, 'a', { nome: 'A' });
    seedCredencial(db, 'a', { lixo: true });
    seedConta(db, 'b', { nome: 'B' });
    credencialComDias('b', 5);
    const { r, linhas } = varrer();
    const res = await r;
    // The CLASS name, never the message (step 3 logs this result; §3 decision 23).
    expect(res.erros).toEqual([{ etapa: 'conta', id: 'a', erro: 'CredencialAmazonInvalidaError' }]);
    expect(reautorizacao('b')?.resolvidoEm).toBeNull();
    expect(linhas.some((l) => l.meta?.integracaoId === 'a')).toBe(true);
  });

  it('a gRPC failure on one conta is contained too', async () => {
    seedConta(db, 'a', { nome: 'A' });
    db.falharLeitura(caminhoCredencial('a'), grpc(14, 'UNAVAILABLE'));
    seedConta(db, 'b', { nome: 'B' });
    credencialComDias('b', 5);
    const res = await varrer().r;
    expect(res.erros.map((e) => e.id)).toEqual(['a']);
    expect(reautorizacao('b')).toBeDefined();
  });

  it('a NON-gRPC error rethrows out of the sweep (a bug fails the tick loudly)', async () => {
    seedConta(db, 'a', { nome: 'A' });
    db.falharLeitura(caminhoCredencial('a'), new RangeError('bug'));
    await expect(varrer().r).rejects.toBeInstanceOf(RangeError);
  });
});

describe('pass (b) — open per-conta rows of deleted contas', () => {
  it('closes a deleted conta’s rows (reconexão clocked by the list read) and leaves live contas alone', async () => {
    seedConta(db, 'viva', { nome: 'Viva' });
    credencialComDias('viva', 10);
    const deps = { increment, nowMs: AGORA_MS };
    await avisarReconexaoPendente(
      asDb(db),
      { integracaoId: 'morta', lojaNome: 'M', status: 400, codigoLwa: null, relogioUs: 1 },
      deps,
    );
    await avisarReautorizacao(
      asDb(db),
      { integracaoId: 'morta', lojaNome: 'M', autorizadoEmMs: AGORA_MS - 360 * DIA_MS },
      deps,
    );
    // The per-APP rows and other channels' rows are never orphans.
    await avisarSegredoLwaExpirando(asDb(db), { dataCivil: null }, deps);
    db.seed(caminhoAviso('outroCanal:morta'), {
      tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
      canal: CANAL_AVISO.lojaIntegrada,
      severidade: 'critico',
      resolvidoEm: null,
      criadoEm: 1,
    });
    const res = await varrer().r;
    expect(res.orfaos.resolvidos).toBe(2);
    expect(reconexao('morta')?.resolucaoMotivo).toBe('conta-removida');
    expect(reautorizacao('morta')?.resolucaoMotivo).toBe('conta-removida');
    expect(reautorizacao('viva')?.resolvidoEm).toBeNull();
    expect(db.ler(caminhoAviso(chaveSegredoExpirando()))?.resolvidoEm).toBeNull();
    expect(db.ler(caminhoAviso('outroCanal:morta'))?.resolvidoEm).toBeNull();
    expect(res.orfaos.truncado).toBe(false);
  });

  it('runs the EXISTING (resolvidoEm, criadoEm desc) shape and flags `truncado` at the ceiling', async () => {
    const total = PAGINA_AVISOS_ABERTOS * MAX_PAGINAS_AVISOS_ABERTOS + 1;
    for (let i = 0; i < total; i += 1) {
      db.seed(caminhoAviso(`x:${String(i).padStart(5, '0')}`), {
        tipo: TIPO_AVISO.lojaIntegradaReconexaoPendente,
        canal: CANAL_AVISO.lojaIntegrada,
        resolvidoEm: null,
        criadoEm: i,
      });
    }
    const res = await varrer().r;
    expect(res.orfaos).toMatchObject({
      paginas: MAX_PAGINAS_AVISOS_ABERTOS,
      lidos: PAGINA_AVISOS_ABERTOS * MAX_PAGINAS_AVISOS_ABERTOS,
      truncado: true,
    });
    const avisos = db.consultas.filter((c) => c.colecao === 'avisos');
    expect(avisos[0]).toMatchObject({
      filtros: [['resolvidoEm', null]],
      ordens: [['criadoEm', 'desc']],
      limite: PAGINA_AVISOS_ABERTOS,
    });
  });
});

describe('pass (b) — the backstop poll’s import-stopped row (step 4, PR 4-b)', () => {
  const importacao = (id: string) => db.ler(caminhoAviso(chaveImportacaoParada(id)));

  /**
   * Raise a conta's import-stopped aviso as the poll does: clocked by the commit
   * time of a write to ITS poll document (here, a seeded one).
   */
  async function pollAvisou(id: string): Promise<number> {
    const commit = db.seed(`pollPedidosAmazon/${id}`, { falhasSeguidas: 1 });
    await levantarImportacaoParadaAmazon(
      asDb(db),
      {
        integracaoId: id,
        lojaNome: `Conta ${id}`,
        motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente,
        commit,
      },
      { increment, nowMs: AGORA_MS },
    );
    return relogioDoDocumentoUs(commit);
  }

  it('★ a deleted conta’s open row closes, CLOCKED by the enumeration’s read time; a live conta’s row — active or not — stays open', async () => {
    seedConta(db, 'viva', { nome: 'Viva' });
    credencialComDias('viva', 200);
    seedConta(db, 'desativada', { nome: 'Desativada', ativo: false });
    credencialComDias('desativada', 200);
    await pollAvisou('viva');
    await pollAvisou('desativada');
    const raiseDaMorta = await pollAvisou('morta');
    // The enumeration is the sweep's FIRST operation, so its read time is the
    // latest commit before it: the dead conta's raise.
    const ultima = db.escritas.at(-1)?.writeTime;
    if (ultima === undefined) throw new Error('teste: nenhuma escrita antes da varredura');
    const lidaEmUs = relogioDoDocumentoUs(ultima);
    expect(lidaEmUs).toBeGreaterThan(raiseDaMorta);

    const res = await varrer().r;

    expect(res.contas).toBe(2);
    expect(res.orfaos.resolvidos).toBe(1);
    expect(importacao('morta')).toMatchObject({
      resolucaoMotivo: 'conta-removida',
      relogioEvento: lidaEmUs,
    });
    // The poll's rows while the conta exists: never this pass's to close — and a
    // deactivated conta is still listed (the documented residue).
    expect(importacao('viva')?.resolvidoEm).toBeNull();
    expect(importacao('desativada')?.resolvidoEm).toBeNull();
  });

  it('★ the race: a conta created AFTER the enumeration, whose poll raised before the orphan pass, keeps its open row', async () => {
    // A listed conta with no credential: pass (a) seeds its RESOLVED reconexão
    // row — a write after the enumeration and before pass (b), where the
    // concurrent conta and its poll run land.
    seedConta(db, 'viva', { nome: 'Viva' });
    // Control: a deleted conta's raise from BEFORE the enumeration does close.
    await pollAvisou('morta');
    let raiseDaNova: number | null = null;
    db.antesDaProximaEscrita(caminhoAviso(chaveReconexao('viva')), async () => {
      seedConta(db, 'nova', { nome: 'Nova' });
      raiseDaNova = await pollAvisou('nova');
    });

    const res = await varrer().r;

    // Anti-vacuity: the interleaving ran, and the enumeration never saw the conta.
    expect(raiseDaNova).not.toBeNull();
    expect(res.contas).toBe(1);
    expect(reconexao('viva')).toMatchObject({ resolucaoMotivo: 'credencial-ausente' });
    // The orphan pass read the new row (its key is in no listed conta's set)
    // and its clocked resolve lost to the later raise: still open, its clock kept.
    expect(importacao('nova')).toMatchObject({ resolvidoEm: null, relogioEvento: raiseDaNova });
    expect(importacao('morta')?.resolucaoMotivo).toBe('conta-removida');
    expect(res.orfaos.resolvidos).toBe(1);
  });
});

describe("pass (b) — the order import's two tipos (Amazon step 5)", () => {
  const ORDER = '171-9876543-2109876';

  /**
   * Raise a row as the step-5 producers will: per conta clocked by the conta
   * read's read time, per pedido by a Firestore commit — here, the commit of a
   * seeded document, so the clock sits on the fake's own server timeline.
   */
  async function contaAvisou(id: string, motivo: MotivoContaAmazon): Promise<number> {
    const lido = db.seed(`integracao-leitura/${id}-${motivo}`, { x: 1 });
    const relogioEvento = relogioDoDocumentoUs(lido);
    await escreverAviso(
      asDb(db),
      {
        tipo: TIPO_AVISO.amazonContaPrecisaAtencao,
        conta: id,
        janela: motivo,
        severidade: SEVERIDADE_AVISO.atencao,
        canal: CANAL_AVISO.amazon,
        params: { motivo },
        motivo,
        urlInterna: { rota: ROTAS_AVISO.canalAmazon.build(id), campo: null },
        relogioEvento,
      },
      { increment, agoraUs: AGORA_MS * 1000 },
    );
    return relogioEvento;
  }

  function chavePedido(id: string): string {
    return chaveDeAviso({
      tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
      conta: id,
      entidade: ORDER,
      janela: MOTIVO_PEDIDO_AMAZON.divergenciaItens,
    });
  }

  async function pedidoAvisou(id: string): Promise<void> {
    const commit = db.seed(`pedidos-commit/${id}`, { x: 1 });
    await escreverAviso(
      asDb(db),
      {
        tipo: TIPO_AVISO.amazonPedidoPrecisaAtencao,
        conta: id,
        entidade: ORDER,
        janela: MOTIVO_PEDIDO_AMAZON.divergenciaItens,
        severidade: SEVERIDADE_AVISO.critico,
        canal: CANAL_AVISO.amazon,
        params: { pedido: ORDER, motivo: MOTIVO_PEDIDO_AMAZON.divergenciaItens },
        motivo: MOTIVO_PEDIDO_AMAZON.divergenciaItens,
        urlInterna: { rota: ROTAS_AVISO.pedido.build(`pedido-${id}`), campo: null },
        relogioEvento: relogioDoDocumentoUs(commit),
      },
      { increment, agoraUs: AGORA_MS * 1000 },
    );
  }

  const linha = (chave: string) => db.ler(caminhoAviso(chave));

  it("★ NEAR-MISS: a LIVE conta's open per-pedido row and BOTH its open per-conta rows survive the sweep", async () => {
    seedConta(db, 'viva', { nome: 'Viva' });
    credencialComDias('viva', 200);
    await pedidoAvisou('viva');
    await contaAvisou('viva', MOTIVO_CONTA_AMAZON.contaSemOperacao);
    await contaAvisou('viva', MOTIVO_CONTA_AMAZON.intermediadorDivergente);

    const res = await varrer().r;

    expect(res.contas).toBe(1);
    expect(res.orfaos.resolvidos).toBe(0);
    expect(linha(chavePedido('viva'))?.resolvidoEm).toBeNull();
    for (const motivo of [
      MOTIVO_CONTA_AMAZON.contaSemOperacao,
      MOTIVO_CONTA_AMAZON.intermediadorDivergente,
    ]) {
      expect(linha(chaveContaPrecisaAtencao('viva', motivo))?.resolvidoEm, motivo).toBeNull();
    }
  });

  it("★ a REMOVED conta's per-conta rows close `conta-removida`, CLOCKED by the enumeration; its per-pedido row is a residue", async () => {
    seedConta(db, 'viva', { nome: 'Viva' });
    credencialComDias('viva', 200);
    await pedidoAvisou('morta');
    await contaAvisou('morta', MOTIVO_CONTA_AMAZON.contaSemOperacao);
    await contaAvisou('morta', MOTIVO_CONTA_AMAZON.intermediadorDivergente);
    // The enumeration is the sweep's FIRST operation: its read time is the
    // latest commit before it.
    const ultima = db.escritas.at(-1)?.writeTime;
    if (ultima === undefined) throw new Error('teste: nenhuma escrita antes da varredura');
    const lidaEmUs = relogioDoDocumentoUs(ultima);

    const res = await varrer().r;

    expect(res.orfaos.resolvidos).toBe(2);
    for (const motivo of [
      MOTIVO_CONTA_AMAZON.contaSemOperacao,
      MOTIVO_CONTA_AMAZON.intermediadorDivergente,
    ]) {
      expect(linha(chaveContaPrecisaAtencao('morta', motivo)), motivo).toMatchObject({
        resolucaoMotivo: 'conta-removida',
        relogioEvento: lidaEmUs,
      });
    }
    // The per-PEDIDO tipo is not the pass's: a deleted conta's row stays open
    // (the documented residue), never closed by a key it cannot compute.
    expect(linha(chavePedido('morta'))?.resolvidoEm).toBeNull();
  });

  it('★ the race: a conta created AFTER the enumeration keeps the per-conta row its first import raised', async () => {
    seedConta(db, 'viva', { nome: 'Viva' });
    let raiseDaNova: number | null = null;
    db.antesDaProximaEscrita(caminhoAviso(chaveReconexao('viva')), async () => {
      seedConta(db, 'nova', { nome: 'Nova' });
      raiseDaNova = await contaAvisou('nova', MOTIVO_CONTA_AMAZON.contaSemOperacao);
    });

    const res = await varrer().r;

    expect(raiseDaNova).not.toBeNull();
    expect(res.contas).toBe(1);
    expect(
      linha(chaveContaPrecisaAtencao('nova', MOTIVO_CONTA_AMAZON.contaSemOperacao)),
    ).toMatchObject({ resolvidoEm: null, relogioEvento: raiseDaNova });
    expect(res.orfaos.resolvidos).toBe(0);
  });
});

describe('pass (c) — the app secret', () => {
  it('switch off → skipped and logged; no secret row touched', async () => {
    const { r, linhas } = varrer(AMBIENTE_DESLIGADO);
    expect((await r).segredo).toEqual({ acao: 'pulado' });
    expect(db.ler(caminhoAviso(chaveSegredoExpirando()))).toBeUndefined();
    expect(linhas.some((l) => l.meta?.evento === 'segredo-pulado')).toBe(true);
  });

  it.each([
    ['unset', undefined, 'ausente'],
    ['blank', '', 'ausente'],
    ['2026-13-01', '2026-13-01', 'invalida'],
    [' 2026-01-01', ' 2026-01-01', 'invalida'],
  ])('on, with an %s date → raised WITHOUT a date', async (_c, valor, data) => {
    const res = await varrer({ ...AMBIENTE_LIGADO, AMAZON_LWA_SEGREDO_EXPIRA_EM: valor }).r;
    expect(res.segredo).toMatchObject({ acao: 'avisado', dias: null, data });
    expect(db.ler(caminhoAviso(chaveSegredoExpirando()))).toMatchObject({
      params: {},
      prazo: null,
      resolvidoEm: null,
    });
  });

  it('on, 30 days → raised with dias + expiraEm', async () => {
    const res = await varrer({ ...AMBIENTE_LIGADO, AMAZON_LWA_SEGREDO_EXPIRA_EM: '2027-02-14' }).r;
    expect(res.segredo).toMatchObject({ acao: 'avisado', dias: 30 });
    expect(db.ler(caminhoAviso(chaveSegredoExpirando()))?.params).toEqual({
      dias: 30,
      expiraEm: '2027-02-14',
    });
  });

  it('on, 31 days → resolved (an open row closes)', async () => {
    await avisarSegredoLwaExpirando(asDb(db), { dataCivil: null }, { increment, nowMs: AGORA_MS });
    const res = await varrer({ ...AMBIENTE_LIGADO, AMAZON_LWA_SEGREDO_EXPIRA_EM: '2027-02-15' }).r;
    expect(res.segredo).toEqual({ acao: 'resolvido', dias: 31, fechou: true });
    expect(db.ler(caminhoAviso(chaveSegredoExpirando()))?.resolucaoMotivo).toBe('segredo-em-dia');
  });
});

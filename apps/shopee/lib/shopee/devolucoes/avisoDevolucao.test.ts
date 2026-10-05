import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  PENDENCIA_RECLAMACAO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';
import type { ShopeeReturnDetail } from '@delfrance/integrations-shopee';

// ⚠️ The REAL `escreverAviso` / `resolverAviso` AND the real transaction over
// the shared fake Firestore, never a mock of either — the property under test
// is what the CONFIRMED state of a real transaction outcome does to the row,
// and a mocked writer cannot drop a stale clock. `nfe/avisoNfe.test.ts` is the
// harness precedent.
import { FIXTURE_RETURN_DETAIL_DOC, lerDevolucaoDetalhe } from '../fixtures/wireCorpus';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { microsDeSegundosShopee } from '../pedidos/orderMapping';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  RESOLUCAO_AVISO_DEVOLUCAO,
  aplicarAvisoDeDevolucao,
  chaveDoAvisoDeDevolucao,
  preverEfeitoDoAvisoDeDevolucao,
  type ResultadoAvisoDevolucao,
} from './avisoDevolucao';
import {
  mapearDevolucaoShopee,
  relogioDoAvisoDeDevolucao,
  type DevolucaoMapeada,
} from './devolucaoMapping';
import {
  preverIncidenteDevolucaoShopee,
  salvarIncidenteDevolucaoShopee,
  type PrevisaoDevolucao,
} from './devolucaoTx';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real conta, order, return or buyer.  */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_789_000_000_000;
const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
/** The corpus detail's own return_sn — ALPHANUMERIC, like Shopee's samples. */
const RETURN_SN = '260910ABCDE0001';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const INCIDENTE_PATH = `${PEDIDO_PATH}/incidentes/${idIncidenteDevolucaoShopee(RETURN_SN)}`;
const CHAVE = chaveDoAvisoDeDevolucao(CONTA, RETURN_SN);
const AVISO_PATH = `avisos/${CHAVE}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

function base(): ShopeeReturnDetail {
  return lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC).response;
}

/** The corpus's own `update_time`, in wire SECONDS. */
const T0_S = base().update_time;

/**
 * The corpus detail with top-level overrides, at `T0 + segundos`. The corpus is
 * ACCEPTED with a buyer offer AND evidence pending, both due at the same second
 * — so its pendência is `responder-proposta` (the tie keeps the fixed order).
 */
function detalhe(segundos: number, over: Partial<ShopeeReturnDetail> = {}): ShopeeReturnDetail {
  return { ...base(), update_time: T0_S + segundos, ...over };
}

/** REQUESTED — the seller owes an answer; its prazo is the NEARER of the two seller deadlines. */
const SOLICITADA: Partial<ShopeeReturnDetail> = { status: 'REQUESTED' };
/** Still OPEN, and nothing waits for the seller (no offer, no evidence owed). */
const SEM_PENDENCIA: Partial<ShopeeReturnDetail> = { negotiation: null, seller_proof: null };
/** Terminal. */
const ENCERRADA: Partial<ShopeeReturnDetail> = { status: 'CLOSED' };

function dbComPedido(): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, { numero: ORDER_SN });
  return db;
}

interface Commit {
  readonly previsao: PrevisaoDevolucao;
  readonly mapeada: DevolucaoMapeada;
}

/** ONE transaction of the real importer write — its aviso effect NOT yet applied. */
async function commit(db: FakeDb, d: ShopeeReturnDetail): Promise<Commit> {
  const mapeada = mapearDevolucaoShopee(d);
  const previsao = await salvarIncidenteDevolucaoShopee(asDb(db), {
    pedidoId: PEDIDO_ID,
    incidenteId: idIncidenteDevolucaoShopee(RETURN_SN),
    mapeada,
  });
  return { previsao, mapeada };
}

/** The aviso effect of a committed outcome — possibly LATE, as a post-commit inversion runs it. */
function efeito(db: FakeDb, c: Commit, nowMs = AGORA_MS): Promise<ResultadoAvisoDevolucao> {
  return aplicarAvisoDeDevolucao(
    asDb(db),
    {
      integracaoId: CONTA,
      pedidoId: PEDIDO_ID,
      orderSn: ORDER_SN,
      returnSn: RETURN_SN,
      previsao: c.previsao,
      relogioProvedorUs: c.mapeada.relogioProvedorUs,
    },
    deps(nowMs),
  );
}

/** A whole delivery: the transaction, then its effect. */
async function entregar(
  db: FakeDb,
  d: ShopeeReturnDetail,
): Promise<Commit & { aviso: ResultadoAvisoDevolucao }> {
  const c = await commit(db, d);
  return { ...c, aviso: await efeito(db, c) };
}

function aviso(db: FakeDb): Record<string, unknown> {
  const doc = db.store[AVISO_PATH];
  if (!doc) throw new Error('aviso ausente');
  return doc.data;
}

function escritasNoAviso(db: FakeDb): number {
  return db.writes.filter((w) => w.path === AVISO_PATH).length;
}

/* -------------------------------------------------------------------------- */
/*  (1) a chave                                                                */
/* -------------------------------------------------------------------------- */

describe('chaveDoAvisoDeDevolucao — uma linha por DEVOLUÇÃO', () => {
  it('é a chave do tipo reclamacaoAguardandoVendedor, conta + return_sn alfanumérico verbatim', () => {
    expect(CHAVE).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.reclamacaoAguardandoVendedor,
        conta: CONTA,
        entidade: RETURN_SN,
      }),
    );
    expect(CHAVE).toBe(`reclamacaoAguardandoVendedor:${CONTA}:${RETURN_SN}`);
  });

  it('nunca é a chave de pedidoPrecisaDecisao (a varredura do passo 8 fecharia a linha)', () => {
    expect(CHAVE.startsWith(`${TIPO_AVISO.pedidoPrecisaDecisao}:`)).toBe(false);
  });

  it('duas devoluções do mesmo pedido, ou duas contas, são duas linhas', () => {
    expect(chaveDoAvisoDeDevolucao(CONTA, '2609100000000002')).not.toBe(CHAVE);
    expect(chaveDoAvisoDeDevolucao('int-2', RETURN_SN)).not.toBe(CHAVE);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) o efeito, puro — QUAIS desfechos projetam                              */
/* -------------------------------------------------------------------------- */

describe('preverEfeitoDoAvisoDeDevolucao — só o estado CONFIRMADO, e só nos desfechos certos', () => {
  const W0 = microsDeSegundosShopee(T0_S);

  /** The raw incidente a first import of `d` writes — the stored side of `prever`. */
  function armazenado(d: ShopeeReturnDetail): Record<string, unknown> {
    const p = preverIncidenteDevolucaoShopee(undefined, mapearDevolucaoShopee(d));
    if (p.patch === null) throw new Error('criação sem patch');
    return p.patch;
  }

  function prever(raw: Record<string, unknown> | undefined, d: ShopeeReturnDetail) {
    const m = mapearDevolucaoShopee(d);
    const previsao = preverIncidenteDevolucaoShopee(raw, m);
    return { previsao, efeito: preverEfeitoDoAvisoDeDevolucao(previsao, m.relogioProvedorUs) };
  }

  it('`criado` com pendência ⇒ abrir: a pendência de prazo MAIS PRÓXIMO, o status, o relógio W + revisão', () => {
    const d = detalhe(0, SOLICITADA);
    const { previsao, efeito: e } = prever(undefined, d);
    expect(previsao.acao).toBe('criado');
    expect(e).toEqual({
      efeito: 'abrir',
      pendencia: PENDENCIA_RECLAMACAO.responderSolicitacao,
      // min(due_date, return_seller_due_date) — copied, never computed.
      prazoUs: microsDeSegundosShopee(Math.min(d.due_date ?? 0, d.return_seller_due_date ?? 0)),
      status: 'REQUESTED',
      relogioEvento: W0 + 1,
    });
  });

  it('o relógio NÃO é a revisão crua: é relogioDoAvisoDeDevolucao(W, revisão), acima de W', () => {
    const { efeito: e } = prever(undefined, detalhe(0));
    expect(e.efeito).toBe('abrir');
    if (e.efeito !== 'abrir') throw new Error('esperava abrir');
    expect(e.relogioEvento).toBe(relogioDoAvisoDeDevolucao(W0, 1));
    expect(e.relogioEvento).toBeGreaterThan(W0);
  });

  it('`criado` já encerrada ⇒ resolver `devolucao-encerrada` (mudouAviso é true na criação)', () => {
    const { previsao, efeito: e } = prever(undefined, detalhe(0, ENCERRADA));
    expect(previsao.mudouAviso).toBe(true);
    expect(e).toEqual({
      efeito: 'resolver',
      resolucao: RESOLUCAO_AVISO_DEVOLUCAO.devolucaoEncerrada,
      relogioEvento: W0 + 1,
    });
  });

  it('CANCELLED também é `devolucao-encerrada` — o conjunto terminal é o do mapeamento, não um literal', () => {
    const { efeito: e } = prever(undefined, detalhe(0, { status: 'CANCELLED' }));
    expect(e).toMatchObject({ resolucao: RESOLUCAO_AVISO_DEVOLUCAO.devolucaoEncerrada });
  });

  it('aberta e nada esperando o vendedor ⇒ resolver `sem-pendencia-do-vendedor` (near-miss do encerrada)', () => {
    const { efeito: e } = prever(undefined, detalhe(0, SEM_PENDENCIA));
    expect(e).toEqual({
      efeito: 'resolver',
      resolucao: RESOLUCAO_AVISO_DEVOLUCAO.semPendencia,
      relogioEvento: W0 + 1,
    });
  });

  it('`atualizado` que muda o aviso ⇒ projeta com a revisão NOVA (2)', () => {
    const { previsao, efeito: e } = prever(armazenado(detalhe(0)), detalhe(1, SOLICITADA));
    expect(previsao.acao).toBe('atualizado');
    expect(previsao.mudouAviso).toBe(true);
    expect(e.efeito).toBe('abrir');
    if (e.efeito !== 'abrir') throw new Error('esperava abrir');
    expect(e.relogioEvento).toBe(microsDeSegundosShopee(T0_S + 1) + 2);
  });

  it('`atualizado` que NÃO muda o aviso (só o valor) ⇒ nenhum efeito', () => {
    const { previsao, efeito: e } = prever(
      armazenado(detalhe(0)),
      detalhe(1, { refund_amount: 20 }),
    );
    expect(previsao.acao).toBe('atualizado');
    expect(previsao.mudouAviso).toBe(false);
    expect(e).toEqual({ efeito: 'nenhum' });
  });

  it('`ignorado-sem-mudanca` PROJETA mesmo com mudouAviso false — o replay, com o MESMO relógio da criação', () => {
    const { previsao, efeito: e } = prever(armazenado(detalhe(0)), detalhe(0));
    expect(previsao.acao).toBe('ignorado-sem-mudanca');
    expect(previsao.mudouAviso).toBe(false);
    expect(e).toEqual({
      efeito: 'abrir',
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
      prazoUs: microsDeSegundosShopee(base().negotiation?.offer_due_date ?? 0),
      status: 'ACCEPTED',
      relogioEvento: W0 + 1,
    });
    // The SAME clock the create's effect carried — which is what makes the
    // replay a no-op once that effect has landed.
    expect(e).toEqual(prever(undefined, detalhe(0)).efeito);
  });

  it('`relogio-avancado` (só o relógio andou) ⇒ nenhum efeito', () => {
    const { previsao, efeito: e } = prever(armazenado(detalhe(0)), detalhe(5));
    expect(previsao.acao).toBe('relogio-avancado');
    expect(e).toEqual({ efeito: 'nenhum' });
  });

  it('`ignorado-obsoleto` ⇒ nenhum efeito, embora o detalhe velho "peça" um aviso', () => {
    const { previsao, efeito: e } = prever(
      armazenado(detalhe(5, ENCERRADA)),
      detalhe(0, SOLICITADA),
    );
    expect(previsao.acao).toBe('ignorado-obsoleto');
    expect(e).toEqual({ efeito: 'nenhum' });
  });

  it('`ignorado-sem-pedido` ⇒ nenhum efeito', async () => {
    const db = new FakeDb();
    const c = await commit(db, detalhe(0, SOLICITADA));
    expect(c.previsao.acao).toBe('ignorado-sem-pedido');
    expect(preverEfeitoDoAvisoDeDevolucao(c.previsao, c.mapeada.relogioProvedorUs)).toEqual({
      efeito: 'nenhum',
    });
  });

  it('um desfecho que projeta SEM estado confirmado é contrato violado: RangeError, não um aviso de nada', () => {
    const previsao: PrevisaoDevolucao = {
      acao: 'ignorado-sem-mudanca',
      patch: null,
      confirmado: { claimStatus: null, bloco: null },
      anterior: null,
      mudouAviso: false,
    };
    expect(() => preverEfeitoDoAvisoDeDevolucao(previsao, W0)).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) o aviso escrito                                                         */
/* -------------------------------------------------------------------------- */

describe('aplicarAvisoDeDevolucao — o plano escrito', () => {
  it('abre com EXATAMENTE os campos do tipo: params {pedido, devolucao, pendencia}, motivo = status, prazo µs', async () => {
    const db = dbComPedido();
    const d = detalhe(0);
    const r = await entregar(db, d);
    expect(r.aviso).toBe('aberto');

    const a = aviso(db);
    expect(a.tipo).toBe(TIPO_AVISO.reclamacaoAguardandoVendedor);
    expect(a.severidade).toBe(SEVERIDADE_AVISO.atencao);
    expect(a.canal).toBe(CANAL_AVISO.shopee);
    expect(a.params).toEqual({
      pedido: ORDER_SN,
      devolucao: RETURN_SN,
      pendencia: PENDENCIA_RECLAMACAO.responderProposta,
    });
    expect(a.motivo).toBe('ACCEPTED');
    expect(a.urlInterna).toEqual({ rota: ROTAS_AVISO.pedido.build(PEDIDO_ID), campo: null });
    expect(a.prazo).toBe(microsDeSegundosShopee(d.negotiation?.offer_due_date ?? 0));
    expect(a.relogioEvento).toBe(microsDeSegundosShopee(T0_S) + 1);
    // "Now" through the ms → µs seam, from the delivery's own clock.
    expect(a.criadoEm).toBe(AGORA_MS * 1000);
    expect(a.ocorrencias).toBe(1);
    expect(a.resolvidoEm).toBeNull();
  });

  it('um prazo AUSENTE é gravado como null — o prazo de um estado anterior não sobrevive', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    expect(typeof aviso(db).prazo).toBe('number');

    const r = await entregar(
      db,
      detalhe(1, {
        ...SOLICITADA,
        ...SEM_PENDENCIA,
        due_date: null,
        return_seller_due_date: null,
      }),
    );
    expect(r.previsao.mudouAviso).toBe(true);
    expect(r.aviso).toBe('aberto');
    expect(aviso(db).prazo).toBeNull();
  });

  it('resolvido carimba o relógio e o motivo da resolução', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    const r = await entregar(db, detalhe(1, ENCERRADA));
    expect(r.aviso).toBe('resolvido');
    const a = aviso(db);
    expect(a.resolvidoEm).toBe(AGORA_MS * 1000);
    expect(a.resolucaoMotivo).toBe(RESOLUCAO_AVISO_DEVOLUCAO.devolucaoEncerrada);
    expect(a.relogioEvento).toBe(microsDeSegundosShopee(T0_S + 1) + 2);
  });

  it('resolver sem linha nenhuma não cria fantasma: `inalterado`, zero escritas', async () => {
    const db = dbComPedido();
    const r = await entregar(db, detalhe(0, ENCERRADA));
    expect(r.aviso).toBe('inalterado');
    expect(db.store[AVISO_PATH]).toBeUndefined();
    expect(escritasNoAviso(db)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) RT-8 — a ordem, o relógio e as inversões                               */
/* -------------------------------------------------------------------------- */

describe('RT-8 — um detalhe velho não abre nem fecha; a inversão pós-commit não vence', () => {
  it('REQUESTED ⇒ aberto; ACCEPTED sem pendência ⇒ resolvido; REQUESTED atrasado ⇒ não reabre', async () => {
    const db = dbComPedido();
    expect((await entregar(db, detalhe(0, SOLICITADA))).aviso).toBe('aberto');
    expect(typeof aviso(db).prazo).toBe('number');

    expect((await entregar(db, detalhe(2, SEM_PENDENCIA))).aviso).toBe('resolvido');
    expect(aviso(db).resolucaoMotivo).toBe(RESOLUCAO_AVISO_DEVOLUCAO.semPendencia);

    const atrasada = await entregar(db, detalhe(1, SOLICITADA));
    expect(atrasada.previsao.acao).toBe('ignorado-obsoleto');
    expect(atrasada.aviso).toBe('inalterado');
    expect(aviso(db).resolvidoEm).toBe(AGORA_MS * 1000);
  });

  it('um `ignorado-obsoleto` não escreve NADA no aviso', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(5, SOLICITADA));
    db.writes.length = 0;
    const r = await entregar(db, detalhe(0, ENCERRADA));
    expect(r.previsao.acao).toBe('ignorado-obsoleto');
    expect(r.aviso).toBe('inalterado');
    expect(escritasNoAviso(db)).toBe(0);
    expect(aviso(db).resolvidoEm).toBeNull();
  });

  it('nem quando a linha guarda um relógio MAIS VELHO que o detalhe obsoleto (depois de um avanço só de relógio)', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0)); // aviso a W0 + 1
    expect((await entregar(db, detalhe(9))).previsao.acao).toBe('relogio-avancado');
    db.writes.length = 0;
    const r = await entregar(db, detalhe(5)); // W5 < W9 ⇒ obsoleto, mas W5 + 1 > W0 + 1
    expect(r.previsao.acao).toBe('ignorado-obsoleto');
    expect(r.aviso).toBe('inalterado');
    expect(escritasNoAviso(db)).toBe(0);
    expect(aviso(db).ocorrencias).toBe(1);
  });

  it('um RESOLVE velho que chega depois de um RAISE novo não fecha a linha', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    const b = await commit(db, detalhe(1, SEM_PENDENCIA)); // resolveria — efeito atrasado
    const c = await commit(db, detalhe(2, SOLICITADA)); // reabre o estado pendente
    expect(await efeito(db, c)).toBe('aberto');

    expect(await efeito(db, b)).toBe('inalterado');
    expect(aviso(db).resolvidoEm).toBeNull();
    expect(aviso(db).relogioEvento).toBe(microsDeSegundosShopee(T0_S + 2) + 3);
  });

  it('um RAISE velho que chega depois de um RESOLVE novo não reabre a linha', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    const b = await commit(db, detalhe(1, { status: 'PROCESSING' })); // abriria — efeito atrasado
    const c = await commit(db, detalhe(2, ENCERRADA));
    expect(await efeito(db, c)).toBe('resolvido');

    expect(await efeito(db, b)).toBe('inalterado');
    expect(aviso(db).resolvidoEm).not.toBeNull();
    expect(aviso(db).motivo).toBe('REQUESTED');
  });

  it('incidente apagado e recriado num segundo POSTERIOR: o raise da revisão 1 NÃO é descartado', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    await entregar(db, detalhe(1, { status: 'PROCESSING' }));
    await entregar(db, detalhe(2, SOLICITADA));
    const r4 = await entregar(db, detalhe(3, { status: 'PROCESSING' }));
    expect(r4.previsao.confirmado.bloco?.revisao).toBe(4);

    delete db.store[INCIDENTE_PATH];
    const recriada = await entregar(db, detalhe(4, SOLICITADA));
    expect(recriada.previsao.acao).toBe('criado');
    expect(recriada.previsao.confirmado.bloco?.revisao).toBe(1);
    // With a bare `revisao` clock, 1 <= 4 and this raise would be dropped.
    expect(recriada.aviso).toBe('aberto');
    expect(aviso(db).motivo).toBe('REQUESTED');
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) o replay — o handoff do W2: `ignorado-sem-mudanca` re-aplica            */
/* -------------------------------------------------------------------------- */

describe('o replay converge — e não gera churn', () => {
  it('commit ok + falha na escrita do aviso ⇒ a re-entrega (`ignorado-sem-mudanca`) abre o aviso', async () => {
    const db = dbComPedido();
    db.falhasDeCriacao.set(AVISO_PATH, grpc(14, 'UNAVAILABLE'));
    const primeira = await commit(db, detalhe(0));
    expect(primeira.previsao.acao).toBe('criado');
    await expect(efeito(db, primeira)).rejects.toThrow('UNAVAILABLE');
    expect(db.store[AVISO_PATH]).toBeUndefined();

    db.falhasDeCriacao.clear();
    const replay = await entregar(db, detalhe(0));
    expect(replay.previsao.acao).toBe('ignorado-sem-mudanca');
    expect(replay.aviso).toBe('aberto');
    expect(aviso(db).relogioEvento).toBe(microsDeSegundosShopee(T0_S) + 1);
  });

  it('commit ok + falha no RESOLVE ⇒ a re-entrega fecha a linha', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    db.falhasDeUpdate.set(AVISO_PATH, grpc(14, 'UNAVAILABLE'));
    const fechada = await commit(db, detalhe(1, ENCERRADA));
    await expect(efeito(db, fechada)).rejects.toThrow('UNAVAILABLE');
    expect(aviso(db).resolvidoEm).toBeNull();

    db.falhasDeUpdate.clear();
    const replay = await entregar(db, detalhe(1, ENCERRADA));
    expect(replay.previsao.acao).toBe('ignorado-sem-mudanca');
    expect(replay.aviso).toBe('resolvido');
  });

  it('um replay de um efeito que JÁ pousou não escreve nada (relógio IGUAL descartado)', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0));
    db.writes.length = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = await entregar(db, detalhe(0));
      expect(r.previsao.acao).toBe('ignorado-sem-mudanca');
      expect(r.aviso).toBe('inalterado');
    }
    expect(escritasNoAviso(db)).toBe(0);
    expect(aviso(db).ocorrencias).toBe(1);
  });

  it('um replay de um resolve que JÁ pousou não re-resolve nem re-carimba', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0, SOLICITADA));
    await entregar(db, detalhe(1, ENCERRADA));
    db.writes.length = 0;
    const r = await entregar(db, detalhe(1, ENCERRADA));
    expect(r.aviso).toBe('inalterado');
    expect(escritasNoAviso(db)).toBe(0);
  });
});

describe('`relogio-avancado` não projeta — o custo e o resíduo, fixados', () => {
  it('só o relógio andou ⇒ ZERO escritas no aviso (nada de `ocorrencias` + 1)', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0));
    db.writes.length = 0;
    const r = await entregar(db, detalhe(7));
    expect(r.previsao.acao).toBe('relogio-avancado');
    expect(r.aviso).toBe('inalterado');
    expect(escritasNoAviso(db)).toBe(0);
    expect(aviso(db).ocorrencias).toBe(1);
  });

  it('depois de um avanço, o replay naquele relógio refresca a linha UMA vez e depois é descartado', async () => {
    const db = dbComPedido();
    await entregar(db, detalhe(0));
    await entregar(db, detalhe(7)); // relogio-avancado
    const primeiro = await entregar(db, detalhe(7));
    expect(primeiro.previsao.acao).toBe('ignorado-sem-mudanca');
    expect(primeiro.aviso).toBe('aberto');
    expect(aviso(db).ocorrencias).toBe(2);
    expect(aviso(db).relogioEvento).toBe(microsDeSegundosShopee(T0_S + 7) + 1);

    const segundo = await entregar(db, detalhe(7));
    expect(segundo.aviso).toBe('inalterado');
    expect(aviso(db).ocorrencias).toBe(2);
  });

  it('RESÍDUO: efeito perdido + replay com relógio NOVO e conteúdo igual ⇒ continua perdido até um `ignorado-sem-mudanca`', async () => {
    const db = dbComPedido();
    db.falhasDeCriacao.set(AVISO_PATH, grpc(14, 'UNAVAILABLE'));
    await expect(entregar(db, detalhe(0))).rejects.toThrow('UNAVAILABLE');
    db.falhasDeCriacao.clear();

    const avancou = await entregar(db, detalhe(3));
    expect(avancou.previsao.acao).toBe('relogio-avancado');
    expect(avancou.aviso).toBe('inalterado');
    expect(db.store[AVISO_PATH]).toBeUndefined();

    const replay = await entregar(db, detalhe(3));
    expect(replay.previsao.acao).toBe('ignorado-sem-mudanca');
    expect(replay.aviso).toBe('aberto');
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) unidades — este módulo não converte nada (R-10)                        */
/* -------------------------------------------------------------------------- */

describe('unidades — nenhum conversor e nenhum relógio neste módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./avisoDevolucao.ts', import.meta.url)),
    'utf8',
  );
  // Code only: the docblock may NAME the seam it funnels through.
  const codigo = fonte
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*\*|\/\/)/.test(l))
    .join('\n');

  it.each(['millisToMicros', 'coerceToMicros', 'microsDeSegundosShopee', 'Date.now', 'new Date'])(
    'o código não chama %s',
    (nome) => {
      expect(codigo).not.toContain(nome);
    },
  );

  it('o "agora" atravessa pelo seam de avisos/autorizacao.ts', () => {
    expect(codigo).toContain("from '../avisos/autorizacao'");
    expect(codigo).toContain('depsDeEscrita(deps)');
    expect(codigo).toContain('agoraUsDe(deps)');
  });
});

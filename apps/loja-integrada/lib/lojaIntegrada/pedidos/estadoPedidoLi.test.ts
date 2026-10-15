import { temMovimentoAplicado } from '@delfrance/data/pedido';
import type { SituacaoHistoricoLinhaLi } from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_PEDIDO,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  STATUS_PAGAMENTO,
  estoqueAplicadoSchema,
  type EstadoPedido,
  type StatusPagamento,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { dataLiParaMicros } from './dataLi';
import {
  LACUNA_HISTORICO_LI,
  MODO_HISTORICO_LI,
  MOTIVO_ESTADO_LI,
  MOTIVO_STATUS_LI,
  PREFIXO_ERRO_LI,
  alvoEstadoLi,
  decidirEstadoLi,
  estadoLiAplicavel,
  lerHistoricoLi,
  modoHistoricoLi,
  remocaoAplicadaLi,
  statusPagamentoLiAplicavel,
  type LeituraHistoricoLi,
  type ModoHistoricoLi,
} from './estadoPedidoLi';

const NUMERO = 165;

/** Codigos by their catalogue id, so a chain reads like the plan's `9→2→4→8`. */
const C: Record<number, string> = {
  9: 'pedido_efetuado',
  2: 'aguardando_pagamento',
  3: 'pagamento_em_analise',
  4: 'pedido_pago',
  6: 'pagamento_em_disputa',
  7: 'pagamento_devolvido',
  8: 'pedido_cancelado',
  11: 'pedido_enviado',
  14: 'pedido_entregue',
  16: 'pedido_chargeback',
  1019: 'cancelamento_solicitado',
  1020: 'pagamento_devolvido_sem_retorno',
};
const c = (id: number): string => C[id] ?? `codigo-${String(id)}`;

/** The stamp of row `i`: one minute apart, from 10:00. */
const data = (i: number) => `2026-03-02T10:${String(i).padStart(2, '0')}:00.000000`;

function linha(
  id: number,
  i: number,
  codigo: number,
  anterior: number | null,
  numero = NUMERO,
): SituacaoHistoricoLinhaLi {
  return {
    id,
    numero,
    data: data(i),
    situacao: { codigo: c(codigo) },
    situacao_anterior: anterior === null ? null : { codigo: c(anterior) },
  };
}

/** A clean chain `9→a→b→…`: one row per step, ids from 100. */
function cadeia(...codigos: number[]): SituacaoHistoricoLinhaLi[] {
  return codigos.slice(1).map((cod, i) => linha(100 + i, i, cod, codigos[i]!));
}

function ler(
  codigoDetalhe: number | string,
  linhas: readonly SituacaoHistoricoLinhaLi[],
  modo: ModoHistoricoLi = MODO_HISTORICO_LI.estrito,
): LeituraHistoricoLi {
  return lerHistoricoLi({
    numero: NUMERO,
    codigoDetalhe: typeof codigoDetalhe === 'number' ? c(codigoDetalhe) : codigoDetalhe,
    linhas,
    modo,
  });
}

function ok(leitura: LeituraHistoricoLi) {
  if (!leitura.ok) throw new Error(`expected a reading, got holes: ${leitura.lacunas.join(',')}`);
  return leitura;
}

/** The estado and status a CREATE gets from a chain ending at its last codigo. */
function criar(...codigos: number[]) {
  const codigo = c(codigos[codigos.length - 1]!);
  const h = ok(ler(codigo, cadeia(...codigos)));
  const d = decidirEstadoLi({ armazenado: null, codigo, capturado: h.capturado });
  return { estado: d.estado, status: d.statusPagamento.criacao, h, d };
}

const us = (i: number) => dataLiParaMicros(data(i));

describe('the queue attempt decides the mode', () => {
  it('strict on attempts 0 and 1; degraded from 2 and in a sweep run (null)', () => {
    expect(modoHistoricoLi(0)).toBe(MODO_HISTORICO_LI.estrito);
    expect(modoHistoricoLi(1)).toBe(MODO_HISTORICO_LI.estrito);
    expect(modoHistoricoLi(2)).toBe(MODO_HISTORICO_LI.degradado);
    expect(modoHistoricoLi(7)).toBe(MODO_HISTORICO_LI.degradado);
    expect(modoHistoricoLi(null)).toBe(MODO_HISTORICO_LI.degradado);
  });
});

describe('the history verdict: captured or not', () => {
  it('9→2→8 ⇒ not captured ⇒ cancelado / cancelado', () => {
    const r = criar(9, 2, 8);
    expect(r.h.capturado).toBe(false);
    expect(r.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(r.status).toBe(STATUS_PAGAMENTO.cancelado);
  });

  it('9→2→4→8 ⇒ captured ⇒ estornadoIntegralmente / estornado', () => {
    const r = criar(9, 2, 4, 8);
    expect(r.h.capturado).toBe(true);
    expect(r.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(r.status).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('⚠️ 9→2→6→8 ⇒ estornadoIntegralmente / estornado: a dispute is capture evidence', () => {
    const r = criar(9, 2, 6, 8);
    expect(r.h.capturado).toBe(true);
    expect(r.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(r.status).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('the chargeback and the refund without return are capture evidence too', () => {
    for (const evid of [16, 1020]) {
      expect(ok(ler(8, cadeia(9, 2, evid, 8))).capturado, String(evid)).toBe(true);
    }
  });

  it('a capture codigo counts as a row’s situação AND as the situação a row left', () => {
    // The dispute row's successor lost its link (it says it left 2): only the row itself shows 6.
    const soComoSituacao = [linha(100, 0, 2, 9), linha(101, 1, 6, 2), linha(102, 2, 8, 2)];
    expect(ok(ler(8, soComoSituacao, MODO_HISTORICO_LI.degradado)).capturado).toBe(true);
    // A truncated start: only the first row's previous situação shows the payment.
    expect(ok(ler(8, [linha(100, 0, 8, 4)], MODO_HISTORICO_LI.degradado)).capturado).toBe(true);
  });

  it('⚠️ an entry NEWER than the detail is decided at the cut, never on the whole history', () => {
    // The detail still says 2; the history, read after it, already shows the payment.
    const h = ok(ler(2, cadeia(9, 2, 4)));
    expect(h.corte.map((l) => l.codigo)).toEqual([c(2)]);
    expect(h.capturado).toBe(false);
    expect(h.dataAprovacao).toEqual({ derivavel: true, us: null });
    const d = decidirEstadoLi({ armazenado: null, codigo: c(2), capturado: h.capturado });
    expect(d.estado).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('the cut is the LAST row reaching the detail’s codigo', () => {
    // 4 → 6 → 4: the order is paid again after the dispute closed.
    const h = ok(ler(4, cadeia(9, 2, 4, 6, 4)));
    expect(h.corte).toHaveLength(4);
  });

  it('an order still at pedido_efetuado has an empty cut, even with newer rows', () => {
    const h = ok(ler(9, cadeia(9, 2, 4)));
    expect(h.corte).toEqual([]);
    expect(h.capturado).toBe(false);
    expect(h.lacunas).toEqual([]);
    expect(ok(ler(9, [])).corte).toEqual([]);
  });

  it('rows are ordered by instant then id, whatever order they arrive in', () => {
    const h = ok(ler(8, [...cadeia(9, 2, 4, 8)].reverse()));
    expect(h.corte.map((l) => l.codigo)).toEqual([c(2), c(4), c(8)]);
  });
});

describe('the dates', () => {
  it('approval: the FIRST row reaching a capture-evidence codigo', () => {
    const h = ok(ler(14, cadeia(9, 2, 4, 11, 14)));
    expect(h.dataAprovacao).toEqual({ derivavel: true, us: us(1) });
  });

  it('cancellation: the row reaching the detail’s reversal codigo', () => {
    const h = ok(ler(8, cadeia(9, 2, 4, 8)));
    expect(h.dataCancelamento).toEqual({ derivavel: true, us: us(2) });
  });

  it('⚠️ NEAR-MISS: no cancellation date while the detail is not a reversal (a resurrected sale)', () => {
    const h = ok(ler(4, cadeia(9, 2, 8, 4)));
    expect(h.dataCancelamento).toEqual({ derivavel: true, us: null });
  });

  it('no approval date for an order never captured', () => {
    expect(ok(ler(8, cadeia(9, 2, 8))).dataAprovacao).toEqual({ derivavel: true, us: null });
  });
});

describe('strict and degraded: a hole retries twice, then imports with its dates not derivable', () => {
  /** The detail says 11 (shipped); the history never recorded it. */
  const lacunar = cadeia(9, 2, 4);

  it('strict (attempt 0): the detail codigo absent from the history ⇒ refused, retried', () => {
    expect(ler(11, lacunar)).toEqual({ ok: false, lacunas: [LACUNA_HISTORICO_LI.codigoAusente] });
  });

  it('degraded (attempt 2, or a sweep): the same hole ⇒ decided from the detail codigo', () => {
    const h = ok(ler(11, lacunar, MODO_HISTORICO_LI.degradado));
    expect(h.lacunas).toEqual([LACUNA_HISTORICO_LI.codigoAusente]);
    expect(h.capturado).toBe(true);
    // The approval row is BEFORE the hole: still derivable.
    expect(h.dataAprovacao).toEqual({ derivavel: true, us: us(1) });
  });

  it('degraded: a reversal the history never recorded ⇒ the cancellation date is NOT derivable', () => {
    const h = ok(ler(8, cadeia(9, 2), MODO_HISTORICO_LI.degradado));
    expect(h.dataCancelamento).toEqual({ derivavel: false });
    expect(h.capturado).toBe(false);
  });

  it('a broken chain: strict refuses; degraded keeps the dates only when the break cannot hide them', () => {
    // 9→2, then a row leaving 4 for 11: the step into 4 is missing.
    const quebrada = [linha(100, 0, 2, 9), linha(101, 1, 11, 4)];
    expect(ler(11, quebrada)).toEqual({ ok: false, lacunas: [LACUNA_HISTORICO_LI.cadeiaQuebrada] });
    const h = ok(ler(11, quebrada, MODO_HISTORICO_LI.degradado));
    expect(h.capturado).toBe(true);
    // The first capture row is AT the break: an earlier capture may be hidden.
    expect(h.dataAprovacao).toEqual({ derivavel: false });
  });

  it('⚠️ NEAR-MISS: a break AFTER the approval row leaves the approval date derivable', () => {
    const rows = [linha(100, 0, 2, 9), linha(101, 1, 4, 2), linha(102, 2, 14, 11)];
    const h = ok(ler(14, rows, MODO_HISTORICO_LI.degradado));
    expect(h.dataAprovacao).toEqual({ derivavel: true, us: us(1) });
  });

  it('a truncated start counts its first row’s previous situação as capture evidence', () => {
    const truncada = [linha(100, 0, 8, 4)];
    expect(ler(8, truncada)).toEqual({ ok: false, lacunas: [LACUNA_HISTORICO_LI.inicioTruncado] });
    const h = ok(ler(8, truncada, MODO_HISTORICO_LI.degradado));
    expect(h.capturado).toBe(true);
    expect(h.dataAprovacao).toEqual({ derivavel: false });
    expect(h.dataCancelamento).toEqual({ derivavel: true, us: us(0) });
  });

  it('an unreadable row date, or a row of another order, is dropped and makes every date underivable', () => {
    const ilegivel = { ...linha(102, 2, 8, 4), data: '2026-03-02 10:02:00' };
    expect(ler(8, [...cadeia(9, 2, 4), ilegivel])).toEqual({
      ok: false,
      lacunas: [LACUNA_HISTORICO_LI.dataIlegivel, LACUNA_HISTORICO_LI.codigoAusente],
    });
    const h = ok(
      ler(8, [...cadeia(9, 2, 4, 8), linha(900, 9, 4, 8, 999)], MODO_HISTORICO_LI.degradado),
    );
    expect(h.lacunas).toEqual([LACUNA_HISTORICO_LI.numeroDivergente]);
    expect(h.dataAprovacao).toEqual({ derivavel: false });
    expect(h.dataCancelamento).toEqual({ derivavel: false });
  });

  it('a repeated row id keeps its first copy, and is not a hole', () => {
    const rows = cadeia(9, 2, 4);
    expect(ok(ler(4, [...rows, rows[1]!])).corte).toHaveLength(2);
  });

  it('⚠️ a break AFTER the last visible reversal row could hide a later reach of it ⇒ the cancellation date is NOT derivable', () => {
    // 9→2→8, then a row that left 4 (not 8): something between them is missing.
    const rows = [linha(100, 0, 2, 9), linha(101, 1, 8, 2), linha(102, 2, 11, 4)];
    const h = ok(ler(8, rows, MODO_HISTORICO_LI.degradado));
    expect(h.lacunas).toEqual([LACUNA_HISTORICO_LI.cadeiaQuebrada]);
    expect(h.dataCancelamento).toEqual({ derivavel: false });
  });

  it('⚠️ NEAR-MISS: a break BEFORE the reversal row cannot hide a later reach ⇒ the cancellation date is derivable', () => {
    // A row that left 3 for 4 (the step into 3 is missing), then the 8.
    const rows = [linha(100, 0, 2, 9), linha(101, 1, 4, 3), linha(102, 2, 8, 4)];
    const h = ok(ler(8, rows, MODO_HISTORICO_LI.degradado));
    expect(h.lacunas).toEqual([LACUNA_HISTORICO_LI.cadeiaQuebrada]);
    expect(h.dataCancelamento).toEqual({ derivavel: true, us: us(2) });
  });

  it('⚠️ a truncated start whose FIRST row is the capture: an earlier capture row may be cut off ⇒ approval NOT derivable', () => {
    // The first row reached 4 from 2: everything before 2 is missing.
    const rows = [linha(100, 0, 4, 2), linha(101, 1, 11, 4)];
    const h = ok(ler(11, rows, MODO_HISTORICO_LI.degradado));
    expect(h.lacunas).toEqual([LACUNA_HISTORICO_LI.inicioTruncado]);
    expect(h.capturado).toBe(true);
    expect(h.dataAprovacao).toEqual({ derivavel: false });
  });

  it('EQUAL pair: a first row whose previous situação is NULL is a complete start, not a truncation (strict accepts it)', () => {
    const rows = [
      { ...linha(100, 0, 2, 9), situacao_anterior: null },
      linha(101, 1, 4, 2),
    ] satisfies SituacaoHistoricoLinhaLi[];
    const h = ok(ler(4, rows));
    expect(h.lacunas).toEqual([]);
    expect(h.dataAprovacao).toEqual({ derivavel: true, us: us(1) });
    // …the same as a first row that left pedido_efetuado.
    expect(ok(ler(4, cadeia(9, 2, 4))).dataAprovacao).toEqual(h.dataAprovacao);
  });

  it('⚠️ two rows with the SAME stamp arriving newest first: ordered by id, so the chain holds and the cut is right', () => {
    const mesmo = data(0);
    const rows = [
      { ...linha(101, 0, 4, 2), data: mesmo },
      { ...linha(100, 0, 2, 9), data: mesmo },
    ];
    const h = ok(ler(4, rows));
    expect(h.lacunas).toEqual([]);
    expect(h.corte.map((l) => l.id)).toEqual([100, 101]);
    expect(h.capturado).toBe(true);
  });
});

describe('⚠️ an UNKNOWN detail codigo derives no date (its status is kept, so its dates are too)', () => {
  it('9→2→8→xyz: neither date is derivable, so a stored cancellation date survives', () => {
    const rows = [...cadeia(9, 2, 8), { ...linha(102, 2, 8, 8), situacao: { codigo: 'xyz' } }];
    const h = ok(ler('xyz', rows));
    expect(h.dataCancelamento).toEqual({ derivavel: false });
    expect(h.dataAprovacao).toEqual({ derivavel: false });
  });

  it('NEAR-MISS: a KNOWN non-reversal codigo still derives "no cancellation date" (null)', () => {
    expect(ok(ler(4, cadeia(9, 2, 4))).dataCancelamento).toEqual({ derivavel: true, us: null });
  });
});

describe('the codigo: exact, through the shared table', () => {
  it('EQUAL pair: `pedido_pago` is paid on create', () => {
    const d = decidirEstadoLi({ armazenado: null, codigo: 'pedido_pago', capturado: true });
    expect(d.estado).toBe(ESTADO_PEDIDO.pago);
    expect(d.statusPagamento.criacao).toBe(STATUS_PAGAMENTO.aprovado);
  });

  it('⚠️ NEAR-MISS: `Pedido_Pago` and `pedido_pago ` are UNKNOWN codigos', () => {
    for (const codigo of ['Pedido_Pago', 'pedido_pago ', 'toString']) {
      expect(alvoEstadoLi(codigo, true), codigo).toEqual({ tipo: 'desconhecido', codigo });
    }
  });

  it('16 ⇒ devolvido (the charged_back convention), never em_disputa and never estornado', () => {
    const a = alvoEstadoLi('pedido_chargeback', true);
    expect(a.tipo === 'conhecido' && a.statusPagamento).toBe(STATUS_PAGAMENTO.devolvido);
    expect(a.tipo === 'conhecido' && a.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
  });

  it('3 ⇒ em_revisao + emAnalise, never em_processo_aprovacao', () => {
    const a = alvoEstadoLi('pagamento_em_analise', false);
    expect(a.tipo === 'conhecido' && a.statusPagamento).toBe(STATUS_PAGAMENTO.em_revisao);
    expect(a.tipo === 'conhecido' && a.estado).toBe(ESTADO_PEDIDO.emAnalise);
  });

  it('6 ⇒ pago + em_disputa + the contestado aviso (disputa), on create and on update', () => {
    const criado = decidirEstadoLi({ armazenado: null, codigo: c(6), capturado: true });
    expect(criado.estado).toBe(ESTADO_PEDIDO.pago);
    expect(criado.statusPagamento.criacao).toBe(STATUS_PAGAMENTO.em_disputa);
    expect(criado.contestacao).toBe(MOTIVO_PEDIDO_CONTESTADO_LI.disputa);
    const atualizado = decidirEstadoLi({
      armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: { removido: { p: 1 } } },
      codigo: c(6),
      capturado: true,
    });
    expect(atualizado.motivo).toBe(MOTIVO_ESTADO_LI.semMudanca);
    expect(atualizado.contestacao).toBe(MOTIVO_PEDIDO_CONTESTADO_LI.disputa);
    expect(atualizado.statusPagamento.atualizacao).toEqual({
      tipo: 'status',
      status: STATUS_PAGAMENTO.em_disputa,
    });
  });

  it('1019 keeps the stored payment status on update; a new payment: aprovado if captured, else pendente', () => {
    const capturado = decidirEstadoLi({ armazenado: null, codigo: c(1019), capturado: true });
    expect(capturado.estado).toBe(ESTADO_PEDIDO.processandoCancelamento);
    expect(capturado.statusPagamento.criacao).toBe(STATUS_PAGAMENTO.aprovado);
    expect(capturado.statusPagamento.atualizacao).toEqual({ tipo: 'manter' });
    const naoCapturado = decidirEstadoLi({ armazenado: null, codigo: c(1019), capturado: false });
    expect(naoCapturado.statusPagamento.criacao).toBe(STATUS_PAGAMENTO.pendente);
  });
});

describe('an unknown codigo keeps the order and says so', () => {
  it('create ⇒ estado `error`, our error text, a pendente payment, the desconhecida aviso', () => {
    const d = decidirEstadoLi({ armazenado: null, codigo: 'xyz_novo', capturado: false });
    expect(d.estado).toBe(ESTADO_PEDIDO.error);
    expect(d.erro).toEqual({
      tipo: 'definir',
      mensagem: `${PREFIXO_ERRO_LI}situação desconhecida: "xyz_novo"`,
    });
    expect(d.statusPagamento).toEqual({
      criacao: STATUS_PAGAMENTO.pendente,
      atualizacao: { tipo: 'manter' },
    });
    expect(d.situacaoDesconhecida).toBe('xyz_novo');
  });

  it('⚠️ update of a stored `pago` ⇒ estado KEPT (never `error`), error text set, status kept', () => {
    const d = decidirEstadoLi({
      armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: null },
      codigo: 'xyz_novo',
      capturado: true,
    });
    expect(d.estado).toBeNull();
    expect(d.motivo).toBe(MOTIVO_ESTADO_LI.situacaoDesconhecida);
    expect(d.estadoResultante).toBe(ESTADO_PEDIDO.pago);
    expect(d.erro.tipo).toBe('definir');
    expect(d.statusPagamento.atualizacao).toEqual({ tipo: 'manter' });
  });

  it('a known codigo clears (only our own) error and resolves the desconhecida aviso', () => {
    const d = decidirEstadoLi({ armazenado: null, codigo: c(4), capturado: true });
    expect(d.erro).toEqual({ tipo: 'limpar' });
    expect(d.situacaoDesconhecida).toBeNull();
    expect(d.contestacao).toBeNull();
  });
});

describe('⚠️ a refund after an applied removal keeps estado and status, and raises the aviso', () => {
  /** A stock snapshot as the sync writes it: a removal applied. */
  const REMOVIDO = { depositoId: 'd1', ehSaida: true, removido: { produto1: 2 } };
  const SEM_REMOCAO = { depositoId: 'd1', ehSaida: true, removido: {} };

  it.each([
    [1020, true, MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno, STATUS_PAGAMENTO.estornado],
    [16, true, MOTIVO_PEDIDO_CONTESTADO_LI.chargeback, STATUS_PAGAMENTO.devolvido],
    [7, true, MOTIVO_PEDIDO_CONTESTADO_LI.devolvido, STATUS_PAGAMENTO.estornado],
  ] as const)(
    'codigo %s: with the removal ⇒ kept + aviso; without it ⇒ reversed, no aviso',
    (cod, cap, motivo, status) => {
      const mantido = decidirEstadoLi({
        armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: REMOVIDO },
        codigo: c(cod),
        capturado: cap,
      });
      expect(mantido.estado).toBeNull();
      expect(mantido.motivo).toBe(MOTIVO_ESTADO_LI.contestadoAposRemocao);
      expect(mantido.estadoResultante).toBe(ESTADO_PEDIDO.pago);
      expect(mantido.statusPagamento.atualizacao).toEqual({ tipo: 'manter' });
      expect(mantido.contestacao).toBe(motivo);

      const revertido = decidirEstadoLi({
        armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: SEM_REMOCAO },
        codigo: c(cod),
        capturado: cap,
      });
      expect(revertido.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
      expect(revertido.statusPagamento.atualizacao).toEqual({ tipo: 'status', status });
      expect(revertido.contestacao).toBeNull();
    },
  );

  it('⚠️ NEAR-MISS: an UNCAPTURED 7 after a removal is a cancellation, never kept', () => {
    const d = decidirEstadoLi({
      armazenado: {
        estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        estoqueAplicado: REMOVIDO,
      },
      codigo: c(7),
      capturado: false,
    });
    expect(d.estado).toBe(ESTADO_PEDIDO.cancelado);
    expect(d.contestacao).toBeNull();
  });

  it('⚠️ a stored PAGO is capture evidence the history may have lost: 7 after a removal is KEPT, even with an empty degraded history', () => {
    // Degraded mode, nothing read: the history alone cannot say the payment was captured.
    const h = ok(ler(7, [], MODO_HISTORICO_LI.degradado));
    expect(h.capturado).toBe(false);
    const d = decidirEstadoLi({
      armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: REMOVIDO },
      codigo: c(7),
      capturado: h.capturado,
    });
    expect(d.estado).toBeNull();
    expect(d.motivo).toBe(MOTIVO_ESTADO_LI.contestadoAposRemocao);
    expect(d.statusPagamento.atualizacao).toEqual({ tipo: 'manter' });
    // A payment seen for the first time is the CAPTURED refund, never a cancellation.
    expect(d.statusPagamento.criacao).toBe(STATUS_PAGAMENTO.estornado);
    expect(d.contestacao).toBe(MOTIVO_PEDIDO_CONTESTADO_LI.devolvido);
    // …and without the removal it is the uncaptured arm, as on create.
    const semRemocao = decidirEstadoLi({
      armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: SEM_REMOCAO },
      codigo: c(7),
      capturado: false,
    });
    expect(semRemocao.estado).toBe(ESTADO_PEDIDO.cancelado);
  });

  it('⚠️ NEAR-MISS: a cancellation (8) is not a refund-type codigo: it reverses even after a removal', () => {
    const d = decidirEstadoLi({
      armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: REMOVIDO },
      codigo: c(8),
      capturado: true,
    });
    expect(d.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
  });

  it.each([
    [1020, STATUS_PAGAMENTO.estornado],
    [16, STATUS_PAGAMENTO.devolvido],
    [7, STATUS_PAGAMENTO.estornado],
  ] as const)(
    '⚠️ a NEW payment on the kept arm (codigo %s) takes the table’s refund status: it pays nothing, so Σ paid stays the kept payments’',
    (cod, status) => {
      const d = decidirEstadoLi({
        armazenado: { estado: ESTADO_PEDIDO.pago, estoqueAplicado: REMOVIDO },
        codigo: c(cod),
        capturado: true,
      });
      expect(d.statusPagamento).toEqual({ criacao: status, atualizacao: { tipo: 'manter' } });
    },
  );

  it('a create has no removal: the refund codigo takes its table row', () => {
    const d = decidirEstadoLi({ armazenado: null, codigo: c(1020), capturado: true });
    expect(d.estado).toBe(ESTADO_PEDIDO.estornadoIntegralmente);
    expect(d.contestacao).toBeNull();
  });

  it('remocaoAplicadaLi IS the stock sync’s predicate: the snapshot parsed as the sync parses it, then `temMovimentoAplicado`', () => {
    const snapshots: unknown[] = [
      REMOVIDO,
      SEM_REMOCAO,
      { ...SEM_REMOCAO, adicionado: { a: 1 } },
      { ...SEM_REMOCAO, removido: null, reservado: { a: 1 } },
      { depositoId: 'd1', ehSaida: true },
    ];
    for (const s of snapshots) {
      const parsed = estoqueAplicadoSchema.parse(s);
      expect(remocaoAplicadaLi(s), JSON.stringify(s)).toBe(temMovimentoAplicado(parsed));
    }
    expect(remocaoAplicadaLi(REMOVIDO)).toBe(true);
  });

  it('⚠️ NEAR-MISS: a reservation, an empty map or a snapshot the sync itself refuses is NOT applied', () => {
    for (const nao of [
      SEM_REMOCAO,
      { ...SEM_REMOCAO, removido: null, reservado: { a: 1 } },
      // The sync refuses these snapshots outright ('estoqueAplicado inválido'): it never restocks them.
      { removido: { produto1: 2 } },
      { ...REMOVIDO, campoEstranho: 1 },
      { ...REMOVIDO, removido: [1] },
      {},
      null,
      'x',
    ]) {
      expect(remocaoAplicadaLi(nao), JSON.stringify(nao)).toBe(false);
    }
  });
});

describe('⚠️ a refund-type codigo on an estado the business owns raises the aviso (the operator must learn of it)', () => {
  it.each([
    [16, MOTIVO_PEDIDO_CONTESTADO_LI.chargeback],
    [1020, MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno],
    [7, MOTIVO_PEDIDO_CONTESTADO_LI.devolvido],
  ] as const)(
    'stored finalizado (no removal) + codigo %s ⇒ estado kept, aviso raised',
    (cod, motivo) => {
      const d = decidirEstadoLi({
        armazenado: { estado: ESTADO_PEDIDO.finalizado, estoqueAplicado: null },
        codigo: c(cod),
        capturado: true,
      });
      expect(d.estado).toBeNull();
      expect(d.motivo).toBe(MOTIVO_ESTADO_LI.foraDaEscada);
      expect(d.contestacao).toBe(motivo);
    },
  );

  it('NEAR-MISS: a paid codigo on the same finalizado raises nothing; a cancellation (8) has no motivo to raise', () => {
    for (const cod of [4, 8]) {
      const d = decidirEstadoLi({
        armazenado: { estado: ESTADO_PEDIDO.finalizado, estoqueAplicado: null },
        codigo: c(cod),
        capturado: true,
      });
      expect(d.motivo, String(cod)).toBe(MOTIVO_ESTADO_LI.foraDaEscada);
      expect(d.contestacao, String(cod)).toBeNull();
    }
  });
});

describe('the estado ladder', () => {
  const escreve = (de: unknown, para: EstadoPedido, capturado = false) =>
    estadoLiAplicavel(de, para, capturado);

  it('⚠️ a CAPTURED pedido at processandoCancelamento never drops below pago: 4→1019→2 is a painel reversal (regressivo)', () => {
    for (const abaixo of [
      ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      ESTADO_PEDIDO.emAnalise,
      ESTADO_PEDIDO.carrinho,
    ]) {
      expect(escreve(ESTADO_PEDIDO.processandoCancelamento, abaixo, true), abaixo).toEqual({
        escrever: false,
        motivo: MOTIVO_ESTADO_LI.regressivo,
      });
    }
    // Back to pago is still allowed, captured or not.
    expect(escreve(ESTADO_PEDIDO.processandoCancelamento, ESTADO_PEDIDO.pago, true)).toMatchObject({
      escrever: true,
    });
  });

  it('⚠️ NEAR-MISS: an UNCAPTURED 2→1019→2 (a request on an unpaid order, withdrawn) is written', () => {
    expect(
      escreve(
        ESTADO_PEDIDO.processandoCancelamento,
        ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
        false,
      ),
    ).toEqual({
      escrever: true,
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      ressuscitado: false,
    });
  });

  it('end to end through the history: 9→2→4→1019→2 keeps the estado; 9→2→1019→2 moves it', () => {
    const armazenado = { estado: ESTADO_PEDIDO.processandoCancelamento, estoqueAplicado: null };
    const pago = ok(ler(2, cadeia(9, 2, 4, 1019, 2)));
    expect(pago.capturado).toBe(true);
    const mantido = decidirEstadoLi({ armazenado, codigo: c(2), capturado: pago.capturado });
    expect(mantido.estado).toBeNull();
    expect(mantido.motivo).toBe(MOTIVO_ESTADO_LI.regressivo);
    const naoPago = ok(ler(2, cadeia(9, 2, 1019, 2)));
    expect(naoPago.capturado).toBe(false);
    const movido = decidirEstadoLi({ armazenado, codigo: c(2), capturado: naoPago.capturado });
    expect(movido.estado).toBe(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento);
  });

  it('stored finalizado + a paid codigo ⇒ unchanged (the business owns it)', () => {
    expect(escreve(ESTADO_PEDIDO.finalizado, ESTADO_PEDIDO.pago)).toEqual({
      escrever: false,
      motivo: MOTIVO_ESTADO_LI.foraDaEscada,
    });
  });

  it('stored pago + 2 (a painel reversal) ⇒ unchanged, regressivo (a WARNING)', () => {
    expect(escreve(ESTADO_PEDIDO.pago, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento)).toEqual({
      escrever: false,
      motivo: MOTIVO_ESTADO_LI.regressivo,
    });
    expect(escreve(ESTADO_PEDIDO.pago, ESTADO_PEDIDO.emAnalise)).toMatchObject({ escrever: false });
  });

  it('cancelado + 4 ⇒ pago, ressuscitado', () => {
    expect(escreve(ESTADO_PEDIDO.cancelado, ESTADO_PEDIDO.pago)).toEqual({
      escrever: true,
      estado: ESTADO_PEDIDO.pago,
      ressuscitado: true,
    });
  });

  it('forward on the ladder; pago ↔ processandoCancelamento both ways; error ↔ anything', () => {
    expect(
      escreve(ESTADO_PEDIDO.carrinho, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento),
    ).toMatchObject({ escrever: true });
    expect(escreve(ESTADO_PEDIDO.pago, ESTADO_PEDIDO.processandoCancelamento)).toMatchObject({
      escrever: true,
    });
    expect(escreve(ESTADO_PEDIDO.processandoCancelamento, ESTADO_PEDIDO.pago)).toMatchObject({
      escrever: true,
      ressuscitado: false,
    });
    expect(
      escreve(ESTADO_PEDIDO.error, ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento),
    ).toMatchObject({ escrever: true });
    expect(escreve(ESTADO_PEDIDO.pago, ESTADO_PEDIDO.estornadoIntegralmente)).toMatchObject({
      escrever: true,
      ressuscitado: false,
    });
  });

  it('already there ⇒ sem-mudanca; a stored value that is not an estado ⇒ never moved', () => {
    expect(escreve(ESTADO_PEDIDO.pago, ESTADO_PEDIDO.pago)).toEqual({
      escrever: false,
      motivo: MOTIVO_ESTADO_LI.semMudanca,
    });
    expect(escreve('pagoo', ESTADO_PEDIDO.pago)).toEqual({
      escrever: false,
      motivo: MOTIVO_ESTADO_LI.foraDaEscada,
    });
    expect(escreve(undefined, ESTADO_PEDIDO.pago)).toEqual({
      escrever: false,
      motivo: MOTIVO_ESTADO_LI.foraDaEscada,
    });
  });
});

describe('the payment-status ladder', () => {
  const para = (status: StatusPagamento) => ({ tipo: 'status', status }) as const;

  it('a paid status never regresses to pendente or em_revisao', () => {
    for (const pago of [STATUS_PAGAMENTO.aprovado, STATUS_PAGAMENTO.em_disputa]) {
      for (const antes of [STATUS_PAGAMENTO.pendente, STATUS_PAGAMENTO.em_revisao]) {
        expect(statusPagamentoLiAplicavel(pago, para(antes))).toEqual({
          escrever: false,
          motivo: MOTIVO_STATUS_LI.regressivo,
        });
      }
    }
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.em_revisao, para(STATUS_PAGAMENTO.pendente)),
    ).toMatchObject({ escrever: false });
  });

  it('a dead status may be left (ressuscitado); a dead target always writes', () => {
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.devolvido, para(STATUS_PAGAMENTO.aprovado)),
    ).toEqual({
      escrever: true,
      status: STATUS_PAGAMENTO.aprovado,
      ressuscitado: true,
    });
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.cancelado, para(STATUS_PAGAMENTO.pendente)),
    ).toMatchObject({ escrever: true });
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.aprovado, para(STATUS_PAGAMENTO.estornado)),
    ).toMatchObject({ escrever: true, ressuscitado: false });
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.aprovado, para(STATUS_PAGAMENTO.em_disputa)),
    ).toMatchObject({ escrever: true });
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.em_disputa, para(STATUS_PAGAMENTO.aprovado)),
    ).toMatchObject({ escrever: true });
  });

  it('an off-ladder stored status is never moved; a stored null always is', () => {
    for (const operador of [
      STATUS_PAGAMENTO.recusado,
      STATUS_PAGAMENTO.pago_parcialmente,
      STATUS_PAGAMENTO.em_processo_aprovacao,
      'x',
    ]) {
      expect(
        statusPagamentoLiAplicavel(operador, para(STATUS_PAGAMENTO.aprovado)),
        String(operador),
      ).toEqual({
        escrever: false,
        motivo: MOTIVO_STATUS_LI.foraDaEscada,
      });
    }
    expect(statusPagamentoLiAplicavel(null, para(STATUS_PAGAMENTO.pendente))).toMatchObject({
      escrever: true,
    });
    expect(statusPagamentoLiAplicavel(undefined, para(STATUS_PAGAMENTO.pendente))).toMatchObject({
      escrever: true,
    });
  });

  it('manter and sem-mudanca write nothing', () => {
    expect(statusPagamentoLiAplicavel(STATUS_PAGAMENTO.aprovado, { tipo: 'manter' })).toEqual({
      escrever: false,
      motivo: MOTIVO_STATUS_LI.manter,
    });
    expect(
      statusPagamentoLiAplicavel(STATUS_PAGAMENTO.aprovado, para(STATUS_PAGAMENTO.aprovado)),
    ).toEqual({ escrever: false, motivo: MOTIVO_STATUS_LI.semMudanca });
  });
});

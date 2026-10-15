import { describe, expect, it } from 'vitest';
import { MOTIVO_PEDIDO_CONTESTADO_LI } from './aviso';
import {
  STATUS_PAGAMENTO,
  isPagamentoPagante,
  statusToEstadoPedido,
} from './pedido/collection/pagamento';
import { ESTADO_PEDIDO } from './pedido/collection/pedido';
import { ESTADOS_PEDIDO_MOVIMENTACAO, ESTADOS_PEDIDO_RESERVA } from './pedido/pureLogic/estoque';
import {
  CODIGO_LI_CANCELADO,
  CODIGO_LI_CANCELAMENTO_SOLICITADO,
  CODIGO_LI_EM_DISPUTA,
  CODIGO_SITUACAO_LI,
  CODIGOS_LI_CAPTURADO,
  CODIGOS_LI_ESTORNO,
  CODIGOS_LI_PAGO,
  SITUACOES_LI,
  alvoDeCriacaoLi,
  codigoSituacaoLiSchema,
  situacaoLi,
  type CodigoSituacaoLi,
} from './situacaoPedidoLojaIntegrada';

/**
 * The platform's situação catalogue as the read-only `GET /v1/situacao` capture
 * (C3) returned it — byte-identical on both stores — transcribed to its
 * codigo, id and three flags. Only platform-wide catalogue data: the `nome`
 * labels and everything store-specific are left out.
 */
const CATALOGO_C3: readonly {
  readonly codigo: string;
  readonly id: number;
  readonly aprovado: boolean;
  readonly cancelado: boolean;
  readonly final: boolean;
}[] = [
  { codigo: 'aguardando_pagamento', id: 2, aprovado: false, cancelado: false, final: false },
  { codigo: 'cancelamento_solicitado', id: 1019, aprovado: false, cancelado: true, final: false },
  { codigo: 'em_producao', id: 17, aprovado: true, cancelado: false, final: false },
  { codigo: 'faturado', id: 1018, aprovado: true, cancelado: false, final: false },
  { codigo: 'pagamento_devolvido', id: 7, aprovado: false, cancelado: true, final: true },
  {
    codigo: 'pagamento_devolvido_sem_retorno',
    id: 1020,
    aprovado: true,
    cancelado: false,
    final: true,
  },
  { codigo: 'pagamento_em_analise', id: 3, aprovado: false, cancelado: false, final: false },
  { codigo: 'pedido_chargeback', id: 16, aprovado: true, cancelado: false, final: true },
  { codigo: 'pagamento_em_disputa', id: 6, aprovado: true, cancelado: false, final: false },
  { codigo: 'pedido_cancelado', id: 8, aprovado: false, cancelado: true, final: true },
  { codigo: 'pedido_efetuado', id: 9, aprovado: false, cancelado: false, final: false },
  { codigo: 'pedido_em_separacao', id: 15, aprovado: true, cancelado: false, final: false },
  { codigo: 'pedido_entregue', id: 14, aprovado: true, cancelado: false, final: true },
  { codigo: 'pedido_enviado', id: 11, aprovado: true, cancelado: false, final: true },
  { codigo: 'pedido_pago', id: 4, aprovado: true, cancelado: false, final: false },
  { codigo: 'pronto_para_retirada', id: 13, aprovado: true, cancelado: false, final: true },
];

const E = ESTADO_PEDIDO;
const S = STATUS_PAGAMENTO;
const M = MOTIVO_PEDIDO_CONTESTADO_LI;

/**
 * EVERY row, pinned whole: `[codigo, id, estado (captured, not), status
 * (captured, not), keeps the stored status on update, contest motivo]`. A row
 * whose answer does not depend on capture repeats it.
 */
const TABELA: readonly [
  CodigoSituacaoLi,
  number,
  [string, string],
  [number, number],
  boolean,
  string | null,
][] = [
  ['pedido_efetuado', 9, [E.carrinho, E.carrinho], [S.pendente, S.pendente], false, null],
  [
    'aguardando_pagamento',
    2,
    [E.aguardandoConfirmacaoDePagamento, E.aguardandoConfirmacaoDePagamento],
    [S.pendente, S.pendente],
    false,
    null,
  ],
  [
    'pagamento_em_analise',
    3,
    [E.emAnalise, E.emAnalise],
    [S.em_revisao, S.em_revisao],
    false,
    null,
  ],
  ['pedido_pago', 4, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['faturado', 1018, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['em_producao', 17, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['pedido_em_separacao', 15, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['pedido_enviado', 11, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['pronto_para_retirada', 13, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['pedido_entregue', 14, [E.pago, E.pago], [S.aprovado, S.aprovado], false, null],
  ['pagamento_em_disputa', 6, [E.pago, E.pago], [S.em_disputa, S.em_disputa], false, M.disputa],
  [
    'cancelamento_solicitado',
    1019,
    [E.processandoCancelamento, E.processandoCancelamento],
    [S.aprovado, S.pendente],
    true,
    null,
  ],
  [
    'pedido_cancelado',
    8,
    [E.estornadoIntegralmente, E.cancelado],
    [S.estornado, S.cancelado],
    false,
    null,
  ],
  [
    'pagamento_devolvido',
    7,
    [E.estornadoIntegralmente, E.cancelado],
    [S.estornado, S.cancelado],
    false,
    M.devolvido,
  ],
  [
    'pedido_chargeback',
    16,
    [E.estornadoIntegralmente, E.estornadoIntegralmente],
    [S.devolvido, S.devolvido],
    false,
    M.chargeback,
  ],
  [
    'pagamento_devolvido_sem_retorno',
    1020,
    [E.estornadoIntegralmente, E.estornadoIntegralmente],
    [S.estornado, S.estornado],
    false,
    M.devolvidoSemRetorno,
  ],
];

const codigos = (pred: (c: (typeof CATALOGO_C3)[number]) => boolean) =>
  CATALOGO_C3.filter(pred)
    .map((c) => c.codigo)
    .sort();

describe('SITUACOES_LI against the captured catalogue (C3)', () => {
  it('has exactly one row per captured codigo, keyed by it, with its id', () => {
    expect(Object.keys(SITUACOES_LI).sort()).toEqual(codigos(() => true));
    expect([...codigoSituacaoLiSchema.options].sort()).toEqual(codigos(() => true));
    expect(Object.values(CODIGO_SITUACAO_LI).sort()).toEqual(codigos(() => true));
    for (const c of CATALOGO_C3) {
      const linha = SITUACOES_LI[c.codigo as CodigoSituacaoLi];
      expect(linha.codigo, c.codigo).toBe(c.codigo);
      expect(linha.id, c.codigo).toBe(c.id);
    }
  });

  it('CODIGOS_LI_CAPTURADO is exactly the `aprovado: true` set', () => {
    expect([...CODIGOS_LI_CAPTURADO].sort()).toEqual(codigos((c) => c.aprovado));
  });

  it('CODIGOS_LI_PAGO is that set minus the dispute, the chargeback and the refund without return', () => {
    const naoPagos = new Set([
      'pagamento_em_disputa',
      'pedido_chargeback',
      'pagamento_devolvido_sem_retorno',
    ]);
    expect([...CODIGOS_LI_PAGO].sort()).toEqual(
      codigos((c) => c.aprovado && !naoPagos.has(c.codigo)),
    );
    expect(CODIGOS_LI_PAGO.size).toBe(7);
  });

  it('no rung is read from a flag: identical flags, different verdicts', () => {
    const flags = (codigo: string) => {
      const c = CATALOGO_C3.find((x) => x.codigo === codigo);
      return [c?.aprovado, c?.cancelado, c?.final];
    };
    // A delivered order and a chargeback carry the SAME three flags…
    expect(flags('pedido_entregue')).toEqual(flags('pedido_chargeback'));
    expect(flags('pedido_enviado')).toEqual(flags('pagamento_devolvido_sem_retorno'));
    // …and opposite outcomes.
    expect(SITUACOES_LI.pedido_entregue.estado.capturado).toBe(E.pago);
    expect(SITUACOES_LI.pedido_chargeback.estado.capturado).toBe(E.estornadoIntegralmente);
    expect(SITUACOES_LI.pedido_enviado.statusPagamento.capturado).toBe(S.aprovado);
    expect(SITUACOES_LI.pagamento_devolvido_sem_retorno.statusPagamento.capturado).toBe(
      S.estornado,
    );
    // `cancelado: true` on a request that is not final is NOT a cancellation.
    expect(flags('cancelamento_solicitado')).toEqual([false, true, false]);
    expect(SITUACOES_LI.cancelamento_solicitado.estado.capturado).toBe(E.processandoCancelamento);
  });
});

describe('SITUACOES_LI, row by row', () => {
  it.each(TABELA)(
    '%s (%i)',
    (codigo, id, [estadoCap, estadoNao], [statusCap, statusNao], mantem, motivo) => {
      expect(SITUACOES_LI[codigo]).toEqual({
        codigo,
        id,
        estado: { capturado: estadoCap, naoCapturado: estadoNao },
        statusPagamento: { capturado: statusCap, naoCapturado: statusNao },
        mantemStatusArmazenado: mantem,
        motivoContestacao: motivo,
      });
    },
  );

  it('the pin above covers the whole table', () => {
    expect(TABELA.map(([c]) => c).sort()).toEqual(Object.keys(SITUACOES_LI).sort());
  });
});

describe('the near-misses the payment-status convention must keep apart', () => {
  it('3 is em_revisao + emAnalise — never em_processo_aprovacao, never an awaiting rung', () => {
    const r = alvoDeCriacaoLi('pagamento_em_analise', false);
    expect(r).toEqual({ estado: E.emAnalise, statusPagamento: S.em_revisao });
    expect(r?.statusPagamento).not.toBe(S.em_processo_aprovacao);
    expect(r?.estado).not.toBe(E.aguardandoConfirmacaoDePagamento);
  });

  it('16 is devolvido — never estornado, never em_disputa', () => {
    const r = alvoDeCriacaoLi('pedido_chargeback', false);
    expect(r?.statusPagamento).toBe(S.devolvido);
    expect(r?.statusPagamento).not.toBe(S.estornado);
    expect(r?.statusPagamento).not.toBe(S.em_disputa);
    expect(r?.estado).toBe(E.estornadoIntegralmente);
  });

  it('7 and 1020 are estornado; 6 is em_disputa on a pago order (a hold)', () => {
    expect(alvoDeCriacaoLi('pagamento_devolvido', true)?.statusPagamento).toBe(S.estornado);
    expect(alvoDeCriacaoLi('pagamento_devolvido_sem_retorno', false)?.statusPagamento).toBe(
      S.estornado,
    );
    expect(alvoDeCriacaoLi('pagamento_em_disputa', false)).toEqual({
      estado: E.pago,
      statusPagamento: S.em_disputa,
    });
  });

  it('1019 is processandoCancelamento — never cancelado — and keeps the stored status', () => {
    const linha = situacaoLi('cancelamento_solicitado');
    expect(linha?.estado.capturado).toBe(E.processandoCancelamento);
    expect(linha?.estado.naoCapturado).toBe(E.processandoCancelamento);
    expect(linha?.estado.capturado).not.toBe(E.cancelado);
    expect(linha?.mantemStatusArmazenado).toBe(true);
    // Near-miss: no other row keeps the stored status.
    expect(Object.values(SITUACOES_LI).filter((l) => l.mantemStatusArmazenado)).toHaveLength(1);
  });

  it('an unknown codigo is null — not an `error` estado, not an exception', () => {
    expect(situacaoLi('xyz_novo')).toBeNull();
    expect(alvoDeCriacaoLi('xyz_novo', true)).toBeNull();
    expect(alvoDeCriacaoLi('xyz_novo', false)).toBeNull();
  });

  it.each([
    ['a case fold', 'Pedido_Pago'],
    ['a trailing space', 'pedido_pago '],
    ['a leading space', ' pedido_pago'],
    ['an inherited name', 'toString'],
    ['the prototype key', '__proto__'],
    ['the constructor', 'constructor'],
    ['an empty string', ''],
    ['the numeric id as text', '4'],
  ])('near-miss: %s is unknown (exact match only)', (_caso, codigo) => {
    expect(situacaoLi(codigo)).toBeNull();
    expect(CODIGOS_LI_PAGO.has(codigo)).toBe(false);
    expect(CODIGOS_LI_CAPTURADO.has(codigo)).toBe(false);
  });

  it('EQUAL PAIR: the exact codigo is known', () => {
    expect(situacaoLi('pedido_pago')?.estado.capturado).toBe(E.pago);
    expect(CODIGOS_LI_PAGO.has('pedido_pago')).toBe(true);
  });
});

describe('alvoDeCriacaoLi: captured or not', () => {
  it('8 and 7 reverse a captured sale and cancel an uncaptured one', () => {
    for (const codigo of [CODIGO_LI_CANCELADO, CODIGO_SITUACAO_LI.pagamentoDevolvido]) {
      expect(alvoDeCriacaoLi(codigo, true), codigo).toEqual({
        estado: E.estornadoIntegralmente,
        statusPagamento: S.estornado,
      });
      expect(alvoDeCriacaoLi(codigo, false), codigo).toEqual({
        estado: E.cancelado,
        statusPagamento: S.cancelado,
      });
    }
  });

  it('1019 creates its payment approved when captured, pending otherwise', () => {
    expect(alvoDeCriacaoLi(CODIGO_LI_CANCELAMENTO_SOLICITADO, true)?.statusPagamento).toBe(
      S.aprovado,
    );
    expect(alvoDeCriacaoLi(CODIGO_LI_CANCELAMENTO_SOLICITADO, false)?.statusPagamento).toBe(
      S.pendente,
    );
  });

  it('a capture-evidence codigo answers the same with or without history evidence', () => {
    for (const codigo of CODIGOS_LI_CAPTURADO) {
      expect(alvoDeCriacaoLi(codigo, false), codigo).toEqual(alvoDeCriacaoLi(codigo, true));
    }
  });

  it('the captured flag only moves the three rows that depend on it', () => {
    const movem = Object.keys(SITUACOES_LI)
      .filter((c) => {
        const a = alvoDeCriacaoLi(c, true);
        const b = alvoDeCriacaoLi(c, false);
        return JSON.stringify(a) !== JSON.stringify(b);
      })
      .sort();
    expect(movem).toEqual(['cancelamento_solicitado', 'pagamento_devolvido', 'pedido_cancelado']);
  });

  it('a paid-then-awaiting history does NOT lift 2 to pago here — the update ladder decides that', () => {
    expect(alvoDeCriacaoLi(CODIGO_SITUACAO_LI.aguardandoPagamento, true)).toEqual({
      estado: E.aguardandoConfirmacaoDePagamento,
      statusPagamento: S.pendente,
    });
  });
});

describe('the table agrees with the repo-wide payment rules', () => {
  it('every status maps back to its estado, except the two rungs with no payment meaning', () => {
    const discordam: string[] = [];
    for (const linha of Object.values(SITUACOES_LI)) {
      for (const lado of ['capturado', 'naoCapturado'] as const) {
        if (statusToEstadoPedido(linha.statusPagamento[lado]) !== linha.estado[lado]) {
          discordam.push(`${linha.codigo}/${lado}`);
        }
      }
    }
    expect(discordam.sort()).toEqual([
      'cancelamento_solicitado/capturado',
      'cancelamento_solicitado/naoCapturado',
      'pedido_efetuado/capturado',
      'pedido_efetuado/naoCapturado',
    ]);
  });

  it('a paid or disputed codigo counts as paid; a reversal never does', () => {
    for (const codigo of [...CODIGOS_LI_PAGO, CODIGO_LI_EM_DISPUTA]) {
      expect(isPagamentoPagante(alvoDeCriacaoLi(codigo, true)?.statusPagamento), codigo).toBe(true);
    }
    for (const codigo of [...CODIGOS_LI_ESTORNO, CODIGO_LI_CANCELADO]) {
      expect(isPagamentoPagante(alvoDeCriacaoLi(codigo, true)?.statusPagamento), codigo).toBe(
        false,
      );
    }
  });

  it('awaiting payment (2) and under review (3) reserve stock; the cart rung (9) does not', () => {
    expect(ESTADOS_PEDIDO_RESERVA.has(SITUACOES_LI.aguardando_pagamento.estado.capturado)).toBe(
      true,
    );
    expect(ESTADOS_PEDIDO_RESERVA.has(SITUACOES_LI.pagamento_em_analise.estado.capturado)).toBe(
      true,
    );
    expect(ESTADOS_PEDIDO_RESERVA.has(SITUACOES_LI.pedido_efetuado.estado.capturado)).toBe(false);
  });

  it('a reversing row leaves the movement set (restocks); the dispute and the request do not', () => {
    // Why the importer must KEEP the stored estado on a refund after a removal:
    // writing these estados over an applied removal would restock the goods.
    for (const codigo of CODIGOS_LI_ESTORNO) {
      const estado = alvoDeCriacaoLi(codigo, true)?.estado ?? E.error;
      expect(ESTADOS_PEDIDO_MOVIMENTACAO.has(estado), codigo).toBe(false);
    }
    expect(
      ESTADOS_PEDIDO_MOVIMENTACAO.has(SITUACOES_LI.pagamento_em_disputa.estado.capturado),
    ).toBe(true);
    expect(
      ESTADOS_PEDIDO_MOVIMENTACAO.has(SITUACOES_LI.cancelamento_solicitado.estado.capturado),
    ).toBe(true);
  });
});

describe('the named sets and constants', () => {
  it('the refund-type set is exactly the rows that contest after a removal', () => {
    const contestam = Object.values(SITUACOES_LI)
      .filter((l) => l.motivoContestacao !== null && l.codigo !== CODIGO_LI_EM_DISPUTA)
      .map((l) => l.codigo)
      .sort();
    expect([...CODIGOS_LI_ESTORNO].sort()).toEqual(contestam);
    expect(contestam).toEqual([
      'pagamento_devolvido',
      'pagamento_devolvido_sem_retorno',
      'pedido_chargeback',
    ]);
  });

  it('names the dispute, the cancellation and the request by codigo', () => {
    expect(CODIGO_LI_EM_DISPUTA).toBe('pagamento_em_disputa');
    expect(CODIGO_LI_CANCELADO).toBe('pedido_cancelado');
    expect(CODIGO_LI_CANCELAMENTO_SOLICITADO).toBe('cancelamento_solicitado');
  });

  it('keeps the named-member constant in step with the enum, member for member', () => {
    for (const [nome, valor] of Object.entries(CODIGO_SITUACAO_LI)) {
      expect(codigoSituacaoLiSchema.safeParse(valor).success, nome).toBe(true);
    }
    expect(Object.keys(CODIGO_SITUACAO_LI)).toHaveLength(codigoSituacaoLiSchema.options.length);
  });
});

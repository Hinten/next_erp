/**
 * The pure plan of the status write-back (master plan step 7, PR 7-d): the
 * situação matrix over every codigo, the objeto rule, the one-write sequence of
 * each event × codigo, freshness, and the situação-history check.
 *
 * Every expected cell is written out HERE, independently of the module's own
 * table, so a cell edited there reds a row here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SituacaoHistoricoLinhaLi,
  liSituacaoHistoricoLinhaSchema,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGOS_LI_PAGO,
  CODIGO_SITUACAO_LI,
  ESTADO_FRETE,
  ESTADO_RASTREIO_LI,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  type CodigoSituacaoLi,
  codigoSituacaoLiSchema,
  veredictoDoCodigoLi,
} from '@delfrance/schemas';

import { carimboLi, linhaHistoricoLi, NUMERO_LI } from '../testing/pedidosLi';
import type { EnvioDoPedidoLi } from './identidadeRastreio';
import {
  CODIGOS_LI_NAO_PAGO,
  COLUNAS_RASTREIO_LI,
  type CelulaLi,
  type ColunaRastreioLi,
  ESTADOS_DESPACHADOS_LI,
  MATRIZ_RASTREIO_LI,
  type MatrizRastreioLi,
  type MotivoRecusaSituacaoLi,
  NUNCA_ESCREVER_LI,
  SITUACAO_ALVO_DO_ESTADO_LI,
  celulaRastreioLi,
  conferirHistoricoLi,
  decidirObjetoRastreioLi,
  decidirSequenciaRastreioLi,
  decidirSituacaoRastreioLi,
  eventoSuperadoLi,
} from './planoRastreio';

// D17, per file: nothing here may reach the global `fetch` (no client is built at all).
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('planoRastreio.test: o fetch global não pode ser chamado');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const C = CODIGO_SITUACAO_LI;
const M = MOTIVO_RASTREIO_DIVERGENTE_LI;
const CODIGO = 'PJ258408772BR';
const ENVIO = 801;

const W: CelulaLi = { acao: 'escrever' };
const S: CelulaLi = { acao: 'pular' };
const R = (motivo: MotivoRecusaSituacaoLi): CelulaLi => ({ acao: 'recusar', motivo });

/** The approved matrix, written out by hand: [11, 13, 14, objeto]. */
const ESPERADO: Readonly<Record<string, readonly [CelulaLi, CelulaLi, CelulaLi, CelulaLi]>> = {
  [C.pedidoPago]: [W, W, W, W],
  [C.faturado]: [W, W, W, W],
  [C.emProducao]: [W, W, W, W],
  [C.pedidoEmSeparacao]: [W, W, W, W],
  [C.pedidoEnviado]: [S, R(M.transicaoLateral), W, W],
  [C.prontoParaRetirada]: [R(M.transicaoLateral), S, W, R(M.transicaoLateral)],
  [C.pedidoEntregue]: [R(M.transicaoLateral), R(M.transicaoLateral), S, R(M.transicaoLateral)],
  [C.pedidoEfetuado]: [
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
  ],
  [C.aguardandoPagamento]: [
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
  ],
  [C.pagamentoEmAnalise]: [
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
    R(M.situacaoNaoPaga),
  ],
  [C.pagamentoEmDisputa]: [
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
  ],
  [C.cancelamentoSolicitado]: [
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
  ],
  [C.pedidoCancelado]: [
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
  ],
  [C.pagamentoDevolvido]: [
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
  ],
  [C.pedidoChargeback]: [
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
  ],
  [C.pagamentoDevolvidoSemRetorno]: [
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
    R(M.situacaoBloqueada),
  ],
};

const COLUNAS: readonly ColunaRastreioLi[] = [
  C.pedidoEnviado,
  C.prontoParaRetirada,
  C.pedidoEntregue,
  'objeto',
];

/** Strings no table knows — another case, a trailing space, an inherited name, a later codigo. */
const DESCONHECIDOS: readonly unknown[] = [
  'Pedido_Pago',
  'pedido_pago ',
  'Pedido_Enviado',
  'pedido_enviado ',
  'toString',
  '__proto__',
  'pedido_em_transporte',
  '',
  null,
  undefined,
  4,
  11,
];

/* -------------------------------------------------------------------------- */
/*                         The situação matrix (17 × 4)                             */
/* -------------------------------------------------------------------------- */

describe('the situação matrix: every codigo × every target and the code', () => {
  it('the hand-written grid covers EXACTLY the 16 codigos of the enum', () => {
    expect(Object.keys(ESPERADO).sort()).toEqual([...codigoSituacaoLiSchema.options].sort());
    expect(Object.keys(MATRIZ_RASTREIO_LI).sort()).toEqual(
      [...codigoSituacaoLiSchema.options].sort(),
    );
    expect([...COLUNAS_RASTREIO_LI].sort()).toEqual([...COLUNAS].sort());
  });

  it.each(codigoSituacaoLiSchema.options.flatMap((codigo) => COLUNAS.map((c) => [codigo, c])))(
    '%s × %s is the approved cell',
    (codigo, coluna) => {
      const esperado = ESPERADO[codigo]![COLUNAS.indexOf(coluna as ColunaRastreioLi)];
      expect(celulaRastreioLi(codigo, coluna as ColunaRastreioLi)).toEqual(esperado);
      expect(MATRIZ_RASTREIO_LI[codigo as CodigoSituacaoLi][coluna as ColunaRastreioLi]).toEqual(
        esperado,
      );
    },
  );

  it.each(DESCONHECIDOS.flatMap((codigo) => COLUNAS.map((c) => [codigo, c])))(
    '⚠️ NEAR-MISS: the unknown codigo %j × %s ⇒ situacao-desconhecida, never a skip or a write',
    (codigo, coluna) => {
      expect(celulaRastreioLi(codigo, coluna as ColunaRastreioLi)).toEqual(
        R(M.situacaoDesconhecida),
      );
    },
  );

  it("PARITY: a row writes or already holds SOME target iff step 15's verdict is `pago` — one rule, never two copies", () => {
    for (const codigo of [...codigoSituacaoLiSchema.options, ...DESCONHECIDOS]) {
      const aceita = COLUNAS.some((c) => celulaRastreioLi(codigo, c).acao !== 'recusar');
      expect(aceita, String(codigo)).toBe(veredictoDoCodigoLi(codigo) === 'pago');
      // A paid row refuses only sideways, never with a payment motivo.
      if (veredictoDoCodigoLi(codigo) === 'pago') {
        for (const c of COLUNAS) {
          const celula = celulaRastreioLi(codigo, c);
          if (celula.acao === 'recusar')
            expect(celula.motivo, `${String(codigo)} × ${c}`).toBe(M.transicaoLateral);
        }
      }
    }
  });

  it('the three groups partition the 16 codigos: PAGO (7) + NUNCA_ESCREVER (6) + NAO_PAGO (3), pairwise disjoint', () => {
    expect(CODIGOS_LI_PAGO.size).toBe(7);
    expect(NUNCA_ESCREVER_LI.size).toBe(6);
    expect(CODIGOS_LI_NAO_PAGO.size).toBe(3);
    const todos = [...CODIGOS_LI_PAGO, ...NUNCA_ESCREVER_LI, ...CODIGOS_LI_NAO_PAGO];
    expect(new Set(todos).size).toBe(16);
    expect([...todos].sort()).toEqual([...codigoSituacaoLiSchema.options].sort());
  });

  it('NUNCA_ESCREVER is exactly the stopped codigos, 1019 INCLUDED; NAO_PAGO the three unpaid rungs', () => {
    expect([...NUNCA_ESCREVER_LI].sort()).toEqual(
      [
        C.pagamentoEmDisputa,
        C.cancelamentoSolicitado,
        C.pedidoCancelado,
        C.pagamentoDevolvido,
        C.pedidoChargeback,
        C.pagamentoDevolvidoSemRetorno,
      ].sort(),
    );
    expect([...CODIGOS_LI_NAO_PAGO].sort()).toEqual(
      [C.pedidoEfetuado, C.aguardandoPagamento, C.pagamentoEmAnalise].sort(),
    );
  });

  it('the code column follows the 11 column: never at 13 or 14, refused on every R row', () => {
    for (const codigo of codigoSituacaoLiSchema.options) {
      const onze = celulaRastreioLi(codigo, C.pedidoEnviado);
      const objeto = celulaRastreioLi(codigo, 'objeto');
      if (codigo === C.prontoParaRetirada || codigo === C.pedidoEntregue) {
        expect(objeto, codigo).toEqual(R(M.transicaoLateral));
      } else if (onze.acao === 'recusar') {
        expect(objeto, codigo).toEqual(onze);
      } else {
        expect(objeto, codigo).toEqual(W);
      }
    }
  });

  it('decidirSituacaoRastreioLi is the matrix for the three targets', () => {
    for (const codigo of [...codigoSituacaoLiSchema.options, ...DESCONHECIDOS]) {
      for (const alvo of [C.pedidoEnviado, C.prontoParaRetirada, C.pedidoEntregue] as const) {
        expect(decidirSituacaoRastreioLi(codigo, alvo), `${String(codigo)}→${alvo}`).toEqual(
          celulaRastreioLi(codigo, alvo),
        );
      }
    }
  });

  it('EQUAL pair: the current codigo equal to the target ⇒ skip, exactly', () => {
    expect(decidirSituacaoRastreioLi('pedido_enviado', C.pedidoEnviado)).toEqual(S);
    expect(decidirSituacaoRastreioLi('pronto_para_retirada', C.prontoParaRetirada)).toEqual(S);
    expect(decidirSituacaoRastreioLi('pedido_entregue', C.pedidoEntregue)).toEqual(S);
  });

  it('⚠️ NEAR-MISS: the target codigo in another case, with a space or an inherited name is unknown, never a skip', () => {
    for (const quase of ['Pedido_Enviado', 'pedido_enviado ', 'toString']) {
      expect(decidirSituacaoRastreioLi(quase, C.pedidoEnviado), quase).toEqual(
        R(M.situacaoDesconhecida),
      );
    }
  });

  it('the event → target mapping: postado → 11, entregue → 14, aguardandoRetirada → 13', () => {
    expect(SITUACAO_ALVO_DO_ESTADO_LI).toEqual({
      [ESTADO_RASTREIO_LI.postado]: C.pedidoEnviado,
      [ESTADO_RASTREIO_LI.entregue]: C.pedidoEntregue,
      [ESTADO_RASTREIO_LI.aguardandoRetirada]: C.prontoParaRetirada,
    });
  });

  it('a matrix missing one codigo does not compile', () => {
    const { [C.pedidoPago]: _fora, ...semUm } = MATRIZ_RASTREIO_LI;
    // @ts-expect-error — the matrix is typed over every codigo of the enum.
    const incompleta: MatrizRastreioLi = semUm;
    expect(Object.keys(incompleta)).toHaveLength(15);
  });
});

/* -------------------------------------------------------------------------- */
/*                               Freshness                               */
/* -------------------------------------------------------------------------- */

describe('freshness: an event acts only while the pedido still describes it', () => {
  it('ESTADOS_DESPACHADOS_LI is the seven shipped, not-final estados', () => {
    expect([...ESTADOS_DESPACHADOS_LI].sort()).toEqual(
      [
        ESTADO_FRETE.postado,
        ESTADO_FRETE.recebidoPelaTransportadora,
        ESTADO_FRETE.aCaminho,
        ESTADO_FRETE.tentandoRealizarEntrega,
        ESTADO_FRETE.falhaNaEntrega,
        ESTADO_FRETE.suspenso,
        ESTADO_FRETE.enderecoNaoEncontrado,
      ].sort(),
    );
  });

  it.each([...ESTADOS_DESPACHADOS_LI])(
    'EQUAL pair: `postado` with the pedido now at %s ⇒ act',
    (atual) => {
      expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.postado, atual)).toBeNull();
    },
  );

  it('EQUAL pair: `entregue` with `entregue`, `aguardandoRetirada` with `aguardandoRetirada` ⇒ act', () => {
    expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.entregue, ESTADO_FRETE.entregue)).toBeNull();
    expect(
      eventoSuperadoLi(ESTADO_RASTREIO_LI.aguardandoRetirada, ESTADO_FRETE.aguardandoRetirada),
    ).toBeNull();
  });

  it('⚠️ NEAR-MISS: `postado` or `aguardandoRetirada` with the pedido at `entregue` ⇒ superseded by the delivery', () => {
    expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.postado, ESTADO_FRETE.entregue)).toBe(
      'superado-por-entrega',
    );
    expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.aguardandoRetirada, ESTADO_FRETE.entregue)).toBe(
      'superado-por-entrega',
    );
  });

  it.each([
    ESTADO_FRETE.aguardandoPostagem,
    ESTADO_FRETE.cancelado,
    ESTADO_FRETE.devolvido,
    ESTADO_FRETE.aCaminhoDoRemetente,
    ESTADO_FRETE.objetoExtraviado,
    ESTADO_FRETE.aguardandoRetirada,
    'Postado',
    null,
    undefined,
  ])('⚠️ NEAR-MISS: `postado` with the pedido at %j ⇒ outdated', (atual) => {
    expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.postado, atual)).toBe('evento-desatualizado');
  });

  it('⚠️ NEAR-MISS: `entregue` with anything but `entregue` (a delivery undone) ⇒ outdated', () => {
    for (const atual of [ESTADO_FRETE.postado, ESTADO_FRETE.aCaminho, ESTADO_FRETE.devolvido]) {
      expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.entregue, atual), atual).toBe(
        'evento-desatualizado',
      );
    }
    expect(eventoSuperadoLi(ESTADO_RASTREIO_LI.aguardandoRetirada, ESTADO_FRETE.postado)).toBe(
      'evento-desatualizado',
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                             The objeto rule                           */
/* -------------------------------------------------------------------------- */

const encontrado = (objeto: unknown): EnvioDoPedidoLi => ({
  kind: 'encontrado',
  id: ENVIO,
  objeto,
});

describe('the objeto rule: identity, validity, emptiness, equality', () => {
  it('EQUAL pair: LI `null`, `""` and an ABSENT objeto are all empty ⇒ send our code', () => {
    for (const vazio of [null, '', undefined]) {
      expect(decidirObjetoRastreioLi({ nosso: CODIGO, envio: encontrado(vazio) })).toEqual({
        kind: 'enviar',
        envioId: ENVIO,
        valor: CODIGO,
      });
    }
  });

  it.each([' ', '\t', 'X'.repeat(201)])(
    '⚠️ NEAR-MISS: LI holding %j is NOT empty ⇒ objeto-divergente, nothing sent',
    (objetoLi) => {
      expect(decidirObjetoRastreioLi({ nosso: CODIGO, envio: encontrado(objetoLi) })).toEqual({
        kind: 'objeto-divergente',
      });
    },
  );

  it('EQUAL pair: LI already holding our code exactly ⇒ igual (skip)', () => {
    expect(decidirObjetoRastreioLi({ nosso: CODIGO, envio: encontrado(CODIGO) })).toEqual({
      kind: 'igual',
    });
  });

  it.each(['pj258408772br', 'PJ258408772BR ', ' PJ258408772BR', 'PJ999999999BR'])(
    '⚠️ NEAR-MISS: LI holding %j is another code ⇒ objeto-divergente, never overwritten',
    (objetoLi) => {
      expect(decidirObjetoRastreioLi({ nosso: CODIGO, envio: encontrado(objetoLi) })).toEqual({
        kind: 'objeto-divergente',
      });
    },
  );

  it('EQUAL pair: our code, visible ASCII up to 200, is sendable as stored', () => {
    for (const nosso of [CODIGO, 'A', 'X'.repeat(200), 'AB-123/45']) {
      expect(decidirObjetoRastreioLi({ nosso, envio: encontrado(null) })).toEqual({
        kind: 'enviar',
        envioId: ENVIO,
        valor: nosso,
      });
    }
  });

  it.each(['PJ258408772BR ', 'PJ 258', ' PJ258', 'X'.repeat(201), 'PJ258408772BRÇ', 'PJ\n1', 42])(
    '⚠️ NEAR-MISS: our stored code %j is NOT sendable ⇒ objeto-invalido (a code with a trailing space is not sendable)',
    (nosso) => {
      expect(decidirObjetoRastreioLi({ nosso, envio: encontrado(null) })).toEqual({
        kind: 'objeto-invalido',
      });
    },
  );

  it('no code at all (null, "", absent) ⇒ sem-codigo, no aviso', () => {
    for (const nosso of [null, '', undefined]) {
      expect(decidirObjetoRastreioLi({ nosso, envio: encontrado(null) })).toEqual({
        kind: 'sem-codigo',
      });
    }
  });

  it('the identity split: no stored envio ⇒ envio-divergente; an unmatched one ⇒ pedido-divergente', () => {
    expect(decidirObjetoRastreioLi({ nosso: CODIGO, envio: { kind: 'sem-external-id' } })).toEqual({
      kind: 'envio-divergente',
    });
    expect(decidirObjetoRastreioLi({ nosso: CODIGO, envio: { kind: 'nao-encontrado' } })).toEqual({
      kind: 'pedido-divergente',
    });
    // An unmatched envio is an identity failure even with no code to send.
    expect(decidirObjetoRastreioLi({ nosso: null, envio: { kind: 'nao-encontrado' } })).toEqual({
      kind: 'pedido-divergente',
    });
    // No code to send: no envio is needed, so no aviso for a missing one.
    expect(decidirObjetoRastreioLi({ nosso: null, envio: { kind: 'sem-external-id' } })).toEqual({
      kind: 'sem-codigo',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                  The one-write sequence: event × codigo               */
/* -------------------------------------------------------------------------- */

const POSTADO = ESTADO_RASTREIO_LI.postado;
const ENTREGUE = ESTADO_RASTREIO_LI.entregue;
const RETIRADA = ESTADO_RASTREIO_LI.aguardandoRetirada;

const PAGOS_ANTES_DO_ENVIO = [C.pedidoPago, C.faturado, C.emProducao, C.pedidoEmSeparacao];

/** The four posting columns: P1 sendable+empty, P2 LI holds ours, P3 LI holds another, P4 no sendable code. */
const P1 = { nosso: CODIGO, envio: encontrado(null) };
const P2 = { nosso: CODIGO, envio: encontrado(CODIGO) };
const P3 = { nosso: CODIGO, envio: encontrado('OUTRO123BR') };
const P4_SEM = { nosso: null, envio: encontrado(null) };
const P4_INVALIDO = { nosso: `${CODIGO} `, envio: encontrado(null) };
const P4_SEM_ENVIO = { nosso: CODIGO, envio: { kind: 'sem-external-id' } as EnvioDoPedidoLi };

const situacao = (
  codigo: string,
  o: { aviso?: string | null; objetoSemEfeito?: boolean; objetoNaoEnviado?: boolean } = {},
) => ({
  kind: 'situacao',
  codigo,
  aviso: o.aviso ?? null,
  objetoSemEfeito: o.objetoSemEfeito ?? false,
  objetoNaoEnviado: o.objetoNaoEnviado ?? false,
});

describe('the one-write sequence, cell by cell', () => {
  it.each(PAGOS_ANTES_DO_ENVIO)(
    'LI at %s: P1 the code ONLY (LI moves itself to 11); P2 11 + objeto-sem-efeito; P3 aviso + 11; P4 11 (+ its aviso); E 14 only; R 13',
    (codigo) => {
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P1 })).toEqual({
        kind: 'objeto',
        envioId: ENVIO,
        valor: CODIGO,
      });
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P2 })).toEqual(
        situacao(C.pedidoEnviado, { objetoSemEfeito: true }),
      );
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P3 })).toEqual(
        situacao(C.pedidoEnviado, { aviso: M.objetoDivergente }),
      );
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P4_SEM })).toEqual(
        situacao(C.pedidoEnviado),
      );
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P4_INVALIDO })).toEqual(
        situacao(C.pedidoEnviado, { aviso: M.objetoInvalido }),
      );
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P4_SEM_ENVIO })).toEqual(
        situacao(C.pedidoEnviado, { aviso: M.envioDivergente }),
      );
      // A delivery writes 14 ONLY — never the code, even when LI lacks it (one INFO line).
      expect(decidirSequenciaRastreioLi({ estado: ENTREGUE, codigo, ...P1 })).toEqual(
        situacao(C.pedidoEntregue, { objetoNaoEnviado: true }),
      );
      expect(decidirSequenciaRastreioLi({ estado: ENTREGUE, codigo, ...P2 })).toEqual(
        situacao(C.pedidoEntregue),
      );
      expect(decidirSequenciaRastreioLi({ estado: RETIRADA, codigo, ...P4_SEM })).toEqual(
        situacao(C.prontoParaRetirada),
      );
    },
  );

  it('LI at 11: P1 the code (carrying it); P2 nothing; P3 aviso, nothing; P4 nothing (+ aviso if invalid); E 14; R transicao-lateral', () => {
    const codigo = C.pedidoEnviado;
    expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P1 })).toEqual({
      kind: 'objeto',
      envioId: ENVIO,
      valor: CODIGO,
    });
    expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P2 })).toEqual({
      kind: 'nada',
      aviso: null,
    });
    expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P3 })).toEqual({
      kind: 'nada',
      aviso: M.objetoDivergente,
    });
    expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P4_SEM })).toEqual({
      kind: 'nada',
      aviso: null,
    });
    expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...P4_INVALIDO })).toEqual({
      kind: 'nada',
      aviso: M.objetoInvalido,
    });
    expect(decidirSequenciaRastreioLi({ estado: ENTREGUE, codigo, ...P1 })).toEqual(
      situacao(C.pedidoEntregue, { objetoNaoEnviado: true }),
    );
    expect(decidirSequenciaRastreioLi({ estado: RETIRADA, codigo, ...P4_SEM })).toEqual({
      kind: 'recusar',
      motivo: M.transicaoLateral,
    });
  });

  it('LI at 13: every posting column ⇒ transicao-lateral, NO code; E 14; R nothing', () => {
    const codigo = C.prontoParaRetirada;
    for (const p of [P1, P2, P3, P4_SEM, P4_INVALIDO, P4_SEM_ENVIO]) {
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...p })).toEqual({
        kind: 'recusar',
        motivo: M.transicaoLateral,
      });
    }
    expect(decidirSequenciaRastreioLi({ estado: ENTREGUE, codigo, ...P1 })).toEqual(
      situacao(C.pedidoEntregue, { objetoNaoEnviado: true }),
    );
    expect(decidirSequenciaRastreioLi({ estado: RETIRADA, codigo, ...P4_SEM })).toEqual({
      kind: 'nada',
      aviso: null,
    });
  });

  it('LI at 14: a posting or a pickup ⇒ transicao-lateral, never the code, never a regress; E nothing', () => {
    const codigo = C.pedidoEntregue;
    for (const p of [P1, P2, P3, P4_SEM]) {
      expect(decidirSequenciaRastreioLi({ estado: POSTADO, codigo, ...p })).toEqual({
        kind: 'recusar',
        motivo: M.transicaoLateral,
      });
      expect(decidirSequenciaRastreioLi({ estado: RETIRADA, codigo, ...p })).toEqual({
        kind: 'recusar',
        motivo: M.transicaoLateral,
      });
    }
    expect(decidirSequenciaRastreioLi({ estado: ENTREGUE, codigo, ...P1 })).toEqual({
      kind: 'nada',
      aviso: null,
    });
  });

  it.each([
    [C.pedidoEfetuado, M.situacaoNaoPaga],
    [C.aguardandoPagamento, M.situacaoNaoPaga],
    [C.pagamentoEmAnalise, M.situacaoNaoPaga],
    [C.pagamentoEmDisputa, M.situacaoBloqueada],
    [C.cancelamentoSolicitado, M.situacaoBloqueada],
    [C.pedidoCancelado, M.situacaoBloqueada],
    [C.pagamentoDevolvido, M.situacaoBloqueada],
    [C.pedidoChargeback, M.situacaoBloqueada],
    [C.pagamentoDevolvidoSemRetorno, M.situacaoBloqueada],
    ['Pedido_Pago', M.situacaoDesconhecida],
    ['pedido_pago ', M.situacaoDesconhecida],
    ['pedido_em_transporte', M.situacaoDesconhecida],
  ])('LI at %s: every event and column ⇒ the aviso %s, nothing written', (codigo, motivo) => {
    for (const estado of [POSTADO, ENTREGUE, RETIRADA]) {
      for (const p of [P1, P2, P3, P4_SEM, P4_INVALIDO, P4_SEM_ENVIO]) {
        expect(decidirSequenciaRastreioLi({ estado, codigo, ...p }), `${estado}`).toEqual({
          kind: 'recusar',
          motivo,
        });
      }
    }
  });

  it('a present but UNMATCHED stored envio ⇒ pedido-divergente in EVERY row and event — nothing written', () => {
    for (const codigo of [...codigoSituacaoLiSchema.options, 'Pedido_Pago']) {
      for (const estado of [POSTADO, ENTREGUE, RETIRADA]) {
        expect(
          decidirSequenciaRastreioLi({
            estado,
            codigo,
            nosso: CODIGO,
            envio: { kind: 'nao-encontrado' },
          }),
          `${estado} @ ${codigo}`,
        ).toEqual({ kind: 'recusar', motivo: M.pedidoDivergente });
      }
    }
  });

  it('PROPERTY: the code is sent ONLY on a posting, and only where 11 is writable or already holds', () => {
    for (const codigo of [...codigoSituacaoLiSchema.options, ...DESCONHECIDOS]) {
      for (const estado of [POSTADO, ENTREGUE, RETIRADA]) {
        const s = decidirSequenciaRastreioLi({ estado, codigo, ...P1 });
        if (s.kind !== 'objeto') continue;
        expect(estado).toBe(POSTADO);
        expect([...PAGOS_ANTES_DO_ENVIO, C.pedidoEnviado]).toContain(codigo);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                         The situação-history check                    */
/* -------------------------------------------------------------------------- */

function linhas(...brutas: ReturnType<typeof linhaHistoricoLi>[]): SituacaoHistoricoLinhaLi[] {
  return brutas.map((b) => liSituacaoHistoricoLinhaSchema.parse(b));
}

const h = (
  id: number,
  horas: number,
  codigo: string,
  anterior: string | null,
  numero = NUMERO_LI,
) => linhaHistoricoLi(id, carimboLi(horas), codigo, anterior, numero);

/** The rows of a paid order up to `pedido_pago`. */
const ATE_PAGO = [
  h(1, 0, C.aguardandoPagamento, C.pedidoEfetuado),
  h(2, 1, C.pedidoPago, C.aguardandoPagamento),
];

describe('the history check after a situação we caused', () => {
  it('EQUAL pair: our row `pedido_pago → pedido_enviado` after a read that saw `pedido_pago` ⇒ conferido (the code PUT’s own move included)', () => {
    expect(
      conferirHistoricoLi(linhas(...ATE_PAGO, h(3, 5, C.pedidoEnviado, C.pedidoPago)), {
        numero: NUMERO_LI,
        codigoAntes: C.pedidoPago,
        codigoEscrito: C.pedidoEnviado,
      }),
    ).toEqual({ kind: 'conferido' });
  });

  it('⚠️ NEAR-MISS: `pedido_pago → cancelamento_solicitado → pedido_enviado` ⇒ sobrescrito(1019), critico', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 5, C.cancelamentoSolicitado, C.pedidoPago),
          h(4, 6, C.pedidoEnviado, C.cancelamentoSolicitado),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'sobrescrito', codigo: C.cancelamentoSolicitado, critico: true });
  });

  it('⚠️ NEAR-MISS: `pedido_enviado → pagamento_em_disputa → pedido_entregue` ⇒ sobrescrito(6), critico', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 5, C.pedidoEnviado, C.pedidoPago),
          h(4, 9, C.pagamentoEmDisputa, C.pedidoEnviado),
          h(5, 10, C.pedidoEntregue, C.pagamentoEmDisputa),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoEnviado, codigoEscrito: C.pedidoEntregue },
      ),
    ).toEqual({ kind: 'sobrescrito', codigo: C.pagamentoEmDisputa, critico: true });
  });

  it('⚠️ NEAR-MISS: an overwritten codigo the table refuses but that is not a never-write one ⇒ sobrescrito, atencao', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 5, C.aguardandoPagamento, C.pedidoPago),
          h(4, 6, C.pedidoEnviado, C.aguardandoPagamento),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'sobrescrito', codigo: C.aguardandoPagamento, critico: false });
  });

  it('a compatible intermediate: `pedido_pago → pedido_em_separacao → pedido_enviado` ⇒ intermediaria-compativel, NO aviso', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 5, C.pedidoEmSeparacao, C.pedidoPago),
          h(4, 6, C.pedidoEnviado, C.pedidoEmSeparacao),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'intermediaria-compativel', codigos: [C.pedidoEmSeparacao] });
  });

  it('an OLDER row reaching our codigo with our row not yet visible ⇒ sem-linha, NEVER sobrescrito', () => {
    // 4 → 11 long ago, 11 → 4 (moved back), and our new 4 → 11 is not in the page yet.
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 2, C.pedidoEnviado, C.pedidoPago),
          h(4, 3, C.pedidoPago, C.pedidoEnviado),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'sem-linha' });
  });

  it('anchored on the LAST row reaching the SEEN codigo, not on the last row of ours', () => {
    // An old 4 → 1019 → 11 sequence BEFORE the anchor is history, not an overwrite of this write.
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 2, C.cancelamentoSolicitado, C.pedidoPago),
          h(4, 3, C.pedidoEnviado, C.cancelamentoSolicitado),
          h(5, 4, C.pedidoPago, C.pedidoEnviado),
          h(6, 8, C.pedidoEnviado, C.pedidoPago),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'conferido' });
  });

  it('our row with `situacao_anterior` null ⇒ inconclusivo, never sobrescrito', () => {
    expect(
      conferirHistoricoLi(linhas(...ATE_PAGO, h(3, 5, C.pedidoEnviado, null)), {
        numero: NUMERO_LI,
        codigoAntes: C.pedidoPago,
        codigoEscrito: C.pedidoEnviado,
      }),
    ).toEqual({ kind: 'inconclusivo' });
  });

  it('`pedido_enviado → pedido_enviado` after ours ⇒ duplicado (a concurrent attempt)', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 5, C.pedidoEnviado, C.pedidoPago),
          h(4, 6, C.pedidoEnviado, C.pedidoEnviado),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'duplicado' });
  });

  it('a change AFTER our row is not an overwrite ⇒ conferido', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          ...ATE_PAGO,
          h(3, 5, C.pedidoEnviado, C.pedidoPago),
          h(4, 6, C.cancelamentoSolicitado, C.pedidoEnviado),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'conferido' });
  });

  it('a row of ANOTHER numero is ignored; a repeated row id counts once; rows are ordered by time, then id', () => {
    expect(
      conferirHistoricoLi(
        linhas(
          // Out of order on the page, a duplicate, and another order's overwrite.
          h(3, 5, C.pedidoEnviado, C.pedidoPago),
          ...ATE_PAGO,
          h(3, 5, C.pedidoEnviado, C.pedidoPago),
          h(9, 4, C.cancelamentoSolicitado, C.pedidoPago, NUMERO_LI + 1),
        ),
        { numero: NUMERO_LI, codigoAntes: C.pedidoPago, codigoEscrito: C.pedidoEnviado },
      ),
    ).toEqual({ kind: 'conferido' });
  });

  it('no row reaching the seen codigo, or no row at all ⇒ inconclusivo / sem-linha', () => {
    expect(
      conferirHistoricoLi([], {
        numero: NUMERO_LI,
        codigoAntes: C.pedidoPago,
        codigoEscrito: C.pedidoEnviado,
      }),
    ).toEqual({ kind: 'inconclusivo' });
    expect(
      conferirHistoricoLi(linhas(...ATE_PAGO), {
        numero: NUMERO_LI,
        codigoAntes: C.pedidoPago,
        codigoEscrito: C.pedidoEnviado,
      }),
    ).toEqual({ kind: 'sem-linha' });
  });
});

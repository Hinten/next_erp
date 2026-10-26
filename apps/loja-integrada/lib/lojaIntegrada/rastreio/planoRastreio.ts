/**
 * The PURE plan of the status write-back (master plan step 7, PR 7-d): which
 * write, if any, one run may send to Loja Integrada for one freight event, and
 * how to read the situação history after it. Pure and total: no clock, no
 * network, no Firestore; an unknown value is refused, never thrown.
 *
 * ## The situação matrix: paid codigos only, decided by step 15's own rule
 *
 * The first filter is step 15's verdict (`veredictoDoCodigoLi`), so ONE rule
 * decides both "may we ship it" and "may we tell the buyer it shipped":
 *
 *  - `pago` ⇒ {@link MATRIZ_RASTREIO_LI}, typed over EVERY codigo of the enum, so
 *    a codigo added to the enum does not compile until its row is decided;
 *  - `nao-pago` ⇒ refused: `situacao-bloqueada` for {@link NUNCA_ESCREVER_LI}
 *    (a dispute, a cancellation request, a cancellation, a refund, a chargeback),
 *    `situacao-nao-paga` for {@link CODIGOS_LI_NAO_PAGO};
 *  - `desconhecido` ⇒ `situacao-desconhecida`: another case, a trailing space, an
 *    inherited name or a codigo Loja Integrada adds later. Fail closed.
 *
 * Every codigo comparison is EXACT (no fold). The code column follows the 11
 * column — writing a tracking code moves the order to `pedido_enviado` and
 * e-mails the buyer — and is never allowed while Loja Integrada shows 13 or 14.
 *
 * ## One write per run
 *
 * {@link decidirSequenciaRastreioLi} names the ONE write a run may send for an
 * event and the codigo the deciding read saw: a posting with a sendable code
 * sends the code ALONE (Loja Integrada moves the order to 11 itself); without
 * one, 11; a delivery 14 only, never the code; a pickup 13 only.
 *
 * ## The objeto rule
 *
 * {@link decidirObjetoRastreioLi}: the envio's identity first, then our code's
 * validity (`objetoDeEnvioValidoLi`, the package's own predicate, sent as
 * stored), then the live objeto's emptiness (`vazioArmazenadoLi`: `null`,
 * absent or exactly `''` — never a whitespace-only text) and equality
 * (`deepEqual`, no fold). A different non-empty objeto is never overwritten.
 *
 * ## The history check
 *
 * {@link conferirHistoricoLi} reads the rows through the import's own clean-up
 * leaf (`limparHistoricoLi`), anchors on the LAST row that reached the codigo the
 * deciding read saw, reads an empty previous situação as inconclusive,
 * and re-runs the matrix over an intermediate codigo before calling it an
 * overwrite.
 */
import {
  CODIGOS_SITUACAO_ESCRITA_LI,
  type CodigoSituacaoEscritaLi,
  type SituacaoHistoricoLinhaLi,
  objetoDeEnvioValidoLi,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_SITUACAO_LI,
  ESTADO_FRETE,
  ESTADO_RASTREIO_LI,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  VEREDITO_PAGAMENTO_LI,
  type CodigoSituacaoLi,
  type EstadoRastreioLi,
  type MotivoRastreioDivergenteLi,
  situacaoLi,
  veredictoDoCodigoLi,
} from '@delfrance/schemas';

import { deepEqual } from '../core/igualdadeJsonLi';
import { limparHistoricoLi } from '../pedidos/estadoPedidoLi';
import { vazioArmazenadoLi } from '../pedidos/vazioArmazenado';
import type { EnvioDoPedidoLi } from './identidadeRastreio';

const C = CODIGO_SITUACAO_LI;
const M = MOTIVO_RASTREIO_DIVERGENTE_LI;

/* -------------------------------------------------------------------------- */
/*                          The event and its target                          */
/* -------------------------------------------------------------------------- */

/** The situação each event targets: postado → 11, entregue → 14, aguardandoRetirada → 13. */
export const SITUACAO_ALVO_DO_ESTADO_LI = {
  [ESTADO_RASTREIO_LI.postado]: C.pedidoEnviado,
  [ESTADO_RASTREIO_LI.entregue]: C.pedidoEntregue,
  [ESTADO_RASTREIO_LI.aguardandoRetirada]: C.prontoParaRetirada,
} as const satisfies Record<EstadoRastreioLi, CodigoSituacaoEscritaLi>;

/* -------------------------------------------------------------------------- */
/*                           The situação matrix                         */
/* -------------------------------------------------------------------------- */

/**
 * The codigos the write-back NEVER writes onto: the stopped ones — a dispute, a
 * cancellation REQUEST (1019, refused by decision), a cancellation,
 * a refund, a chargeback, a refund without return. Separate from
 * {@link CODIGOS_LI_NAO_PAGO} on purpose: it picks the motivo and an overwritten
 * one's severity.
 */
export const NUNCA_ESCREVER_LI: ReadonlySet<string> = new Set<CodigoSituacaoLi>([
  C.pagamentoEmDisputa,
  C.cancelamentoSolicitado,
  C.pedidoCancelado,
  C.pagamentoDevolvido,
  C.pedidoChargeback,
  C.pagamentoDevolvidoSemRetorno,
]);

/** The unpaid rungs: the cart, awaiting payment, payment under review. */
export const CODIGOS_LI_NAO_PAGO: ReadonlySet<string> = new Set<CodigoSituacaoLi>([
  C.pedidoEfetuado,
  C.aguardandoPagamento,
  C.pagamentoEmAnalise,
]);

/** A column of the matrix: one of the three write-back codigos, or the tracking code. */
export type ColunaRastreioLi = CodigoSituacaoEscritaLi | 'objeto';

/** The column of the tracking code. */
export const COLUNA_OBJETO_LI = 'objeto' as const;

/** Every column, in order: the three targets, then the code. */
export const COLUNAS_RASTREIO_LI: readonly ColunaRastreioLi[] = [
  ...CODIGOS_SITUACAO_ESCRITA_LI,
  COLUNA_OBJETO_LI,
];

/** The motivos a matrix cell may refuse with. */
export type MotivoRecusaSituacaoLi =
  | typeof M.situacaoBloqueada
  | typeof M.situacaoNaoPaga
  | typeof M.situacaoDesconhecida
  | typeof M.transicaoLateral;

/** One cell: write, skip silently (already there), or refuse with an aviso. */
export type CelulaLi =
  | { readonly acao: 'escrever' }
  | { readonly acao: 'pular' }
  | { readonly acao: 'recusar'; readonly motivo: MotivoRecusaSituacaoLi };

/** The matrix's type: every codigo of the enum × every column. */
export type MatrizRastreioLi = Readonly<
  Record<CodigoSituacaoLi, Readonly<Record<ColunaRastreioLi, CelulaLi>>>
>;

const W: CelulaLi = { acao: 'escrever' };
const S: CelulaLi = { acao: 'pular' };
const recusa = (motivo: MotivoRecusaSituacaoLi): CelulaLi => ({ acao: 'recusar', motivo });
const LATERAL = recusa(M.transicaoLateral);

/** Every column refused with `motivo`. */
function linhaRecusada(motivo: MotivoRecusaSituacaoLi): Record<ColunaRastreioLi, CelulaLi> {
  const r = recusa(motivo);
  return {
    [C.pedidoEnviado]: r,
    [C.prontoParaRetirada]: r,
    [C.pedidoEntregue]: r,
    [COLUNA_OBJETO_LI]: r,
  };
}

/** A paid order not shipped yet: every target, and the code. */
const PAGO_ANTES_DO_ENVIO: Record<ColunaRastreioLi, CelulaLi> = {
  [C.pedidoEnviado]: W,
  [C.prontoParaRetirada]: W,
  [C.pedidoEntregue]: W,
  [COLUNA_OBJETO_LI]: W,
};

const NAO_PAGO = linhaRecusada(M.situacaoNaoPaga);
const BLOQUEADO = linhaRecusada(M.situacaoBloqueada);

/**
 * The approved matrix, by the current Loja Integrada codigo ×
 * the column. Never regress from 14, never cross 11 ↔ 13, never the code onto
 * 13/14. Typed over every codigo: a codigo added to the enum fails to compile
 * here until its row is decided.
 */
export const MATRIZ_RASTREIO_LI = {
  [C.pedidoPago]: PAGO_ANTES_DO_ENVIO,
  [C.faturado]: PAGO_ANTES_DO_ENVIO,
  [C.emProducao]: PAGO_ANTES_DO_ENVIO,
  [C.pedidoEmSeparacao]: PAGO_ANTES_DO_ENVIO,
  [C.pedidoEnviado]: {
    [C.pedidoEnviado]: S,
    [C.prontoParaRetirada]: LATERAL,
    [C.pedidoEntregue]: W,
    [COLUNA_OBJETO_LI]: W,
  },
  [C.prontoParaRetirada]: {
    [C.pedidoEnviado]: LATERAL,
    [C.prontoParaRetirada]: S,
    [C.pedidoEntregue]: W,
    [COLUNA_OBJETO_LI]: LATERAL,
  },
  [C.pedidoEntregue]: {
    [C.pedidoEnviado]: LATERAL,
    [C.prontoParaRetirada]: LATERAL,
    [C.pedidoEntregue]: S,
    [COLUNA_OBJETO_LI]: LATERAL,
  },
  [C.pedidoEfetuado]: NAO_PAGO,
  [C.aguardandoPagamento]: NAO_PAGO,
  [C.pagamentoEmAnalise]: NAO_PAGO,
  [C.pagamentoEmDisputa]: BLOQUEADO,
  [C.cancelamentoSolicitado]: BLOQUEADO,
  [C.pedidoCancelado]: BLOQUEADO,
  [C.pagamentoDevolvido]: BLOQUEADO,
  [C.pedidoChargeback]: BLOQUEADO,
  [C.pagamentoDevolvidoSemRetorno]: BLOQUEADO,
} as const satisfies MatrizRastreioLi;

/**
 * The cell of a wire codigo × a column (module header): step 15's verdict
 * first, then the matrix. EXACT: `'Pedido_Enviado'`, `'pedido_enviado '` and
 * `'toString'` are unknown, never a skip or a write.
 */
export function celulaRastreioLi(codigo: unknown, coluna: ColunaRastreioLi): CelulaLi {
  const veredito = veredictoDoCodigoLi(codigo);
  if (typeof codigo !== 'string' || veredito === VEREDITO_PAGAMENTO_LI.desconhecido) {
    return recusa(M.situacaoDesconhecida);
  }
  if (veredito !== VEREDITO_PAGAMENTO_LI.pago) {
    return recusa(NUNCA_ESCREVER_LI.has(codigo) ? M.situacaoBloqueada : M.situacaoNaoPaga);
  }
  const linha = situacaoLi(codigo);
  // `pago` implies a codigo the table knows; fail closed anyway.
  if (linha === null) return recusa(M.situacaoDesconhecida);
  return MATRIZ_RASTREIO_LI[linha.codigo][coluna];
}

/** The situação decision for a target codigo (the matrix's three target columns). */
export function decidirSituacaoRastreioLi(atual: unknown, alvo: CodigoSituacaoEscritaLi): CelulaLi {
  return celulaRastreioLi(atual, alvo);
}

/* -------------------------------------------------------------------------- */
/*                               Freshness                               */
/* -------------------------------------------------------------------------- */

/** The shipped, not-yet-final freight estados a posting acts across. */
export const ESTADOS_DESPACHADOS_LI: ReadonlySet<string> = new Set<string>([
  ESTADO_FRETE.postado,
  ESTADO_FRETE.recebidoPelaTransportadora,
  ESTADO_FRETE.aCaminho,
  ESTADO_FRETE.tentandoRealizarEntrega,
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.suspenso,
  ESTADO_FRETE.enderecoNaoEncontrado,
]);

/** Why an event no longer acts: the delivery superseded it, or the pedido moved backwards. */
export type MotivoSuperadoLi = 'superado-por-entrega' | 'evento-desatualizado';

/**
 * Whether the event the pedido no longer describes: `null` = act.
 *
 *  - `postado`: acts across {@link ESTADOS_DESPACHADOS_LI};
 *  - `entregue`: acts while the pedido is `entregue`;
 *  - `aguardandoRetirada`: acts while the pedido is `aguardandoRetirada`;
 *  - a `postado` or `aguardandoRetirada` with the pedido at `entregue` ⇒
 *    `superado-por-entrega` (the delivery's own run writes 14);
 *  - anything else ⇒ `evento-desatualizado` (a re-anchored label, a cancellation,
 *    a return, a lost parcel, an estado this code does not know).
 */
export function eventoSuperadoLi(
  estadoDoEvento: EstadoRastreioLi,
  estadoAtual: unknown,
): MotivoSuperadoLi | null {
  switch (estadoDoEvento) {
    case ESTADO_RASTREIO_LI.postado:
      if (typeof estadoAtual === 'string' && ESTADOS_DESPACHADOS_LI.has(estadoAtual)) return null;
      break;
    case ESTADO_RASTREIO_LI.entregue:
      if (estadoAtual === ESTADO_FRETE.entregue) return null;
      break;
    case ESTADO_RASTREIO_LI.aguardandoRetirada:
      if (estadoAtual === ESTADO_FRETE.aguardandoRetirada) return null;
      break;
  }
  if (estadoDoEvento !== ESTADO_RASTREIO_LI.entregue && estadoAtual === ESTADO_FRETE.entregue) {
    return 'superado-por-entrega';
  }
  return 'evento-desatualizado';
}

/* -------------------------------------------------------------------------- */
/*                            The objeto rule                            */
/* -------------------------------------------------------------------------- */

/** What the tracking code of one posting gets. */
export type DecisaoObjetoLi =
  /** No code stored: nothing to send, no aviso. */
  | { readonly kind: 'sem-codigo' }
  /** A stored envio id that matches no live envio: an identity failure, NOTHING written. */
  | { readonly kind: 'pedido-divergente' }
  /** No stored envio id: the code is not sent (aviso), the situação as usual. */
  | { readonly kind: 'envio-divergente' }
  /** Our code cannot be sent as stored (aviso), the situação as usual. */
  | { readonly kind: 'objeto-invalido' }
  /** Loja Integrada already holds our code exactly. */
  | { readonly kind: 'igual' }
  /** Loja Integrada holds another non-empty code: never overwritten (aviso). */
  | { readonly kind: 'objeto-divergente' }
  /** Send our code, as stored, to this envio. */
  | { readonly kind: 'enviar'; readonly envioId: number; readonly valor: string };

/**
 * The objeto decision (module header), in order: an unmatched stored envio, no
 * code at all, no stored envio, an invalid code, then the live objeto — empty
 * (`null`, absent, `''`) ⇒ send; equal (no fold) ⇒ skip; anything else ⇒ never
 * overwritten.
 */
export function decidirObjetoRastreioLi(entrada: {
  readonly nosso: unknown;
  readonly envio: EnvioDoPedidoLi;
}): DecisaoObjetoLi {
  const { nosso, envio } = entrada;
  if (envio.kind === 'nao-encontrado') return { kind: 'pedido-divergente' };
  if (vazioArmazenadoLi(nosso)) return { kind: 'sem-codigo' };
  if (envio.kind === 'sem-external-id') return { kind: 'envio-divergente' };
  if (!objetoDeEnvioValidoLi(nosso)) return { kind: 'objeto-invalido' };
  if (vazioArmazenadoLi(envio.objeto)) {
    return { kind: 'enviar', envioId: envio.id, valor: nosso };
  }
  return deepEqual(envio.objeto, nosso) ? { kind: 'igual' } : { kind: 'objeto-divergente' };
}

/* -------------------------------------------------------------------------- */
/*                     The one-write sequence              */
/* -------------------------------------------------------------------------- */

/** The ONE write a run may send for an event, decided from the read made just before it. */
export type SequenciaRastreioLi =
  /** Nothing is written; the aviso names why. */
  | { readonly kind: 'recusar'; readonly motivo: MotivoRastreioDivergenteLi }
  /** Nothing to write: already reflected — with an aviso when the code could not follow. */
  | { readonly kind: 'nada'; readonly aviso: MotivoRastreioDivergenteLi | null }
  /** The tracking code ALONE: Loja Integrada moves the order to 11 by itself. */
  | { readonly kind: 'objeto'; readonly envioId: number; readonly valor: string }
  /** The situação, with an aviso when the code could not be sent alongside the posting. */
  | {
      readonly kind: 'situacao';
      readonly codigo: CodigoSituacaoEscritaLi;
      readonly aviso: MotivoRastreioDivergenteLi | null;
      /** Loja Integrada holds our code but did not move: the 11 goes with a WARNING. */
      readonly objetoSemEfeito: boolean;
      /** A delivery whose valid code Loja Integrada lacks: one INFO line, the code never sent. */
      readonly objetoNaoEnviado: boolean;
    };

/** The aviso motivo an objeto decision raises, if any. */
function avisoDoObjeto(o: DecisaoObjetoLi): MotivoRastreioDivergenteLi | null {
  switch (o.kind) {
    case 'objeto-divergente':
      return M.objetoDivergente;
    case 'objeto-invalido':
      return M.objetoInvalido;
    case 'envio-divergente':
      return M.envioDivergente;
    case 'pedido-divergente':
      return M.pedidoDivergente;
    case 'sem-codigo':
    case 'igual':
    case 'enviar':
      return null;
  }
}

/**
 * The one write of an event (the master plan's step-7 event × codigo
 * sequence). The identity comes first: a stored envio Loja Integrada does not
 * list refuses EVERY event. Then the matrix for the event's target; a posting
 * additionally decides its code.
 */
export function decidirSequenciaRastreioLi(entrada: {
  readonly estado: EstadoRastreioLi;
  /** The situação codigo the deciding read saw, verbatim. */
  readonly codigo: unknown;
  readonly envio: EnvioDoPedidoLi;
  /** The pedido's stored tracking code, verbatim. */
  readonly nosso: unknown;
}): SequenciaRastreioLi {
  const { estado, codigo, envio, nosso } = entrada;
  if (envio.kind === 'nao-encontrado') return { kind: 'recusar', motivo: M.pedidoDivergente };
  const alvo = SITUACAO_ALVO_DO_ESTADO_LI[estado];
  const celula = decidirSituacaoRastreioLi(codigo, alvo);
  if (celula.acao === 'recusar') return { kind: 'recusar', motivo: celula.motivo };

  if (estado !== ESTADO_RASTREIO_LI.postado) {
    if (celula.acao === 'pular') return { kind: 'nada', aviso: null };
    // A delivery never sends the code: one INFO line when LI lacks a valid one.
    const objetoNaoEnviado =
      estado === ESTADO_RASTREIO_LI.entregue &&
      envio.kind === 'encontrado' &&
      vazioArmazenadoLi(envio.objeto) &&
      objetoDeEnvioValidoLi(nosso);
    return {
      kind: 'situacao',
      codigo: alvo,
      aviso: null,
      objetoSemEfeito: false,
      objetoNaoEnviado,
    };
  }

  // A posting: the code column follows the 11 column.
  const colunaObjeto = celulaRastreioLi(codigo, COLUNA_OBJETO_LI);
  const objeto = decidirObjetoRastreioLi({ nosso, envio });
  if (objeto.kind === 'enviar' && colunaObjeto.acao === 'escrever') {
    return { kind: 'objeto', envioId: objeto.envioId, valor: objeto.valor };
  }
  const aviso = avisoDoObjeto(objeto);
  if (celula.acao === 'pular') return { kind: 'nada', aviso };
  return {
    kind: 'situacao',
    codigo: alvo,
    aviso,
    objetoSemEfeito: objeto.kind === 'igual',
    objetoNaoEnviado: false,
  };
}

/* -------------------------------------------------------------------------- */
/*                          The history check                     */
/* -------------------------------------------------------------------------- */

/** What the situação history says about a situação change we caused. */
export type ConferenciaHistoricoLi =
  /** Exactly `seen → ours` after the anchor. */
  | { readonly kind: 'conferido' }
  /** `seen → X → ours` with X a codigo the matrix would have written from: no loss. */
  | { readonly kind: 'intermediaria-compativel'; readonly codigos: readonly string[] }
  /** `seen → X → ours` with X a codigo the matrix refuses: X was overwritten. */
  | { readonly kind: 'sobrescrito'; readonly codigo: string; readonly critico: boolean }
  /** `ours → ours`: a concurrent attempt wrote the same codigo again. */
  | { readonly kind: 'duplicado' }
  /** No row of ours after the anchor (not visible yet). */
  | { readonly kind: 'sem-linha' }
  /** No anchor, or our row with an empty previous situação. */
  | { readonly kind: 'inconclusivo' };

/**
 * The check after a situação change we caused — a situação write, or the move a
 * tracking code made (module header). `codigoAntes` is the codigo the deciding
 * read saw; `codigoEscrito` the one we caused.
 */
export function conferirHistoricoLi(
  brutas: readonly SituacaoHistoricoLinhaLi[],
  o: {
    readonly numero: number;
    readonly codigoAntes: string;
    readonly codigoEscrito: CodigoSituacaoEscritaLi;
  },
): ConferenciaHistoricoLi {
  const { linhas } = limparHistoricoLi(brutas, o.numero);
  // the LAST row that reached the codigo the deciding read saw.
  let ancora = -1;
  linhas.forEach((l, i) => {
    if (l.codigo === o.codigoAntes) ancora = i;
  });
  if (ancora < 0) return { kind: 'inconclusivo' };
  const depois = linhas.slice(ancora + 1);
  const nossa = depois.findIndex((l) => l.codigo === o.codigoEscrito);
  if (nossa < 0) return { kind: 'sem-linha' };
  const linhaNossa = depois[nossa]!;
  // our row with no previous situação proves nothing either way.
  if (linhaNossa.codigoAnterior === null) return { kind: 'inconclusivo' };

  // The codigos someone else set in the gap: the rows before ours, and our row's
  // own previous situação when it is not the seen one (a row missing in between).
  const intermediarios = depois.slice(0, nossa).map((l) => l.codigo);
  if (
    linhaNossa.codigoAnterior !== o.codigoAntes &&
    linhaNossa.codigoAnterior !== o.codigoEscrito
  ) {
    if (!intermediarios.includes(linhaNossa.codigoAnterior)) {
      intermediarios.push(linhaNossa.codigoAnterior);
    }
  }

  // an intermediate the matrix would have written from is no loss.
  const recusados = intermediarios.filter(
    (x) => decidirSituacaoRastreioLi(x, o.codigoEscrito).acao === 'recusar',
  );
  if (recusados.length > 0) {
    const critico = recusados.find((x) => NUNCA_ESCREVER_LI.has(x));
    return critico === undefined
      ? { kind: 'sobrescrito', codigo: recusados[0]!, critico: false }
      : { kind: 'sobrescrito', codigo: critico, critico: true };
  }

  const duplicado = depois
    .slice(nossa + 1)
    .some((l) => l.codigo === o.codigoEscrito && l.codigoAnterior === o.codigoEscrito);
  if (duplicado) return { kind: 'duplicado' };
  if (intermediarios.length > 0) {
    return { kind: 'intermediaria-compativel', codigos: intermediarios };
  }
  return { kind: 'conferido' };
}

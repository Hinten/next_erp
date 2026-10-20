import { FirebaseError } from 'firebase/app';
import {
  CODIGO_ERRO_LI,
  VEREDITO_PAGAMENTO_LI,
  contaIdDoPedidoLi,
  preimagemPedidoLi,
  rotuloSituacaoLi,
  type CodigoErroLi,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';

import { FRASE_MOTIVO_CONTESTADO_LI } from '@/lib/avisos/mensagens';
import type { EtiquetaProviderUi } from '@/lib/checkout/etiqueta/types';

import {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
  type LojaIntegradaClient,
} from './client';

/**
 * The web half of the Loja Integrada paid re-check (master plan step 15, #1825).
 *
 * Before an imported Loja Integrada order is dispatched, the ERP asks the
 * deployed `apps/loja-integrada` backend (`GET …/pedidos/[pedidoId]/pagamento`)
 * what the order's CURRENT situação is. The browser never calls Loja Integrada
 * itself: the backend decides whether its one read may run, and answers from the
 * ERP's own contested mirror, or with a coded "não verificável", when it cannot.
 *
 * This module holds every piece of that check the web needs, and ONE copy of its
 * operator text, for all four gates:
 *
 * - **the identity** ({@link ehPedidoImportadoDaLojaIntegrada}): a pedido is an
 *   imported order exactly when its id is the sha256 of the shared preimage. A
 *   Mercado Livre or Shopee pedido, a duplicate or a manual pedido fails it, and
 *   never wakes the scale-to-zero backend;
 * - **the call** ({@link conferirPagamentoLi}): every way it can end, as data,
 *   stamped with the CLIENT's monotonic clock;
 * - **two decision tables**, total over `CodigoErroLi`:
 *   - hard — the checkout save and the Melhor Envio buy, which spend stock and
 *     money ({@link decidirConferenciaPagamentoLi}): a verdict that does not
 *     authorise dispatch BLOCKS;
 *   - soft — a Melhor Envio reprint and a generic label, which spend nothing
 *     ({@link decidirConferenciaImpressaoLi}): the same verdict asks the operator
 *     to tick "Estou ciente do risco" before continuing;
 *   - an answer that cannot be verified asks the SAME cause-specific confirm at
 *     every gate: the soft column never asks more than the hard one;
 * - **the soft gate itself** ({@link conferirAntesDeImprimirLi}), which the
 *   label providers and the `/pedidos` row reprint call.
 *
 * ⚠️ The verdict is never cached. The one reuse is a `pago` CARRIED along one
 * checkout chain (`conferenciaLi`), accepted for {@link VALIDADE_CONFERENCIA_LI_MS}
 * by the client's own `performance.now()` — never by the server's
 * `conferidoEmMs`, which would bring clock skew.
 */

/* -------------------------------------------------------------------------- */
/*                                 The identity                                */
/* -------------------------------------------------------------------------- */

/** The two pedido fields the identity reads — a list projection must keep both. */
export interface IdentidadePedidoLi {
  readonly integracaoPedidoOuterRef?: unknown;
  readonly numero?: unknown;
}

/** Lowercase hex of a SHA-256, through WebCrypto — or `null` where the page has none. */
async function sha256Hex(texto: string): Promise<string | null> {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether `pedidoId` IS an order imported from Loja Integrada: the pedido's
 * conta (`contaIdDoPedidoLi`) and `numero` give the shared preimage
 * (`preimagemPedidoLi`), and its sha256 equals the id. Both folds are the
 * definers', applied verbatim — so `'165'` (as the import stores it) and `165`
 * are the same order, the bare and `documents/` conta refs the same conta.
 *
 * Not imported (`false`, and no gate calls anything): no conta ref, a ref to
 * another collection, a duplicate's `null` numero, a non-canonical numero
 * (`'0165'`), another conta's preimage, another channel's spelling of the same
 * order, a digest in another case.
 *
 * ⚠️ A page with no WebCrypto (`crypto.subtle` exists only on a secure origin —
 * https, or localhost) answers `true` for a pedido that HAS a preimage: the
 * route re-checks the identity itself before any read and answers
 * `aplicavel: false` for a pedido that is not an import, so the fallback costs a
 * call, never a wrong verdict. Skipping instead would silently drop the check.
 */
export async function ehPedidoImportadoDaLojaIntegrada(
  pedidoId: string,
  pedido: IdentidadePedidoLi,
): Promise<boolean> {
  const preimagem = preimagemPedidoLi(
    contaIdDoPedidoLi(pedido.integracaoPedidoOuterRef),
    pedido.numero,
  );
  if (preimagem === null) return false;
  const digest = await sha256Hex(preimagem);
  return digest === null ? true : digest === pedidoId;
}

/* -------------------------------------------------------------------------- */
/*                               One call, as data                             */
/* -------------------------------------------------------------------------- */

/** Why the call produced no answer to decide from. */
export type FalhaConferenciaPagamentoLi =
  /** The backend's envelope, with a code this build knows. */
  | { readonly tipo: 'codigo'; readonly codigo: CodigoErroLi }
  /** No client: logged out, or a build that cannot reach the backend safely. */
  | { readonly tipo: 'sem-cliente' }
  /** A 401/403 without a known code — the caller's session or permission. */
  | { readonly tipo: 'sem-permissao' }
  /** A 404 without an envelope: a backend older than the route. */
  | { readonly tipo: 'backend-desatualizado' }
  /** A 2xx this build cannot read (the backend and the page disagree). */
  | { readonly tipo: 'resposta-invalida' }
  /** Any other non-2xx without a known code: a 5xx page, a code a newer backend added. */
  | { readonly tipo: 'http'; readonly status: number; readonly codigo: string | null }
  | { readonly tipo: 'rede' }
  /** {@link PRAZO_CONFERENCIA_PAGAMENTO_LI_MS} passed with no answer. */
  | { readonly tipo: 'tempo-esgotado' }
  /** The Firebase ID token could not be obtained. */
  | { readonly tipo: 'sessao' };

/** How one paid re-check call ended. */
export type ConferenciaPagamentoLi =
  | {
      readonly tipo: 'resposta';
      readonly resposta: RespostaConferenciaPagamentoLi;
      /** `performance.now()` when the answer arrived — the age a carried `pago` is judged by. */
      readonly recebidoEm: number;
    }
  | { readonly tipo: 'falha'; readonly falha: FalhaConferenciaPagamentoLi };

/** A verdict carried along one checkout chain — the call's answer, as it came back. */
export type ConferenciaLiCarregada = Extract<ConferenciaPagamentoLi, { tipo: 'resposta' }>;

/** How long a carried `pago` is reused, by the client's clock (ms). */
export const VALIDADE_CONFERENCIA_LI_MS = 120_000;

const CODIGOS_ERRO_LI: ReadonlySet<string> = new Set<string>(Object.values(CODIGO_ERRO_LI));

function ehCodigoErroLi(codigo: string | null): codigo is CodigoErroLi {
  return codigo !== null && CODIGOS_ERRO_LI.has(codigo);
}

/** The outcome a client error stands for, or `null` for one that is not the call's (rethrown). */
function falhaDoErro(err: unknown): FalhaConferenciaPagamentoLi | null {
  // The subclasses FIRST: each is an instance of its parent too.
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) return { tipo: 'resposta-invalida' };
  if (err instanceof LojaIntegradaClientHttpError) {
    if (ehCodigoErroLi(err.code)) return { tipo: 'codigo', codigo: err.code };
    if (err.status === 401 || err.status === 403) return { tipo: 'sem-permissao' };
    if (err.status === 404 && err.code === null) return { tipo: 'backend-desatualizado' };
    return { tipo: 'http', status: err.status, codigo: err.code };
  }
  if (err instanceof LojaIntegradaClientTempoEsgotadoError) return { tipo: 'tempo-esgotado' };
  if (err instanceof LojaIntegradaClientNetworkError) return { tipo: 'rede' };
  // `getAuthToken()` runs outside the client's transport catch, on purpose.
  if (err instanceof FirebaseError) return { tipo: 'sessao' };
  return null;
}

/**
 * ONE paid re-check call, as data. A plain awaited call, never a react-query
 * hook: the app's query defaults (`staleTime`, `retry: 1`) would serve a stale
 * `pago` or double a 503.
 *
 * Anything that is not one of the client's own errors is rethrown (rule 6) —
 * including an abort the caller asked for through `sinal`.
 */
export async function conferirPagamentoLi(
  client: LojaIntegradaClient | null,
  pedidoId: string,
  opcoes: { readonly sinal?: AbortSignal; readonly agora?: () => number } = {},
): Promise<ConferenciaPagamentoLi> {
  if (client === null) return { tipo: 'falha', falha: { tipo: 'sem-cliente' } };
  const agora = opcoes.agora ?? (() => performance.now());
  try {
    const resposta = await client.conferirPagamento(
      pedidoId,
      opcoes.sinal === undefined ? undefined : { sinal: opcoes.sinal },
    );
    return { tipo: 'resposta', resposta, recebidoEm: agora() };
  } catch (err) {
    const falha = falhaDoErro(err);
    if (falha === null) throw err;
    return { tipo: 'falha', falha };
  }
}

/**
 * Whether a carried verdict stands in for a new call: a LIVE-or-mirror answer
 * whose verdict is `pago` (only a live read can say it), received less than
 * {@link VALIDADE_CONFERENCIA_LI_MS} ago by `agora` — the same monotonic clock
 * that stamped it. Anything else (a `nao-pago`, an `aplicavel: false`, an
 * answer from the future) is asked again.
 */
export function conferenciaLiReaproveitavel(
  carregada: ConferenciaLiCarregada | null | undefined,
  agora: number,
): boolean {
  if (carregada == null) return false;
  const r = carregada.resposta;
  if (!r.aplicavel || r.veredito !== VEREDITO_PAGAMENTO_LI.pago) return false;
  const idade = agora - carregada.recebidoEm;
  return idade >= 0 && idade < VALIDADE_CONFERENCIA_LI_MS;
}

/* -------------------------------------------------------------------------- */
/*                            The two decision tables                          */
/* -------------------------------------------------------------------------- */

/** Which unverifiable class a failure is — it picks the confirm's copy. */
export type ClasseNaoVerificavelLi = 'configuracao' | 'transitorio';

/** What a HARD gate (checkout save, Melhor Envio buy) does with a backend code. */
export type AcaoHardDoCodigoLi = 'bloquear' | 'confirmar-configuracao' | 'confirmar-transitorio';

/** What a SOFT gate (reprint, generic label) does with a backend code. */
export type AcaoImpressaoDoCodigoLi = 'ciente' | 'confirmar-configuracao' | 'confirmar-transitorio';

const E = CODIGO_ERRO_LI;

/**
 * The hard column, by backend code — TOTAL by type (`satisfies`), so a code
 * added to `CODIGO_ERRO_LI` without a row fails to compile:
 *
 * - **not authorised** (block): another order came back, Loja Integrada does not
 *   have it, or the ERP has no such pedido;
 * - **unverifiable, configuration**: the read switch, the conta's state or its
 *   credential — retrying does not help;
 * - **unverifiable, transient**: Loja Integrada throttled, timed out or is down,
 *   and every code this route never answers (listed so the table stays total).
 */
export const ACAO_HARD_DO_CODIGO_LI = {
  [E.pedidoDivergente]: 'bloquear',
  [E.pedidoAusenteNaLoja]: 'bloquear',
  [E.pedidoNaoEncontrado]: 'bloquear',
  [E.chamadasDesligadas]: 'confirmar-configuracao',
  [E.reconexaoPendente]: 'confirmar-configuracao',
  [E.contaInativa]: 'confirmar-configuracao',
  [E.contaNaoEncontrada]: 'confirmar-configuracao',
  [E.credencialAusente]: 'confirmar-configuracao',
  [E.credencialInvalida]: 'confirmar-configuracao',
  [E.credencialAlterada]: 'confirmar-configuracao',
  [E.limiteDeChamadas]: 'confirmar-transitorio',
  [E.tempoEsgotadoLoja]: 'confirmar-transitorio',
  [E.lojaIndisponivel]: 'confirmar-transitorio',
  [E.estacionamentoEmConflito]: 'confirmar-transitorio',
  [E.idInvalido]: 'confirmar-transitorio',
  [E.rotaEmConflito]: 'confirmar-transitorio',
  [E.corpoInvalido]: 'confirmar-transitorio',
  [E.validadeInvalida]: 'confirmar-transitorio',
  [E.validadePassada]: 'confirmar-transitorio',
  [E.validadeDistante]: 'confirmar-transitorio',
  [E.tokenDeOutraConta]: 'confirmar-transitorio',
  [E.tokenRecusado]: 'confirmar-transitorio',
  [E.tokenInvalido]: 'confirmar-transitorio',
  [E.validacaoInconclusiva]: 'confirmar-transitorio',
} as const satisfies Record<CodigoErroLi, AcaoHardDoCodigoLi>;

/**
 * The soft column, by backend code — total like the hard one, and pinned
 * against it row by row: the checkbox replaces EXACTLY the block, and every
 * confirm is the same confirm.
 */
export const ACAO_IMPRESSAO_DO_CODIGO_LI = {
  [E.pedidoDivergente]: 'ciente',
  [E.pedidoAusenteNaLoja]: 'ciente',
  [E.pedidoNaoEncontrado]: 'ciente',
  [E.chamadasDesligadas]: 'confirmar-configuracao',
  [E.reconexaoPendente]: 'confirmar-configuracao',
  [E.contaInativa]: 'confirmar-configuracao',
  [E.contaNaoEncontrada]: 'confirmar-configuracao',
  [E.credencialAusente]: 'confirmar-configuracao',
  [E.credencialInvalida]: 'confirmar-configuracao',
  [E.credencialAlterada]: 'confirmar-configuracao',
  [E.limiteDeChamadas]: 'confirmar-transitorio',
  [E.tempoEsgotadoLoja]: 'confirmar-transitorio',
  [E.lojaIndisponivel]: 'confirmar-transitorio',
  [E.estacionamentoEmConflito]: 'confirmar-transitorio',
  [E.idInvalido]: 'confirmar-transitorio',
  [E.rotaEmConflito]: 'confirmar-transitorio',
  [E.corpoInvalido]: 'confirmar-transitorio',
  [E.validadeInvalida]: 'confirmar-transitorio',
  [E.validadePassada]: 'confirmar-transitorio',
  [E.validadeDistante]: 'confirmar-transitorio',
  [E.tokenDeOutraConta]: 'confirmar-transitorio',
  [E.tokenRecusado]: 'confirmar-transitorio',
  [E.tokenInvalido]: 'confirmar-transitorio',
  [E.validacaoInconclusiva]: 'confirmar-transitorio',
} as const satisfies Record<CodigoErroLi, AcaoImpressaoDoCodigoLi>;

/**
 * The pt-BR line for each code: the `<causa>` of a confirm, or the reason of a
 * block. Total by type, like the tables.
 */
const LINHA_DO_CODIGO_LI: Readonly<Record<CodigoErroLi, string>> = {
  [E.pedidoDivergente]: 'A Loja Integrada devolveu outro pedido. Confira a credencial da conta.',
  [E.pedidoAusenteNaLoja]:
    'A Loja Integrada não encontrou este pedido. Confira a credencial da conta.',
  [E.pedidoNaoEncontrado]: 'O pedido não foi encontrado no ERP.',
  [E.chamadasDesligadas]: 'a chave de chamadas está desligada',
  [E.reconexaoPendente]: 'a conta está aguardando reconexão',
  [E.contaInativa]: 'a conta Loja Integrada está inativa',
  [E.contaNaoEncontrada]: 'a conta Loja Integrada do pedido não foi encontrada',
  [E.credencialAusente]: 'a conta não tem credencial cadastrada',
  [E.credencialInvalida]: 'a credencial armazenada da conta está ilegível',
  [E.credencialAlterada]: 'a credencial da conta acabou de mudar',
  [E.limiteDeChamadas]: 'limite de chamadas',
  [E.tempoEsgotadoLoja]: 'tempo esgotado',
  [E.lojaIndisponivel]: 'a Loja Integrada está indisponível',
  [E.estacionamentoEmConflito]: 'conflito ao registrar a reconexão da conta',
  [E.idInvalido]: 'o identificador do pedido foi recusado',
  [E.rotaEmConflito]: 'conflito de escrita no pedido',
  [E.corpoInvalido]: 'a requisição foi recusada',
  [E.validadeInvalida]: 'resposta inesperada do backend',
  [E.validadePassada]: 'resposta inesperada do backend',
  [E.validadeDistante]: 'resposta inesperada do backend',
  [E.tokenDeOutraConta]: 'resposta inesperada do backend',
  [E.tokenRecusado]: 'resposta inesperada do backend',
  [E.tokenInvalido]: 'resposta inesperada do backend',
  [E.validacaoInconclusiva]: 'resposta inesperada do backend',
};

/** The `<causa>` of every non-code failure, by its class. */
function causaDaFalha(falha: Exclude<FalhaConferenciaPagamentoLi, { tipo: 'codigo' }>): {
  readonly classe: ClasseNaoVerificavelLi;
  readonly causa: string;
} {
  switch (falha.tipo) {
    case 'sem-cliente':
      return {
        classe: 'configuracao',
        causa: 'o backend da Loja Integrada não está disponível nesta sessão',
      };
    case 'sem-permissao':
      return { classe: 'configuracao', causa: 'sem permissão para conferir o pagamento' };
    case 'backend-desatualizado':
      return {
        classe: 'configuracao',
        causa: 'o backend da Loja Integrada ainda não oferece esta conferência',
      };
    case 'resposta-invalida':
      return {
        classe: 'configuracao',
        causa: 'o backend da Loja Integrada respondeu num formato que esta tela não conhece',
      };
    case 'http':
      return {
        classe: 'transitorio',
        causa: `o backend da Loja Integrada respondeu HTTP ${String(falha.status)}`,
      };
    case 'rede':
      return { classe: 'transitorio', causa: 'falha de rede' };
    case 'tempo-esgotado':
      return { classe: 'transitorio', causa: 'tempo esgotado' };
    case 'sessao':
      return { classe: 'transitorio', causa: 'não foi possível renovar a sessão' };
  }
}

/** What a gate decides, before any copy is shown. */
type Base =
  | { readonly acao: 'bloquear'; readonly linha: string }
  | {
      readonly acao: 'confirmar';
      readonly classe: ClasseNaoVerificavelLi;
      readonly causa: string;
    }
  | { readonly acao: 'prosseguir' };

/** The outcome of a gate run: no call (not an imported order), or the call's. */
export type DesfechoConferenciaLi = { readonly tipo: 'nao-identificado' } | ConferenciaPagamentoLi;

/** The line a not-authorised verdict blocks (or warns) with — without the gate's suffix. */
function linhaDoVeredito(r: RespostaConferenciaPagamentoLi): string | null {
  if (!r.aplicavel) return null;
  if (r.fonte === 'erp') {
    const frase =
      r.motivoContestacao === null
        ? 'o pagamento foi contestado'
        : FRASE_MOTIVO_CONTESTADO_LI[r.motivoContestacao];
    return `O pagamento deste pedido está contestado (${frase}).`;
  }
  switch (r.veredito) {
    case VEREDITO_PAGAMENTO_LI.pago:
      return null;
    case VEREDITO_PAGAMENTO_LI.naoPago:
      return (
        `A Loja Integrada mostra este pedido como "${rotuloSituacaoLi(r.codigo) ?? r.codigo}", ` +
        'não como pago.'
      );
    case VEREDITO_PAGAMENTO_LI.desconhecido:
      return `A Loja Integrada devolveu uma situação que o ERP não conhece (${r.codigo}).`;
  }
}

function decidir(desfecho: DesfechoConferenciaLi, tabela: 'hard' | 'impressao'): Base {
  if (desfecho.tipo === 'nao-identificado') return { acao: 'prosseguir' };
  if (desfecho.tipo === 'resposta') {
    const linha = linhaDoVeredito(desfecho.resposta);
    return linha === null ? { acao: 'prosseguir' } : { acao: 'bloquear', linha };
  }
  const { falha } = desfecho;
  if (falha.tipo !== 'codigo') return { acao: 'confirmar', ...causaDaFalha(falha) };
  const acao =
    tabela === 'hard'
      ? ACAO_HARD_DO_CODIGO_LI[falha.codigo]
      : ACAO_IMPRESSAO_DO_CODIGO_LI[falha.codigo];
  const linha = LINHA_DO_CODIGO_LI[falha.codigo];
  switch (acao) {
    case 'bloquear':
    case 'ciente':
      return { acao: 'bloquear', linha };
    case 'confirmar-configuracao':
      return { acao: 'confirmar', classe: 'configuracao', causa: linha };
    case 'confirmar-transitorio':
      return { acao: 'confirmar', classe: 'transitorio', causa: linha };
  }
}

/** A hard gate's decision. */
export type DecisaoConferenciaPagamentoLi = Base;

/** A soft gate's decision: a block becomes the acknowledged-risk warning. */
export type DecisaoConferenciaImpressaoLi =
  | { readonly acao: 'imprimir' }
  | { readonly acao: 'ciente'; readonly linha: string }
  | Extract<Base, { acao: 'confirmar' }>;

/**
 * The HARD gates — the checkout save and the Melhor Envio buy: `prosseguir`
 * (not an import, not applicable, `pago`), `bloquear` (a verdict that does not
 * authorise dispatch, or an answer about another order), or `confirmar` (it
 * could not be verified; the class picks the copy).
 */
export function decidirConferenciaPagamentoLi(
  desfecho: DesfechoConferenciaLi,
): DecisaoConferenciaPagamentoLi {
  return decidir(desfecho, 'hard');
}

/**
 * The SOFT gates — a Melhor Envio reprint and a generic label: `imprimir`,
 * `ciente` (the hard gate's block, as a warning the operator may acknowledge),
 * or the same `confirmar` the hard gate asks.
 */
export function decidirConferenciaImpressaoLi(
  desfecho: DesfechoConferenciaLi,
): DecisaoConferenciaImpressaoLi {
  const base = decidir(desfecho, 'impressao');
  switch (base.acao) {
    case 'prosseguir':
      return { acao: 'imprimir' };
    case 'bloquear':
      return { acao: 'ciente', linha: base.linha };
    case 'confirmar':
      return base;
  }
}

/* -------------------------------------------------------------------------- */
/*                         The copy — one source, four gates                   */
/* -------------------------------------------------------------------------- */

/** Which hard gate stopped: the checkout, the modal's buy, or the buy inside the checkout chain. */
export type GateConferenciaLi = 'checkout' | 'comprar' | 'cadeia';

const SUFIXO_DO_GATE: Readonly<Record<GateConferenciaLi, string>> = {
  checkout: 'O checkout não foi salvo.',
  comprar: 'A compra da etiqueta foi bloqueada.',
  cadeia: 'A compra da etiqueta foi bloqueada; o checkout e a NF-e já foram salvos.',
};

/** A hard gate's block message: the line, then what did not happen. */
export function mensagemBloqueioConferenciaLi(linha: string, gate: GateConferenciaLi): string {
  return `${linha} ${SUFIXO_DO_GATE[gate]}`;
}

/** The A1 confirm of an unverifiable check — the same at every gate. */
export function mensagemConfirmacaoConferenciaLi(p: {
  readonly classe: ClasseNaoVerificavelLi;
  readonly causa: string;
}): string {
  return p.classe === 'configuracao'
    ? `A conferência de pagamento na Loja Integrada não está disponível (${p.causa}): é ` +
        'configuração da conta, não instabilidade. Deseja continuar mesmo assim?'
    : `A Loja Integrada não respondeu à conferência de pagamento (${p.causa}). ` +
        'Deseja continuar mesmo assim?';
}

/** What a soft gate is about to print. */
export type AtoImpressaoLi = 'reimpressao' | 'etiqueta-generica';

const FRASE_DO_ATO: Readonly<Record<AtoImpressaoLi, string>> = {
  reimpressao:
    'Reimprimir a etiqueta deste pedido pode levar ao despacho de um pedido que não deveria sair.',
  'etiqueta-generica':
    'Imprimir a etiqueta deste pedido pode levar ao despacho de um pedido que não deveria sair.',
};

/** The acknowledged-risk warning of a soft gate (the dialog adds "Estou ciente do risco"). */
export function avisoCienteConferenciaLi(
  linha: string,
  ato: AtoImpressaoLi,
): { readonly titulo: string; readonly mensagem: string } {
  return {
    titulo: 'Pagamento não confirmado na Loja Integrada',
    mensagem:
      `${linha} ${FRASE_DO_ATO[ato]} ` +
      'Você pode continuar, mas o pedido pode não estar liberado para despacho.',
  };
}

/* -------------------------------------------------------------------------- */
/*                                The soft gate                                */
/* -------------------------------------------------------------------------- */

/**
 * The soft gate (A2) before a Melhor Envio REPRINT or a GENERIC label:
 *
 *  1. not an imported order ⇒ `prosseguir`, with no call;
 *  2. a `pago` carried under {@link VALIDADE_CONFERENCIA_LI_MS} ⇒ `prosseguir`,
 *     with no call;
 *  3. otherwise one call, and {@link decidirConferenciaImpressaoLi}:
 *     - `imprimir` ⇒ `prosseguir`;
 *     - `ciente` ⇒ `ui.confirmarCiente` — Continuar only after the operator
 *       ticks "Estou ciente do risco"; Cancelar ⇒ `cancelado`;
 *     - `confirmar` ⇒ `ui.confirmRisk` with the A1 copy, never the checkbox.
 *
 * Never on a Melhor Envio BUY (the buy modal's hard gate owns it), on Rastrear,
 * or on a click that prints nothing.
 */
export async function conferirAntesDeImprimirLi(args: {
  readonly client: LojaIntegradaClient | null;
  readonly pedidoId: string;
  readonly pedido: IdentidadePedidoLi;
  readonly conferenciaLi?: ConferenciaLiCarregada | null;
  readonly ui: Pick<EtiquetaProviderUi, 'confirmRisk' | 'confirmarCiente'>;
  readonly ato: AtoImpressaoLi;
  readonly agora?: () => number;
}): Promise<'prosseguir' | 'cancelado'> {
  const agora = args.agora ?? (() => performance.now());
  if (!(await ehPedidoImportadoDaLojaIntegrada(args.pedidoId, args.pedido))) return 'prosseguir';
  if (conferenciaLiReaproveitavel(args.conferenciaLi, agora())) return 'prosseguir';

  const desfecho = await conferirPagamentoLi(args.client, args.pedidoId, { agora });
  const decisao = decidirConferenciaImpressaoLi(desfecho);
  switch (decisao.acao) {
    case 'imprimir':
      return 'prosseguir';
    case 'ciente':
      return (await args.ui.confirmarCiente(avisoCienteConferenciaLi(decisao.linha, args.ato)))
        ? 'prosseguir'
        : 'cancelado';
    case 'confirmar':
      return (await args.ui.confirmRisk(mensagemConfirmacaoConferenciaLi(decisao)))
        ? 'prosseguir'
        : 'cancelado';
  }
}

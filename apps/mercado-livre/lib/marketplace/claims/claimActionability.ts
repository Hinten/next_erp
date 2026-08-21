/**
 * What the SELLER can still do on a Mercado Livre claim — the owner's
 * "import only what we can respond to or act on" directive, applied to claims
 * (#768). PURE: no Firestore, no clock, no ML calls.
 *
 * The signal is `players[role=respondent].available_actions`, which ML documents
 * as *"lista de ações que podem ser executadas por cada uma das partes
 * intervenientes"*. It is authoritative and it empties out on its own: a closed
 * claim carries `available_actions: []` for every player, which is exactly the
 * "nothing left to do here" the directive asks about.
 *
 * ⚠️ **The Incidente and the Conversa are gated DIFFERENTLY, on purpose.**
 * The incidente is pedido business history — refunds, returns, the mediation
 * outcome — and stays valuable long after the claim closes, so it is written for
 * EVERY claim. The conversa is a chat surface an attendant is expected to answer
 * in; one with no send action is a thread that silently swallows replies, which
 * is #817. So: incidente always, conversa only while the seller can message.
 *
 * ⚠️ It is NOT symmetric with "can we act at all". A seller holding only
 * `refund` or `allow_return` can act — through the incidente, and through the
 * resolution actions #768's respond half adds — but cannot SEND A MESSAGE, and
 * a chat composer is the wrong place to offer a refund. `acoesDisponiveis` is
 * returned whole so that half can read it without re-deriving anything.
 */
import type { MlClaim, MlClaimPlayer } from '@delfrance/integrations-mercado-livre';

/** ML's player roles (`players[].role`). */
export const ROLE_CLAIM = {
  complainant: 'complainant',
  respondent: 'respondent',
  mediator: 'mediator',
} as const satisfies Record<string, string>;

/**
 * The seller's two message actions, per ML's action table:
 *
 * | action | stage | receiver_role |
 * |---|---|---|
 * | `send_message_to_complainant` | `claim`   | `complainant` |
 * | `send_message_to_mediator`    | `dispute` | `mediator`    |
 *
 * ⚠️ `send_message_to_respondent` is deliberately ABSENT: that is the action the
 * *buyer* holds. We are always the respondent on a claim against our own sale,
 * so treating it as ours would open a composer that posts to nobody.
 */
export const ACOES_MENSAGEM_VENDEDOR = {
  send_message_to_complainant: 'complainant',
  send_message_to_mediator: 'mediator',
} as const satisfies Record<string, string>;

export type AcaoMensagemClaim = keyof typeof ACOES_MENSAGEM_VENDEDOR;

/** The `receiver_role` a given send action addresses — `POST …/actions/send-message`. */
export function receiverRoleDaAcao(acao: AcaoMensagemClaim): string {
  return ACOES_MENSAGEM_VENDEDOR[acao];
}

export interface ClaimActionability {
  /** Whether a chat conversa should exist / stay answerable for this claim. */
  readonly podeResponder: boolean;
  /** `null` while answerable; otherwise the operator-facing reason. */
  readonly motivo: string | null;
  /**
   * The send action to use, when there is one. `send_message_to_mediator` wins
   * over `send_message_to_complainant`: once a mediation is open, ML routes the
   * seller's messages to the mediator, and a message sent to the complainant in
   * that stage is refused.
   */
  readonly acaoMensagem: AcaoMensagemClaim | null;
  /** Every action ML offered the seller, verbatim — the resolution half reads this. */
  readonly acoesDisponiveis: readonly string[];
}

/** The seller's own `players[]` entry. */
export function findRespondentPlayer(claim: MlClaim): MlClaimPlayer | undefined {
  return claim.players.find((p) => p.role === ROLE_CLAIM.respondent);
}

/** ML claim `status` wire literal for a closed claim. */
const CLAIM_STATUS_CLOSED = 'closed';

/**
 * `type: 'return'` claims carry NO messages at all — ML says so outright
 * (*"Neste caso, não há mensagens"*) and points integrators at the returns API
 * instead. A chat conversa for one would be permanently empty.
 *
 * ⚠️ Both spellings are checked because ML's own reference disagrees with
 * itself: the field table documents `return`, while the search response example
 * ships `"type": "returns"`. Matching one would leave the other importing empty
 * threads.
 */
const TIPOS_SEM_MENSAGEM: ReadonlySet<string> = new Set(['return', 'returns']);

/**
 * Decide whether this claim should own an answerable chat conversa.
 *
 * Ordered cheapest-and-most-certain first, so the reason an operator reads is
 * the most specific true one rather than whichever check happened to run.
 */
export function claimActionability(claim: MlClaim): ClaimActionability {
  const respondent = findRespondentPlayer(claim);
  const acoesDisponiveis = (respondent?.available_actions ?? [])
    .map((a) => (a.action ?? '').trim())
    .filter((a) => a !== '');

  const acaoMensagem: AcaoMensagemClaim | null = acoesDisponiveis.includes(
    'send_message_to_mediator',
  )
    ? 'send_message_to_mediator'
    : acoesDisponiveis.includes('send_message_to_complainant')
      ? 'send_message_to_complainant'
      : null;

  const semMensagem = { podeResponder: false, acaoMensagem: null, acoesDisponiveis } as const;

  if (respondent == null) {
    // We are not a party to this claim. Nothing to answer, by definition.
    return { ...semMensagem, motivo: 'O vendedor não é parte desta reclamação' };
  }

  const tipo = (claim.type ?? '').trim().toLowerCase();
  if (TIPOS_SEM_MENSAGEM.has(tipo)) {
    return { ...semMensagem, motivo: 'Devolução — o Mercado Livre não abre mensagens neste fluxo' };
  }

  if (acaoMensagem != null) {
    return { podeResponder: true, motivo: null, acaoMensagem, acoesDisponiveis };
  }

  // No send action. Say WHY as precisely as the payload allows: "closed" and
  // "open but you have nothing to say right now" are different situations, and
  // the second one can reopen on the next notification.
  if ((claim.status ?? '').trim().toLowerCase() === CLAIM_STATUS_CLOSED) {
    return { ...semMensagem, motivo: 'Reclamação encerrada no Mercado Livre' };
  }
  if (acoesDisponiveis.length > 0) {
    // e.g. only `refund` / `allow_return` / `send_tracking_number` remain — real
    // work, but not chat work. It lives on the incidente.
    return {
      ...semMensagem,
      motivo: 'Sem envio de mensagens nesta etapa — veja as ações no incidente do pedido',
    };
  }
  return { ...semMensagem, motivo: 'Sem ações disponíveis para o vendedor nesta reclamação' };
}

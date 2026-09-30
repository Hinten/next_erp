/**
 * The answer shape of the payment-link orchestrations (#367): a status and a
 * body, decided by the orchestration and merely serialised by the route
 * (`NextResponse.json(r.corpo, { status: r.status })`).
 *
 * Why the orchestrations RETURN their refusals instead of throwing: a refusal
 * (409 `LINK_NAO_ELEGIVEL`, 404, 429) is a deterministic answer about the
 * request, not a failure of the system, and a route's catch is reserved for the
 * Mercado Pago / configuration errors `respond.ts` maps. Everything else — a
 * Firestore outage, a bug — still THROWS and surfaces as a 500 (root
 * `CLAUDE.md` rule 6).
 *
 * The bodies follow the shared wire contract (`erroLinkPagamentoSchema` in
 * `@delfrance/schemas`): `code` tells a refusal from version skew, `reason` names
 * WHY in the same vocabulary the web's client-side gate uses
 * (`MOTIVO_RECUSA_LINK_LABELS`), so a notice shown before the click and a refusal
 * answered after it never describe one situation in two ways.
 */
import {
  CODIGO_ERRO_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  type ErroLinkPagamento,
  type MotivoRecusaLink,
} from '@delfrance/schemas';

/** A refusal: the statuses the link routes answer with an error body. */
export interface RespostaErroLink {
  status: 400 | 404 | 409 | 429;
  corpo: ErroLinkPagamento;
}

/** What an orchestration returns: a success body or one of the refusals. */
export type RespostaLink<T> = { status: 200 | 201; corpo: T } | RespostaErroLink;

/** A success answer. `200` by default; `201` only for a create that wrote. */
export function respostaOk<T>(corpo: T, status: 200 | 201 = 200): RespostaLink<T> {
  return { status, corpo };
}

/**
 * An error answer. `reason` is only ever sent alongside `LINK_NAO_ELEGIVEL`
 * (see {@link recusaLink}); an absent one is left OUT of the body rather than
 * sent as `undefined`.
 */
export function erroLink(
  status: RespostaErroLink['status'],
  code: string,
  error: string,
  reason?: MotivoRecusaLink,
): RespostaErroLink {
  return { status, corpo: { error, code, ...(reason ? { reason } : {}) } };
}

/**
 * `409 LINK_NAO_ELEGIVEL` with the pt-BR sentence of `motivo` — the one
 * refusal every "this request cannot be honoured right now" case shares.
 */
export function recusaLink(motivo: MotivoRecusaLink): RespostaErroLink {
  return erroLink(409, CODIGO_ERRO_LINK.naoElegivel, MOTIVO_RECUSA_LINK_LABELS[motivo], motivo);
}

/** `404 PEDIDO_NAO_ENCONTRADO`. */
export function pedidoNaoEncontrado(): RespostaErroLink {
  return erroLink(404, CODIGO_ERRO_LINK.pedidoNaoEncontrado, 'Pedido não encontrado.');
}

/** `404 LINK_NAO_ENCONTRADO`. */
export function linkNaoEncontrado(): RespostaErroLink {
  return erroLink(404, CODIGO_ERRO_LINK.linkNaoEncontrado, 'Link de pagamento não encontrado.');
}

/** `400 LINK_BODY_INVALIDO` for a rule the body schema cannot express (it needs the clock). */
export function corpoInvalido(mensagem: string): RespostaErroLink {
  return erroLink(400, CODIGO_ERRO_LINK.corpoInvalido, mensagem);
}

/** `429 MP_REQUISICAO_REPETIDA` — Mercado Pago refused an identical request within a minute. */
export function requisicaoRepetida(): RespostaErroLink {
  return erroLink(
    429,
    CODIGO_ERRO_LINK.requisicaoRepetida,
    'Aguarde um minuto antes de sincronizar novamente.',
  );
}

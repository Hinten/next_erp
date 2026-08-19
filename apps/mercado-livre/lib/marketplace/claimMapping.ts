/**
 * Pure builders for the Mercado Livre CLAIMS import (Step 14) — ML claim wire
 * shapes → Incidente / Conversa / Mensagem field records. No Firestore, no
 * clock reads (the orchestrator threads `nowUs`), no id hashing (that is
 * `claimIds.ts`'s job — builders receive the already-computed doc ids).
 *
 * Ports `Claims.toIncidente` / `Claims.toConversa` / `ClaimsMessage.toMensagem`
 * / `_Resolution.toResolucao`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3540-3600,
 * 3906-3949, 4105-4135`) plus the reason/attachment mensagens the task builds
 * inline (`tasks.dart:1925-1996`), with the Step 14 hardening policy:
 *
 *  - Display maps fall back to the RAW wire string (legacy `fromValue` THREW
 *    on unknown vocabulary — a poison-pill retry loop; unknown must map).
 *  - `tipoResolucaoFromReason` fixes legacy's hardcoded `item_devolvido`
 *    (models.dart:4128, the #364 fix) with a real reason→tipo table.
 *  - The resolução comentários no longer interpolate a null `decision` as the
 *    literal `'null'` (content-only field; deliberate non-port of the quirk).
 *  - `origem` is `ORIGEM_CONVERSA.mercadoLivreReclamacoes` (`'mlclaims'`) —
 *    legacy passed `Origem.mercadoLivrePedido` here, which collided claim
 *    conversas with order-message conversas in every origem filter; the
 *    dedicated slug has existed for claims all along (deliberate fix).
 *  - Claim-message mensagens carry `timestamp` = the MESSAGE time. Legacy
 *    stored the IMPORT-TIME wall clock (`timestamp ??= DateTime.now()`,
 *    atendimento models.dart:727) — nondeterministic; the new thread hook
 *    windows strictly by `timestamp` (`useMensagensWindow.ts`). Deterministic
 *    message-time keeps re-processing idempotent; a redelivery rewrites the
 *    legacy wall-clock value (deliberate deviation).
 *  - **Identity is a CLIENTE, never a usuario** (#768). Legacy minted a
 *    sem-auth `usuarios` doc per buyer; `usuarios` is now only for people
 *    who can log in, so the buyer rides `clienteOuterRef` /
 *    `clienteMensagemOuterRef` and `claimUsuario.ts` is gone.
 *  - ⚠️ **`estadoEnvio` comes from `sender_role`**, not a constant. Legacy
 *    stamped `enviado` on EVERY claim message, buyer ones included, and the
 *    thread only rendered them correctly because the synthetic usuario made
 *    `MensagemBubble`'s second test pass. This import writes no `user_id`,
 *    so direction rests on `estadoEnvio` alone.
 *  - The chat CONVERSA is gated on the seller still holding a send action
 *    (`claimActionability.ts`); the INCIDENTE is written for EVERY claim —
 *    it is pedido business history and outlives the claim being answerable.
 *  - Incidente `comentarios` uses the RAW wire `resource` — legacy
 *    interpolated the Dart enum toString (`'_ResourceClaims.order …'`,
 *    models.dart:3915). Create-only field; deliberate cleanup, not parity.
 *
 * ⚠️ UNITS: `incidenteSchema` datetimes are MICROSECONDS since epoch;
 * `conversaSchema`/`mensagemSchema` datetimes are MILLISECONDS. The `µs`/`ms`
 * suffixes below are load-bearing.
 */
import type { MlClaim, MlClaimMessage, MlClaimReason } from '@delfrance/integrations-mercado-livre';
import {
  ESTADO_ENVIO,
  ORIGEM_CONVERSA,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  TIPO_MENSAGEM,
  TIPO_RESOLUCAO,
  toOuterRef,
  type Resolucao,
  type TipoIncidente,
  type TipoResolucao,
} from '@delfrance/schemas';
import { coerceToMicros, coerceToMillis } from '@delfrance/core/datetime';

/* -------------------------------------------------------------------------- */
/*                          Display maps (raw fallback)                       */
/* -------------------------------------------------------------------------- */

// `_StatusClaims.displayName` (models.dart:3708-3717).
const STATUS_DISPLAY: Readonly<Record<string, string>> = {
  opened: 'Aberta',
  closed: 'Fechada',
};

// `_StageClaims.displayName` (models.dart:3675-3688).
const STAGE_DISPLAY: Readonly<Record<string, string>> = {
  claim: 'Reclamação',
  dispute: 'Mediação',
  recontact: 'Recontato',
  none: 'Nenhum',
  // Not in the legacy enum — ML added it for `ml_case` claims (buyer ↔ Mercado
  // Livre). Without it the raw slug `stale` reached the operator as a conversa
  // title.
  stale: 'Com o Mercado Livre',
};

// `_ResourceClaims.displayName` (models.dart:3737-3750) + `pack`, which the
// legacy enum lacked (its `order` handling covered packs upstream) — a pack
// resolves to a pedido, so it reads as one.
const RESOURCE_DISPLAY: Readonly<Record<string, string>> = {
  order: 'Pedido',
  pack: 'Pedido',
  shipment: 'Envio',
  payment: 'Pagamento',
  purchase: 'Compra',
};

/** Display lookup with raw-string fallback — never throws; null reads as ''. */
function displayOf(map: Readonly<Record<string, string>>, raw: string | null): string {
  if (raw == null) return '';
  return map[raw] ?? raw;
}

/* -------------------------------------------------------------------------- */
/*                              Enum translations                             */
/* -------------------------------------------------------------------------- */

/**
 * ML claim `type` → `TipoIncidente`. The four documented ML types ARE
 * TipoIncidente wire values (`_typeClaims.toTipoDeIncidente` matched them by
 * value, models.dart:3653); `'change'` is the exchange flow (→ troca); every
 * other/unknown/null type (service/fulfillment/ml_case/…) → outros — legacy
 * THREW on anything outside its four-value enum.
 */
export function tipoIncidenteFromClaimType(type: string | null): TipoIncidente {
  switch (type) {
    case TIPO_INCIDENTE.mediacaoDoMarketplace:
    case TIPO_INCIDENTE.cancelamentoPeloComprador:
    case TIPO_INCIDENTE.devolucao:
    case TIPO_INCIDENTE.cancelamentoPeloVendedor:
      return type;
    // ⚠️ ML's reference contradicts ITSELF on this one: the claim-detail field
    // table documents the type as `return`, while the search-response example
    // ships `"type": "returns"` — and `TIPO_INCIDENTE.devolucao` is the plural.
    // Matching only the plural filed every singular-spelled return claim as
    // `outros`, silently, forever. Accept both.
    case 'return':
      return TIPO_INCIDENTE.devolucao;
    case 'change':
      return TIPO_INCIDENTE.troca;
    default:
      // service / fulfillment / ml_case and anything ML adds next: no closer
      // TipoIncidente exists, and legacy THREW here.
      return TIPO_INCIDENTE.outros;
  }
}

/**
 * ML resolution `reason` → `TipoResolucao` — the #364 fix over legacy's
 * hardcoded `item_devolvido` (models.dart:4128). Unknown/null reasons → outro.
 */
/**
 * ML `resolution.reason` → `TipoResolucao`.
 *
 * ⚠️ Rebuilt against ML's CURRENT published `resolution.reason` list
 * ("Gerenciar reclamações" → resolution.reason), which is ~30 values. The old
 * table covered 16 and a third of those are not in ML's vocabulary at all
 * (`refunded`, `partial_refund`, `expired`, `closed_by_buyer`, `buyer_regret`,
 * `withdrawn`, …) — so most real closures were landing on `outro` while the
 * table looked complete. The invented keys are KEPT: they cost nothing, and if
 * any of them is a value ML once sent, dropping it would regress history.
 */
const TIPO_RESOLUCAO_BY_REASON: Readonly<Record<string, TipoResolucao>> = {
  // ── produto devolvido / trocado ──────────────────────────────────────────
  item_returned: TIPO_RESOLUCAO.itemDevolvido,
  item_changed: TIPO_RESOLUCAO.enviadoOutroItem,
  product_exchanged: TIPO_RESOLUCAO.enviadoOutroItem,
  item_replaced: TIPO_RESOLUCAO.enviadoOutroItem,
  // ── dinheiro de volta ────────────────────────────────────────────────────
  payment_refunded: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  refunded: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  reimbursed: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  charged_back: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  coverage_decision: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  partial_refunded: TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
  partial_refund: TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
  // ── ninguém agiu a tempo ─────────────────────────────────────────────────
  timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  expired: TIPO_RESOLUCAO.inatividadeDoCliente,
  complainant_timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  respondent_timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  return_expired: TIPO_RESOLUCAO.inatividadeDoCliente,
  change_expired: TIPO_RESOLUCAO.inatividadeDoCliente,
  warehouse_timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  // ── encerrada sem que nada mudasse de mãos ───────────────────────────────
  already_shipped: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  buyer_claim_opened: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  buyer_dispute_opened: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  cancel_installation: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  cancelled_by_buyer: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  change_cancelled_buyer: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  change_cancelled_meli: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  change_cancelled_seller: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  closed_by_buyer: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  buyer_regret: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  found_missing_parts: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  low_cost: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  no_bpp: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  opened_claim_by_mistake: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  prefered_to_keep_product: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  product_delivered: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  rep_resolution: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  return_canceled: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  seller_asked_to_close_claim: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  seller_did_not_help: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  seller_explained_functions: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  seller_sent_product: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  shipment_not_stopped: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  warehouse_decision: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  withdrawn: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  worked_out_with_seller: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  // ⚠️ `not_delivered` is deliberately NOT mapped: ML documents it as "produto
  // não entregue", which says what happened and nothing about how the money or
  // the item moved. Guessing `encerradoSemNenhumaAcao` there would assert a
  // fact the payload does not carry; `outro` is the honest answer.
};

export function tipoResolucaoFromReason(reason: string | null): TipoResolucao {
  if (reason == null) return TIPO_RESOLUCAO.outro;
  return TIPO_RESOLUCAO_BY_REASON[reason] ?? TIPO_RESOLUCAO.outro;
}

/* -------------------------------------------------------------------------- */
/*                                 Incidente (µs)                             */
/* -------------------------------------------------------------------------- */

/** ML claim `status` wire literal for a closed claim (`_StatusClaims.closed`). */
const CLAIM_STATUS_CLOSED = 'closed';

/** The legacy fallback when the reason lookup yields no detail/name (tasks.dart:1778). */
const MOTIVO_DESCONHECIDO = 'Motivo da reclamação desconhecido';

/**
 * `_Resolution.toResolucao` (models.dart:4124-4133) with the fixed tipo table.
 * Null when the claim carries no resolution.
 */
export function buildResolucao(resolution: MlClaim['resolution']): Resolucao | null {
  if (resolution == null) return null;
  const decision = resolution.decision;
  return {
    data: coerceToMicros(resolution.date_created),
    tipo: tipoResolucaoFromReason(resolution.reason),
    comentarios:
      `${resolution.closed_by ?? ''}: ${resolution.reason ?? ''}` +
      (decision?.length ? ` ${decision.join('/')}` : ''),
    valor: 0,
    frete: null,
  };
}

/**
 * `Claims.toIncidente` (models.dart:3906-3921). All datetimes MICROSECONDS;
 * `nowUs` is only the fallback for an unparseable wire datetime (legacy would
 * have crashed in `DateTime.parse` long before this point).
 */
export function buildIncidenteFromClaim(
  claim: MlClaim,
  reason: MlClaimReason | undefined,
  nowUs: number,
): Record<string, unknown> {
  const statusDisplay = displayOf(STATUS_DISPLAY, claim.status);
  const stageDisplay = displayOf(STAGE_DISPLAY, claim.stage);
  return {
    origem: ORIGEM_INCIDENTE.pedidoMercadoLivre,
    tipo: tipoIncidenteFromClaimType(claim.type),
    // `max(2000)` on the schema — slice so an outsized ML detail can never
    // become a deterministic ZodError retry loop.
    motivoDoIncidente: (reason?.detail ?? reason?.name ?? MOTIVO_DESCONHECIDO).slice(0, 2000),
    // Raw wire `resource` (legacy wrote the Dart enum toString — module doc);
    // sliced like motivo above: same schema `max(2000)`, same poison-pill class.
    comentarios:
      `${claim.resource} ${claim.resource_id}(${claim.id}) - ${statusDisplay} ${stageDisplay}`.slice(
        0,
        2000,
      ),
    timestamp: coerceToMicros(claim.date_created) ?? nowUs,
    ultimaModificacao: coerceToMicros(claim.last_updated ?? claim.date_created) ?? nowUs,
    externalId: String(claim.id),
    resolucao: buildResolucao(claim.resolution),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Conversa (ms)                              */
/* -------------------------------------------------------------------------- */

export interface ConversaFromClaimContext {
  buyerUserId: number;
  /** `documents/clientes/<id>` — the buyer, resolved from the pedido (#768). */
  clienteOuterRef: string | null;
  contaId: string;
  contaCor: number | null;
  pedidoId: string;
  incidenteId: string;
  /** Null while the seller can still message; otherwise why they cannot. */
  respostaBloqueada: string | null;
}

/**
 * `Claims.toConversa` (models.dart:3923-3949). All datetimes MILLISECONDS.
 * `estadoConversa` is deliberately ABSENT: the schema default (naoRespondido)
 * fills it on create, and the update path must never touch the operator's
 * triage state (legacy :1908-1923 restored `old_estado` after the merge).
 * `data_cadastro` IS present — the orchestrator strips it on the update path.
 * `versao` is left to the schema default (null); legacy `Conversa.withUser`
 * wrote `1`, which nothing reads (the only sensitive branch checks `== 2`) —
 * deliberate deviation.
 */
export function buildConversaFromClaim(
  claim: MlClaim,
  ctx: ConversaFromClaimContext,
): Record<string, unknown> {
  const resourceDisplay = displayOf(RESOURCE_DISPLAY, claim.resource);
  const stageDisplay = displayOf(STAGE_DISPLAY, claim.stage);
  const statusDisplay = displayOf(STATUS_DISPLAY, claim.status);
  return {
    origem: ORIGEM_CONVERSA.mercadoLivreReclamacoes,
    id: String(claim.id),
    nome: `${resourceDisplay} ${claim.resource_id}(${claim.id}) - ${stageDisplay} ${statusDisplay}`.trim(),
    sender_id: String(ctx.buyerUserId),
    atendido: claim.status === CLAIM_STATUS_CLOSED,
    cor_etiqueta: ctx.contaCor ?? 0,
    data_cadastro: coerceToMillis(claim.date_created),
    ultima_modificacao: coerceToMillis(claim.last_updated ?? claim.date_created),
    // ⚠️ NO `usarioOuterRef` and no `user_id`: the buyer is a cliente now
    // (#768). The field stays on the schema for the docs the Flutter app and
    // WhatsApp still write, and `useClienteLink` falls back to it for those.
    clienteOuterRef: ctx.clienteOuterRef,
    respostaBloqueada: ctx.respostaBloqueada,
    integracaoOuterRef: toOuterRef(`integracao/${ctx.contaId}`),
    pedidoOuterRef: toOuterRef(`pedidos/${ctx.pedidoId}`),
    incidenteOuterRef: toOuterRef(`pedidos/${ctx.pedidoId}/incidentes/${ctx.incidenteId}`),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Mensagens (ms)                             */
/* -------------------------------------------------------------------------- */
// `mensagemSchema` has NO passthrough — only modeled fields are written, and
// `data_cadastro` is `.nullish()` with no default, so it is set explicitly on
// every builder below.

/** `sender_role` values that mean "the seller wrote this". */
const ROLE_RESPONDENT = 'respondent';

/**
 * Whether a claim message is OURS. Everything that is not the respondent —
 * the complainant, the mediator, an unknown future role — renders as inbound,
 * which is the safe direction: showing someone else's message as ours is a
 * misattribution an operator cannot detect, while the reverse is obvious.
 */
export function claimMessageDoVendedor(msg: MlClaimMessage): boolean {
  return (msg.sender_role ?? '').trim().toLowerCase() === ROLE_RESPONDENT;
}

/** ML message `status` values meaning the counterparty never saw it. */
const STATUS_NAO_ENTREGUE: ReadonlySet<string> = new Set(['rejected', 'moderated']);

/**
 * One claim message → mensagem fields (`ClaimsMessage.toMensagem`,
 * models.dart:3582-3598). `docId` doubles as `mid`, and as `midGroup` only
 * when the message carries attachments (the attachment mensagens point at it).
 * `timestamp` is the deliberate deviation documented in the module doc (legacy
 * stored the import-time wall clock, `timestamp ??= DateTime.now()`).
 *
 * ⚠️ **`estadoEnvio` is derived from `sender_role`.** Legacy hardcoded
 * `enviado` on every message including the buyer's, and `MensagemBubble` only
 * rendered those correctly because the synthetic usuario satisfied its second
 * test (`user_id === customerUid`). This import writes no `user_id`, so
 * direction rests on `estadoEnvio` alone.
 *
 * ⚠️ A `rejected`/`moderated` message of OURS is one ML did not deliver — it
 * filters the counterparty's moderated messages out of this endpoint but returns
 * ours. It lands as `erro`, so the thread shows it was never seen rather than
 * quietly claiming it was.
 */
export function buildClaimMessageMensagem(
  msg: MlClaimMessage,
  docId: string,
  ctx: { clienteOuterRef: string | null },
): Record<string, unknown> {
  const ms = coerceToMillis(msg.date_created);
  const doVendedor = claimMessageDoVendedor(msg);
  const naoEntregue = STATUS_NAO_ENTREGUE.has((msg.status ?? '').trim().toLowerCase());
  return {
    estadoEnvio: doVendedor
      ? naoEntregue
        ? ESTADO_ENVIO.erro
        : ESTADO_ENVIO.enviado
      : ESTADO_ENVIO.recebido,
    tipo: TIPO_MENSAGEM.comum,
    conteudo: msg.message,
    mid: docId,
    midGroup: msg.attachments.length > 0 ? docId : null,
    data_cadastro: ms,
    timestamp: ms,
    // Only an inbound message carries the contact — an outbound one is ours.
    clienteMensagemOuterRef: doVendedor ? null : ctx.clienteOuterRef,
  };
}

/**
 * The claim-reason mensagem (tasks.dart:1926-1936) — written once per
 * conversa create/update. `reasonId` is the RAW ML reason id (e.g.
 * `'PDD9545'`), UNHASHED: it is both the doc id and `mid` in legacy, and
 * hashing it would fork years of history. User fields ARE set (legacy
 * `Mensagem.withUserAndParent`).
 */
export function buildReasonMensagem(args: {
  reasonId: string;
  claim: MlClaim;
  reason: MlClaimReason | undefined;
  clienteOuterRef: string | null;
}): Record<string, unknown> {
  const { reasonId, claim, reason, clienteOuterRef } = args;
  return {
    // The buyer's stated reason for opening the claim — inbound, so it must
    // render on the customer side like any message they wrote.
    estadoEnvio: ESTADO_ENVIO.recebido,
    tipo: TIPO_MENSAGEM.comum,
    conteudo: reason?.detail ?? reason?.name ?? MOTIVO_DESCONHECIDO,
    mid: reasonId,
    data_cadastro: coerceToMillis(reason?.date_created ?? claim.date_created),
    timestamp: coerceToMillis(reason?.last_updated ?? reason?.date_created ?? claim.date_created),
    clienteMensagemOuterRef: clienteOuterRef,
  };
}

/**
 * One claim-message ATTACHMENT mensagem (tasks.dart:1968-1977). `tipo` stays
 * `comum` — the legacy quirk kept on purpose (NOT `arquivo`/`'f'`; the thread
 * UI renders off `anexoStorage`, and flipping tipo would make re-processed
 * docs diverge from the stored history). Timestamps come from the PARENT
 * claim message's `date_created`. User fields ARE set (legacy
 * `Mensagem.withUserAndParent`).
 */
export function buildAttachmentMensagem(args: {
  filename: string;
  parentMessage: MlClaimMessage;
  parentMessageDocId: string;
  arquivoOuterRef: string;
  clienteOuterRef: string | null;
}): Record<string, unknown> {
  const ms = coerceToMillis(args.parentMessage.date_created);
  // An attachment belongs to whoever sent the message carrying it, so it takes
  // the PARENT's direction. Legacy stamped every one `salva`, which rendered
  // the buyer's photos as drafts of ours.
  const doVendedor = claimMessageDoVendedor(args.parentMessage);
  return {
    estadoEnvio: doVendedor ? ESTADO_ENVIO.enviado : ESTADO_ENVIO.recebido,
    tipo: TIPO_MENSAGEM.comum,
    mid: args.filename,
    midGroup: args.parentMessageDocId,
    anexoStorage: args.arquivoOuterRef,
    data_cadastro: ms,
    timestamp: ms,
    clienteMensagemOuterRef: doVendedor ? null : args.clienteOuterRef,
  };
}

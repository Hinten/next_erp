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
    case 'change':
      return TIPO_INCIDENTE.troca;
    case null:
      return TIPO_INCIDENTE.outros;
    default:
      return TIPO_INCIDENTE.outros;
  }
}

/**
 * ML resolution `reason` → `TipoResolucao` — the #364 fix over legacy's
 * hardcoded `item_devolvido` (models.dart:4128). Unknown/null reasons → outro.
 */
const TIPO_RESOLUCAO_BY_REASON: Readonly<Record<string, TipoResolucao>> = {
  item_returned: TIPO_RESOLUCAO.itemDevolvido,
  product_exchanged: TIPO_RESOLUCAO.enviadoOutroItem,
  item_replaced: TIPO_RESOLUCAO.enviadoOutroItem,
  payment_refunded: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  refunded: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  charged_back: TIPO_RESOLUCAO.pagamentoDevolvidoIntegralmente,
  partial_refunded: TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
  partial_refund: TIPO_RESOLUCAO.pagamentoDevolvidoParcialmente,
  timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  expired: TIPO_RESOLUCAO.inatividadeDoCliente,
  complainant_timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  respondent_timeout: TIPO_RESOLUCAO.inatividadeDoCliente,
  closed_by_buyer: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  cancelled_by_buyer: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  buyer_regret: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
  withdrawn: TIPO_RESOLUCAO.encerradoSemNenhumaAcao,
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
  usuarioId: string;
  contaId: string;
  contaCor: number | null;
  pedidoId: string;
  incidenteId: string;
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
    usarioOuterRef: toOuterRef(`usuarios/${ctx.usuarioId}`),
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

/**
 * One claim message → mensagem fields (`ClaimsMessage.toMensagem`,
 * models.dart:3582-3598). `docId` is `makeClaimMessageId`'s digest — it
 * doubles as `mid`, and as `midGroup` only when the message carries
 * attachments (the attachment mensagens point back at it). NO user fields —
 * legacy's plain `Mensagem(...)` constructor set none. `timestamp` is the
 * deliberate deviation documented in the module doc (legacy stored the
 * import-time wall clock, `timestamp ??= DateTime.now()`).
 */
export function buildClaimMessageMensagem(
  msg: MlClaimMessage,
  docId: string,
): Record<string, unknown> {
  const ms = coerceToMillis(msg.date_created);
  return {
    estadoEnvio: ESTADO_ENVIO.enviado,
    tipo: TIPO_MENSAGEM.comum,
    conteudo: msg.message,
    mid: docId,
    midGroup: msg.attachments.length > 0 ? docId : null,
    data_cadastro: ms,
    timestamp: ms,
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
  usuarioId: string;
}): Record<string, unknown> {
  const { reasonId, claim, reason, usuarioId } = args;
  return {
    estadoEnvio: ESTADO_ENVIO.salva,
    tipo: TIPO_MENSAGEM.comum,
    conteudo: reason?.detail ?? reason?.name ?? MOTIVO_DESCONHECIDO,
    mid: reasonId,
    data_cadastro: coerceToMillis(reason?.date_created ?? claim.date_created),
    timestamp: coerceToMillis(reason?.last_updated ?? reason?.date_created ?? claim.date_created),
    usarioMensagemOuterRef: toOuterRef(`usuarios/${usuarioId}`),
    user_id: usuarioId,
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
  usuarioId: string;
}): Record<string, unknown> {
  const ms = coerceToMillis(args.parentMessage.date_created);
  return {
    estadoEnvio: ESTADO_ENVIO.salva,
    tipo: TIPO_MENSAGEM.comum,
    mid: args.filename,
    midGroup: args.parentMessageDocId,
    anexoStorage: args.arquivoOuterRef,
    data_cadastro: ms,
    timestamp: ms,
    usarioMensagemOuterRef: toOuterRef(`usuarios/${args.usuarioId}`),
    user_id: args.usuarioId,
  };
}

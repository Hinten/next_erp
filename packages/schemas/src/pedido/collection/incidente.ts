import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { microsSinceEpoch } from '../../shared/datetime';
import { freteDoPedidoSchema } from '../../shared/frete';

// Incidente belongs to the PEDIDO permission domain (`permCode: 'p4'` in the
// legacy ODM); it shares the pedido bits, like `motivoIncidente`.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * `tipoDeIncidente` — STRING-coded enum, wire values mirror the legacy Flutter
 * enum (`.old/packages/pedido/lib/src/models.dart:1153`). Stored on disk as the
 * raw value (`'returns'`, `'t'`, …).
 */
export const TIPO_INCIDENTE = {
  mediacaoDoMarketplace: 'mediations',
  cancelamentoPeloComprador: 'cancel_purchase',
  devolucao: 'returns',
  cancelamentoPeloVendedor: 'cancel_sale',
  troca: 't',
  atendimento: 'a',
  entregaAtrasada: 'e',
  outros: 'o',
} as const satisfies Record<string, TipoIncidente>;

export const tipoIncidenteSchema = z.enum([
  'mediations',
  'cancel_purchase',
  'returns',
  'cancel_sale',
  't',
  'a',
  'e',
  'o',
]);
export type TipoIncidente = z.infer<typeof tipoIncidenteSchema>;

export const TIPO_INCIDENTE_LABELS: Record<TipoIncidente, string> = {
  mediations: 'Mediação do Marketplace',
  cancel_purchase: 'Cancelamento pelo Comprador',
  returns: 'Devolução',
  cancel_sale: 'Cancelamento pelo Vendedor',
  t: 'Troca',
  a: 'Atendimento ruim',
  e: 'Entrega Atrasada',
  o: 'Outros',
};

/**
 * `OrigemIncidente` — INT-coded enum
 * (`.old/packages/pedido/lib/src/models.dart:1205`).
 */
export const ORIGEM_INCIDENTE = {
  site: 0,
  facebook: 1,
  pedidoMercadoLivre: 2,
  troca: 3,
  devolucao: 4,
  outros: 99,
} as const;

export const origemIncidenteSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(99),
]);
export type OrigemIncidente = z.infer<typeof origemIncidenteSchema>;

export const ORIGEM_INCIDENTE_LABELS: Record<OrigemIncidente, string> = {
  0: 'Site',
  1: 'Facebook',
  2: 'Pedido Mercado Livre',
  3: 'Troca',
  4: 'Devolução',
  99: 'Outros',
};

/**
 * `TipoResolucao` — INT-coded enum
 * (`.old/packages/pedido/lib/src/models.dart:1365`).
 */
export const TIPO_RESOLUCAO = {
  itemDevolvido: 0,
  enviadoOutroItem: 1,
  etiquetaDeDevolucao: 2,
  pagamentoDevolvidoIntegralmente: 3,
  pagamentoDevolvidoParcialmente: 4,
  inatividadeDoCliente: 5,
  encerradoSemNenhumaAcao: 6,
  outro: 7,
} as const;

export const tipoResolucaoSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);
export type TipoResolucao = z.infer<typeof tipoResolucaoSchema>;

export const TIPO_RESOLUCAO_LABELS: Record<TipoResolucao, string> = {
  0: 'Item devolvido',
  1: 'Enviado outro item',
  2: 'Etiqueta de devolução',
  3: 'Pagamento devolvido integralmente',
  4: 'Pagamento devolvido parcialmente',
  5: 'Inatividade do cliente',
  6: 'Encerrado sem nenhuma ação',
  7: 'Outro',
};

/**
 * Marketplace claim STATUS — ML's `claim.status`, a plain binary.
 *
 * ⚠️ New in #1322, and the reason it is modelled rather than derived: "open"
 * used to be inferred everywhere as `resolucao == null`, which conflates two
 * different things. A claim ML has closed in the seller's favour carries a
 * `resolution` and so reads as resolved — but so does a claim an operator
 * merely wrote a note on, and neither tells you what the marketplace itself
 * currently says. The claim's own status was stored only inside the
 * free-text `comentarios` string, where nothing can query it.
 */
export const STATUS_CLAIM = {
  aberta: 'opened',
  fechada: 'closed',
} as const satisfies Record<string, StatusClaim>;

export const statusClaimSchema = z.enum(['opened', 'closed']);
export type StatusClaim = z.infer<typeof statusClaimSchema>;

export const STATUS_CLAIM_LABELS: Record<StatusClaim, string> = {
  opened: 'Aberta',
  closed: 'Encerrada',
};

/**
 * Marketplace claim STAGE — ML's `claim.stage`: who is currently involved.
 *
 * `claim` is buyer↔seller; `dispute` means a Mercado Livre mediator has
 * stepped in; `recontact` is a party reopening contact after closure;
 * `stale` is the ml_case buyer↔ML flow; `none` does not apply.
 */
export const STAGE_CLAIM = {
  reclamacao: 'claim',
  mediacao: 'dispute',
  recontato: 'recontact',
  parado: 'stale',
  naoSeAplica: 'none',
} as const satisfies Record<string, StageClaim>;

export const stageClaimSchema = z.enum(['claim', 'dispute', 'recontact', 'stale', 'none']);
export type StageClaim = z.infer<typeof stageClaimSchema>;

export const STAGE_CLAIM_LABELS: Record<StageClaim, string> = {
  claim: 'Reclamação',
  dispute: 'Mediação do Mercado Livre',
  recontact: 'Recontato',
  stale: 'Parada',
  none: 'Não se aplica',
};

/**
 * Which blocked action an operator overrode, and the record of them doing it.
 *
 * ⚠️ An open incidente REFUSES dispatch, NF-e emission and the advance to
 * `finalizado`. That refusal needs a way out, because some claims are resolved
 * BY shipping — a PNR (produto não recebido) mediation where the right answer
 * is to dispatch — and a block we cannot clear ourselves would strand the
 * pedido: only ML closing the claim writes `resolucao`.
 *
 * The override is gated on `PERM.incidenteResolucao.write` and recorded HERE
 * rather than as a free-text note, so the `onIncidenteChanged` modification
 * trigger picks it up with its actor for free.
 */
export const ACAO_BLOQUEADA = {
  despacho: 'despacho',
  nfe: 'nfe',
  finalizar: 'finalizar',
} as const satisfies Record<string, AcaoBloqueada>;

export const acaoBloqueadaSchema = z.enum(['despacho', 'nfe', 'finalizar']);
export type AcaoBloqueada = z.infer<typeof acaoBloqueadaSchema>;

export const ACAO_BLOQUEADA_LABELS: Record<AcaoBloqueada, string> = {
  despacho: 'Despacho / etiqueta',
  nfe: 'Emissão de NF-e',
  finalizar: 'Finalizar pedido',
};

export const overrideBloqueioSchema = z
  .object({
    acoes: z.array(acaoBloqueadaSchema).default([]).describe('Ações liberadas'),
    data: microsSinceEpoch('Data da liberação').nullable().default(null),
    usuarioOuterRef: z.string().nullable().default(null).describe('Quem liberou'),
    motivo: z.string().max(2000).nullable().default(null).describe('Motivo da liberação'),
  })
  .passthrough();
export type OverrideBloqueio = z.infer<typeof overrideBloqueioSchema>;

/**
 * `Resolucao` — embedded object inside an `Incidente` (the legacy model has
 * `hasCollection: false`; it is never its own collection). Mirrors
 * `.old/packages/pedido/lib/src/models.dart:1413`.
 */
export const resolucaoSchema = z
  .object({
    data: microsSinceEpoch('Data da resolução').nullable().default(null),
    valor: z.number().min(0).default(0).describe('Despesa da resolução'),
    tipo: tipoResolucaoSchema.describe('Tipo de resolução'),
    comentarios: z.string().nullable().default(null).describe('Comentários sobre a resolução'),
    frete: freteDoPedidoSchema.nullable().default(null).describe('Frete da resolução'),
  })
  .passthrough();
export type Resolucao = z.infer<typeof resolucaoSchema>;

/**
 * Incidente — subcoleção `pedidos/{pedidoId}/incidentes` (plural, matching the
 * legacy `INCIDENTE_PEDIDO_COLLECTION` constant). Mirrors
 * `.old/packages/pedido/lib/src/models.dart:1256`. An order issue/incident:
 * mediation, return, exchange, late delivery, etc., optionally with a recorded
 * resolution.
 */
export const incidenteSchema = z
  .object({
    origem: origemIncidenteSchema.nullable().default(null).describe('Origem'),
    tipo: tipoIncidenteSchema.default(TIPO_INCIDENTE.devolucao).describe('Tipo de incidente'),
    motivoDoIncidente: z.string().max(2000).nullable().default(null).describe('Motivo'),
    comentarios: z.string().max(2000).nullable().default(null).describe('Comentários'),
    timestamp: microsSinceEpoch('Data do incidente').nullable().default(null),
    ultimaModificacao: microsSinceEpoch('Última modificação').nullable().default(null),
    externalId: z.string().nullable().default(null).describe('ID externo'),
    resolucao: resolucaoSchema.nullable().default(null).describe('Resolução'),

    // Marketplace claim state (#1322) ---------------------------------------
    // Null on every hand-written incidente and on every legacy row: these
    // describe a MARKETPLACE claim, and their absence is meaningful ("this
    // incidente is not a claim"), not a value waiting to be backfilled.
    claimStatus: statusClaimSchema.nullable().default(null).describe('Status na reclamação'),
    claimStage: stageClaimSchema.nullable().default(null).describe('Etapa da reclamação'),
    /**
     * ML's `claim.fulfilled` — the claim was opened on a product that had
     * already been DELIVERED.
     *
     * ⚠️ This is what separates "do not ship this" from "the goods are already
     * with the buyer and are coming back". It is the marketplace's own answer,
     * not something derived from our frete estado, which can lag or (on a
     * marketplace-owned frete) never report at all.
     */
    entregue: z.boolean().nullable().default(null).describe('Reclamação sobre item entregue'),
    overrideBloqueio: overrideBloqueioSchema
      .nullable()
      .default(null)
      .describe('Liberação de bloqueio'),
  })
  .passthrough();

export type Incidente = z.infer<typeof incidenteSchema>;

/* -------------------------------------------------------------------------- */
/*                        Blocking-overlay pure logic                         */
/* -------------------------------------------------------------------------- */

/**
 * Incidente tipos that BLOCK the irreversible actions while open.
 *
 * An ALLOW-list, so a tipo added later defaults to non-blocking — the safe
 * direction, since the cost of a wrong entry here is refusing work an operator
 * legitimately needs to do.
 *
 * ⚠️ `t` (troca), `a` (atendimento), `e` (entrega atrasada) and `o` (outros)
 * are deliberately ABSENT. A late delivery is a reason to ship faster, not to
 * refuse shipping, and `o` is the passthrough-`subtipo` carrier the estoque
 * sync writes its drift rows under (`estoque-drift`,
 * `estoque-reconstrucao-legado`) — blocking on it would stop dispatch on every
 * pedido whose stock ever needed reconciling.
 */
const TIPOS_INCIDENTE_BLOQUEANTES: ReadonlySet<TipoIncidente> = new Set<TipoIncidente>([
  TIPO_INCIDENTE.mediacaoDoMarketplace,
  TIPO_INCIDENTE.cancelamentoPeloComprador,
  TIPO_INCIDENTE.cancelamentoPeloVendedor,
  TIPO_INCIDENTE.devolucao,
]);

/** The subset of {@link TIPOS_INCIDENTE_BLOQUEANTES} that IS a return. */
const TIPOS_INCIDENTE_DEVOLUCAO: ReadonlySet<TipoIncidente> = new Set<TipoIncidente>([
  TIPO_INCIDENTE.devolucao,
]);

/** Everything {@link classificarIncidenteBloqueante} reads off one incidente. */
export interface IncidenteBloqueanteInput {
  origem: OrigemIncidente | null;
  tipo: TipoIncidente;
  claimStatus: StatusClaim | null;
  resolucao: unknown | null;
  entregue: boolean | null;
}

/**
 * How one incidente contributes to the pedido's blocking overlay: `'disputa'`,
 * `'devolucao'`, or `null` for "does not block".
 *
 * Three conditions, all required:
 *
 * 1. **Marketplace origin.** ⚠️ Load-bearing, not a nicety. `incidenteSchema.tipo`
 *    DEFAULTS to `returns`, so without this filter every hand-written incidente
 *    an operator forgot to retype would block `finalizado`, and
 *    `trocaIncidentesBestEffort` would block on every pedido save. Widening this
 *    to operator-created incidentes is a separate decision with its own blast
 *    radius — do not slip it in.
 * 2. **A blocking tipo** — see {@link TIPOS_INCIDENTE_BLOQUEANTES}.
 * 3. **Still open.** ML's own `claim.status` decides when we have it; a claim
 *    it has closed stops blocking even if nobody recorded a `resolucao`. When
 *    `claimStatus` is absent (a legacy row imported before #1322), fall back to
 *    the old `resolucao == null` reading rather than treating the row as
 *    permanently open.
 *
 * Which of the two markers it produces is ML's answer, not ours: a return-type
 * claim, or any claim opened on an already-DELIVERED item (`entregue`). The
 * distinction matters because the two block different things — an undelivered
 * dispute must not ship, while a delivered one must not be consolidated.
 */
export function classificarIncidenteBloqueante(
  inc: IncidenteBloqueanteInput,
): 'disputa' | 'devolucao' | null {
  if (inc.origem !== ORIGEM_INCIDENTE.pedidoMercadoLivre) return null;
  if (!TIPOS_INCIDENTE_BLOQUEANTES.has(inc.tipo)) return null;
  const aberto =
    inc.claimStatus != null ? inc.claimStatus === STATUS_CLAIM.aberta : inc.resolucao == null;
  if (!aberto) return null;
  return TIPOS_INCIDENTE_DEVOLUCAO.has(inc.tipo) || inc.entregue === true ? 'devolucao' : 'disputa';
}

/**
 * Whether an incidente's recorded override releases `acao`.
 *
 * Absent/empty releases nothing — the override is per-action on purpose, so
 * clearing the dispatch block does not silently also permit the NF-e.
 */
export function bloqueioLiberado(
  override: OverrideBloqueio | null | undefined,
  acao: AcaoBloqueada,
): boolean {
  return override?.acoes?.includes(acao) ?? false;
}

/**
 * The pedido-level view of the overlay, denormalized by the
 * `onIncidenteBloqueioSync` trigger — everything the three guards read.
 */
export interface BloqueioPedido {
  disputaAbertaEm?: number | null;
  devolucaoAbertaEm?: number | null;
  /** Union of the released actions across the pedido's OPEN blocking incidentes. */
  bloqueiosLiberados?: readonly AcaoBloqueada[] | null;
}

function liberado(p: BloqueioPedido, acao: AcaoBloqueada): boolean {
  return p.bloqueiosLiberados?.includes(acao) ?? false;
}

/**
 * Whether DISPATCH must be refused: an open dispute, not released.
 *
 * ⚠️ A devolução deliberately does NOT block dispatch. The goods are already
 * with the buyer, so there is nothing left to ship — refusing the checkout
 * would only stop the operator from processing the pedido at all.
 */
export function bloqueioDespachoAtivo(p: BloqueioPedido): boolean {
  return p.disputaAbertaEm != null && !liberado(p, ACAO_BLOQUEADA.despacho);
}

/**
 * Whether NF-e EMISSION must be refused: an open dispute, not released.
 *
 * ⚠️ `emissaoNFeBloqueadaPorEstado` cannot cover this, which is the point. ML
 * keeps the order `paid` throughout a mediation, so the pedido is legitimately
 * `pago` and that deny-list — a set of VOIDED-sale estados — correctly matches
 * nothing. A nota emitted here is a real tax liability on a sale about to be
 * refunded, and SEFAZ accepts a cancelamento only within 24h.
 */
export function bloqueioNFeAtivo(p: BloqueioPedido): boolean {
  return p.disputaAbertaEm != null && !liberado(p, ACAO_BLOQUEADA.nfe);
}

/**
 * Whether advancing to `finalizado` must be refused: an open dispute OR an open
 * return, not released.
 *
 * ⚠️ This is the one guard a devolução drives, and the fit is exact rather than
 * conservative: `ESTADO_PEDIDO.finalizado` asserts that the return window has
 * PASSED and the money is certain. An open return says both are false by
 * definition — it IS the return window, still open.
 */
export function bloqueioFinalizarAtivo(p: BloqueioPedido): boolean {
  const aberto = p.disputaAbertaEm != null || p.devolucaoAbertaEm != null;
  return aberto && !liberado(p, ACAO_BLOQUEADA.finalizar);
}

export const incidenteMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/incidentes',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  // ⚠️ `overrideBloqueio` RELEASES the dispatch / NF-e / finalizar block, so it
  // must not ride the pedido's own write bit. This subcollection is writable by
  // anyone holding `pedido.write`, and leaving the field client-writable would
  // hand the power to ship a disputed order to everyone who can fix a shipping
  // address — the exact escalation #1224/#1234 rejected when claim RESOLUTION
  // got its own permission domain. Its only writer is the
  // `liberarBloqueioIncidente` callable, gated on `PERM.incidenteResolucao.write`.
  serverOwnedFields: ['overrideBloqueio'],
};

export const incidente = { schema: incidenteSchema, meta: incidenteMeta };

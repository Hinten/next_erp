import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { millisSinceEpoch } from '../../shared/datetime';
import { outerRefSchema } from '../../shared/outerRef';

// Shares the PAGAMENTO permission domain, not PEDIDO: the legacy app gated the
// link under its own payments code (`'mx'`), and a user who can see a link must
// always be able to see the payments that settle it (`pedidos/{id}/pagamentos`
// reads on `d_pagamento` too) — otherwise the tab would render a link whose
// "quem já pagou" it cannot read.
const PERM_PAGAMENTO_READ = 1n << 24n;
const PERM_PAGAMENTO_WRITE = 1n << 25n;
const PERM_PAGAMENTO_DELETE = 1n << 26n;

/**
 * Doc id of a link — the SAME shape the web mints with `newDocId()`
 * (`apps/web/lib/data/newDocId.ts`): 20 characters from `[A-Za-z0-9]`.
 *
 * The id is minted by the CLIENT before the preference is POSTed, so a retried
 * request reuses it, and it travels to Mercado Pago as `metadata.link_id` so the
 * payment that comes back can be attributed to its link. The same schema guards
 * `pagamento.linkPagamentoId` (server-stamped from that metadata) and the wire
 * contract, so a value that reaches Firestore has always passed one definition.
 *
 * ⚠️ This is the DOC id, never the `id` FIELD of {@link linkPgtoMercadoPagoSchema}
 * (that one is Mercado Pago's preference id).
 */
export const linkPagamentoIdSchema = z
  .string()
  .max(20)
  .regex(/^[A-Za-z0-9]{20}$/);
export type LinkPagamentoId = z.infer<typeof linkPagamentoIdSchema>;

/**
 * How a link is meant to be paid.
 *  - `individual`    — one payer, one payment (`quantidadeMaxima` 1). A vaquinha
 *                      is a batch of these, one per person, sharing a `grupoId`.
 *  - `compartilhado` — ONE link paid N times (`quantidadeMaxima` N). Allowed only
 *                      for totals that split exactly (`cotaExataReais`).
 *
 * A stored `null` is a LEGACY link (written by the Flutter app before this field
 * existed): it cannot be attributed to any payment.
 */
export const modoLinkPagamentoSchema = z.enum(['individual', 'compartilhado']);
export type ModoLinkPagamento = z.infer<typeof modoLinkPagamentoSchema>;

/** Named members of {@link modoLinkPagamentoSchema}. */
export const MODO_LINK_PAGAMENTO = {
  individual: 'individual',
  compartilhado: 'compartilhado',
} as const satisfies Record<string, ModoLinkPagamento>;

export const MODO_LINK_PAGAMENTO_LABELS: Record<ModoLinkPagamento, string> = {
  individual: 'Por pessoa',
  compartilhado: 'Compartilhado',
};

/**
 * Stored lifecycle of a link: `aberto` → `concluido` (auto-closed after its
 * quota was reached) | `cancelado` (the operator withdrew it).
 *
 * ⚠️ Expiry is NOT a status. It is DERIVED from `dataExpiracao` against the
 * clock at read time (`resumirLinksPagamento`), because nothing runs at the
 * moment a link lapses that could write it.
 */
export const statusLinkPagamentoSchema = z.enum(['aberto', 'concluido', 'cancelado']);
export type StatusLinkPagamento = z.infer<typeof statusLinkPagamentoSchema>;

/** Named members of {@link statusLinkPagamentoSchema}. */
export const STATUS_LINK_PAGAMENTO = {
  aberto: 'aberto',
  concluido: 'concluido',
  cancelado: 'cancelado',
} as const satisfies Record<string, StatusLinkPagamento>;

export const STATUS_LINK_PAGAMENTO_LABELS: Record<StatusLinkPagamento, string> = {
  aberto: 'Aberto',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
};

/**
 * Mercado Pago `payment_type_id`s an operator may EXCLUDE from a Checkout Pro
 * preference (`payment_methods.excluded_payment_types`). `account_money` can
 * never be excluded, which is why at most three of these four may be listed.
 */
export const tipoPagamentoMpSchema = z.enum([
  'credit_card',
  'debit_card',
  'ticket',
  'bank_transfer',
]);
export type TipoPagamentoMp = z.infer<typeof tipoPagamentoMpSchema>;

/** Named members of {@link tipoPagamentoMpSchema}. */
export const TIPO_PAGAMENTO_MP = {
  cartaoCredito: 'credit_card',
  cartaoDebito: 'debit_card',
  boleto: 'ticket',
  pix: 'bank_transfer',
} as const satisfies Record<string, TipoPagamentoMp>;

export const TIPO_PAGAMENTO_MP_LABELS: Record<TipoPagamentoMp, string> = {
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  ticket: 'Boleto',
  bank_transfer: 'Pix',
};

/**
 * `pedidos/{pedidoId}/linkPgtoMercadoPago` — one Mercado Pago Checkout Pro
 * payment link created for a pedido (#367).
 *
 * The leaf is the LEGACY one (`.old/packages/pagamento/mercado_pago/lib/src/models.dart`
 * `LINK_PGTO`), so the migrated corpus lands where this app reads it; the
 * issue text's `linkpagamentomercadopago` is only the Dart getter name. The
 * first six fields below are the legacy wire shape verbatim
 * (`models.g.dart:147-186`) — names AND units — and every field added for #367
 * is `.nullable().default(null)` (or carries a real default) so a legacy doc
 * still PARSES instead of falling back to a raw soft-read.
 *
 * `serverOwned`: only `apps/mercado-pago` (Admin SDK) writes here — it creates
 * the Mercado Pago preference and persists the link in one step — so the
 * generated rules deny every client write, `su` included, and the browser reads
 * through the `pagamento.read` bit (see the permission note above).
 *
 * ⚠️ Three things that look like typos and are not:
 *  - DATES ARE MILLISECONDS (`millisSinceEpoch`), unlike most of this domain's
 *    µs fields. The legacy corpus is ms, and one `orderBy(dataCriacao)` must
 *    never compare two units. Stamp new values with `nowMillis()`.
 *  - The `id` FIELD is Mercado Pago's PREFERENCE id, not the doc id. The doc id
 *    is the client-minted link id ({@link linkPagamentoIdSchema}); attribution
 *    always keys on the doc id.
 *  - There is NO `ultimaModificacao` / `timestamp` key. `TableView` would then
 *    need a second (update-monitor) index, and a status transition is terminal
 *    and monotonic — the backend re-derives it from a `tx.get` of this doc, so
 *    no watermark is needed.
 *
 * Plain `z.object` (strip policy) with no top-level `.refine`, so `.shape` /
 * `.pick` keep working: on READ an unknown key (the ODM `docId` / `createTime` /
 * `updateTime` / `readTime` extras some legacy docs carry) is stripped, and on
 * WRITE the data layer re-parses `.strict()` — so a backend status change must
 * be a merge patch (`parseMerge`), never a `set()` built by spreading a stored
 * legacy doc. Cross-field rules (`modo` ↔ `quantidadeMaxima`) live in the wire
 * contract and the pure helpers.
 */
export const linkPgtoMercadoPagoSchema = z.object({
  // ---- legacy wire fields (OLD models.g.dart:147-186) ----
  contaMercadoPagoOuterRef: outerRefSchema.describe('Conta Mercado Pago'),
  // Legacy `@Minimo(0.01)`: a link cannot charge less than one centavo.
  valorCobrado: z.number().min(0.01).describe('Valor'),
  // Mercado Pago's `init_point`. Deliberately NOT `.url()`: a legacy value is
  // whatever the old app stored, and a failed parse would drop the whole doc to
  // a raw soft-read.
  link: z.string().min(1).describe('Link'),
  // Mercado Pago's PREFERENCE id — NOT the doc id. The legacy app always wrote
  // the key, even when null.
  id: z.string().nullable().default(null).describe('ID da preferência'),
  dataCriacao: millisSinceEpoch('Criado em').nullable().default(null),
  // Required: the legacy app always wrote it.
  dataExpiracao: millisSinceEpoch('Expira em'),

  // ---- new (#367): ALL nullable / defaulted so legacy docs parse ----
  /** `null` ⇒ a legacy link: no payment can be attributed to it. */
  modo: modoLinkPagamentoSchema.nullable().default(null),
  /** The operator's label for the payer — a FIRST name (LGPD), typed per link. */
  nomePagador: z.string().min(1).max(20).nullable().default(null),
  /** Payments the link accepts: 1 for `individual`, N for `compartilhado`. */
  quantidadeMaxima: z.number().int().min(1).max(50).nullable().default(null),
  /** Batch id shared by the links of one vaquinha. */
  grupoId: z.string().min(1).max(128).nullable().default(null),
  /** Position inside the batch, so the copy text keeps a stable order. */
  ordem: z.number().int().min(0).nullable().default(null),
  status: statusLinkPagamentoSchema.default(STATUS_LINK_PAGAMENTO.aberto),
  encerradoEm: millisSinceEpoch('Encerrado em').nullable().default(null),
  /** `documents/usuarios/<uid>` of who cancelled it; `null` when auto-closed. */
  encerradoPorOuterRef: outerRefSchema.nullable().default(null),
  /** Why Mercado Pago refused the expire call on an auto-close (best effort). */
  erroEncerramento: z.string().max(500).nullable().default(null),
  /** `documents/usuarios/<uid>` of who created it. */
  criadoPorOuterRef: outerRefSchema.nullable().default(null),
  /** At most three of the four types, so one payment method always stays on. */
  tiposExcluidos: z.array(tipoPagamentoMpSchema).max(3).nullable().default(null),
  parcelasMaximas: z.number().int().min(1).max(12).nullable().default(null),
});

export type LinkPgtoMercadoPago = z.infer<typeof linkPgtoMercadoPagoSchema>;

export const linkPgtoMercadoPagoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/linkPgtoMercadoPago',
  permissions: {
    read: PERM_PAGAMENTO_READ,
    write: PERM_PAGAMENTO_WRITE,
    delete: PERM_PAGAMENTO_DELETE,
  },
  // Written EXCLUSIVELY by apps/mercado-pago (Admin SDK). NOT validator
  // whitelisted and NO `serverOwnedFields`: the generator rejects either next to
  // `serverOwned`. The write/delete bits exist only because the claims map needs
  // a valid single bit per action; the rules deny every client write anyway.
  serverOwned: true,
  // Newest first, one page: the tab lists a pedido's links and builds its
  // summaries and copy text from this list, so the per-pedido link cap
  // (`LIMITES_LINK_PAGAMENTO.linksPorPedidoMax`) must never exceed `limit`.
  // Declared so the `defaultQuery.indexes` meta-test REQUIRES the matching
  // `linkPgtoMercadoPago(dataCriacao desc)` entry in firestore.indexes.json — on
  // Enterprise an unindexed query silently full-scans and bills the data scanned.
  defaultQuery: {
    orderBy: [{ field: 'dataCriacao', direction: 'desc' }],
    limit: 50,
  },
};

export const linkPgtoMercadoPago = {
  schema: linkPgtoMercadoPagoSchema,
  meta: linkPgtoMercadoPagoMeta,
};

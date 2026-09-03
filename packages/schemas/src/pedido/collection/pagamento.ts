import { z } from 'zod';
import { roundReais } from '@delfrance/core/money';
import type { CollectionMetadata } from '../../types';
import { microsSinceEpoch } from '../../shared/datetime';
import { bandeiraSchema } from '../../bandeiraCartao';
import { outerRefSchema } from '../../shared/outerRef';
import { ESTADO_PEDIDO } from './pedido';
import type { EstadoPedido } from './pedido';

const PERM_PAGAMENTO_READ = 1n << 24n;
const PERM_PAGAMENTO_WRITE = 1n << 25n;
const PERM_PAGAMENTO_DELETE = 1n << 26n;

const PERM_METODO_PGTO_READ = 1n << 27n;
const PERM_METODO_PGTO_WRITE = 1n << 28n;
const PERM_METODO_PGTO_DELETE = 1n << 29n;

/**
 * FORMA_PAGAMENTO — wire format mirrors Flutter's int-coded enum
 * (`@JsonValue(N)`). Stored on disk as the integer value.
 */
export const formaPagamentoSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(10),
  z.literal(11),
  z.literal(12),
  z.literal(13),
  z.literal(15),
  z.literal(16),
  z.literal(17),
  z.literal(18),
  z.literal(19),
  z.literal(90),
  z.literal(99),
]);
export type FormaPagamento = z.infer<typeof formaPagamentoSchema>;

export const FORMA_PAGAMENTO = {
  dinheiro: 1,
  cheque: 2,
  cartao_credito: 3,
  cartao_debito: 4,
  credito_loja: 5,
  vale_alimentacao: 10,
  vale_refeicao: 11,
  vale_presente: 12,
  vale_combustivel: 13,
  boleto_bancario: 15,
  deposito_bancario: 16,
  pix: 17,
  carteira_digital_transferencia_bancaria: 18,
  fidelidade_cashback_credito_virtual: 19,
  sem_pagamento: 90,
  outros: 99,
} as const satisfies Record<string, FormaPagamento>;

export const FORMA_PAGAMENTO_LABELS: Record<FormaPagamento, string> = {
  1: 'Dinheiro',
  2: 'Cheque',
  3: 'Cartão de Crédito',
  4: 'Cartão de Débito',
  5: 'Crédito Loja',
  10: 'Vale alimentação',
  11: 'Vale refeição',
  12: 'Vale Presente',
  13: 'Vale Combustível',
  15: 'Boleto Bancário/Duplicata',
  16: 'Depósito Bancário',
  17: 'PIX',
  18: 'Carteira digital/Transferência bancária',
  19: 'Programa de Fidelidade/Cashback/Crédito Virtual',
  90: 'Sem pagamento',
  99: 'Outros',
};

/**
 * STATUS_PAGAMENTO — wire format mirrors Flutter's int-coded enum.
 */
export const statusPagamentoSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
  z.literal(11),
]);
export type StatusPagamento = z.infer<typeof statusPagamentoSchema>;

export const STATUS_PAGAMENTO = {
  pendente: 0,
  em_revisao: 1,
  pago_parcialmente: 2,
  em_processo_aprovacao: 3,
  aprovado: 4,
  em_disputa: 5,
  recusado: 6,
  cancelado: 7,
  estornado: 8,
  devolvido: 9,
  estornado_parcialmente: 10,
  estornado_totalmente: 11,
} as const satisfies Record<string, StatusPagamento>;

export const STATUS_PAGAMENTO_LABELS: Record<StatusPagamento, string> = {
  0: 'Pendente',
  1: 'Em revisão',
  2: 'Pago parcialmente',
  3: 'Em processo de aprovação',
  4: 'Aprovado',
  5: 'Em disputa',
  6: 'Recusado',
  7: 'Cancelado',
  8: 'Estornado',
  9: 'Devolvido',
  10: 'Estornado parcialmente',
  11: 'Estornado totalmente',
};

/**
 * Map a payment status to the corresponding pedido state. Mirrors
 * Flutter's `STATUS_PAGAMENTO.toEstadoPedido()`. Used by webhook
 * handlers in apps/integrations and by the manual status-change UI to
 * propose a pedido state transition alongside the payment status.
 */
export function statusToEstadoPedido(status: StatusPagamento): EstadoPedido {
  switch (status) {
    case STATUS_PAGAMENTO.pendente:
    case STATUS_PAGAMENTO.pago_parcialmente:
    case STATUS_PAGAMENTO.em_processo_aprovacao:
      return ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento;
    case STATUS_PAGAMENTO.em_revisao:
      return ESTADO_PEDIDO.emAnalise;
    case STATUS_PAGAMENTO.aprovado:
    case STATUS_PAGAMENTO.em_disputa:
      return ESTADO_PEDIDO.pago;
    case STATUS_PAGAMENTO.recusado:
      return ESTADO_PEDIDO.pagamentoNaoRealizado;
    case STATUS_PAGAMENTO.cancelado:
      return ESTADO_PEDIDO.cancelado;
    case STATUS_PAGAMENTO.estornado:
    case STATUS_PAGAMENTO.devolvido:
    case STATUS_PAGAMENTO.estornado_totalmente:
      return ESTADO_PEDIDO.estornadoIntegralmente;
    case STATUS_PAGAMENTO.estornado_parcialmente:
      return ESTADO_PEDIDO.estornadoParcialmente;
    default:
      return ESTADO_PEDIDO.error;
  }
}

/**
 * Whether a payment counts toward "paid": no status (`null`/`undefined`),
 * `aprovado`, or `em_disputa`. This is the canonical rule shared by every "how
 * much is paid?" consumer — the web footer's Vlr. Pago, the NFe bundle
 * (`apps/nfe`'s `bundle.ts`), and the server-side estado reconciles — so the
 * payment total is computed identically everywhere. Every other status
 * (pendente, recusado, cancelado, estornado…) does NOT cover the total.
 *
 * ⚠️ **`em_disputa` counts because the money has not moved.** A mediation is a
 * HOLD, not a reversal: ML keeps the order `paid` and marks the funds
 * `retained` until the claim resolves, and only then does the payment become
 * `refunded`/`charged_back` — which arrives here as `estornado`/`devolvido`
 * through the **payments** topic and stops covering the total then. Treating
 * the hold as "unpaid" made the two halves of this file contradict each other:
 * {@link statusToEstadoPedido} maps `em_disputa` to `pago`, while this rule
 * dropped it to zero, so `nextPedidoEstado` DOWNGRADED a fully-paid pedido to
 * `aguardandoConfirmacaoDePagamento` the moment a mediation opened.
 *
 * That downgrade fired on the Mercado Pago webhook path and on the operator's
 * own "reconciliar" button, and it protected nothing: `pago` and
 * `aguardandoConfirmacaoDePagamento` are BOTH in `ESTADOS_PEDIDO_RESERVA` and
 * `ESTADOS_PEDIDO_MOVIMENTACAO` (so stock never moved) and neither is in
 * `EMISSAO_NFE_BLOQUEADA` (so NF-e stayed emittable). All it did was label a
 * paid order as awaiting payment. The money-at-risk signal belongs to the
 * dispute overlay on the pedido, which can say so without lying about the
 * amount received.
 */
export function isPagamentoPagante(status: number | null | undefined): boolean {
  return (
    status == null || status === STATUS_PAGAMENTO.aprovado || status === STATUS_PAGAMENTO.em_disputa
  );
}

/**
 * Total amount already paid on a pedido: the sum of every {@link isPagamentoPagante}
 * payment's `valor`, 2-decimal-rounded. The one summing rule behind `valorPago`
 * for the estado auto-transition (the admin `reconcilePedidoEstado` and
 * `reconcilePedidoFromPagamento`, both in
 * `packages/data/src/admin/pedidoReconcile.ts`) as well as the footer's Vlr.
 * Pago / Troco. Accepts any row carrying `valor` + `status_pagamento` (a full
 * `Pagamento` doc or a lighter summary).
 */
export function sumPagamentosPagos(
  pagamentos: ReadonlyArray<{ valor: number; status_pagamento?: number | null }>,
): number {
  return roundReais(
    pagamentos
      .filter((p) => isPagamentoPagante(p.status_pagamento))
      .reduce((sum, p) => sum + (p.valor ?? 0), 0),
  );
}

/**
 * Pagamento — subcoleção `pedidos/{pedidoId}/pagamentos` (plural, matching the
 * Flutter ERP's `PAGAMENTO_COLLECTION` constant,
 * `.old/packages/pedido/lib/src/models.dart:24`). Mirrors
 * `packages/pedido/lib/src/models.dart` Pagamento — all 19 legacy fields
 * (`.old` `models.dart:1802-1993`, confirmed against every producer by the
 * #463 parity audit) are enumerated below. `cartao` / `cheque` stay
 * `z.unknown()`: they round-trip an opaque embedded map, not a reference.
 *
 * No `.passthrough()` — this is a plain (strip-policy) `z.object`. On READ,
 * `parseSoftRead` (`@delfrance/data`) still tolerates an unmodeled key: it
 * strips it silently rather than throwing, which is what keeps a legacy
 * corpus doc carrying a since-retired field readable (root `CLAUDE.md` rule
 * 8). On WRITE, `parseForWrite`/`parseMergePatch` (same package) notice the
 * strip and re-parse with `.strict()`, so a genuinely unknown top-level key
 * throws a `ZodError` instead of being silently persisted — see
 * `packages/data/src/zodParse.ts`.
 */
export const pagamentoSchema = z.object({
  id: z.string().nullable().default(null),
  // Reference to the payment-integration doc (`metodo_pgto`, e.g. Mercado
  // Pago): a `documents/metodo_pgto/<id>` doc-path string. Modeled (not
  // literally pass-through anymore); the editor spreads it from the existing
  // doc, and a gateway's `tipo` is read by dereferencing it, not off the ref
  // value.
  metodoPagamentoOuterRef: outerRefSchema.nullable().default(null),
  forma_de_pagamento: formaPagamentoSchema.default(FORMA_PAGAMENTO.dinheiro),
  status_pagamento: statusPagamentoSchema.nullable().default(null),
  cartao: z.unknown().nullable().default(null),
  cheque: z.unknown().nullable().default(null),
  descricaoPagamento: z.string().nullable().default(null),
  valor: z.number().min(0),
  parcelas: z.number().int().min(1).default(1),
  juros: z.number().min(0).nullable().default(null),
  tarifas: z.number().min(0).nullable().default(null),
  aVista: z.boolean().default(true),
  duplicata: z.boolean().default(false),
  nFat: z.string().max(60).nullable().default(null),
  // Datetime fields — microseconds since epoch (`microsSinceEpoch()`), the
  // project standard. Migrated from the legacy ISO-8601 strings; the builder
  // reads both during rollout (see tools/migrations/pedido-pagamento-micros).
  vencimento: microsSinceEpoch('Vencimento').nullable().default(null),
  ultimaModificacao: microsSinceEpoch('Última modificação').nullable().default(null),
  dataCancelamento: microsSinceEpoch('Data de cancelamento').nullable().default(null),
  dataAprovacao: microsSinceEpoch('Data de aprovação').nullable().default(null),
  dataCadastro: microsSinceEpoch('Data de cadastro').nullable().default(null),
});

export type Pagamento = z.infer<typeof pagamentoSchema>;

/* -------------------------------------------------------------------------- */
/*                      Embedded card / cheque detail                         */
/* -------------------------------------------------------------------------- */

/**
 * `pagamento.cartao` — embedded card detail (NOT a collection; stored as a nested
 * map in the pagamento doc, where `pagamentoSchema` keeps it as opaque
 * pass-through). Mirrors Flutter's `Cartao` (`models.dart:2205`). Only `bandeira`
 * / `numeroCartao` / `cAut` are editable in the form today; `tpIntegra` is fixed
 * to `'2'` (não integrado) and `cnpj_instituicao` / `tarifa` / `tarifaFixa` /
 * `prazoRecebimento` come from the bandeira catalog (`bandeirasCartao`) — they are
 * preserved on edit but not yet auto-filled here (follow-up). `.passthrough()`
 * keeps any legacy field; `.catch` keeps a legacy-shaped value from failing the
 * whole parse on load.
 */
export const cartaoSchema = z
  .object({
    tpIntegra: z.string().default('2'),
    bandeira: bandeiraSchema.nullable().catch(null).default(null),
    numeroCartao: z.string().nullable().catch(null).default(null),
    cAut: z.string().nullable().catch(null).default(null),
    cnpj_instituicao: z.string().nullable().catch(null).default(null),
    tarifa: z.number().nullable().catch(null).default(null),
    tarifaFixa: z.number().nullable().catch(null).default(null),
    prazoRecebimento: z.number().nullable().catch(null).default(null),
  })
  .passthrough();
export type Cartao = z.infer<typeof cartaoSchema>;

/**
 * `pagamento.cheque` — embedded cheque detail (NOT a collection; nested map,
 * pass-through on `pagamentoSchema`). Mirrors Flutter's `Cheque`
 * (`models.dart:2298`). `bomPara` uses `microsSinceEpoch()` so a legacy ISO-8601
 * value is coerced to microseconds (the new-app standard) instead of being
 * dropped; `.catch(null)` only catches a genuinely unparseable value. The
 * multi-cheque parcela split (intervalo/quantidade) is not ported (follow-up).
 */
export const chequeSchema = z
  .object({
    banco: z.string().nullable().catch(null).default(null),
    agencia: z.string().nullable().catch(null).default(null),
    conta: z.string().nullable().catch(null).default(null),
    numero: z.number().int().nullable().catch(null).default(null),
    titular: z.string().max(255).nullable().catch(null).default(null),
    cpf_cnpj: z.string().max(18).nullable().catch(null).default(null),
    telefone: z.string().max(16).nullable().catch(null).default(null),
    bomPara: microsSinceEpoch('Bom para').nullable().catch(null).default(null),
  })
  .passthrough();
export type Cheque = z.infer<typeof chequeSchema>;

export const pagamentoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/pagamentos',
  permissions: {
    read: PERM_PAGAMENTO_READ,
    write: PERM_PAGAMENTO_WRITE,
    delete: PERM_PAGAMENTO_DELETE,
  },
};

export const pagamento = { schema: pagamentoSchema, meta: pagamentoMeta };

/* -------------------------------------------------------------------------- */
/*                            MetodoPagamento                                 */
/* -------------------------------------------------------------------------- */

/**
 * TIPO_INTEGRACAO_PGTO — int-coded enum, today only `mercadoPago`.
 *
 * ⚠️ **Wire-frozen.** These integers come from the Flutter app and the migrated
 * corpus is stored with them (see `guides/coexistence.md`), so a value may be
 * ADDED but never renumbered.
 *
 * ⚠️ This used to say "new gateways register against this enum + a corresponding
 * PaymentGateway plugin in packages/integrations/<channel>/". That path was never
 * taken by anything, and the contract it named was deleted in #1429 — all three
 * of its members threw, and the working Mercado Pago integration lives in
 * `apps/mercado-pago`. The real procedure for a SECOND provider:
 *
 *  1. Widen `tipoIntegracaoPgtoSchema` from `z.literal(1)` to a union, and add the
 *     `TIPO_INTEGRACAO_PGTO` + `_LABELS` entries.
 *  2. Add `apps/<provider>` mirroring `apps/mercado-pago`: OAuth start/callback,
 *     a credential store under `metodo_pgto/{id}/credenciais` (the schema is already
 *     generic), a receiver on `defineNotificationPipeline`, Cloud Tasks.
 *  3. Add `packages/integrations/<provider>` — client, wire schemas, error
 *     taxonomy — and its own `<provider>PaymentToPagamento` mapper. ⚠️ Mercado
 *     Livre and Mercado Pago deliberately keep SEPARATE mappers for the same
 *     underlying payment resource; do not try to share one.
 *  4. Add the `/pagamentos/<provider>` screens in apps/web.
 *  5. **Introduce `PAGAMENTO_TIPO_CAPS` in that same PR, with BOTH rows.** A
 *     capability table keyed on this enum was deliberately NOT created while it
 *     had one member: its compile-error guarantee cannot fire against a single
 *     literal, and its axes would have been invented from one sample. Model it
 *     on `FREIGHT_TIPO_CAPS` / `MARKETPLACE_TIPO_CAPS` (`../../shared/`).
 *
 * ⚠️ Note the axis before you reach for that table: payments vary per ACCOUNT,
 * not per provider — `hasLinkPagamento` is an operator setting on the
 * `metodo_pgto` document and `user_id` is a per-account webhook routing key.
 * Anything that varies per account belongs on the doc, not in a tipo-keyed table.
 */
export const tipoIntegracaoPgtoSchema = z.literal(1);
export type TipoIntegracaoPgto = z.infer<typeof tipoIntegracaoPgtoSchema>;

export const TIPO_INTEGRACAO_PGTO = { mercadoPago: 1 } as const satisfies Record<
  string,
  TipoIntegracaoPgto
>;
export const TIPO_INTEGRACAO_PGTO_LABELS: Record<TipoIntegracaoPgto, string> = {
  1: 'Mercado Pago',
};

export const metodoPagamentoSchema = z.object({
  tipo: tipoIntegracaoPgtoSchema,
  hasLinkPagamento: z.boolean().default(false),
  nome: z.string().min(1).max(255),
  /**
   * The Mercado Pago collector id this account maps to (MP's numeric
   * `user_id`), denormalized onto the doc so an inbound webhook can resolve
   * its owning `metodo_pgto` account with a single equality query — mirrors
   * `integracaoSchema.user_id`. Null for an account not yet OAuth-connected.
   * Stamped at OAuth exchange.
   */
  user_id: z.number().int().nullable().default(null),
  dataCadastro: microsSinceEpoch('Data de cadastro').nullable().default(null),
  // Same µs unit as `dataCadastro` — stamped by `saveRecord` on every write.
  ultimaModificacao: microsSinceEpoch('Última modificação').nullable().optional(),
});
export type MetodoPagamento = z.infer<typeof metodoPagamentoSchema>;

export const metodoPagamentoMeta: CollectionMetadata = {
  collectionPath: 'metodo_pgto',
  permissions: {
    read: PERM_METODO_PGTO_READ,
    write: PERM_METODO_PGTO_WRITE,
    delete: PERM_METODO_PGTO_DELETE,
  },
  // Declares that deleting a Mercado Pago account frees its OAuth credential
  // subcollection, mirroring `integracao` → `credenciais`. NOTE: like the
  // `integracao` cascade, this is declarative metadata only — server-side
  // enforcement (a delete trigger) is tracked by the generic cascade work
  // (#401/#516/#517); until it lands, a deleted account orphans its
  // admin-only `credenciais` doc.
  // `oauthState` is the per-attempt OAuth connect record (#1034) — it holds a
  // live PKCE `code_verifier`, so it frees on delete alongside the credential.
  cascade: [
    { path: 'metodo_pgto/{metodoId}/credenciais', onDelete: 'cascade' },
    { path: 'metodo_pgto/{metodoId}/oauthState', onDelete: 'cascade' },
  ],
  // `user_id` is the MP WEBHOOK ROUTING KEY (#1034, sibling of #821/T4): an
  // inbound payment notification resolves its collector by this field. Left
  // client-writable, any holder of `d_metodoPagamento` write could repoint one
  // seller's payment stream at another account's document straight from the
  // client SDK. Its only legitimate writer is the OAuth exchange
  // (`exchangeAndPersist`, apps/mercado-pago), which goes through the Admin SDK
  // and bypasses rules; `apps/web` already excludes the field from the form.
  serverOwnedFields: ['user_id'],
  defaultQuery: {
    orderBy: [{ field: 'nome', direction: 'asc' }],
    limit: 50,
    columns: ['nome', 'hasLinkPagamento', 'user_id'],
  },
};

export const metodoPagamento = {
  schema: metodoPagamentoSchema,
  meta: metodoPagamentoMeta,
};

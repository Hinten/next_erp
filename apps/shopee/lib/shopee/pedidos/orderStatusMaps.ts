/**
 * The Shopee `order_status` → `ESTADO_PEDIDO` ladder, and the monotonicity rule
 * that decides whether a stored estado may be moved to it (#1513, step 5, plan
 * W5/W6).
 *
 * PURE: no Firestore, no wire call, no clock. Both halves are total functions
 * over strings, which is what lets the transaction re-derive the estado from its
 * own `tx.get` snapshot instead of from a decision taken outside the callback
 * (root `CLAUDE.md` rule 7).
 *
 * ## Two functions, and why the split matters
 *
 * `estadoPedidoDeOrderStatus` answers "what does Shopee say this order IS" —
 * from the wire alone. `estadoShopeeAplicavel` answers "may we write that over
 * what the document currently holds" — from the snapshot alone. Folding them
 * into one would need the stored estado at map time, i.e. inside the wire
 * mapper, which is exactly the shape that produced the legacy importer's
 * stale-closure updates.
 *
 * ## ⚠️ `UNPAID` RESERVES STOCK, deliberately
 *
 * `aguardandoConfirmacaoDePagamento` is in `ESTADOS_PEDIDO_RESERVA`
 * (`apps/functions/src/estoques/sincronizarEstoquePedido.ts`), so importing an
 * unpaid Shopee order holds the unit. That is the Mercado Livre trade taken
 * verbatim (#1087): overselling across channels is unrecoverable — a cancelled
 * order, a refund and a marketplace penalty — while a unit held through a Pix
 * window is released by the `CANCELLED` push, and by step 8's stuck-reservation
 * sweep when that push never arrives. The reservation therefore ships PAIRED
 * with its release.
 *
 * ## ⚠️ The terminal set is ENUMERATED, and it is not ABSORBING
 *
 * `ESTADOS_PEDIDO_SHOPEE_TERMINAL` has one member. Deriving it as "not on the
 * ladder" would release a live reservation the first time Shopee invents a
 * status string — the ML precedent's own warning. And being terminal does not
 * make it absorbing: see clause 3 of {@link estadoShopeeAplicavel}.
 */
import { ESTADO_PEDIDO, type EstadoPedido } from '@delfrance/schemas';

/* -------------------------------------------------------------------------- */
/*                        the eleven documented statuses                       */
/* -------------------------------------------------------------------------- */

/**
 * Shopee's own `order_status` values (guide 31, eleven of them).
 *
 * ⚠️ This is a REFERENCE list, never a parse gate: `order_status` is
 * `z.string()` on the wire schema and `marketplace.status` is `z.string()` on
 * the pedido, precisely so a value Shopee adds tomorrow is DATA rather than a
 * throw. Adding a member here changes nothing until the ladder below maps it.
 *
 * ⚠️ `INVOICE_PENDING` is deliberately ABSENT: guide 382 makes it a
 * `get_order_list` FILTER, not a status — uploading an NF-e does not change
 * `order_status` at all.
 */
export const SHOPEE_ORDER_STATUS = {
  unpaid: 'UNPAID',
  pending: 'PENDING',
  readyToShip: 'READY_TO_SHIP',
  processed: 'PROCESSED',
  retryShip: 'RETRY_SHIP',
  shipped: 'SHIPPED',
  toConfirmReceive: 'TO_CONFIRM_RECEIVE',
  inCancel: 'IN_CANCEL',
  cancelled: 'CANCELLED',
  toReturn: 'TO_RETURN',
  completed: 'COMPLETED',
} as const satisfies Record<string, string>;

/**
 * The prefix every `pedido.error` this importer writes carries.
 *
 * It is what makes the CLEAR provably ours: an error another writer left (an
 * NF-e failure, a manual note) is never erased, because the clear only fires on
 * a stored message that starts with this.
 */
export const PREFIXO_ERRO_SHOPEE = '[shopee] ';

/* -------------------------------------------------------------------------- */
/*                                  the ladder                                 */
/* -------------------------------------------------------------------------- */

/** What Shopee's status says the pedido should be. */
export type AlvoEstadoShopee =
  | { readonly tipo: 'estado'; readonly estado: EstadoPedido }
  /** `TO_RETURN`: keep whatever is stored, and flag it. */
  | { readonly tipo: 'manter' }
  /** A status this ladder does not model. */
  | { readonly tipo: 'erro'; readonly motivo: string };

/** Named members of {@link AlvoEstadoShopee}'s discriminator. */
export const ALVO_ESTADO_SHOPEE = {
  estado: 'estado',
  manter: 'manter',
  erro: 'erro',
} as const satisfies Record<string, AlvoEstadoShopee['tipo']>;

/**
 * `order_status` → the estado this importer wants the pedido to hold.
 *
 * Enumerated in BOTH directions: `aguardandoConfirmacaoDePagamento` ←
 * `UNPAID`/`PENDING` · `pago` ← the five shipping statuses, `COMPLETED`, and a
 * `TO_RETURN` **create** · `processandoCancelamento` ← `IN_CANCEL` · `cancelado`
 * ← `CANCELLED` · `error` ← anything unrecognised. **Nothing else.** This
 * importer never writes `finalizado`, `fraude`, `emAnalise`, `estornado*` or
 * `pagamentoNaoRealizado`.
 *
 * ⚠️ `COMPLETED → pago`, not `finalizado`. `finalizado` asserts the RETURN
 * WINDOW closed, which is a different event from delivery and one no channel
 * reports; `pago` is the ceiling any marketplace path may write in this repo
 * (`apps/mercado-livre/CLAUDE.md`). `completed_scenario` rides
 * `marketplace.completedScenario` instead.
 *
 * ⚠️ `PENDING` sits on the SAME rung as `UNPAID`, not on `emProcessamento`.
 * Both are in `ESTADOS_PEDIDO_RESERVA`, so stock is identical either way — the
 * choice is about meaning: `emProcessamento` means "the payment cleared" in this
 * repo, and Shopee's `PENDING` explicitly means it has not (`KYC_PENDING`,
 * `SYSTEM_PENDING`). One rung for both also makes the undocumented question
 * "can Shopee go `PENDING → UNPAID`?" moot. The reason is not lost: it is
 * verbatim in `marketplace.pendingTerms`.
 *
 * ⚠️ **The `pending_terms` are NOT an argument.** They never change the verdict,
 * and a parameter a function ignores is the "comment asserting what the other
 * copy does" smell — so they are read where they are USED, in `orderMapping.ts`,
 * which writes them verbatim onto the flag. ⚠️ The SCOPE property is pinned
 * THERE, not here: a test in this file could only compare this one-argument
 * function against itself, which is a tautology — `orderMapping.test.ts` drives
 * two details differing only in `pending_terms` and asserts the same `alvo`
 * with a different `marketplace.pendingTerms`.
 *
 * ⚠️ `TO_RETURN` answers `manter` rather than an estado (Lucas, 2026-09-09):
 * `estado` stays where it was and `marketplace.status` carries the truth. The
 * blocking overlay for returns is step 17's `incidente`, not a rung here. On a
 * CREATE there is nothing to keep — see `orderPedidoTx.ts`, which seeds `pago`
 * (the rung every returning order passed through; Shopee only returns what was
 * delivered).
 */
export function estadoPedidoDeOrderStatus(status: string): AlvoEstadoShopee {
  switch (status) {
    case SHOPEE_ORDER_STATUS.unpaid:
    case SHOPEE_ORDER_STATUS.pending:
      return {
        tipo: ALVO_ESTADO_SHOPEE.estado,
        estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      };
    case SHOPEE_ORDER_STATUS.readyToShip:
    case SHOPEE_ORDER_STATUS.processed:
    case SHOPEE_ORDER_STATUS.retryShip:
    case SHOPEE_ORDER_STATUS.shipped:
    case SHOPEE_ORDER_STATUS.toConfirmReceive:
    case SHOPEE_ORDER_STATUS.completed:
      return { tipo: ALVO_ESTADO_SHOPEE.estado, estado: ESTADO_PEDIDO.pago };
    case SHOPEE_ORDER_STATUS.inCancel:
      return { tipo: ALVO_ESTADO_SHOPEE.estado, estado: ESTADO_PEDIDO.processandoCancelamento };
    case SHOPEE_ORDER_STATUS.cancelled:
      return { tipo: ALVO_ESTADO_SHOPEE.estado, estado: ESTADO_PEDIDO.cancelado };
    case SHOPEE_ORDER_STATUS.toReturn:
      return { tipo: ALVO_ESTADO_SHOPEE.manter };
    default:
      return {
        tipo: ALVO_ESTADO_SHOPEE.erro,
        motivo: `${PREFIXO_ERRO_SHOPEE}status desconhecido: "${status}"`,
      };
  }
}

/** The estado an `erro` verdict writes — enumerated here so callers never guess. */
export const ESTADO_DO_ERRO_SHOPEE: EstadoPedido = ESTADO_PEDIDO.error;

/* -------------------------------------------------------------------------- */
/*                                monotonicity                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ORDERED rungs — forward only. Two members, and only two: everything else
 * this importer writes is off-ladder and orderless (a cancellation is not
 * "after" a payment, it is beside it).
 */
export const ORDEM_ESTADO_SHOPEE = [
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.pago,
] as const;

/**
 * The estados this importer is allowed to move AWAY from.
 *
 * Anything else stored — `finalizado`, `emAnalise`, `emProcessamento`,
 * `estornado*`, `fraude` — belongs to the business: an operator put it there and
 * a marketplace re-fetch must never walk it back.
 */
export const ESTADOS_SHOPEE_GOVERNAVEIS: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ...ORDEM_ESTADO_SHOPEE,
  ESTADO_PEDIDO.processandoCancelamento,
  ESTADO_PEDIDO.cancelado,
  ESTADO_PEDIDO.error,
]);

/**
 * The terminal estados on this channel — ENUMERATED, never derived.
 *
 * ⚠️ Terminal does NOT mean absorbing here; it means "leaving it is worth a log
 * line". See clause 3 of {@link estadoShopeeAplicavel}.
 */
export const ESTADOS_PEDIDO_SHOPEE_TERMINAL: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.cancelado,
]);

/** Why an estado was NOT written. */
export type MotivoEstadoShopee =
  /** `TO_RETURN` — the ladder deliberately declines to decide. */
  | 'manter'
  /** The stored estado already IS the target. */
  | 'sem-mudanca'
  /** Backwards on the ordered ladder (a late `UNPAID` over a `pago`). */
  | 'regressivo'
  /** The stored estado belongs to the business, not to Shopee. */
  | 'fora-da-escada';

/** Named members of {@link MotivoEstadoShopee}. */
export const MOTIVO_ESTADO_SHOPEE = {
  manter: 'manter',
  semMudanca: 'sem-mudanca',
  regressivo: 'regressivo',
  foraDaEscada: 'fora-da-escada',
} as const satisfies Record<string, MotivoEstadoShopee>;

export type VereditoEstadoShopee =
  | {
      readonly escrever: true;
      readonly estado: EstadoPedido;
      /** A terminal estado was left. Written anyway, and logged loudly. */
      readonly ressuscitado: boolean;
    }
  | { readonly escrever: false; readonly motivo: MotivoEstadoShopee };

/**
 * May the stored estado be moved to what Shopee now says?
 *
 * Three clauses, in this order:
 *
 * 1. **Off-ladder STORED ⇒ write nothing** (`fora-da-escada`). "From
 *    `emProcessamento` on, `estado` belongs to the business", Shopee-shaped.
 *
 * 2. **On the ordered ladder, forward only.** `aguardandoConfirmacaoDePagamento
 *    → pago` ✔; **`pago → aguardandoConfirmacaoDePagamento` REFUSED**
 *    (`regressivo`). ⚠️ That is the near-miss the whole function exists for: a
 *    late-delivered `UNPAID` must never un-pay a shipped order and re-reserve
 *    its stock. Only the ESTADO is dropped — the watermark still advances and
 *    every other field group still applies, because the payload IS newer; it is
 *    only the estado it implies that is wrong.
 *
 * 3. **Off-ladder targets are always writable, off-ladder stored estados are
 *    always leavable.** `pago → processandoCancelamento` ✔, `pago → cancelado`
 *    ✔, `processandoCancelamento → pago` ✔ (a seller-rejected `IN_CANCEL` is a
 *    real Shopee outcome), `error ↔ anything` ✔.
 *    **`cancelado → pago` is ALLOWED**, and flagged `ressuscitado` so the log
 *    says so. The ladder is driven by a RE-FETCH of the live order — never by
 *    the push body — so `READY_TO_SHIP` on a pedido we hold as `cancelado` means
 *    *we* cancelled it wrongly and the live order is the authority. Making
 *    `cancelado` absorbing would strand a live sale as cancelled with its stock
 *    already released: the overselling direction, and permanent.
 */
export function estadoShopeeAplicavel(
  armazenado: EstadoPedido,
  alvo: AlvoEstadoShopee,
): VereditoEstadoShopee {
  if (alvo.tipo === ALVO_ESTADO_SHOPEE.manter) {
    return { escrever: false, motivo: MOTIVO_ESTADO_SHOPEE.manter };
  }
  const destino = alvo.tipo === ALVO_ESTADO_SHOPEE.erro ? ESTADO_DO_ERRO_SHOPEE : alvo.estado;
  if (destino === armazenado) {
    return { escrever: false, motivo: MOTIVO_ESTADO_SHOPEE.semMudanca };
  }
  if (!ESTADOS_SHOPEE_GOVERNAVEIS.has(armazenado)) {
    return { escrever: false, motivo: MOTIVO_ESTADO_SHOPEE.foraDaEscada };
  }
  const de = ORDEM_ESTADO_SHOPEE.indexOf(armazenado as (typeof ORDEM_ESTADO_SHOPEE)[number]);
  const para = ORDEM_ESTADO_SHOPEE.indexOf(destino as (typeof ORDEM_ESTADO_SHOPEE)[number]);
  if (de >= 0 && para >= 0 && para < de) {
    return { escrever: false, motivo: MOTIVO_ESTADO_SHOPEE.regressivo };
  }
  return {
    escrever: true,
    estado: destino,
    ressuscitado:
      ESTADOS_PEDIDO_SHOPEE_TERMINAL.has(armazenado) &&
      !ESTADOS_PEDIDO_SHOPEE_TERMINAL.has(destino),
  };
}

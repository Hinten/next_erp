import { z } from 'zod';
import type { CollectionMetadata } from '../../types';
import { millisSinceEpoch } from '../../shared/datetime';
import { freteDoPedidoSchema } from '../../shared/frete';
import { outerRefSchema } from '../../shared/outerRef';

// Checkout belongs to the PEDIDO permission domain (it shares the pedido bits,
// exactly like `incidente` — same subcollection parent, same claim).
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * The three EXACT item-error literals the legacy scan engine writes
 * (`.old/lib/despacho/pages/checkout.dart`: `"Quantidade excedida"` 1522/1563/1573,
 * `"Produto não esperado"` 1616, `"Todos os items já foram lançados"` 1473). The
 * new-app pure engine (`../pureLogic/checkoutEngine.ts`, PR 2) reproduces them
 * byte-for-byte so a Flutter reader of a shared-backend checkout doc sees
 * identical `error` strings. NOTE the legacy spelling: English-plural "items"
 * (not "itens") and the accented "já".
 */
export const ITEM_CHECKOUT_ERRORS = {
  quantidadeExcedida: 'Quantidade excedida',
  produtoNaoEsperado: 'Produto não esperado',
  todosLancados: 'Todos os items já foram lançados',
} as const;
export type ItemCheckoutError = (typeof ITEM_CHECKOUT_ERRORS)[keyof typeof ITEM_CHECKOUT_ERRORS];

/**
 * `ItemCheckoutPedido` — one row of the checkout audit log: a physical scan, a
 * soft-deleted scan, or a soft-deleted error row (the FULL trail is persisted).
 * Legacy hand-model `.old/packages/pedido/lib/src/models.dart:4052`, generated
 * writer `models.g.dart:797-805`.
 *
 * WIRE PARITY (verified against the generated Dart `toJson`): the legacy writer
 * emits ALL FIVE keys UNCONDITIONALLY, writing explicit `null` for the nullable
 * ones (`produtoCheckoutPedidoOuterRef`, `dataExclusao`, `error`, `timestamp`).
 * `quantidade` defaults to 1 (a scan is always a single unit).
 *
 * Datetime unit: MILLISECONDS since epoch — legacy `maybeDateTimeToJson`
 * (`.old/packages/global/lib/src/models/utils.dart:95`) serializes
 * `millisecondsSinceEpoch`. This port keeps ms for byte-for-byte parity
 * with the live Flutter app on the shared backend (the repo default elsewhere is
 * µs; the tolerant `millisSinceEpoch` read still parses either).
 */
export const itemCheckoutPedidoSchema = z
  .object({
    produtoCheckoutPedidoOuterRef: outerRefSchema.nullable().default(null),
    quantidade: z.number().int().min(1).default(1),
    dataExclusao: millisSinceEpoch('Excluído em').nullable().default(null),
    error: z.string().nullable().default(null),
    timestamp: millisSinceEpoch('Lançado em').nullable().default(null),
  })
  .passthrough();
export type ItemCheckoutPedido = z.infer<typeof itemCheckoutPedidoSchema>;

/**
 * `CheckoutFretePedido` — subcollection `pedidos/{pedidoId}/checkout` (leaf name
 * EXACTLY `checkout`, NOT pluralized: the legacy constant is
 * `PEDIDO_CHECKOUT_COLLECTION = '<pedidos>/*​/checkout'` and the migrated corpus
 * is stored under it). The dispatch/checkout audit document written when a
 * warehouse operator finishes scanning a paid pedido's physical contents.
 * Legacy hand-model `.old/packages/pedido/lib/src/models.dart:3943`, generated
 * writer `models.g.dart:760-784`.
 *
 * WIRE PARITY (verified against the generated Dart `toJson`):
 *
 *   key                                 | on-disk       | null handling
 *   ------------------------------------|---------------|-------------------------
 *   title (= pedido.numero)             | string        | omitted-when-null¹
 *   obs                                 | string        | omitted-when-null¹
 *   freteNoMomentoDoCheckout            | FreteDoPedido | ALWAYS present
 *   ehDoFreteInicial                    | bool          | omitted-when-null¹
 *   usuarioCheckoutFretePedidoOuterRef  | documents/…   | ALWAYS present
 *   itensCheckout                       | array         | ALWAYS present (explicit null)
 *   timestamp                           | int ms        | ALWAYS present (explicit null)
 *
 * ¹ The legacy Flutter writer OMITS `title`/`obs`/`ehDoFreteInicial` when null
 *   (`@JsonKey(includeIfNull:false)`); the new-app writer sets them explicitly
 *   (the Flutter reader is tolerant — `as String?` / `as bool?`). The base-model
 *   keys `docId`/`createTime`/`updateTime`/`readTime` (also omit-when-null) are
 *   NOT part of this body schema; `.passthrough()` keeps them on read.
 *
 * `usuarioCheckoutFretePedidoOuterRef` = `documents/usuarios/<uid>`, where the
 * usuario doc id IS the Firebase auth uid (`.old/lib/user/providers/auth.dart:377`).
 *
 * Datetime unit: MILLISECONDS (see `itemCheckoutPedidoSchema`).
 *
 * The sibling `checkin` screen/collection (`pedidos/*​/checkin`, receiving/returns)
 * is deliberately NOT ported here — see the checkout port plan §10 follow-ups.
 *
 * PLAIN object, NO cross-field `.refine()` — keeps it `.pick()`-able under Zod 4
 * (see the `zod4-pick-refine-runtime-crash` gotcha).
 */
export const checkoutFretePedidoSchema = z
  .object({
    title: z.string().nullable().default(null),
    obs: z.string().nullable().default(null),
    freteNoMomentoDoCheckout: freteDoPedidoSchema,
    ehDoFreteInicial: z.boolean().nullable().default(null),
    usuarioCheckoutFretePedidoOuterRef: outerRefSchema,
    itensCheckout: z.array(itemCheckoutPedidoSchema).nullable().default(null),
    timestamp: millisSinceEpoch('Data do checkout').nullable().default(null),
  })
  .passthrough();
export type CheckoutFretePedido = z.infer<typeof checkoutFretePedidoSchema>;

export const checkoutFretePedidoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/checkout',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
};

export const checkout = { schema: checkoutFretePedidoSchema, meta: checkoutFretePedidoMeta };

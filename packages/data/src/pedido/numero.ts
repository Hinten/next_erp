import type { PedidoWriteOp } from './port';

/**
 * Pedido `numero` allocation — the constants/format helpers (moved verbatim from
 * `apps/web/lib/pedidos/createPedido.ts` so the devolução transactional flows can
 * share them SDK-agnostically) plus {@link mintNumeros}, the multi-numero variant
 * of the counter bump `createPedidoWithNumero` runs.
 */

/**
 * Fixed width of the zero-padded numeric part of a pedido `numero`
 * (e.g. `42` → `"000042"`). `numero` is stored as a string, so any sort over it
 * is lexical; the fixed width is what keeps `"VEN-000010"` above `"VEN-000002"`
 * instead of below it.
 *
 * ⚠️ `numero` is NO LONGER the `/pedidos` default sort — `pedidoMeta.defaultQuery`
 * orders by `timestamp desc` as of #159. It was dropped precisely because the
 * operação prefix leads the string: a lexical `numero desc` groups the list by
 * operação and only then orders by sequence within each prefix, which is not a
 * recency order at all. Worse, the Mercado Livre importer writes a bare numeric
 * id as `numero`, and digits sort below letters — so every marketplace order sat
 * under every UI-created pedido regardless of date.
 *
 * The width still matters: `numero` remains a sortable column (the Número header
 * sort, backed by `pedidos(ehSaida ASC, numero DESC)`), and within one operação
 * that column is expected to read in sequence order.
 */
export const PEDIDO_NUMERO_WIDTH = 6;

/** Doc id of the global pedido sequence in the `counters` collection. */
export const PEDIDO_COUNTER_DOC_ID = 'pedido';

/** Full doc path of the global pedido sequence counter. */
export const PEDIDO_COUNTER_PATH = `counters/${PEDIDO_COUNTER_DOC_ID}`;

/** Prefix used when a pedido has no operação to derive one from. */
export const PEDIDO_NUMERO_NO_OPERACAO_PREFIX = 'NUL';

/**
 * Derive the `numero` prefix from an operação name: its first 3 letters,
 * uppercased. This namespaces UI-created pedido numbers away from numbers that
 * come from other channels (marketplaces), which would otherwise collide with a
 * bare sequence. Falls back to {@link PEDIDO_NUMERO_NO_OPERACAO_PREFIX} when the
 * pedido has no operação (or an empty name).
 */
export function operacaoNumeroPrefix(nome: string | null | undefined): string {
  const cleaned = (nome ?? '').trim();
  if (!cleaned) return PEDIDO_NUMERO_NO_OPERACAO_PREFIX;
  return cleaned.slice(0, 3).toUpperCase();
}

/**
 * Compose a pedido `numero` from its operação prefix and sequence value, as
 * `<PREFIX>-<seq>` (e.g. `VEN-000042`). The prefix leads deliberately (human
 * readability + namespacing vs. marketplace numbers), so the default
 * `numero`-desc list sort groups by operação then orders by sequence within
 * each prefix — not a single global sequence order. See `PEDIDO_NUMERO_WIDTH`.
 */
export function formatPedidoNumero(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(PEDIDO_NUMERO_WIDTH, '0')}`;
}

/**
 * Mint `prefixes.length` sequential numeros from the counter doc as read INSIDE
 * the caller's transaction (`counterDoc` null when the doc doesn't exist yet —
 * the sequence starts at 1, exactly like `createPedidoWithNumero`). Pure: safe
 * to re-run on transaction contention.
 *
 * `counterOp` writes the counter the same way `createPedidoWithNumero` does
 * today (a `set` of `{ value }`), holding the value after the LAST mint, so the
 * whole batch stays gap-free and unique under concurrent creates.
 */
export function mintNumeros(
  counterDoc: Record<string, unknown> | null,
  prefixes: ReadonlyArray<string>,
): { numeros: string[]; counterOp: PedidoWriteOp } {
  const current = typeof counterDoc?.value === 'number' ? counterDoc.value : 0;
  const numeros = prefixes.map((prefix, i) => formatPedidoNumero(prefix, current + i + 1));
  return {
    numeros,
    counterOp: {
      type: 'set',
      path: PEDIDO_COUNTER_PATH,
      data: { value: current + prefixes.length },
    },
  };
}

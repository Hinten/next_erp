/**
 * How a pedido line is NAMED on screen — one resolver, seven surfaces.
 *
 * Before this existed, every tab of the pedido editor answered the question its
 * own way and they disagreed: PrincipalTab preferred the live produto,
 * ExpectedPane preferred the denormalised sale name, CheckoutTab had no
 * denormalised fallback at all (a deleted produto rendered a raw Firestore doc
 * id), and half the sites used `||` while the other half used `??` — so a
 * stored empty string rendered as a blank row on some screens and fell through
 * on others. None of that was a decision; it was seven independent guesses.
 *
 * ⚠️ Do NOT re-implement this chain inline. `apps/web` has no dependency edge to
 * any `apps/*`, so a rule that runs on more than one surface either lives here
 * or gets written twice and drifts (root `CLAUDE.md`, "Re-implementing a rule
 * that already runs on another surface"). Pure and total — no clock, no
 * network, no Firestore — which is exactly what lets it move.
 */

/**
 * The item fields that can name a line. Structural rather than
 * `Pick<ItemDoPedido, …>` on purpose — four different shapes feed this:
 * `ItemDoPedido` (the stored line), `ExpectedItem` (the checkout scan engine's
 * projection), the devolução edit row, and a bare `{ produtoUid }` adapter for
 * `ItemCheckoutPedido`, whose wire shape carries NO name of its own (see
 * `collection/checkout.ts` — the legacy writer emits exactly five keys and
 * `toItemCheckoutPedido` drops `produtoNome`).
 */
export interface ItemNomeavel {
  produtoUid?: string | null;
  nomeDeVenda?: string | null;
  sku?: string | null;
}

/** The produto side — `Produto` (`nome: string`) and `EngineProduto` (`nome: string | null`) both fit. */
export interface ProdutoNomeavel {
  nome?: string | null;
}

/** Last resort: no produto, no sale name, no sku, no id. */
export const SEM_NOME = 'Sem nome';

/** Trim, and treat a blank or whitespace-only string as absent. */
function textoUtil(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}

/**
 * The display name of one pedido line. Total — always a non-empty string.
 *
 * Priority, and why:
 *
 *  1. **`produto.nome`** — what the product is called NOW. The screens are
 *     operational: the operator matches the row against the catálogo, the
 *     picker, the estoque screen and the shelf, so a stale sale name sends them
 *     hunting for something that no longer answers to it. It also keeps a row
 *     internally consistent — every surface here already renders the live
 *     produto's SKU, thumbnail and variation label beside the name, and pairing
 *     those with a name from a different epoch is worse than either alone.
 *     A marketplace line's `nomeDeVenda` is the CHANNEL's title (long and
 *     keyword-stuffed); once the line is matched to an ERP produto the ERP name
 *     is the better label, and the channel title stays on the item.
 *  2. **`item.nomeDeVenda`** — the denormalised name captured at sale time. The
 *     only name a line has when the produto was deleted, or when a marketplace
 *     order imported a line that matched nothing in the ERP (`produtoUid: null`
 *     is an explicit, supported state).
 *  3. **`item.sku`** — not a name, but a handle an operator recognises.
 *  4. **`produtoUid`** — the raw doc id. Ugly, but ACTIONABLE: `/produtos`
 *     searches by document id (#1395) and PrincipalTab links the row straight
 *     to `/produtos/{id}/editar`.
 *  5. {@link SEM_NOME}.
 *
 * ⚠️ Blank is not a name. A stored `''` or `'   '` at any step falls through to
 * the next — the `||`-vs-`??` split across the old call sites meant a
 * whitespace-only `nomeDeVenda` blanked the row on the `??` surfaces and fell
 * through on the `||` ones, for the same document.
 *
 * ⚠️ This resolves a name for DISPLAY. Do not feed the result into a field that
 * gets persisted: steps 3-5 are placeholders, and writing one back would store
 * a doc id (or the literal "Sem nome") as the line's sale name.
 */
export function nomeDoItem(
  item: ItemNomeavel | null | undefined,
  produto: ProdutoNomeavel | null | undefined,
): string {
  return (
    textoUtil(produto?.nome) ??
    textoUtil(item?.nomeDeVenda) ??
    textoUtil(item?.sku) ??
    textoUtil(item?.produtoUid) ??
    SEM_NOME
  );
}

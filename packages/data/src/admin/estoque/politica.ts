/**
 * The send POLICY — given what a family's members publish now and what they
 * published at the window start, is this send worth making?
 *
 * Split from the arithmetic ({@link file://./quantidades.ts}) because the two
 * answer different questions and only this one has a tier: the quantity is the
 * same number on every sweep, while *whether to push it* depends on which tier
 * is running. ADR 0014 is the full reasoning.
 */

/**
 * Lower clamp of every quantity published to a marketplace (legacy clamp >= 0).
 *
 * Not a tunable: a negative `available_quantity` is meaningless on every wire
 * this repo speaks, and the upper clamp is the one that varies by channel (it
 * is `OpcoesDeQuantidade.estoqueMax`, a required parameter).
 */
export const ESTOQUE_MIN = 0;

/**
 * The send policy (ADR 0014), replacing the old sold/recent/low-stock activity
 * heuristic. Exact rather than approximate, because the ledger can now be summed:
 *
 * ```
 * send  ⟺  ∃ member: anterior ≠ atual  ∧  ¬( incremental ∧ min(anterior, atual) > limiar )
 * ```
 *
 * The first clause is the #695 ask — a component movement that does not change a
 * kit's floored quantity produces no task. The second is the freshness tier: a
 * listing sitting comfortably high on BOTH sides of the movement cannot oversell
 * inside a 15-minute window, so it waits for the daily pass.
 *
 * ⚠️ `min(anterior, atual)`, never `atual` alone. `110 → 95` must send; gating on
 * the current value would skip exactly the movement that walks a listing INTO
 * the danger zone. This is the single most likely line here to be "simplified"
 * into a real oversell — see ADR 0014.
 *
 * ⚠️ `limiar` is a REQUIRED parameter, not an env read, because each channel
 * names and defaults its own high-stock threshold; passing a channel's reader
 * result is the caller's job, and this function stays pure. A `limiar` of
 * `Number.POSITIVE_INFINITY` disables the incremental tier's skip entirely
 * (everything is "near the danger zone"); `-1` disables the SEND on that tier
 * for any pair of positive quantities.
 *
 * Fails OPEN: a member with no reconstructed previous value is treated as
 * changed. That single rule is the inventory of every "this sends even though
 * nothing looks like it moved" case, so keep it complete:
 *  - the first sweep after deploy (no baseline at all);
 *  - a legacy ledger row carrying no `movimento`, which `sum` silently ignores;
 *  - an importer's unaudited `merge`, which moves a quantity while writing no
 *    ledger row;
 *  - a kit whose constraining components did not resolve, so its quantity
 *    cannot be verified at all (`kitNaoVerificavel`) — it sends 0.
 */
export function deveEnviarFamiliaCore(
  quantidadesAtuais: ReadonlyMap<string, number>,
  anteriores: ReadonlyMap<string, number> | null,
  incremental: boolean,
  limiar: number,
): boolean {
  if (anteriores == null) return true;
  for (const [produtoId, atual] of quantidadesAtuais) {
    const anterior = anteriores.get(produtoId);
    if (anterior == null) return true; // unknown ⇒ send
    if (anterior === atual) continue; // this member did not move
    if (!incremental) return true; // daily/full: any change is enough
    if (Math.min(anterior, atual) <= limiar) return true; // near the danger zone
    // Changed, but high on both sides — not worth the fast lane. Keep looking:
    // a sibling variation may still be low enough to justify the whole send.
  }
  return false;
}

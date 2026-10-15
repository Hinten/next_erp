/**
 * How the Shopee **authorization** clock is painted — colour and words for the
 * badge on `/canais/shopee/[id]`.
 *
 * ⚠️ This describes the AUTHORIZATION (7–365 days, the seller's consent), never
 * the access token (~4 hours, refreshable). Conflating the two is the defect the
 * legacy Flutter app shipped: it rendered "Conectado" from the 4-hour clock and
 * never read the other, so an authorization about to lapse looked identical to a
 * healthy conta until the day everything stopped. The two clocks arrive as two
 * different fields (`diasParaExpirar` vs `credencial.expiraEm`) and nothing here
 * folds one into the other.
 *
 * ## Why these are pure functions in `lib/` rather than JSX in the panel
 *
 * The threshold is the whole decision, and a decision buried in a ternary inside
 * a `renderConnected` callback can only be tested by rendering a panel. Here the
 * boundaries are pinned directly — 31/30/1/0/-1 and `null` — which is what makes
 * a later "simplification" of `> 30` into `>= 30` fail a test instead of quietly
 * moving the day the badge turns yellow.
 *
 * ## The days themselves
 *
 * `diasParaExpirar` is computed in `apps/shopee` with `Math.floor`, so the last
 * partial day reads `0` rather than `1` — an operator told "1 dia" on the
 * morning it expires would plan for tomorrow. `0` therefore means TODAY and gets
 * the same red as a negative value, which means the authorization is already
 * gone while the conta document still names the shop.
 */

/** A Mantine colour name, which is what the badge takes. */
export type CorExpiracao = 'green' | 'yellow' | 'red' | 'gray';

/** Beyond this many whole days the authorization is not worth flagging. */
const DIAS_ATENCAO = 30;

/**
 * `null` and anything non-finite mean the same thing to an operator — we do not
 * know — and that is never green. The wire schema types `diasParaExpirar` as
 * `number | null`, so the finite check is belt-and-braces; it exists because the
 * alternative failure is silent: a `NaN` compares `false` against every
 * threshold and would fall through to the red "expirada" arm, inventing a
 * verdict out of a missing one.
 *
 * ⚠️ Written out in both functions rather than shared through a helper, because
 * a type predicate here would have to claim `NaN is null` to narrow — the two
 * lines are cheaper than a lie the compiler then propagates.
 */
export function corExpiracaoAutorizacao(dias: number | null): CorExpiracao {
  if (dias === null || !Number.isFinite(dias)) return 'gray';
  if (dias > DIAS_ATENCAO) return 'green';
  if (dias > 0) return 'yellow';
  // `0` is today and negative is already past: both are red, and the WORDS
  // (below) are what tell them apart.
  return 'red';
}

export function textoExpiracaoAutorizacao(dias: number | null): string {
  if (dias === null || !Number.isFinite(dias)) return 'expiração desconhecida';
  if (dias > 1) return `expira em ${String(dias)} dias`;
  if (dias === 1) return 'expira em 1 dia';
  if (dias === 0) return 'expira hoje';
  return 'autorização expirada';
}

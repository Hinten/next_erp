/**
 * The feed core's PROVIDER SEAM table (step 12a, PR 12-c): batch fluxo → the
 * provider that builds, writes back and recovers its feeds
 * (`ProvedorLoteAmazon`, `./provedorLote`). The `notificacoes/destinos.ts`
 * shape: a typed table whose rows may be `null`, read per run by the jobs
 * root, never copied at load.
 *
 * Both rows are `null` in this PR: no provider exists yet. Stock (step 12)
 * fills `estoque`, price (step 13) fills `preco`. With a `null` row the
 * handlers do nothing a provider would have done: a send ends `sem-provedor`
 * before the lease is read (it takes and releases nothing), a result still
 * advances its record and logs that the write-back was skipped, a recovery
 * logs and ends.
 *
 * ⚠️ This table is the ONLY binding between the feed core and a fluxo: no
 * module of `feeds/` imports a fluxo's own module, and the jobs root is the
 * only reader of this one. Tests that need a provider hand a fake one to the
 * handler directly; they never edit this table.
 */
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { ProvedorLoteAmazon } from './provedorLote';

/**
 * One row per batch fluxo, each typed by ITS fluxo, so a price provider can
 * never sit in the stock row. The provider's own build data (`D`) is erased
 * here: the handler hands `membros`' answer back to the SAME provider's
 * `montar`, and to nothing else.
 */
export type DestinoLoteAmazon = {
  readonly [F in FluxoComLoteAmazon]: ProvedorLoteAmazon<F, unknown> | null;
};

/** The seam (module header). */
export const DESTINO_LOTE_AMAZON: DestinoLoteAmazon = {
  estoque: null,
  preco: null,
};

/** The provider of `fluxo` from the table, read per call (never cached by a root). */
export function provedorDoLoteAmazon<F extends FluxoComLoteAmazon>(
  fluxo: F,
): ProvedorLoteAmazon<F, unknown> | null {
  return DESTINO_LOTE_AMAZON[fluxo];
}

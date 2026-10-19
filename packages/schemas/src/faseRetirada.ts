import { ESTADO_FRETE, INTEGRACAO_FRETE } from './shared/frete';

/* -------------------------------------------------------------------------- */
/*            The checkout's retirada phase: one rule, two callers             */
/* -------------------------------------------------------------------------- */

/**
 * Whether a pedido's freight moves on to `aguardandoRetirada` — the pickup hand-off the checkout's
 * second phase applies, and the state the Loja Integrada status write-back turns into "pronto para
 * retirada" (master plan steps 7 and 15).
 *
 * `true` exactly when the target the pedido is dispatched through is a pickup (`tipoAlvo ===
 * 'retiradaNaLoja'`) AND the freight estado is `checkFinalizado` — the estado the checkout's first
 * phase writes. From any other estado it stays put: a freight already moved forward (delivered, or
 * handled by a marketplace shipment) must never be dragged back to `aguardandoRetirada`, and a
 * pedido not checked out yet has nothing to hand off.
 *
 * ONE copy for two callers (#1369): the checkout's phase 2 in `apps/web`, inside its transaction,
 * and the Loja Integrada label routing route, which re-points a pedido at a pickup target after its
 * checkout. `apps/loja-integrada` cannot import `apps/web`, so the rule lives here or twice.
 *
 * Pure and total: both arguments are RAW values compared exactly (no trim, no case fold); anything
 * else answers `false`.
 *
 * ⚠️ A NEW file on purpose, outside `pedido/**` and `shared/frete.ts`: both sit on the NF-e live
 * lane's path list, so every push touching them would cost a SEFAZ homologação emission.
 */
export function avancaParaRetirada(estadoFrete: unknown, tipoAlvo: unknown): boolean {
  return (
    tipoAlvo === INTEGRACAO_FRETE.retiradaNaLoja && estadoFrete === ESTADO_FRETE.checkFinalizado
  );
}

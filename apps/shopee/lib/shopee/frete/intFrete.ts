/**
 * The Shopee binding of the shared `int_frete` ⇆ conta core (master plan step 20, #1528) — the
 * app's ONE binding. Zero options: no tolerant back-ref scan, because the migrated docs carry the
 * canonical `documents/integracao/<id>` form, so a lookup reads only the two-equality query and
 * the deterministic `shopee-<integracaoId>` doc (`VINCULO_INT_FRETE_CONTA.shopee`, freight tipo
 * `shopee`, back-ref `contaShopeeFreteOuterRef`). A non-canonical ref is a hand edit the window
 * pass (`tools/migrations/src/2026-10-shopee-int-frete/`) STOPs on, never one to match.
 *
 * Every caller that has to name the same doc goes through this constant, so no two of them can
 * decide differently: the conta trigger (`functions/src/onIntegracaoShopeeChanged.ts`) reconciles
 * through `reconciliarIntFreteDaConta`, and the order import (`pedidos/importarPedido.ts`, its
 * read-only half) finds the conta's freight doc with
 * `buscarIntFreteDaConta(db, integracaoId, { apenasAtivo: true })` — never cached (its answer
 * feeds a write), over RAW bodies, and only a pedido it CREATES carries the answer (Lucas,
 * 2026-11-18). The window pass cannot import `apps/shopee`, so it binds the SAME row with the
 * SAME zero options. All the logic, and the rule-7 argument for it, is the core's
 * (`@delfrance/data/admin/frete`); this file only passes it the row.
 *
 * Next-free, reads no environment variable, and takes `db` as a parameter, so the functions
 * bundle imports it.
 */
import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

export const syncIntFreteShopee = intFreteContaSync(VINCULO_INT_FRETE_CONTA.shopee);

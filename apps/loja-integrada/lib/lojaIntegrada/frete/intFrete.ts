/**
 * The Loja Integrada binding of the shared `int_frete` ⇆ conta core (master plan step 20,
 * #1826) — the app's ONE binding. Zero options: no tolerant back-ref scan, because the migrated
 * docs carry the canonical `documents/integracao/<id>` form, so a lookup reads only the
 * two-equality query and the deterministic `lojaIntegrada-<id>` doc.
 *
 * Every caller that has to name the same doc goes through this constant, so no two of them can
 * decide differently: the conta trigger (`functions/src/onIntegracaoLojaIntegradaChanged.ts`)
 * reconciles through `reconciliarIntFreteDaConta`, step 5's importer finds the conta's freight doc with
 * `buscarIntFreteDaConta(db, contaId, { apenasAtivo: true })` (never cached: its answer feeds a
 * write), and `frete/mapaFrete.ts` checks a doc's tipo and back-ref with `ehDocDaConta`. All the
 * logic, and the rule-7 argument for it, is the core's (`@delfrance/data/admin/frete`); this file
 * only passes it the row.
 */
import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

export const syncIntFreteLi = intFreteContaSync(VINCULO_INT_FRETE_CONTA.lojaIntegrada);

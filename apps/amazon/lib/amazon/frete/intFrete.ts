/**
 * The Amazon binding of the shared `int_frete` ⇆ conta core (master plan step 20, #1930) — the
 * app's ONE binding. Zero options: no tolerant back-ref scan, because the migrated docs carry the
 * canonical `documents/integracao/<id>` form, so a lookup reads only the two-equality query and
 * the deterministic `amz-<integracaoId>` doc (`VINCULO_INT_FRETE_CONTA.amazon`, freight tipo
 * `'amz'`). A non-canonical ref is a hand edit the window pass STOPs on, never one to match.
 *
 * Every caller that has to name the same doc goes through this constant, so no two of them can
 * decide differently: the conta trigger (`functions/src/onIntegracaoAmazonChanged.ts`) reconciles
 * through `reconciliarIntFreteDaConta`, and step 5's importer will find the conta's freight doc
 * with `buscarIntFreteDaConta(db, contaId, { apenasAtivo: true })` — never cached (its answer
 * feeds a write), over RAW bodies. All the logic, and the rule-7 argument for it, is the core's
 * (`@delfrance/data/admin/frete`); this file only passes it the row.
 *
 * Next-free, reads no environment variable, and every function takes `db` as a parameter: the
 * `lib/amazon` contract (`estrutura.test.ts`), which lets the functions bundle import it.
 */
import { intFreteContaSync } from '@delfrance/data/admin/frete';
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';

export const syncIntFreteAmazon = intFreteContaSync(VINCULO_INT_FRETE_CONTA.amazon);

/**
 * Mercado Envios `int_frete` ⇆ Mercado Livre conta (`integracao`) sync (#782) — a BINDING of the shared core
 * `@delfrance/data/admin/frete` (moved there for Shopee step 20, #1528, so the two channels cannot drift; #1369).
 * The only ML-specific piece is the tolerant matcher for a bare `integracao/<id>` back-ref
 * (`core/linkRefs.ts`), kept here as the binding's option. ML still runs the core's EVENT-driven pair; moving
 * it onto the state-driven driver is follow-up #1888. Read the core for the concurrency argument and the
 * `.old/` parity notes. Consumers keep importing these names from this file.
 */
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';
import { intFreteContaSync } from '@delfrance/data/admin/frete';

import { refMatchesIntegracao } from '../core/linkRefs';

export {
  CAMPOS_SINCRONIZADOS,
  docMaisNovoQueEvento,
  type DisposicaoIntFrete,
} from '@delfrance/data/admin/frete';

const sync = intFreteContaSync(VINCULO_INT_FRETE_CONTA.mercadoLivre, {
  refTolerante: refMatchesIntegracao,
});

export const ehContaMercadoLivre = sync.ehConta;
export const mudouCampoSincronizado = sync.mudouCampoSincronizado;
export const refCanonicalDaConta = sync.refCanonicalDaConta;
export const montarCamposIntFrete = sync.montarCamposIntFrete;
export const buscarIntFreteDaConta = sync.buscarIntFreteDaConta;
export const sincronizarIntFreteDaConta = sync.sincronizarIntFreteDaConta;
export const desativarIntFreteDaConta = sync.desativarIntFreteDaConta;
export const contaRealmenteExcluida = sync.contaRealmenteExcluida;

/**
 * Mercado Envios `int_frete` ⇆ Mercado Livre conta (`integracao`) reconciliation (#782, #1888).
 * This binding keeps the ML-specific tolerant matcher for bare `integracao/<id>` back-refs.
 * The shared `@delfrance/data/admin/frete` reconciler reads the current conta and freight doc
 * inside one transaction; callers pass only the conta ID, so stale events cannot restore old fields.
 */
import { VINCULO_INT_FRETE_CONTA } from '@delfrance/schemas';
import { intFreteContaSync } from '@delfrance/data/admin/frete';

import { refMatchesIntegracao } from '../core/linkRefs';

export { CAMPOS_SINCRONIZADOS, type DisposicaoIntFrete } from '@delfrance/data/admin/frete';

const sync = intFreteContaSync(VINCULO_INT_FRETE_CONTA.mercadoLivre, {
  refTolerante: refMatchesIntegracao,
});

export const ehContaMercadoLivre = sync.ehConta;
export const mudouCampoSincronizado = sync.mudouCampoSincronizado;
export const deveReconciliar = sync.deveReconciliar;
export const refCanonicalDaConta = sync.refCanonicalDaConta;
export const montarCamposIntFrete = sync.montarCamposIntFrete;
export const escolherIntFreteDaConta = sync.escolherIntFreteDaConta;
export const planejarIntFreteDaConta = sync.planejarIntFreteDaConta;
export const buscarIntFreteDaConta = sync.buscarIntFreteDaConta;
export const reconciliarIntFreteDaConta = sync.reconciliarIntFreteDaConta;

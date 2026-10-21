import { FirebaseError } from 'firebase/app';
import { MOTIVO_ROTA_ETIQUETA_LI, type FreteDoPedido } from '@delfrance/schemas';

import {
  ehPedidoImportadoDaLojaIntegrada,
  type IdentidadePedidoLi,
} from '../loja-integrada/conferenciaPagamento';
import type { PedidoParaRotaLi, PrevisaoRotaEtiquetaLi } from '../loja-integrada/rotaEtiqueta';

/**
 * The checkout's Loja Integrada notices that are NOT the paid re-check (master
 * plan step 15) — both for an order imported from Loja Integrada only (the
 * identity hash, `ehPedidoImportadoDaLojaIntegrada`); every other channel keeps
 * exactly the behaviour it had:
 *
 * - {@link avisoDeEtiquetaAntesDoCheckoutLi} — before the save, a read-only
 *   preview of the label route: a pedido whose label the backend would refuse
 *   to route is warned about BEFORE the stock leaves, while the operator can
 *   still stop and fix the conta's mapping or pick a carrier on `/pedidos`;
 * - {@link motivoSemTransportadoraLi} — after the save (and on a reprint), why
 *   an imported order has no carrier at all, instead of the generic line.
 */

/** A pedido as the preview reads it: the route's guard inputs plus the identity. */
export type PedidoParaAvisoDeEtiquetaLi = PedidoParaRotaLi & IdentidadePedidoLi;

/**
 * The pre-save route warning (A3), or `null` when there is nothing to say:
 *
 * - not an imported order ⇒ `null`, and `prever` is never called — no read;
 * - the preview answers `ja-roteado` (already on a label target) or `rota`
 *   (the backend would route it) ⇒ `null`;
 * - it answers a refusal ⇒ the refusal's own copy, as a "continuar?" question.
 *
 * ⚠️ `sem-rota-li` is deliberately silent: it means the pedido is NOT on its
 * conta's Loja Integrada freight doc (no ref, or a ref naming neither that doc
 * nor a target), so there is no route to preview — the post-save says why it
 * has no carrier ({@link motivoSemTransportadoraLi}).
 *
 * ⚠️ A preview that cannot READ (a `FirebaseError`: permission, offline)
 * answers `null`. It is advisory and never the authority — the routing route
 * re-derives everything from its own reads when the label runs, and reports
 * its own refusal then — so a failed read must not stand between the operator
 * and a save. Anything else is rethrown (rule 6).
 */
export async function avisoDeEtiquetaAntesDoCheckoutLi(args: {
  readonly pedidoId: string;
  readonly pedido: PedidoParaAvisoDeEtiquetaLi;
  /** The read-only preview — `preverRotaEtiquetaLi` bound to the screen's db. */
  readonly prever: (pedido: PedidoParaRotaLi) => Promise<PrevisaoRotaEtiquetaLi>;
}): Promise<string | null> {
  if (!(await ehPedidoImportadoDaLojaIntegrada(args.pedidoId, args.pedido))) return null;
  let previsao: PrevisaoRotaEtiquetaLi;
  try {
    previsao = await args.prever(args.pedido);
  } catch (err) {
    if (err instanceof FirebaseError) return null;
    throw err;
  }
  if (previsao.tipo !== 'recusa' || previsao.motivo === MOTIVO_ROTA_ETIQUETA_LI.semRotaLi) {
    return null;
  }
  return (
    `A etiqueta deste pedido não poderá ser gerada depois do checkout: ${previsao.mensagem} ` +
    'Deseja continuar mesmo assim?'
  );
}

const SEM_ENDERECO = 'Pedido sem endereço de entrega: não há transportadora para gerar a etiqueta.';
const SEM_INTEGRACAO_DE_FRETE =
  'A conta Loja Integrada não tem integração de frete: não há transportadora para gerar a etiqueta.';

/**
 * Why an imported Loja Integrada order reached the label step with no carrier
 * (B11) — the copy that replaces "Este frete não possui integração com
 * transportadora." — or `null` to keep that generic line:
 *
 * - no delivery endereço ⇒ the order cannot be routed to a carrier that ships
 *   (only a pickup target needs none);
 * - an endereço but no freight ref ⇒ the import found no Loja Integrada
 *   freight integration on the conta to point it at;
 * - a ref that names a doc which is gone ⇒ `null`: that is not "no
 *   integration", and the generic line is the honest one;
 * - not an imported order ⇒ `null`, whatever the block holds.
 *
 * `frete` is the parsed block, where a missing ref or endereço is `null`; an
 * absent key reads the same.
 */
export async function motivoSemTransportadoraLi(
  pedidoId: string,
  pedido: IdentidadePedidoLi,
  frete: Pick<FreteDoPedido, 'integracaoFreteOuterRef' | 'enderecoFreteOuterReference'>,
): Promise<string | null> {
  if (!(await ehPedidoImportadoDaLojaIntegrada(pedidoId, pedido))) return null;
  if (frete.enderecoFreteOuterReference == null) return SEM_ENDERECO;
  if (frete.integracaoFreteOuterRef == null) return SEM_INTEGRACAO_DE_FRETE;
  return null;
}

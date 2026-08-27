// Import side-effect first: registers global function options (region) before
// any trigger is defined. Throws if FUNCTIONS_REGION is unset (see options.ts).
import './options';

/**
 * Cloud Functions entrypoint (gen2). Firebase deploys each exported trigger.
 */
export { resizeProductImage } from './product-images/resizeProductImage';
export { reconcileProductImages } from './product-images/reconcileSweep';
export { onArquivoDeleted } from './arquivos/onArquivoDeleted';
export { onProdutoMediaChanged } from './arquivos/onProdutoMediaChanged';
export { onTabMediMediaChanged } from './arquivos/onTabMediMediaChanged';
export { reconcileArquivoOrphans } from './arquivos/arquivoOrphanSweep';
export { onProdutoDeleted } from './produtos/onProdutoDeleted';
export { onProdutoChanged } from './produtos/onProdutoChanged';
export { recalcularDimensoesKit } from './produtos/kitRollup';
export { onProdutoExtraDataChanged } from './produtos/onProdutoExtraDataChanged';
export { onProdutoImpostoChanged } from './produtos/onProdutoImpostoChanged';
export { onEstoqueDeleted } from './estoques/onEstoqueDeleted';
export { onBalancoDeleted } from './estoques/onBalancoDeleted';
export { onOperacaoDeleted } from './operacoes/onOperacaoDeleted';
export { onCategoriaDeleted } from './categorias/onCategoriaDeleted';
// Same cascade, four collections, one factory — see cascadeCaroGenerico.ts.
// `onConversaDeleted` is the budgeted one: a conversa's `mensagem` subcollection
// can outlast a single invocation, so it stops at its budget and is redelivered.
export {
  onIntegracaoDeleted,
  onIntFreteDeleted,
  onMetodoPagamentoDeleted,
  onConversaDeleted,
} from './cascades/caroGenericoTriggers';
export { onNfeDeleted } from './nfe/onNfeDeleted';
export { onPedidoChanged } from './pedidos/registrarHistoricoPedido';
// Pedido modification history for the two covered subcollections; the pedido
// document's own entry rides `onPedidoChanged` above (one observer, one
// write per event).
export { onPagamentoChanged } from './pedidos/onPagamentoChanged';
export { onIncidenteChanged } from './pedidos/onIncidenteChanged';
export { aplicarEstoque } from './estoques/aplicarEstoque';
export {
  onPedidoEstoqueSync,
  resincronizarEstoquePedido,
} from './estoques/sincronizarEstoquePedido';
export { reconciliarPagamentoPedido } from './pedidos/reconciliarPagamentoPedido';
export { finalizarBalanco, processarBalanco } from './estoques/aplicarBalanco';

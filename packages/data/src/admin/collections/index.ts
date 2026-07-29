/**
 * Canonical registry of Admin-SDK collection handles. Every
 * `defineAdminCollection()` instance lives here (one file per collection) so
 * server apps import a ready-made, schema-validated handle instead of
 * re-declaring one. Add a new handle by dropping a `<domain>Collection.ts`
 * file alongside these and re-exporting it below.
 *
 * Defining a handle in app code instead is flagged by the
 * `delfrance/no-inline-admin-collection` ESLint rule (warn).
 */
export { nfev4Collection } from './nfev4Collection';
export { enviNfeMsgCollection } from './enviNfeMsgCollection';
export { nfeConfigCollection } from './nfeConfigCollection';
export { certificadoSecretoCollection } from './certificadoSecretoCollection';
export { filialCollection } from './filialCollection';
export { inutNumeracaoCollection } from './inutNumeracaoCollection';
export { cartaCorrecaoCollection } from './cartaCorrecaoCollection';
export { cargoCollection } from './cargoCollection';
export { usuarioCollection } from './usuarioCollection';
export { arquivoCollection } from './arquivoCollection';
export { arquivoOrphanSweepStateCollection } from './arquivoOrphanSweepStateCollection';
export { categoriaCollection } from './categoriaCollection';
export { produtoCollection } from './produtoCollection';
export { estoqueCollection } from './estoqueCollection';
export { historicoEstoqueCollection } from './historicoEstoqueCollection';
export { historicoModificacaoCollection } from './historicoModificacaoCollection';
export { tabelaDeMedidasCollection } from './tabelaDeMedidasCollection';
export { intFreteCollection } from './intFreteCollection';
export { tokenMelEnvCollection } from './tokenMelEnvCollection';
export { integracaoCollection } from './integracaoCollection';
export { credenciaisIntegracaoCollection } from './credenciaisIntegracaoCollection';
export { tokenDuravelCollection } from './tokenDuravelCollection';
export {
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from './produtoMercadoLivreLinkCollection';
export { grupoDeVariacoesCollection } from './grupoDeVariacoesCollection';
export { produtoExtraDataCollection } from './produtoExtraDataCollection';
export { notificacaoMercadoLivreCollection } from './notificacaoMercadoLivreCollection';
export { importacaoMercadoLivreCollection } from './importacaoMercadoLivreCollection';
export { pedidoCollection } from './pedidoCollection';
export { operacaoCollection } from './operacaoCollection';
export { incidenteCollection } from './incidenteCollection';
export { metodoPagamentoCollection } from './metodoPagamentoCollection';
export { pagamentoCollection } from './pagamentoCollection';
export { historicoEstadoPedidoCollection } from './historicoEstadoPedidoCollection';
export { historicoFreteInicialCollection } from './historicoFreteInicialCollection';
export { credenciaisMetodoPgtoCollection } from './credenciaisMetodoPgtoCollection';
export { notificacaoMercadoPagoCollection } from './notificacaoMercadoPagoCollection';
export { clienteCollection } from './clienteCollection';
export { conversaCollection } from './conversaCollection';
export { mensagemCollection } from './mensagemCollection';
export { credenciaisWhatsappCollection } from './credenciaisWhatsappCollection';
export { notificacoesWhatsappCollection } from './notificacoesWhatsappCollection';
export { orderMLCollection } from './orderMLCollection';
export { enderecoCollection } from './enderecoCollection';
export { backfillPedidosMercadoLivreCollection } from './backfillPedidosMercadoLivreCollection';
export { estoqueMercadoLivreSyncCollection } from './estoqueMercadoLivreSyncCollection';

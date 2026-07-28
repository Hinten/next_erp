/**
 * Pedido domain use-cases behind an SDK-agnostic port (mirrors `../produto`).
 * The web app and a future MCP/admin agent share this orchestration; each
 * supplies its own {@link PedidoDataPort} adapter.
 */
export type {
  PedidoDataPort,
  PedidoDevolucaoDataPort,
  PedidoDocData,
  PedidoTransactArgs,
  PedidoWriteOp,
} from './port';
export {
  buildPedidoPatch,
  savePedido,
  remotelyChangedFields,
  buildEstadoHistoryOp,
  recordEstadoChange,
  buildIncidenteOp,
  saveIncidente,
  deleteIncidente,
  buildPagamentoOp,
  savePagamento,
  deletePagamento,
  nextPedidoEstado,
  PedidoConflictError,
  PedidoNothingChangedError,
} from './usecases';
export {
  PEDIDO_COUNTER_DOC_ID,
  PEDIDO_COUNTER_PATH,
  PEDIDO_NUMERO_NO_OPERACAO_PREFIX,
  PEDIDO_NUMERO_WIDTH,
  formatPedidoNumero,
  mintNumeros,
  operacaoNumeroPrefix,
} from './numero';
export {
  DEVOLUCAO_INTEGRAL_STRIP_KEYS,
  PEDIDO_PATH,
  buildDevolucaoIntegralSeed,
  buildDevolucaoPedido,
  collectChNFeReferenciadas,
  criarEntradaDevolucaoIntegral,
  criarSaidaComDevolucao,
  novosOriginsDeTroca,
  prepareDevolucaoSave,
  registrarIncidenteDeDevolucaoIntegral,
  registrarIncidentesDeTroca,
  resolveDevolucaoOperacao,
  type DevolucaoOperacaoInfo,
  type DevolucaoSavePrepared,
} from './devolucao';
export {
  calcularAlteracoesEstoque,
  planSincronizacaoEstoque,
  temEfeitoAplicado,
  temMovimentoAplicado,
  type EstoqueDelta,
  type ItemParaEstoque,
  type PlanoSincronizacaoEstoque,
  type ProdutoParaEstoque,
  type SincronizacaoEstoqueInput,
} from './estoquePlan';

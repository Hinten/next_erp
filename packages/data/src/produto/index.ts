export type { ProdutoDataPort, ProdutoSnapshot, ProdutoKitFlag, ProdutoWriteOp } from './port';

export {
  movimentacaoInputSchema,
  estoqueComandoSchema,
  type EstoqueComando,
} from './estoqueComando';

export {
  buildExtraDataWriteOps,
  saveProdutoExtraData,
  buildLocalizacaoOp,
  planMovimentacao,
  type TipoMovimentacao,
  type MovimentacaoInput,
  type MovimentacaoPlan,
  type EstoqueAtual,
  buildImpostoWriteOps,
  saveProdutoImpostos,
  buildChildrenComponentesKitOps,
  saveChildrenComponentesKit,
  type ChildComponentesKit,
  buildKitStatusChildOps,
  propagateKitStatusToChildren,
  type KitStatusChange,
  resolveKitGuardInputs,
  type ResolvedKitGuards,
  findProdutoReferences,
  hasReferences,
  describeReferences,
  deleteProdutoCascade,
  ProdutoReferencedError,
  MARKETPLACE_CHANNEL_LABELS,
  type ProdutoReferences,
} from './usecases';

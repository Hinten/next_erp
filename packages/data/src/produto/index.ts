export type { ProdutoDataPort, ProdutoSnapshot, ProdutoWriteOp } from './port';

export {
  buildPrecoHistoryOps,
  buildCustoHistoryOp,
  recordPrecoHistory,
  recordCustoHistory,
  buildExtraDataWriteOps,
  saveProdutoExtraData,
  propagatePrecosToChildren,
  applyPrecosChange,
  findProdutoReferences,
  hasReferences,
  describeReferences,
  deleteProdutoCascade,
  ProdutoReferencedError,
  MARKETPLACE_CHANNEL_LABELS,
  type ProdutoReferences,
} from './usecases';

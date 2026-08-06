export {
  defineAdminCollection,
  type AdminCollectionHandle,
  type DefineAdminCollectionOptions,
  type PathContext,
} from './defineAdminCollection';

export {
  deleteDocumentSubtree,
  type DeleteSubtreeOptions,
  type DeleteSubtreeReport,
} from './deleteSubtree';

export {
  reconcilePedidoEstado,
  reconcilePedidoFromPagamento,
  PedidoReconcileNotFoundError,
} from './pedidoReconcile';

export { isAlreadyExists, isFailedPrecondition, isNotFound } from './grpcErrors';
export {
  CodigoMunicipioNaoResolvidoError,
  resolveCodigoMunicipio,
  type EnderecoCMunInput,
  type MotivoCodigoMunicipioNaoResolvido,
  type ResolveCodigoMunicipioOptions,
} from './cmun';

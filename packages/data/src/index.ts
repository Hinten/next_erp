export {
  defineCollection,
  type CollectionHandle,
  type DefineCollectionOptions,
  type PathContext,
} from './defineCollection';

export {
  whereEqual,
  whereOp,
  whereArrayContains,
  orderByField,
  limit,
  paginate,
  buildQuery,
  groupQuery,
} from './queries';

export {
  PipelineUnsupportedError,
  buildPipeline,
  isPipelineSupported,
  type Pipeline,
  type PipelineSpec,
  type PipelineSearchSpec,
  type PipelineOrderSpec,
  type PipelineFieldFilter,
  type PipelineFilterOp,
} from './pipeline-queries';

export { writeAuditEntry, type AuditEntryInput } from './audit';

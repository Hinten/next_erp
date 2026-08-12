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
  whereDocIdIn,
  orderByField,
  limit,
  paginate,
  buildQuery,
  groupQuery,
} from './queries';

export { defaultQueryConstraints, type DefaultQueryOptions } from './defaultQuery';

export {
  PIPELINE_ID_FIELD,
  PipelineUnsupportedError,
  buildPipeline,
  isPipelineSupported,
  type Pipeline,
  type PipelineSpec,
  type PipelineSearchSpec,
  type PipelineOrderSpec,
  type PipelineFieldFilter,
  type PipelineFilterOp,
  type PipelineSelectEntry,
} from './pipeline-queries';

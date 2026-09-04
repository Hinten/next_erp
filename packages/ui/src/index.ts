export { cssVariablesResolver, theme } from './theme';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { PlaceholderPage, type PlaceholderPageProps } from './PlaceholderPage';

// Input primitives
export { DecimalInput, type DecimalInputProps } from './inputs/DecimalInput';
export { parseDecimalInput } from './inputs/decimalValue';

// Schema metadata layer
export { extractFieldsFromSchema } from './schema/derive';
export { parseZodDescription, type ParsedDescription } from './schema/describe';
export type {
  ActionConfig,
  ColumnFilterValue,
  FieldConfig,
  FieldDescriptor,
  FieldKind,
  FieldRenderProps,
  FilterableField,
  InferRow,
  VirtualColumn,
  VirtualColumnFilter,
} from './schema/types';

// Table primitives
export { TableView, type TableViewProps } from './table/TableView';
export { ColumnPicker, type ColumnPickerItem, type ColumnPickerProps } from './table/ColumnPicker';
export { ActionBar, type ActionBarProps } from './table/ActionBar';
export { useCollectionMonitor, type CollectionMonitorResult } from './table/useCollectionMonitor';
export { SearchBar, type SearchBarProps } from './table/SearchBar';
export {
  useSearchIdResolution,
  type SearchIdResolution,
  type SearchIdResolver,
  type SearchIdResolutionState,
} from './table/useSearchIdResolution';
export { ActiveFilters, type ActiveFiltersProps } from './table/ActiveFilters';
export {
  SEARCH_CHIP_KEY,
  buildFilterChips,
  describeFilter,
  subcollectionLookupFormatter,
  type FilterChip,
} from './table/describeFilter';
export {
  SEARCH_PARAM,
  encodeTableState,
  resolveInitialTableState,
  urlCarriesTableState,
  type TableUrlState,
  type TableUrlStateOptions,
} from './table/useTableUrlState';
export {
  clearListViewMemory,
  listViewMemoryKey,
  readListViewMemory,
  writeListViewMemory,
  type ListViewMemory,
} from './table/listViewMemory';
export { renderCell } from './table/cell-renderers';

// Object primitives
export {
  ObjectView,
  type ObjectViewProps,
  type TransactionWrite,
  type ValidationIssue,
} from './object/ObjectView';
export { AfterSaveBlockedError } from './object/afterSaveBlocked';
export { ConflictModal, type ConflictModalProps } from './object/ConflictModal';
export {
  buildConflictFields,
  labelFromShape,
  type BuildConflictFieldsOptions,
  type ConflictField,
} from './object/conflictFields';
export { FieldRenderer, type FieldRendererProps } from './object/FieldRenderer';
export { useObjectViewSections, type ObjectViewSections } from './object/ObjectViewSectionsContext';
export { NullClearButton, type NullClearButtonProps } from './object/NullClearButton';
export { epochToPickerString, pickerStringToEpoch, type EpochUnit } from './object/datetimeField';
export { RecordPager, type RecordPagerProps } from './object/RecordPager';
export { SectionTabs, useSectionActive, type SectionTabsProps } from './object/SectionTabs';
export { isEmpty, pickDirty, valuesEqual } from './object/diff';
export { DELETE_MARK, stripMarkedForDeletion } from './object/markForDeletion';
export {
  NothingChangedError,
  RecordConflictError,
  saveRecord,
  type SaveRecordInput,
  type SaveRecordResult,
} from './object/saveRecord';
export {
  resolveStampFields,
  CREATED_AT_CANDIDATES,
  MODIFIED_AT_CANDIDATES,
  type ResolvedStampFields,
  type StampFieldOverride,
} from './object/resolveStampFields';
export { useServerTruthSeed, type ServerTruthSeedArgs } from './object/useServerTruthSeed';
export { useUnsavedChangesGuard } from './object/useUnsavedChangesGuard';
export {
  AiReviewModal,
  AiReviewAtual,
  type AiReviewColumn,
  type AiReviewFeedback,
  type AiReviewModalProps,
} from './ai/AiReviewModal';

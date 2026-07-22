export { cssVariablesResolver, theme } from './theme';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { PlaceholderPage, type PlaceholderPageProps } from './PlaceholderPage';

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
export { renderCell } from './table/cell-renderers';

// Object primitives
export {
  ObjectView,
  type ObjectViewProps,
  type TransactionWrite,
  type ValidationIssue,
} from './object/ObjectView';
export { FieldRenderer, type FieldRendererProps } from './object/FieldRenderer';
export { NullClearButton, type NullClearButtonProps } from './object/NullClearButton';
export { epochToPickerString, pickerStringToEpoch, type EpochUnit } from './object/datetimeField';
export { RecordPager, type RecordPagerProps } from './object/RecordPager';
export { SectionTabs, type SectionTabsProps } from './object/SectionTabs';
export { isEmpty, pickDirty, valuesEqual } from './object/diff';
export { DELETE_MARK, stripMarkedForDeletion } from './object/markForDeletion';
export {
  NothingChangedError,
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
export { useUnsavedChangesGuard } from './object/useUnsavedChangesGuard';

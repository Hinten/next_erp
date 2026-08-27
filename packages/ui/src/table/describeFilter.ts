import type { ColumnFilterValue, FilterableField } from '../schema/types';
import { epochToPickerString } from '../object/datetimeField';

/**
 * Render one active column filter as a short human phrase, for the chip row
 * above the table.
 *
 * There was no value formatter anywhere in the table code before this: the
 * filter popovers label their INPUTS but never echo what is currently set, so
 * the only signal that a list was filtered used to be a filled icon in a column
 * header. That is fine when you just clicked it and useless when the filter was
 * restored from a previous visit — which, with the sticky list memory, is now
 * the common case.
 *
 * ⚠️ Every phrase MUST come out as a single string, and the caller must render
 * it as a single text node. `apps/web/e2e/helpers/table-view.ts`'s
 * `clickColumnSort` is `page.getByText(columnLabel, { exact: true })` under
 * Playwright strict mode, so a chip that renders the bare column label in a
 * node of its own resolves to two elements and reds every sort spec — including
 * `clientes.cadastros.e2e.spec.ts`, which sorts WHILE a Nome filter is active.
 * The same applies to `getByText` in `TableView.test.tsx`.
 */

/** Operator symbols, matching the numeric filter body's own Select. */
const OP_SYMBOL: Record<string, string> = {
  eq: '=',
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
};

/** `epochToPickerString`'s `YYYY-MM-DD HH:mm:ss` as the displayed `DD/MM/YYYY HH:mm`. */
function toBrDateTime(value: number, unit: 'ms' | 'us'): string {
  const picker = epochToPickerString(value, unit);
  if (picker === null) return String(value);
  const [date = '', time = ''] = picker.split(' ');
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y} ${time.slice(0, 5)}`.trim();
}

/** The enum option's label for a stored value, falling back to the raw value. */
function enumLabel(field: FilterableField, value: unknown): string {
  const match = field.enumValues?.find((o) => o.value === String(value));
  return match?.label ?? String(value);
}

export interface DescribeFilterOptions {
  /**
   * Caller-supplied value renderer for filters whose value is not
   * self-describing — a virtual column's custom popover, or the
   * subcollection-lookup encoding `"<subfield>:<term>"`, which would otherwise
   * print as `numeracao:1234` on the pedido NF column.
   */
  formatValue?: (value: ColumnFilterValue['value']) => string;
}

/**
 * @param label the column's DISPLAYED label. Resolve it the way the header
 *   does — `fieldOverrides[key]?.label ?? descriptor.label` — or a relabelled
 *   column gets a chip that disagrees with its own header (the #1264 class).
 */
export function describeFilter(
  label: string,
  filter: ColumnFilterValue,
  field: FilterableField,
  options?: DescribeFilterOptions,
): string {
  const { op, value } = filter;

  if (options?.formatValue) return `${label}: ${options.formatValue(value)}`;

  // Membership against a candidate list. Labels when the virtual column
  // declared its options, a bare count when it did not — a row of raw
  // Firestore ids would be worse than no chip at all.
  if (Array.isArray(value)) {
    if (field.enumValues && field.enumValues.length > 0) {
      return `${label}: ${value.map((v) => enumLabel(field, v)).join(', ')}`;
    }
    return `${label}: ${value.length} ${value.length === 1 ? 'selecionado' : 'selecionados'}`;
  }

  if (field.kind === 'boolean') return `${label}: ${value === true ? 'Sim' : 'Não'}`;

  if (field.kind === 'enum') return `${label}: ${enumLabel(field, value)}`;

  if (field.kind === 'datetime' && typeof value === 'number') {
    const when = toBrDateTime(value, field.dateUnit ?? 'us');
    if (op === 'gte') return `${label}: a partir de ${when}`;
    if (op === 'lte') return `${label}: até ${when}`;
    return `${label}: ${when}`;
  }

  if (op === 'contains') return `${label} contém "${String(value)}"`;
  if (op === 'startsWith') return `${label} começa com "${String(value)}"`;
  if (op === 'array-contains') return `${label}: ${String(value)}`;

  const symbol = OP_SYMBOL[op];
  if (symbol && symbol !== '=') return `${label} ${symbol} ${String(value)}`;
  return `${label}: ${String(value)}`;
}

/**
 * Default value renderer for a subcollection-lookup filter, whose value packs
 * the chosen child field and the term into one string.
 */
export function subcollectionLookupFormatter(
  fields: ReadonlyArray<{ value: string; label: string }>,
): (value: ColumnFilterValue['value']) => string {
  return (value) => {
    const raw = String(value);
    const sep = raw.indexOf(':');
    if (sep < 0) return raw;
    const subfield = raw.slice(0, sep);
    const term = raw.slice(sep + 1);
    const match = fields.find((f) => f.value === subfield);
    return `${match?.label ?? subfield} ${term}`;
  };
}

/** Chip key for the free-text search term — never a real field key. */
export const SEARCH_CHIP_KEY = '__search__';

export interface FilterChip {
  /** `SEARCH_CHIP_KEY`, or the filter's field key. */
  key: string;
  /** The whole phrase. Render as ONE text node — see the note at the top. */
  text: string;
}

/**
 * Everything currently narrowing the list, as chips.
 *
 * Ordered search-first, then by the field order, so the broadest constraint
 * reads first. Filters whose field has no descriptor are skipped: they cannot
 * be labelled, and a chip reading `undefined: x` is worse than none — the same
 * filter is equally invisible to `parseFiltersFromParams`, so it is not
 * actually narrowing anything either.
 */
export function buildFilterChips(params: {
  filters: Record<string, ColumnFilterValue>;
  fields: FilterableField[];
  /** The DISPLAYED label for a key — the header's override, else the descriptor's. */
  labelFor?: (field: FilterableField) => string;
  formatters?: Record<string, (value: ColumnFilterValue['value']) => string>;
  search?: string;
  searchLabel?: string;
}): FilterChip[] {
  const { filters, fields, labelFor, formatters, search = '', searchLabel = 'Busca' } = params;
  const chips: FilterChip[] = [];
  if (search !== '') chips.push({ key: SEARCH_CHIP_KEY, text: `${searchLabel}: "${search}"` });
  for (const field of fields) {
    const filter = filters[field.key];
    if (!filter) continue;
    chips.push({
      key: field.key,
      text: describeFilter(labelFor?.(field) ?? field.label, filter, field, {
        formatValue: formatters?.[field.key],
      }),
    });
  }
  return chips;
}

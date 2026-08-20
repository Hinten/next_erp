/**
 * Reads Mercado Livre's size-chart technical specs into the model the editor
 * renders. No React and no IO, so every rule below is unit-testable on its own.
 *
 * Two ML calls feed this, in order (`POST size-charts/specs`, with and without
 * `attributes`):
 *
 *  1. `GET /domains/{id}/technical_specs` — the DOMAIN spec. Its
 *     `grid_template_required` attributes (GENDER, and whatever else a domain
 *     asks for) are the questions the operator must answer before ML will even
 *     tell us what the columns are.
 *  2. `POST /domains/{id}/technical_specs?section=grids` with those answers —
 *     the GRID spec, which is the actual column list.
 *
 * The tree is `{input: {groups: [{components: [{component: 'GRID', components:
 * [...]}]}]}}`, where the GRID's CHILD components are the columns. ML has
 * reshaped these trees before, so the walk stays defensive and every unknown
 * shape degrades rather than throwing — the legacy screen raised
 * `UnimplementedError` on an unrecognised component id and blanked the whole
 * grid, which is a hard dead end for something ML can change unilaterally.
 */

/** One selectable value of a spec attribute (`{id, name}`). */
export interface ChartSpecValue {
  id: string;
  name: string;
}

/**
 * A chart-level attribute the operator answers — a question about the guia
 * itself rather than about one of its rows.
 */
export interface GridTemplateAttribute {
  id: string;
  name: string;
  values: ChartSpecValue[];
  /** ML refuses the chart without it (`required`). */
  required: boolean;
  /**
   * How it is edited. `select` is ML's CLOSED list (`value_type: 'list'`, e.g.
   * GENDER); `text` is free text WITH suggestions.
   *
   * ⚠️ `values` being non-empty does NOT mean the list is closed. BRAND arrives
   * as `value_type: 'string'` with `allow_custom_value: true` and a pile of
   * known brands — ML accepts anything there, and its own hint tells the seller
   * to type the real brand. Rendering it as a Select silently blocks every
   * brand ML has not seen. Same rule as `attributeForm.ts`'s `widgetKind`.
   */
  kind: 'select' | 'text';
}

/** How one attribute of a column is edited. */
export type ChartCellKind = 'text' | 'number' | 'select' | 'multiselect';

/** One attribute inside a column — two of them for a FROM/TO pair. */
export interface ChartColumnPart {
  attributeId: string;
  label: string;
  kind: ChartCellKind;
  /** Closed list for `select`/`multiselect`; empty otherwise. */
  values: ChartSpecValue[];
}

/**
 * One rendered column. A `LINKED_BY_CONNECTOR_INPUT` contributes TWO parts
 * (`*_FROM` and `*_TO`) under a single header joined by `connector` — the legacy
 * screen drew the same thing with two half-width fields and the connector text
 * between them.
 */
export interface ChartColumn {
  /** Stable key for React and for the cell-error index: the first part's id. */
  key: string;
  label: string;
  hint: string | null;
  /** ML rejects a row missing this column. */
  required: boolean;
  /** Eligible as the chart's main attribute (`main_attribute_candidate`). */
  mainCandidate: boolean;
  /** Unit choices for a `number_unit` column; `options` is empty when fixed. */
  unit: { default: string | null; options: ChartSpecValue[] };
  /** Rendered between the parts of a FROM/TO pair (ML's `ui_config.connector`). */
  connector: string | null;
  parts: ChartColumnPart[];
}

/** ML's `measure_type`. `MIXED_MEASURE` is deliberately absent — see below. */
export type ChartMeasureType = 'BODY_MEASURE' | 'CLOTHING_MEASURE';

/* ------------------------------ raw spec walk ---------------------------- */

interface RawAttribute {
  id?: unknown;
  name?: unknown;
  tags?: unknown;
  values?: unknown;
  value_type?: unknown;
  units?: unknown;
  default_unit_id?: unknown;
}

interface RawComponent {
  component?: unknown;
  label?: unknown;
  ui_config?: unknown;
  attributes?: unknown;
  components?: unknown;
  default_unified_unit_id?: unknown;
  unified_units?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function tagsOf(attr: RawAttribute): string[] {
  if (!Array.isArray(attr.tags)) return [];
  return attr.tags.filter((t): t is string => typeof t === 'string');
}

function hasTag(attr: RawAttribute, tag: string): boolean {
  return tagsOf(attr).includes(tag);
}

export function toSpecValues(raw: unknown): ChartSpecValue[] {
  if (!Array.isArray(raw)) return [];
  const out: ChartSpecValue[] = [];
  for (const v of raw) {
    if (!isRecord(v)) continue;
    const id = str(v.id);
    const name = str(v.name);
    // A value ML sends with only one of the two is still selectable — mirror
    // whichever it gave so nothing silently disappears from a closed list.
    if (id == null && name == null) continue;
    out.push({ id: id ?? name!, name: name ?? id! });
  }
  return out;
}

/**
 * Every attribute across the spec tree, regardless of nesting. Follows only the
 * structural keys, never an attribute's own `values`, so a value that happens
 * to carry `attributes` cannot leak in.
 */
function collectAttributes(specs: unknown): RawAttribute[] {
  const out: RawAttribute[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.attributes)) {
      for (const a of obj.attributes) {
        if (isRecord(a)) out.push(a as RawAttribute);
      }
    }
    for (const key of ['input', 'groups', 'components'] as const) {
      if (key in obj) visit(obj[key]);
    }
  };

  visit(specs);
  return out;
}

/** The GRID component's direct children — the column definitions. */
function collectGridComponents(specs: unknown): RawComponent[] {
  const out: RawComponent[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as RawComponent & Record<string, unknown>;
    if (obj.component === 'GRID' && Array.isArray(obj.components)) {
      for (const c of obj.components) {
        if (isRecord(c)) out.push(c as RawComponent);
      }
      return; // the GRID's children ARE the columns; do not descend further
    }
    for (const key of ['input', 'groups', 'components'] as const) {
      if (key in obj) visit(obj[key]);
    }
  };

  visit(specs);
  return out;
}

/* --------------------------- chart-level answers ------------------------- */

/**
 * The domain's `grid_template_required` attributes — the answers ML needs
 * before it will describe the grid.
 *
 * ⚠️ Returns ALL of them. The MVP handled exactly one and told the operator to
 * "cadastre pelo app antigo" for anything else, which is a dead end for a
 * domain that legitimately asks for two.
 */
export function extractGridTemplates(specs: unknown): GridTemplateAttribute[] {
  return collectAttributes(specs)
    .filter((a) => hasTag(a, 'grid_template_required'))
    .map((a) => ({
      id: str(a.id) ?? '',
      name: str(a.name) ?? str(a.id) ?? '',
      values: toSpecValues(a.values),
      required: true,
      kind: attributeKind(a),
    }))
    .filter((t) => t.id !== '');
}

/** Closed list only when ML says `list`; everything else accepts custom text. */
function attributeKind(attr: RawAttribute): 'select' | 'text' {
  return attr.value_type === 'list' ? 'select' : 'text';
}

function normalizeValue(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * What the operator has typed SO FAR into a free-text chart attribute.
 *
 * ⚠️ The on-CHANGE path, and it deliberately leaves the text alone — the trim and
 * the known-value match in {@link resolveChartAttributeValue} both rewrite the
 * string the input renders back, which cost the operator every space they
 * pressed. Blur resolves it; {@link resolveChartAttributeValue} runs again when
 * the chart body is assembled, so an unblurred draft never reaches ML.
 *
 * The empty `id` is the existing "free text, no value_id" marker.
 *
 * ⚠️ Unlike `draftTypedValue` on the produto side, a BLANK draft still counts as
 * no answer here. An answered chart-level attribute is what opens `answered` and
 * puts the value into the grid-spec query KEY, so keeping `'  '` would spend a
 * real Mercado Livre round trip asking about a whitespace brand. The cost is
 * that a LEADING space cannot start an empty box — a trailing one, which is what
 * blocks typing, is unaffected.
 */
export function draftChartAttributeValue(typed: string): ChartSpecValue | null {
  if (typed.trim() === '') return null;
  return { id: '', name: typed };
}

/**
 * What the operator typed into a free-text chart attribute, as an ML value.
 *
 * A known option wins when the text matches one — accent- and case-insensitively,
 * because `Generica` typed for `Genérica` would otherwise go up as a custom
 * value ML does not recognise (the same trap `attributeForm.ts` documents).
 * Otherwise the raw text goes as `name` with **no id**: an invented `value_id`
 * is rejected outright.
 *
 * ⚠️ Runs on BLUR and again in `buildChart` — never on change; see
 * {@link draftChartAttributeValue}.
 */
export function resolveChartAttributeValue(
  attribute: GridTemplateAttribute,
  typed: string,
): ChartSpecValue | null {
  const trimmed = typed.trim();
  if (trimmed === '') return null;
  const match = attribute.values.find((v) => normalizeValue(v.name) === normalizeValue(trimmed));
  return match ?? { id: '', name: trimmed };
}

/**
 * The `grid_filter` attributes, which ML requires at CHART level and forbids
 * inside rows ("devem ser carregados no nível geral da tabela de medidas e não
 * no nível de rows"). Read-only ones are dropped: ML derives them itself.
 *
 * ⚠️ Feed this the **GRID** spec (`?section=grids`), NEVER the domain one.
 * `grid_filter` names two different sets in the two responses. On the grid spec
 * — the *ficha técnica da tabela de medidas* — it marks the chart's own general
 * attributes. On the DOMAIN spec it marks the vocabulary of
 * `/catalog/charts/search`, a much wider set carrying MODEL, LINE and friends,
 * and ML answers a chart body containing one of those with
 * "Attribute MODEL found in chart's attributes is not valid and should not be
 * present in the chart's general attributes".
 */
export function extractChartAttributes(specs: unknown): GridTemplateAttribute[] {
  return collectAttributes(specs)
    .filter((a) => hasTag(a, 'grid_filter'))
    .filter((a) => !hasTag(a, 'read_only') && !hasTag(a, 'hidden'))
    .map((a) => ({
      id: str(a.id) ?? '',
      name: str(a.name) ?? str(a.id) ?? '',
      values: toSpecValues(a.values),
      required: hasTag(a, 'required'),
      kind: attributeKind(a),
    }))
    .filter((t) => t.id !== '');
}

/**
 * Every attribute a spec declares, as chart-level questions keyed by id — the
 * RENDERING lookup, independent of which tags it carries.
 */
function attributesById(specs: unknown): Map<string, GridTemplateAttribute> {
  const byId = new Map<string, GridTemplateAttribute>();
  for (const attr of collectAttributes(specs)) {
    const id = str(attr.id);
    // First occurrence wins: an id appears once per spec, and re-reading it from
    // a later group could only replace richer metadata with poorer.
    if (id == null || byId.has(id)) continue;
    byId.set(id, {
      id,
      name: str(attr.name) ?? id,
      values: toSpecValues(attr.values),
      required: hasTag(attr, 'required'),
      kind: attributeKind(attr),
    });
  }
  return byId;
}

/**
 * Every chart-level question the operator answers, deduplicated by attribute id.
 *
 * The two specs play different roles and neither can be dropped:
 *
 *  - the DOMAIN spec contributes the `grid_template_required` questions — they
 *    had to be answered to obtain the grid spec at all, and ML expects them in
 *    the chart body — and it is the RENDERING source for every id it knows;
 *  - the GRID spec is the AUTHORITY on which OTHER attributes belong here.
 *    Reading that from the domain spec is what once rendered a "Modelo" field
 *    and sent ML a MODEL it rejects — see `extractChartAttributes`.
 *
 * ⚠️ The metadata must keep coming from the DOMAIN spec. The grid spec echoes
 * GENDER back as `value_type: 'string'` narrowed to the single chosen value, and
 * its BRAND carries no `values` at all — take either from there and GENDER
 * degrades to free text while BRAND loses its whole suggestion list.
 *
 * ⚠️ The two lists OVERLAP: ML routinely tags one attribute both ways — GENDER
 * on `MLB-T_SHIRTS` carries `grid_template_required` AND `grid_filter`. Merging
 * here, once, is what keeps the render and the payload from drifting apart;
 * concatenating produced two form fields with the same React key ("Encountered
 * two children with the same key, `GENDER`") and sent the attribute twice.
 *
 * `gridSpecs` is null until every template is answered, so until then the result
 * is the templates alone.
 */
export function chartLevelAttributes(
  domainSpecs: unknown,
  gridSpecs: unknown,
): GridTemplateAttribute[] {
  const domainById = attributesById(domainSpecs);
  const byId = new Map<string, GridTemplateAttribute>();
  // Templates first, so the questions ML *demands* lead the form.
  for (const attr of extractGridTemplates(domainSpecs)) byId.set(attr.id, attr);
  for (const filter of extractChartAttributes(gridSpecs)) {
    // A template entry wins over the bare domain attribute (its `required` is
    // what gates the grid fetch); either beats the grid spec's own echo.
    const known = byId.get(filter.id) ?? domainById.get(filter.id);
    if (known == null) {
      byId.set(filter.id, filter);
      continue;
    }
    byId.set(filter.id, {
      ...known,
      name: known.name !== '' ? known.name : filter.name,
      values: known.values.length > 0 ? known.values : filter.values,
      // ML marks BRAND `required` on the grid spec only; a template is always
      // required, so OR-ing can never relax one.
      required: known.required || filter.required,
    });
  }
  return [...byId.values()];
}

/**
 * Which measure types the domain supports, from the `BODY_MEASURE` /
 * `CLOTHING_MEASURE` tags on its columns (the legacy screen read exactly these).
 * Empty ⇒ the domain has no measure-type concept (footwear) and `measure_type`
 * must be omitted from the create body entirely.
 *
 * ⚠️ `MIXED_MEASURE` is NOT offered even though ML supports it: the live
 * Flutter reader's `TipoTabelaDeMedidasML.fromJson` throws on an unknown value,
 * so writing one would crash it during the dual-run.
 */
export function detectMeasureTypes(specs: unknown): ChartMeasureType[] {
  const attrs = collectAttributes(specs);
  const out: ChartMeasureType[] = [];
  if (attrs.some((a) => hasTag(a, 'BODY_MEASURE'))) out.push('BODY_MEASURE');
  if (attrs.some((a) => hasTag(a, 'CLOTHING_MEASURE'))) out.push('CLOTHING_MEASURE');
  return out;
}

/**
 * The attributes eligible as the chart's main attribute. ML requires at least
 * one, and it is what the listing's picker shows. Apparel domains answer
 * `['SIZE']`; footwear answers several (`MANUFACTURER_SIZE`, `EU_SIZE`, …),
 * which is why the MVP — hardcoded to synthesise SIZE — could not create a
 * footwear chart at all.
 */
export function mainAttributeCandidates(specs: unknown): ChartSpecValue[] {
  return collectAttributes(specs)
    .filter((a) => hasTag(a, 'main_attribute_candidate'))
    .map((a) => ({ id: str(a.id) ?? '', name: str(a.name) ?? str(a.id) ?? '' }))
    .filter((c) => c.id !== '');
}

/**
 * How a unit reads in a picker.
 *
 * ⚠️ ML's id AND name for INCHES is the bare double-quote character:
 * `units: [{id: '"', name: '"'}, {id: 'cm', name: 'cm'}]`. That is real data,
 * not a null or an empty string — but on its own it renders as two barely
 * visible tick marks that look like a blank option, so it gets spelled out.
 *
 * The VALUE is untouched: `"` is what ML expects in `unit_id`, and the backend
 * folds it into the value name (`'36 "'`) and `struct.unit`. Filtering the unit
 * out would drop a measurement system sellers legitimately use.
 */
export function unitLabel(unitId: string): string {
  return unitId === '"' ? 'pol. (")' : unitId;
}

/** ML's per-chart row cap (`ui_config.max_allowed` on the GRID), or null. */
export function maxRows(specs: unknown): number | null {
  let found: number | null = null;
  const visit = (node: unknown): void => {
    if (found != null || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as RawComponent & Record<string, unknown>;
    if (obj.component === 'GRID' && isRecord(obj.ui_config)) {
      const max = obj.ui_config.max_allowed;
      if (typeof max === 'number' && Number.isFinite(max) && max > 0) {
        found = max;
        return;
      }
    }
    for (const key of ['input', 'groups', 'components'] as const) {
      if (key in obj) visit(obj[key]);
    }
  };
  visit(specs);
  return found;
}

/* -------------------------------- columns -------------------------------- */

/** Which control an attribute's `value_type` maps to. */
function cellKind(attr: RawAttribute): ChartCellKind {
  switch (attr.value_type) {
    case 'list':
      return hasTag(attr, 'multivalued') ? 'multiselect' : 'select';
    case 'number':
    case 'number_unit':
      return 'number';
    default:
      // `string`, and anything ML introduces later. Free text always accepts
      // what the operator types, so an unknown type degrades safely.
      return 'text';
  }
}

function unitOf(
  component: RawComponent,
  attr: RawAttribute,
): { default: string | null; options: ChartSpecValue[] } {
  const options = toSpecValues(attr.units ?? component.unified_units);
  const fallback = str(attr.default_unit_id) ?? str(component.default_unified_unit_id);
  return { default: fallback ?? options[0]?.id ?? null, options };
}

/**
 * The columns for a chosen measure type.
 *
 * Dropped on purpose:
 *  - `TEXT_OUTPUT` components — the chart-level GENDER/BRAND echo, not columns
 *    (the legacy `getColunas` skipped them by the same rule);
 *  - `hidden` / `read_only` attributes — ML computes them (`FILTRABLE_SIZE`);
 *  - `grid_filter` attributes — they belong to the chart, not the rows;
 *  - measure columns tagged for the OTHER measure type; ML rejects a mismatched
 *    one with `invalid_row_attribute`, and a chart carries exactly one type.
 *
 * An unrecognised component id becomes a plain text column rather than an
 * exception (legacy threw and blanked the grid).
 */
export function extractColumns(
  specs: unknown,
  measureType: ChartMeasureType | null,
): ChartColumn[] {
  const columns: ChartColumn[] = [];

  for (const component of collectGridComponents(specs)) {
    if (component.component === 'TEXT_OUTPUT') continue;

    const rawAttrs = Array.isArray(component.attributes)
      ? component.attributes.filter(isRecord).map((a) => a as RawAttribute)
      : [];

    const usable = rawAttrs.filter((a) => {
      if (str(a.id) == null) return false;
      if (hasTag(a, 'hidden') || hasTag(a, 'read_only')) return false;
      if (hasTag(a, 'grid_filter')) return false;
      const body = hasTag(a, 'BODY_MEASURE');
      const clothing = hasTag(a, 'CLOTHING_MEASURE');
      if (!body && !clothing) return true;
      if (measureType == null) return true;
      return measureType === 'BODY_MEASURE' ? body : clothing;
    });
    if (usable.length === 0) continue;

    const first = usable[0]!;
    const uiConfig = isRecord(component.ui_config) ? component.ui_config : {};
    const parts: ChartColumnPart[] = usable.map((a) => ({
      attributeId: str(a.id)!,
      label: str(a.name) ?? str(a.id)!,
      kind: cellKind(a),
      values: toSpecValues(a.values),
    }));

    columns.push({
      key: parts[0]!.attributeId,
      // The component's own label names the PAIR ("Contorno do peito"); an
      // attribute label would read "…de" / "…até" on its own.
      label: str(component.label) ?? parts[0]!.label,
      hint: str(uiConfig.hint),
      required: usable.some((a) => hasTag(a, 'required')),
      mainCandidate: usable.some((a) => hasTag(a, 'main_attribute_candidate')),
      unit: unitOf(component, first),
      connector: parts.length > 1 ? (str(uiConfig.connector) ?? '–') : null,
      parts,
    });
  }

  return columns;
}

/** Every attribute id a column writes — the key set for cell errors. */
export function columnAttributeIds(column: ChartColumn): string[] {
  return column.parts.map((p) => p.attributeId);
}

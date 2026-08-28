/**
 * Row and cell logic for the size-chart grid — the bridge between the columns
 * `chartSpec.ts` derives and the stored wire shape (`mlSizeChartRowSchema`).
 * No React and no IO, so every rule below is unit-testable on its own.
 *
 * The stored shape is the legacy Flutter one and stays that way: a row is
 * `{varianteUid, id, attributes: [{id, value_id?, value_name?, unit_id?, valueList?}]}`.
 * The editor works on a keyed `cells` map instead, because a grid indexes by
 * (row, column) and scanning an array per cell render does not.
 */
import type { MlSizeChart, MlSizeChartRow, Variante } from '@delfrance/schemas';
import { varianteFakePath } from '@delfrance/schemas';
import { normalizeLoose } from '@delfrance/ai';
import { localizarDecimal } from '@delfrance/core/decimal';

import type { ChartCellKind, ChartColumn, ChartSpecValue } from './chartSpec';

/** ML's chart-name limit, and the charset it accepts. */
export const CHART_NAME_MAX = 60;

/** One cell's value. `valueList` is only used by a multivalued list column. */
export interface ChartCellValue {
  value_id: string | null;
  value_name: string | null;
  valueList: ChartSpecValue[] | null;
}

/** One editable row. `key` is stable across edits so React never remounts inputs. */
export interface ChartRowDraft {
  key: string;
  /** Fake path of the Variante this row measures — the publish-time join. */
  varianteUid: string | null;
  /** FULL ML row id (`'<chartId>:<n>'`); null while the row has never been sent. */
  id: string | null;
  /** Values by attribute id. */
  cells: Record<string, ChartCellValue>;
  /** Staged for removal — only ever settable on a row ML has not seen. */
  deleted: boolean;
}

export const EMPTY_CELL: ChartCellValue = { value_id: null, value_name: null, valueList: null };

/** A cell counts as filled when it carries any value form. */
export function isFilled(cell: ChartCellValue | undefined): boolean {
  if (!cell) return false;
  if (cell.value_id != null && cell.value_id !== '') return true;
  if (cell.valueList != null && cell.valueList.length > 0) return true;
  return typeof cell.value_name === 'string' && cell.value_name.trim().length > 0;
}

/* ------------------------------- seeding --------------------------------- */

function cellFromAttribute(attr: Record<string, unknown>, kind: ChartCellKind): ChartCellValue {
  const rawList = attr.valueList;
  const valueList = Array.isArray(rawList)
    ? rawList
        .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
        .map((v) => ({
          id: typeof v.value_id === 'string' ? v.value_id : '',
          name: typeof v.value_name === 'string' ? v.value_name : '',
        }))
        .filter((v) => v.id !== '' || v.name !== '')
    : null;
  const name = typeof attr.value_name === 'string' ? attr.value_name : null;
  return {
    value_id: typeof attr.value_id === 'string' ? attr.value_id : null,
    // A measurement stored with a dot renders with a comma, like every other
    // number in this ERP and like every cell the operator types. Charts written
    // before the AI localised its own answers hold both spellings, so the grid
    // showed `10.5` on one row and `10,5` on the next.
    //
    // ⚠️ This DOES change the draft, so `rowNeedsSend` would see every legacy
    // row as modified and re-PUT the whole guia on the next "Enviar". That is
    // why `rowDiffShape` (apps/mercado-livre) compares numeric value names by
    // their parsed value — a separator-only difference is not a change.
    value_name: kind === 'number' && name != null ? localizarDecimal(name) : name,
    valueList: valueList && valueList.length > 0 ? valueList : null,
  };
}

/**
 * Editable rows for a stored chart. Attributes the current columns no longer
 * mention are dropped on purpose: the columns come from the domain's live ficha
 * técnica, and re-sending an attribute ML has retired earns an
 * `invalid_row_attribute`.
 */
export function seedRows(chart: MlSizeChart | null, columns: ChartColumn[]): ChartRowDraft[] {
  // The kind, not just the id: a stored `value_name` is localised only on a
  // numeric part, so the map has to carry it.
  const known = new Map(columns.flatMap((c) => c.parts.map((p) => [p.attributeId, p.kind])));
  return (chart?.rows ?? []).map((row, index) => {
    const cells: Record<string, ChartCellValue> = {};
    for (const attr of row.attributes ?? []) {
      const kind = known.get(attr.id);
      if (kind == null) continue;
      cells[attr.id] = cellFromAttribute(attr as unknown as Record<string, unknown>, kind);
    }
    return {
      key: row.id ?? row.varianteUid ?? `row-${String(index)}`,
      varianteUid: row.varianteUid ?? null,
      id: row.id ?? null,
      cells,
      deleted: false,
    };
  });
}

/**
 * One row per size variante, with the main attribute seeded from the variante's
 * nome and every measurement left blank for the operator.
 *
 * `varianteUid` is what binds the row to the variation at publish time
 * (`findChartRow` matches on the last path segment), so it is not optional.
 */
export function rowsFromVariantes(
  grupoId: string,
  variantes: readonly Variante[],
  mainAttributeId: string,
): ChartRowDraft[] {
  return variantes.map((v) => ({
    key: varianteFakePath(grupoId, v.id),
    varianteUid: varianteFakePath(grupoId, v.id),
    id: null,
    cells: { [mainAttributeId]: { value_id: null, value_name: v.nome, valueList: null } },
    deleted: false,
  }));
}

/**
 * Pre-select the size-equivalence cell whose ML option NAME is the row's own
 * size label — a guia whose rows read `38`, `40`, `42` against a standard list
 * holding `38`, `40`, `42` is the common case, and asking the operator (or a
 * model, or a round trip to ML) to restate it is pure friction.
 *
 * ⚠️ **Exact match only**, under the same fold `resolveChartAttributeValue` uses
 * (trim, case, diacritics). Never a prefix, never a numeric near-miss: `4`
 * matching `40` or `M` matching `MEDIUM` would write a size the operator never
 * chose onto a listing's size filter, and a wrong equivalence is worse than an
 * empty one — the empty one is what ML's own validation catches.
 *
 * ⚠️ **Only ever fills an EMPTY cell.** A stored value always wins, so opening a
 * healthy guia cannot dirty its rows and trigger a needless row PUT; the only
 * charts this touches are the ones already missing the value ML requires.
 */
export function prefillSizeEquivalence(
  rows: readonly ChartRowDraft[],
  columns: readonly ChartColumn[],
  mainAttributeId: string,
): ChartRowDraft[] {
  const targets = columns
    .filter((c) => c.sizeEquivalence)
    .flatMap((c) => c.parts)
    .filter((p) => p.values.length > 0);
  if (targets.length === 0) return [...rows];

  return rows.map((row) => {
    const label = row.cells[mainAttributeId]?.value_name;
    if (label == null || label.trim() === '') return row;
    const wanted = normalizeLoose(label);

    let cells: Record<string, ChartCellValue> | null = null;
    for (const part of targets) {
      if (isFilled(row.cells[part.attributeId])) continue;
      const match = part.values.find((v) => normalizeLoose(v.name) === wanted);
      if (!match) continue;
      cells ??= { ...row.cells };
      // A `select` reads `value_id`, a `multiselect` reads `valueList` — write
      // the shape the column's own widget renders, or the cell looks empty while
      // still shipping to ML (the trap `aiCellValue` documents).
      cells[part.attributeId] =
        part.kind === 'multiselect'
          ? { value_id: null, value_name: null, valueList: [match] }
          : { value_id: match.id, value_name: match.name, valueList: null };
    }
    return cells == null ? row : { ...row, cells };
  });
}

/** The column unit each measurement column starts on. */
export function seedUnits(
  columns: ChartColumn[],
  chart: MlSizeChart | null,
): Record<string, string | null> {
  const stored = new Map<string, string>();
  for (const row of chart?.rows ?? []) {
    for (const attr of row.attributes ?? []) {
      if (typeof attr.unit_id === 'string' && attr.unit_id !== '' && !stored.has(attr.id)) {
        stored.set(attr.id, attr.unit_id);
      }
    }
  }
  const out: Record<string, string | null> = {};
  for (const column of columns) {
    out[column.key] = stored.get(column.key) ?? column.unit.default;
  }
  return out;
}

/* ------------------------------- writing --------------------------------- */

/**
 * The stored `attributes` array for one row. Empty cells are omitted entirely
 * (ML validates presence, not emptiness), and `unit_id` rides only on numeric
 * parts of a column that actually has a unit — the backend folds it into the
 * value name and derives ML's `struct` from the pair.
 */
export function toWireAttributes(
  row: ChartRowDraft,
  columns: ChartColumn[],
  units: Record<string, string | null>,
): NonNullable<MlSizeChartRow['attributes']> {
  const out: NonNullable<MlSizeChartRow['attributes']> = [];
  for (const column of columns) {
    const unit = units[column.key] ?? null;
    for (const part of column.parts) {
      const cell = row.cells[part.attributeId];
      if (!isFilled(cell)) continue;
      const useUnit = part.kind === 'number' && unit != null && unit !== '';
      out.push({
        id: part.attributeId,
        ...(cell!.value_id != null ? { value_id: cell!.value_id } : {}),
        ...(cell!.value_name != null ? { value_name: cell!.value_name } : {}),
        ...(useUnit ? { unit_id: unit } : {}),
        ...(cell!.valueList != null
          ? {
              valueList: cell!.valueList.map((v) => ({ value_id: v.id, value_name: v.name })),
            }
          : {}),
      } as NonNullable<MlSizeChartRow['attributes']>[number]);
    }
  }
  return out;
}

/**
 * Assemble the chart to submit. Rows staged for deletion are dropped here —
 * only ever rows without an ML id, since ML cannot delete a row it has seen.
 * `sizeCalculado` rides through untouched: it is ML's own computed value and
 * the sync excludes it from the row diff.
 */
export function toChartRows(
  rows: readonly ChartRowDraft[],
  columns: ChartColumn[],
  units: Record<string, string | null>,
  stored: MlSizeChart | null,
): MlSizeChartRow[] {
  const cachedSizes = new Map<string, MlSizeChartRow['sizeCalculado']>();
  for (const row of stored?.rows ?? []) {
    if (row.id != null && row.sizeCalculado != null) cachedSizes.set(row.id, row.sizeCalculado);
  }
  return rows
    .filter((r) => !r.deleted)
    .map((r) => {
      const cached = r.id == null ? undefined : cachedSizes.get(r.id);
      return {
        varianteUid: r.varianteUid,
        id: r.id,
        attributes: toWireAttributes(r, columns, units),
        ...(cached != null ? { sizeCalculado: cached } : {}),
      };
    });
}

/* ------------------------------ duplication ------------------------------ */

/**
 * A fresh, unsent copy of a chart — the ONLY way to change something ML froze
 * (gender, domain, measure type, a row's size). The legacy screen's *Copiar*
 * button existed for exactly this reason and used the same `(Cópia)` prefix.
 *
 * The chart id and every row id are nulled: the chart id alone decides
 * create-vs-PATCH in `syncSizeCharts`, so keeping it would make the copy edit
 * the ORIGINAL chart. Both ERP-only caches go too, since they describe the
 * original's state on ML.
 *
 * `main_attribute_id` is deliberately KEPT — it is the operator's column choice,
 * not an ML-assigned identity, and a copy should measure the same way.
 */
export function duplicateChart(chart: MlSizeChart): MlSizeChart {
  const prefix = '(Cópia) ';
  const base = (chart.nome ?? '').trim();
  return {
    ...chart,
    id: null,
    main_attribute_id: chart.main_attribute_id ?? null,
    nome: `${prefix}${base}`.slice(0, CHART_NAME_MAX).trim(),
    exclusaoSolicitadaEm: null,
    rows: (chart.rows ?? []).map((r) => ({
      varianteUid: r.varianteUid ?? null,
      id: null,
      attributes: r.attributes ?? [],
      sizeCalculado: null,
    })),
  };
}

/**
 * Is `candidate` still the guia the operator acted on?
 *
 * Guias live in a positional ARRAY that three writers touch (this editor, the
 * sync backend, the Flutter app), so **an index is not an identity**: an insert
 * or a reorder makes position N point at a different chart, and acting on it
 * would edit or delete the wrong one. A sent guia is keyed by its ML id; a
 * draft has none, so its name + domain is the best key available.
 *
 * ⚠️ Compare against the chart the editor OPENED with, never the edited value —
 * a draft being renamed would otherwise look like a different guia.
 */
export function sameChart(candidate: MlSizeChart | undefined, original: MlSizeChart): boolean {
  if (candidate == null) return false;
  const candidateId = candidate.id ?? '';
  const originalId = original.id ?? '';
  if (candidateId !== '' || originalId !== '') return candidateId === originalId;
  return (
    (candidate.nome ?? '') === (original.nome ?? '') &&
    (candidate.domain_id ?? '') === (original.domain_id ?? '')
  );
}

/* -------------------------------- errors --------------------------------- */

/** Key for one cell in the error index. */
export function cellErrorKey(rowIndex: number, attributeId: string): string {
  return `${String(rowIndex)}:${attributeId}`;
}

/** One validation problem as the editor consumes it. */
export interface ChartCellErrors {
  /** Messages per `cellErrorKey`. */
  byCell: Map<string, string[]>;
  /** Messages with no cell to pin them to (a rejected name, a bad main attribute). */
  chartLevel: string[];
  /** True when at least one problem mentions the chart's NAME specifically. */
  nameRejected: boolean;
}

/** ML codes that are about the chart's name, so the name input owns them. */
const NAME_CODES = new Set(['chart_name_unavailable']);

/**
 * ML's chart-validation rejection, as an instruction the operator can act on.
 *
 * Every message ML sends here is English prose naming raw attribute ids
 * ("Attribute MODEL found in chart's attributes is not valid …"), which tells a
 * seller nothing. These are the codes documented on `validacao-tabela-de-medidas`.
 *
 * ⚠️ An unrecognised code falls through to ML's own text VERBATIM. ML adds
 * validations unilaterally, and an English message beats a swallowed one.
 */
export function describeChartValidationError(problem: {
  code: string | null;
  message: string | null;
  attributeIds: string[];
}): string {
  const raw = problem.message ?? problem.code ?? 'Erro de validação';
  const attrs = problem.attributeIds.length > 0 ? problem.attributeIds.join(' e ') : null;

  // ⚠️ Matched on the MESSAGE, not the code: this rejection is absent from ML's
  // docs (the documented row analogue is `invalid_row_attribute`) so its code is
  // unverified. The advice hedges on purpose — `chartLevelAttributes` no longer
  // OFFERS an attribute outside the grid spec, so the usual case is that the
  // field is already gone and a plain re-send is the whole fix; but ML can reject
  // one the grid spec DID declare, and then there is a value to clear.
  const general = /attribute\s+([A-Z0-9_]+)\s+found in (?:the )?chart'?s attributes/i.exec(raw);
  if (general) {
    return `O Mercado Livre não aceita o atributo ${general[1]!} nos atributos gerais desta guia. Apague esse valor no formulário (se ele ainda aparecer) e envie a guia novamente.`;
  }

  switch (problem.code) {
    case 'chart_name_unavailable':
      return 'Já existe uma guia com esse nome nesta conta. Escolha outro nome.';
    case 'main_attribute_missing_error':
      return 'Escolha o tamanho principal da guia.';
    case 'invalid_main_attribute_id':
      return 'O tamanho principal escolhido não vale neste domínio. Selecione outro em "Tamanho principal".';
    case 'chart_tech_specs_not_found':
      return 'O Mercado Livre não tem tabela de medidas para este domínio com o gênero escolhido. Revise o domínio e o gênero.';
    case 'required_row_attribute_not_found':
      return attrs == null
        ? 'Faltam medidas obrigatórias nesta linha.'
        : `Preencha ${attrs} nesta linha.`;
    case 'invalid_row_attribute_value':
      return attrs == null
        ? 'O valor informado não é aceito pelo Mercado Livre.'
        : `O valor informado em ${attrs} não é aceito pelo Mercado Livre.`;
    case 'invalid_row_attribute':
      return attrs == null
        ? 'Esta medida não pertence ao tipo de medida da guia.'
        : `${attrs} não pertence ao tipo de medida desta guia. Troque o tipo de medida ou deixe a coluna vazia.`;
    case 'duplicated_measure_value':
      return attrs == null
        ? 'Outra linha da guia já usa esse valor.'
        : `Outra linha da guia já usa esse mesmo valor em ${attrs}.`;
    case 'invalid_attribute_value':
      return 'O tamanho só pode conter palavras relacionadas a tamanho — nada de gênero, cor ou material.';
    case 'value_is_not_the_same_type':
      return 'Os tamanhos padrão precisam ser todos numéricos ou todos alfanuméricos, nunca misturados.';
    case 'value_out_of_range': {
      // ML's own text is the only place the accepted bounds appear, so they are
      // lifted out rather than thrown away with the rest of the English.
      const range = /range:\s*(.+?)\s*$/.exec(raw)?.[1] ?? null;
      const subject = attrs == null ? 'O valor' : `O valor de ${attrs}`;
      return range == null
        ? `${subject} está fora do intervalo aceito pelo Mercado Livre.`
        : `${subject} está fora do intervalo aceito pelo Mercado Livre (${range}).`;
    }
    // `code` is `string | null`, so `null` is a member the exhaustiveness check
    // wants named. It falls into the same branch `default` already handled — an
    // unrecognised (or absent) code shows ML's own text.
    case null:
    default:
      return raw;
  }
}

/**
 * Index one chart's validation errors for the grid.
 *
 * A problem whose row could not be resolved deliberately lands at chart level
 * rather than on a guessed cell: the legacy screen pinned by row VALUE, and a
 * size renamed between sends would otherwise light up the wrong row.
 *
 * ⚠️ `rendered` is the set of attribute ids the grid actually draws, and passing
 * it is not optional politeness — an error pinned to a cell that does not exist
 * is INVISIBLE. `FILTRABLE_SIZE` was dropped from the columns for months, so
 * every row of an apparel guia came back
 * `required_row_attribute_not_found`, landed in `byCell` under a key no
 * `PartInput` ever looked up, and the operator got "veja os campos destacados"
 * over a grid with nothing highlighted. ML adds required row attributes
 * unilaterally, so the next one must degrade to a readable chart-level message
 * instead of the same dead end.
 */
export function indexCellErrors(
  errors: ReadonlyArray<{
    chartIndex: number;
    code: string | null;
    message: string | null;
    rowIndex: number | null;
    attributeIds: string[];
    rowMainValue: string | null;
  }>,
  chartIndex: number,
  rendered?: ReadonlySet<string>,
): ChartCellErrors {
  const byCell = new Map<string, string[]>();
  const chartLevel: string[] = [];
  let nameRejected = false;

  // Keep the row ML named, if any — "linha M" beats an unplaceable message.
  const atChartLevel = (text: string, rowMainValue: string | null): void => {
    chartLevel.push(rowMainValue == null ? text : `${rowMainValue}: ${text}`);
  };

  for (const err of errors) {
    if (err.chartIndex !== chartIndex) continue;
    const text = describeChartValidationError(err);
    if (err.code != null && NAME_CODES.has(err.code)) {
      nameRejected = true;
      chartLevel.push(text);
      continue;
    }
    if (err.rowIndex == null || err.attributeIds.length === 0) {
      atChartLevel(text, err.rowMainValue);
      continue;
    }
    // An id the grid does not draw cannot carry its own message. Undefined
    // `rendered` means "the caller has no column list yet" — pin as before
    // rather than dumping every error into the banner.
    const placeable =
      rendered == null ? err.attributeIds : err.attributeIds.filter((id) => rendered.has(id));
    if (placeable.length === 0) {
      atChartLevel(text, err.rowMainValue);
      continue;
    }
    for (const attributeId of placeable) {
      const key = cellErrorKey(err.rowIndex, attributeId);
      const list = byCell.get(key) ?? [];
      list.push(text);
      byCell.set(key, list);
    }
  }

  return { byCell, chartLevel, nameRejected };
}

/* ------------------------------ name rules ------------------------------- */

/**
 * ML's rule for `names`: at most 60 characters, "não aceita caracteres
 * especiais como `(`, `)` nem `-`. Use apenas letras, números e espaços."
 * Returns the problem, or null when the name is acceptable.
 *
 * ⚠️ This is why `duplicateChart` cannot simply keep `(Cópia)` in the SENT
 * name — the operator has to clean it up, and telling them here beats an
 * opaque ML rejection after the round trip.
 */
export function validateChartName(nome: string): string | null {
  const trimmed = nome.trim();
  if (trimmed.length === 0) return 'Informe o nome da guia.';
  if (trimmed.length > CHART_NAME_MAX) {
    return `O nome deve ter no máximo ${String(CHART_NAME_MAX)} caracteres.`;
  }
  if (/[^\p{L}\p{N} ]/u.test(trimmed)) {
    return 'O Mercado Livre aceita apenas letras, números e espaços no nome da guia.';
  }
  return null;
}

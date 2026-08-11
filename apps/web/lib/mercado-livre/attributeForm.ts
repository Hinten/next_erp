/**
 * Pure form logic for the Mercado Livre attribute editor.
 *
 * The server already decided WHICH attributes exist and in what order
 * (`GET /categorias/atributos` → `projectCategoriaAtributos`); this module owns
 * what happens once they are on screen: which control renders, how the N/A
 * sentinel round-trips, what counts as filled, and — the part most likely to go
 * wrong — which stored attributes survive a save.
 *
 * No React and no IO, so every rule below is unit-testable on its own.
 */
import type { MercadoLivreCategoriaAtributo } from './client';

/** One attribute row in form state. */
export interface AttrRow {
  id: string;
  /** ML's enumerated value id, or the `-1` N/A sentinel, or null for free text. */
  value_id: string | null;
  value_name: string | null;
  unit_id: string | null;
}

/** The stored wire shape on `produtoMercadoLivreLink.attributes`. */
export interface AttrWire {
  id: string;
  value_id?: string | null;
  value_name?: string | null;
  unit_id?: string | null;
  name?: string | null;
}

/**
 * ML's "does not apply" marker. An operator picks it to say a required
 * attribute genuinely has no value for this product, and it satisfies the
 * required check — otherwise a listing with, say, no model number could never
 * be published.
 */
export const NA_VALUE_ID = '-1';

/**
 * The legacy screen was inconsistent here: the TEXT widget saved
 * `value_name: 'N/A'` (`cadastroProdutoMLNew.dart:1214`) while the DROPDOWN
 * saved `value_name: null` (`:1319`). Both readers only ever tested
 * `value_id === '-1'` (`:1099`), so nothing depended on the difference — we
 * standardise on the labelled form so the stored doc reads sensibly.
 */
export function naRow(id: string): AttrRow {
  return { id, value_id: NA_VALUE_ID, value_name: 'N/A', unit_id: null };
}

export function isNaRow(row: Pick<AttrRow, 'value_id'>): boolean {
  return row.value_id === NA_VALUE_ID;
}

/** Which control an attribute renders as (`cadastroProdutoMLNew.dart:1179-1384`). */
export type AttrWidgetKind = 'text' | 'select' | 'multiselect' | 'unsupported';

export function widgetKind(attr: MercadoLivreCategoriaAtributo): AttrWidgetKind {
  switch (attr.valueType) {
    case 'string':
    case 'number':
    case 'number_unit':
      // Free text WITH suggestions: ML often ships known values for these but
      // still accepts anything, so a hard Select would block legitimate input.
      return 'text';
    case 'boolean':
      return 'select';
    case 'list':
      return attr.multivalued ? 'multiselect' : 'select';
    default:
      return 'unsupported';
  }
}

/** `number` and `number_unit` accept digits only (`:1283-1286`). */
export function isNumericAttr(attr: MercadoLivreCategoriaAtributo): boolean {
  return attr.valueType === 'number' || attr.valueType === 'number_unit';
}

/** A row carries a value when it is N/A or has any non-blank content. */
export function isFilled(row: Pick<AttrRow, 'value_id' | 'value_name'>): boolean {
  if (isNaRow(row)) return true;
  if (row.value_id != null && row.value_id !== '') return true;
  return typeof row.value_name === 'string' && row.value_name.trim().length > 0;
}

/** Validation message for one attribute, or null when it passes. */
export function validateAttr(
  attr: MercadoLivreCategoriaAtributo,
  row: Pick<AttrRow, 'value_id' | 'value_name'> | undefined,
): string | null {
  if (!attr.required) return null;
  if (row && isFilled(row)) return null;
  return 'Este campo é obrigatório';
}

/** Seed a form row from the stored wire value (or an empty one). */
export function seedRow(
  attr: MercadoLivreCategoriaAtributo,
  stored: AttrWire | undefined,
): AttrRow {
  if (!stored) return { id: attr.id, value_id: null, value_name: null, unit_id: null };
  return {
    id: attr.id,
    value_id: stored.value_id ?? null,
    value_name: stored.value_name ?? null,
    unit_id: stored.unit_id ?? null,
  };
}

export function seedRows(
  attrs: MercadoLivreCategoriaAtributo[],
  stored: AttrWire[] | null | undefined,
): AttrRow[] {
  const byId = new Map((stored ?? []).map((a) => [a.id, a]));
  return attrs.map((attr) => seedRow(attr, byId.get(attr.id)));
}

/**
 * Resolve what the operator typed into an ML value, matching a known option by
 * name when one exists (`cadastroProdutoMLNew.dart:1191-1211`).
 *
 * Name matching is accent- and case-insensitive. The legacy compared raw
 * strings, so `Algodao` silently fell through to free text where `Algodão` was
 * a real option — and ML then rejected the listing for an unknown value.
 */
export function resolveTypedValue(
  attr: MercadoLivreCategoriaAtributo,
  typed: string | null,
): AttrRow {
  const trimmed = (typed ?? '').trim();
  if (trimmed.length === 0) {
    return { id: attr.id, value_id: null, value_name: null, unit_id: null };
  }
  const match = attr.values.find((v) => v.name != null && normalize(v.name) === normalize(trimmed));
  if (match) {
    return { id: attr.id, value_id: match.id ?? null, value_name: match.name, unit_id: null };
  }
  return {
    id: attr.id,
    value_id: null,
    value_name: trimmed,
    // ML wants the unit alongside a bare number; the wire transform appends it.
    unit_id: attr.valueType === 'number_unit' ? attr.defaultUnit : null,
  };
}

function normalize(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Build the `attributes` array to store, from the rendered metadata, the edited
 * rows and whatever was already on the doc.
 *
 * ⚠️ **The single most dangerous function in this slice.** The rule, transcribed
 * from `deleteNonShownAttributes` (`cadastroSlim.dart:414-430`), is to iterate
 * the METADATA and drop only attributes the metadata itself says are no longer
 * shown. A stored attribute that is **absent from the metadata is PRESERVED**.
 *
 * The naive implementation — "keep only what we rendered" — deletes
 * `SIZE_GRID_ID`, which `resolveSizeChart` reads on every publish, silently
 * breaking every size-chart binding a Flutter user or an earlier publish
 * established. Blocked ids (`SELLER_SKU`, `PACKAGE_*`…) ARE in the metadata and
 * ARE dropped, deliberately: the server re-derives them from the produto.
 */
export function attributesForSave(
  attrs: MercadoLivreCategoriaAtributo[],
  rows: AttrRow[],
  stored: AttrWire[] | null | undefined,
  omitidos: Array<{ id: string }> = [],
): AttrWire[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const rendered = new Set(attrs.map((a) => a.id));
  // Only ids the metadata explicitly withheld may be pruned; anything the
  // metadata never mentioned is not ours to delete.
  const withheld = new Set(omitidos.map((o) => o.id));

  const out: AttrWire[] = [];

  for (const wire of stored ?? []) {
    if (rendered.has(wire.id) || withheld.has(wire.id)) continue; // handled below / pruned
    out.push(wire); // unknown to this category — preserve verbatim
  }

  for (const attr of attrs) {
    const row = rowById.get(attr.id);
    if (!row || !isFilled(row)) continue; // never store an empty rendered row
    out.push({
      id: attr.id,
      ...(row.value_id != null ? { value_id: row.value_id } : {}),
      ...(row.value_name != null ? { value_name: row.value_name } : {}),
      ...(row.unit_id != null ? { unit_id: row.unit_id } : {}),
    });
  }

  return out;
}

/**
 * Apply an AI suggestion set onto the current rows.
 *
 * Suggestions arrive already resolved by the server, so this only merges them
 * in — and only for ids the current metadata still renders, so a stale
 * suggestion for a category the operator has since changed is ignored
 * (`cadastroSlim.dart:390-394`).
 *
 * A previously-N/A attribute has its sentinel CLEARED when a suggestion
 * replaces it; the legacy left `value_id: '-1'` in place next to the new value,
 * which stores a contradiction.
 */
export function applySuggestions(
  attrs: MercadoLivreCategoriaAtributo[],
  rows: AttrRow[],
  suggestions: Array<Pick<AttrRow, 'id' | 'value_id' | 'value_name' | 'unit_id'>>,
  accept: (id: string) => boolean = () => true,
): AttrRow[] {
  const rendered = new Map(attrs.map((a) => [a.id, a]));
  const byId = new Map(
    suggestions.filter((s) => rendered.has(s.id) && accept(s.id)).map((s) => [s.id, s]),
  );
  return rows.map((row) => {
    const s = byId.get(row.id);
    if (!s) return row;
    return {
      id: row.id,
      value_id: s.value_id ?? null,
      value_name: s.value_name ?? null,
      unit_id: s.unit_id ?? null,
    };
  });
}

/**
 * COLOR / SIZE inside a variation block (`cadastroProdutoMLNew.dart:949-1032`).
 *
 * When the produto's own grupo de variações already supplies cor or tamanho,
 * the server derives the ML combination from it and the field must NOT be
 * rendered — a second value there is an ML combination conflict. When it does
 * not, the operator sees an inline error rather than a silently missing
 * combination.
 */
export type VariationColorSizeState = { kind: 'hide' } | { kind: 'error'; message: string };

export function variationColorSizeState(
  attributeId: string,
  gruposDaVariacao: Array<{ tipo: number | null }>,
): VariationColorSizeState | null {
  const wanted = attributeId === 'COLOR' ? 2 : attributeId === 'SIZE' ? 1 : null;
  if (wanted == null) return null; // not one of the two special ids
  if (gruposDaVariacao.some((g) => g.tipo === wanted)) return { kind: 'hide' };
  return {
    kind: 'error',
    message:
      wanted === 2
        ? 'Não foi encontrada nenhuma variação do tipo cor'
        : 'Não foi encontrada nenhuma variação do tipo tamanho',
  };
}

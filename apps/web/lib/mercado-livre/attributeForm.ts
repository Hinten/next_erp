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
import { unitLabel } from './units';

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
export type AttrWidgetKind = 'text' | 'number_unit' | 'select' | 'multiselect' | 'unsupported';

export function widgetKind(attr: MercadoLivreCategoriaAtributo): AttrWidgetKind {
  switch (attr.valueType) {
    case 'string':
    case 'number':
      // Free text WITH suggestions: ML often ships known values for these but
      // still accepts anything, so a hard Select would block legitimate input.
      return 'text';
    case 'number_unit':
      // The same free-text box PLUS the unit it is measured in. Mercado Livre
      // keeps the two apart on the wire (`value_name` + `unit_id`), and a
      // number whose unit the operator can neither see nor choose is not a
      // measurement — 355 is a very different bottle in ml than in l.
      return 'number_unit';
    case 'boolean':
      return 'select';
    case 'list':
      return attr.multivalued ? 'multiselect' : 'select';
    case null:
    default:
      return 'unsupported';
  }
}

/* ---------------------------------- units ---------------------------------- */

/** A bare number, in either decimal convention — what a unit may sit next to. */
const NUMERIC = /^-?\d+(?:[.,]\d+)?$/;

/**
 * The units an operator may pick for a `number_unit` attribute.
 *
 * ML's order is preserved: `allowed_units` is a deliberate list, and sorting it
 * would reshuffle every picker for no gain.
 *
 * ⚠️ `defaultUnit` and the row's CURRENT unit are appended when the allow-list
 * does not already carry them. Both really happen — ML ships categories whose
 * `default_unit` is absent from `allowed_units`, and a category's allow-list can
 * narrow after a listing was saved. Dropping the stored unit would leave the
 * Select showing a value it cannot offer, which reads as "the unit changed by
 * itself"; the same "never silently drop what is stored" rule
 * {@link selectOptions} applies to values.
 */
export function unitOptions(
  attr: MercadoLivreCategoriaAtributo,
  current: string | null = null,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();

  function push(id: string | null | undefined): void {
    const value = (id ?? '').trim();
    // ⚠️ Deduped case-INSENSITIVELY, and `allowedUnits` is pushed first so the
    // category taxonomy's spelling is the one that survives. Mercado Livre does
    // not guarantee that `value_struct.unit` matches the casing of the same
    // unit's `allowed_units` id, and `mL` sitting next to `ml` is two picker
    // entries for one unit. `effectiveUnit` answers in this same spelling, so
    // what the Select is handed is always one of its own options.
    const key = value.toLowerCase();
    if (value === '' || seen.has(key)) return;
    seen.add(key);
    // `unitLabel`, not ML's `name`: for INCHES both are the bare `"` character,
    // which renders as a blank-looking option.
    out.push({ value, label: unitLabel(value) });
  }

  // ⚠️ `?? []` despite the type saying otherwise. This object crossed an HTTP
  // boundary, so the annotation is an assertion rather than a guarantee, and
  // `allowedUnits` is the one field no code path read before this change — a
  // response that predates it, or any ML drift, would otherwise throw here and
  // blank the WHOLE attribute grid over a unit. Same degrade-never-throw rule
  // the rest of the ML metadata layer follows.
  for (const u of attr.allowedUnits ?? []) push(u.id);
  push(attr.defaultUnit);
  push(current);
  return out;
}

/**
 * The unit a row is measured in: what it stores, else the category default,
 * else the only unit on offer.
 *
 * Never null for an attribute ML gave any unit at all, which is what lets the
 * field render one without first making the operator choose.
 */
export function effectiveUnit(
  attr: MercadoLivreCategoriaAtributo,
  row: Pick<AttrRow, 'unit_id'> | undefined,
): string | null {
  const options = unitOptions(attr, row?.unit_id ?? null);
  const wanted = (row?.unit_id ?? '').trim() || (attr.defaultUnit ?? '').trim();
  if (wanted !== '') {
    // ⚠️ Return the OPTION's spelling, not the one that was asked for. A Mantine
    // `Select` handed a value absent from its `data` renders blank, so a stored
    // `mL` against an allow-list of `ml` would empty the picker — and leave the
    // row disagreeing with the screen, which is what makes the next blur report
    // an edit nobody made. `unitOptions` pushes both the stored unit and
    // `defaultUnit`, so the fallback below is unreachable in practice and only
    // keeps this total.
    return options.find((u) => u.value.toLowerCase() === wanted.toLowerCase())?.value ?? wanted;
  }
  return options[0]?.value ?? null;
}

/**
 * Split a value that carries its own unit — `'355 mL'` → `355` + `mL`.
 *
 * ⚠️ This exists because Mercado Livre answers `GET /items` with the unit baked
 * INTO the value name and **no `unit_id`** (the pair lives in `value_struct`),
 * so every imported or Flutter-written listing stores it that way. See
 * {@link seedRow} for what goes wrong when it is left whole.
 *
 * Only a unit the category actually knows is recognised, matched
 * case-insensitively but returned in ML's own casing (`mL`, never the `ml` the
 * operator typed), and **longest first** so `mm` wins over `m` on `'55 mm'`.
 * Anything else is left alone: the head must be a bare number, so a value this
 * cannot classify degrades to exactly the old behaviour rather than being
 * guessed at.
 */
export function splitNumberUnit(
  attr: MercadoLivreCategoriaAtributo,
  valueName: string | null,
): { value: string; unit: string | null } {
  const raw = (valueName ?? '').trim();
  if (raw === '') return { value: raw, unit: null };

  const units = unitOptions(attr)
    .map((u) => u.value)
    .sort((a, b) => b.length - a.length);
  const lower = raw.toLowerCase();

  for (const unit of units) {
    if (!lower.endsWith(unit.toLowerCase())) continue;
    const head = raw.slice(0, raw.length - unit.length).trim();
    if (!NUMERIC.test(head)) continue;
    return { value: head, unit };
  }
  return { value: raw, unit: null };
}

/**
 * A unit only ever rides on a `number_unit`. Passing one for a `string` or
 * `list` attribute is ignored rather than trusted, so a caller cannot poison a
 * row that has no measurement in it.
 */
function unitFor(attr: MercadoLivreCategoriaAtributo, unitId: string | null): string | null {
  return attr.valueType === 'number_unit' ? unitId : null;
}

/**
 * Suggestions for a `number_unit`'s number box, on the unit currently selected.
 *
 * The box holds a bare number now, so ML's own `'355 mL'` values cannot be
 * offered as they are. ⚠️ And a value on ANOTHER unit is not a suggestion at
 * all: offering the `1` from `'1 L'` while the box reads millilitres would put a
 * 1000× error one click away.
 */
export function numberUnitOptions(
  attr: MercadoLivreCategoriaAtributo,
  unitId: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const v of attr.values) {
    const name = (v.name ?? '').trim();
    if (name === '') continue;
    const split = splitNumberUnit(attr, name);
    if (split.unit != null && unitId != null && split.unit.toLowerCase() !== unitId.toLowerCase()) {
      continue;
    }
    if (seen.has(split.value)) continue;
    seen.add(split.value);
    out.push(split.value);
  }
  return out;
}

/**
 * Options for an enumerated attribute, keyed by ML's value id.
 *
 * A value ML ships without an id falls back to its own name as the key — the
 * alternative is dropping the option entirely, and an option the operator can
 * see but not choose is worse than one stored by name.
 *
 * ⚠️ That fallback makes two entries able to claim the same key: a value whose
 * NAME happens to equal another value's real ML **id**. Unlikely with ML's
 * numeric ids, but the consequence is silent — a Mantine Select with duplicate
 * values is ambiguous, and `rowFromSelect` would resolve the pick to whichever
 * came first. So keys are deduplicated here and an entry carrying a real id
 * always wins, which is the same precedence `rowFromSelect` applies.
 *
 * Source order is preserved: ML orders a category's values deliberately, and
 * sorting id-bearing entries first would reshuffle every dropdown to fix a
 * collision that almost never happens.
 */
export function selectOptions(
  attr: MercadoLivreCategoriaAtributo,
): Array<{ value: string; label: string }> {
  const byValue = new Map<string, { value: string; label: string; hasId: boolean; at: number }>();

  attr.values.forEach((v, at) => {
    const hasId = v.id != null && v.id !== '';
    const value = (v.id ?? v.name ?? '').trim();
    const label = (v.name ?? v.id ?? '').trim();
    if (value === '' || label === '') return;

    const existing = byValue.get(value);
    // Keep what is there unless this entry is strictly better: a real id
    // outranks a name-derived key. Equal rank ⇒ first one wins.
    if (existing && (existing.hasId || !hasId)) return;
    byValue.set(value, { value, label, hasId, at });
  });

  return [...byValue.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ value, label }) => ({ value, label }));
}

/**
 * The row a Select's chosen option produces.
 *
 * A Mantine `Select` reports the option **value**, so the id round-trips and
 * the name is looked back up — the reverse of the `Autocomplete` case, where
 * the reported string is the label and {@link resolveTypedValue} has to resolve
 * it. Getting these two backwards stores an id in `value_name`, which ML
 * rejects as an unknown value.
 *
 * ⚠️ Resolution is **id first, name second** — not a single `v.id ?? v.name`
 * comparison. Those differ only when one value's name equals another's real id,
 * and there the one-pass version returns whichever appears first in ML's list,
 * storing a value the operator did not pick with nothing on screen to show for
 * it. This mirrors the precedence `selectOptions` uses to key the same options.
 */
export function rowFromSelect(
  attr: MercadoLivreCategoriaAtributo,
  selected: string | null,
): AttrRow {
  if (selected == null || selected === '') {
    return { id: attr.id, value_id: null, value_name: null, unit_id: null };
  }
  const match =
    attr.values.find((v) => v.id != null && v.id !== '' && v.id === selected) ??
    attr.values.find((v) => (v.id == null || v.id === '') && v.name === selected);
  return {
    id: attr.id,
    value_id: match?.id ?? null,
    value_name: match?.name ?? selected,
    unit_id: null,
  };
}

/** The Select value that renders a stored row, or null when it holds none. */
export function selectValueOf(row: AttrRow | undefined): string | null {
  if (!row || isNaRow(row)) return null;
  return row.value_id ?? row.value_name ?? null;
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

/**
 * Seed a form row from the stored wire value (or an empty one).
 *
 * ⚠️ A `number_unit` whose unit is baked into the VALUE gets split back apart
 * here. Mercado Livre answers `GET /items` with `value_name: '355 mL'` and no
 * `unit_id` — the pair rides in `value_struct` — so every listing imported
 * before that was read, and every one the Flutter app wrote, stores it whole.
 *
 * Left whole it lands in the number box, and the first blur runs it through
 * `digitsOnly` (→ `'355'`) and stamps the category's `defaultUnit` over it. So
 * merely TABBING PAST the field restated the measurement in another unit, with
 * nothing on screen to show for it. Splitting at seed keeps the seller's own
 * unit and makes that blur a no-op, because the resolution now matches the row.
 */
export function seedRow(
  attr: MercadoLivreCategoriaAtributo,
  stored: AttrWire | undefined,
): AttrRow {
  const row: AttrRow = {
    id: attr.id,
    value_id: stored?.value_id ?? null,
    value_name: stored?.value_name ?? null,
    unit_id: stored?.unit_id ?? null,
  };
  // The N/A sentinel's `'N/A'` is a marker, not a measurement, so it carries no
  // unit — and every other value type has none to carry.
  if (attr.valueType !== 'number_unit' || isNaRow(row)) return row;

  // ⚠️ Attempted on EVERY number_unit row, never only on one whose `unit_id` is
  // null. That guard assumed "a stored unit ⇒ the value is already bare", and
  // the rows this very app wrote before the split existed break it: an imported
  // `'55 cm'` survived one save of any OTHER attribute, because
  // `resolveTypedValue` found no enumerated value named `'55 cm'` — LENGTH-style
  // measurements ship none — kept the name WHOLE and stamped `defaultUnit`
  // beside it. `{value_name: '55 cm', unit_id: 'cm'}` then folds through the
  // wire transform as `'55 cm cm'`. Skipping those is what left them that way.
  //
  // Safe to attempt unconditionally: `splitNumberUnit` fires only when the text
  // ends in a unit the category knows AND the head is a bare number, so a row
  // that is genuinely already bare finds no suffix and falls through untouched.
  const split = splitNumberUnit(attr, row.value_name);
  return {
    ...row,
    // ⚠️ A split DROPS `value_id`. On a `number_unit` that id names the PAIR —
    // ML's 3681798 *is* `'355 mL'` — and nothing downstream can reconstruct it
    // from the bare `'355'` left in the box, so a row that kept it would lose it
    // again on the first blur and report a phantom edit for it. The split row is
    // now in the same shape `draftTypedValue` produces for a typed measurement,
    // where the id is always null and ML resolves the value from its name.
    value_id: split.unit != null ? null : row.value_id,
    value_name: split.unit != null ? split.value : row.value_name,
    // ⚠️ ALWAYS a unit, even on an EMPTY row and even when nothing could be
    // split out. The field renders `effectiveUnit` whatever the row holds, so a
    // row that disagrees with what is on screen makes the very next blur resolve
    // to something different and report a change — raising unsaved changes on a
    // listing nobody edited, from a single tab keypress. Rows the operator never
    // fills are still dropped at save time by `isFilled`.
    //
    // ⚠️ The split unit OUTRANKS a stored one. `digitsOnly` makes a unit
    // untypeable, so one sitting inside `value_name` can only have come from
    // Mercado Livre or the legacy corpus — it is what the seller actually saw,
    // while a `unit_id` contradicting it is the spurious `defaultUnit` stamp
    // described above.
    //
    // Otherwise `effectiveUnit` decides, and it already means "stored, else the
    // category default, else the only unit on offer" — canonicalised to the
    // allow-list's spelling, which is what keeps the row equal to the picker
    // when a stored unit differs only by case.
    unit_id: split.unit ?? effectiveUnit(attr, row),
  };
}

/**
 * The row a field starts from when nothing is stored.
 *
 * Defined through {@link seedRow} rather than as its own literal so the
 * "a `number_unit` row always carries its unit" rule above has exactly one
 * implementation — the three places that need a blank row cannot drift from it.
 */
export function emptyRow(attr: MercadoLivreCategoriaAtributo): AttrRow {
  return seedRow(attr, undefined);
}

export function seedRows(
  attrs: MercadoLivreCategoriaAtributo[],
  stored: AttrWire[] | null | undefined,
): AttrRow[] {
  const byId = new Map((stored ?? []).map((a) => [a.id, a]));
  return attrs.map((attr) => seedRow(attr, byId.get(attr.id)));
}

/**
 * What the operator has typed SO FAR, stored verbatim.
 *
 * ⚠️ This is the on-CHANGE path and it deliberately does nothing to the text:
 * no trim, no option matching. Both belong to {@link resolveTypedValue}, which
 * runs on blur and again at save. Doing either here makes a space impossible to
 * TYPE, because the input renders `row.value_name` straight back: the trim ate a
 * trailing space before the caret moved, and the canonical snap ate it again for
 * any text matching a known option — so `Nike Air` could not be entered at all
 * on a category shipping `Nike` as a value.
 *
 * A blank-but-not-empty draft (`'  '`) is KEPT rather than cleared, so a leading
 * space is typeable too. Nothing downstream needs a guard for it: {@link isFilled}
 * tests `value_name.trim()`, so such a row still reads as empty for
 * {@link validateAttr} and is still skipped by {@link attributesForSave}.
 *
 * ⚠️ `unitId` is the unit the FIELD is currently on, passed in rather than
 * re-derived from `attr.defaultUnit`. Reaching for the default here is what made
 * the unit unpickable: whatever the operator chose was overwritten on the very
 * next keystroke.
 */
export function draftTypedValue(
  attr: MercadoLivreCategoriaAtributo,
  typed: string | null,
  unitId: string | null,
): AttrRow {
  const raw = typed ?? '';
  if (raw === '') {
    // ⚠️ The unit SURVIVES an empty box. Clearing the number is not a statement
    // about the unit, and dropping it here snaps the picker back to
    // `defaultUnit` behind the operator's back. Harmless downstream: `isFilled`
    // reads only the id and the name, so the row still counts as empty.
    return { id: attr.id, value_id: null, value_name: null, unit_id: unitFor(attr, unitId) };
  }
  return {
    id: attr.id,
    // Unresolved by construction — blur and save decide whether this text is one
    // of ML's known values.
    value_id: null,
    value_name: raw,
    // ML wants the unit alongside a bare number; the wire transform appends it.
    unit_id: unitFor(attr, unitId),
  };
}

/**
 * Resolve what the operator typed into an ML value, matching a known option by
 * name when one exists (`cadastroProdutoMLNew.dart:1191-1211`).
 *
 * Name matching is accent- and case-insensitive. The legacy compared raw
 * strings, so `Algodao` silently fell through to free text where `Algodão` was
 * a real option — and ML then rejected the listing for an unknown value.
 *
 * ⚠️ Runs on BLUR and again inside {@link attributesForSave} — never on change.
 * Both the trim and the canonical snap rewrite the text under the caret, so on
 * the typing path they cost the operator every space they press; see
 * {@link draftTypedValue}.
 *
 * ⚠️ `unitId` is the unit the row is already on, same as {@link draftTypedValue}.
 * Note the MATCHED branch still returns no unit: a value carrying one of ML's
 * own ids is identified by that id, and {@link attributesForSave} lets the
 * draft's unit win regardless.
 */
export function resolveTypedValue(
  attr: MercadoLivreCategoriaAtributo,
  typed: string | null,
  unitId: string | null,
): AttrRow {
  const trimmed = (typed ?? '').trim();
  if (trimmed.length === 0) {
    // See the matching branch in `draftTypedValue`: an empty box keeps its unit.
    return { id: attr.id, value_id: null, value_name: null, unit_id: unitFor(attr, unitId) };
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
    unit_id: unitFor(attr, unitId),
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
 *
 * This is also where a free-text row is finally RESOLVED — trimmed and matched
 * against ML's known values by {@link resolveTypedValue}. The field itself keeps
 * the raw draft so a space is typeable ({@link draftTypedValue}), and the blur
 * handler resolving it is only a convenience: a save reached without one (Enter
 * on the form) would otherwise store the untrimmed draft. Doing it here means
 * correctness does not depend on a focus event ever happening.
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
    const draft = rowById.get(attr.id);
    if (!draft || !isFilled(draft)) continue; // never store an empty rendered row
    // Only a free-text row is resolved. A row carrying a value_id was produced
    // by `rowFromSelect` (or is the N/A sentinel), so its name is already ML's
    // own and re-matching it could only move it.
    const resolved =
      draft.value_id == null && draft.value_name != null
        ? resolveTypedValue(attr, draft.value_name, draft.unit_id)
        : draft;
    // ⚠️ Take the NAME and the ID from the resolution, never the unit. Two
    // reasons, and the second outlives the first: `resolveTypedValue` returns no
    // unit at all when the text matched one of ML's enumerated values, so
    // adopting the resolution wholesale would drop the operator's pick — and the
    // row's `unit_id` may have been STORED against an earlier `defaultUnit`, so
    // if anyone ever lets this function re-derive the unit from today's metadata
    // again, this `??` is the only thing standing between that and silently
    // rewriting the unit of every saved measurement.
    const row = { ...resolved, unit_id: draft.unit_id ?? resolved.unit_id };
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
    const attr = rendered.get(row.id);
    if (!s || !attr) return row;
    const next: AttrRow = {
      id: row.id,
      value_id: s.value_id ?? null,
      value_name: s.value_name ?? null,
      unit_id: s.unit_id ?? null,
    };
    // ⚠️ A model asked for a measurement can still answer `'355 ml'`. Left whole
    // that reaches Mercado Livre as `'355 ml ml'`, because the wire transform
    // appends `unit_id` to the value name. Splitting also RECOVERS the unit the
    // model stated, which is better information than the category default the
    // suggestion would otherwise carry.
    //
    // ⚠️ Suggestions carrying a `value_id` are split too. `applyAiAttributes`'
    // MATCHED branch emits ML's own value name WHOLE alongside its id —
    // `{value_id: '3681798', value_name: '355 mL', unit_id: null}` — so gating
    // this on a null id left the commonest enumerated case unsplit: `'355 mL'`
    // in the digits-only box, and a unitless row while the picker shows `mL`,
    // which is exactly the row-disagrees-with-screen state that makes the next
    // blur report an edit nobody made. Only the N/A sentinel is exempt; its
    // `'N/A'` is a marker, not a measurement.
    if (attr.valueType === 'number_unit' && !isNaRow(next) && next.value_name != null) {
      const split = splitNumberUnit(attr, next.value_name);
      return {
        ...next,
        // The id names the PAIR, so it cannot outlive the split — the same rule
        // `seedRow` and the unit picker both apply.
        value_id: split.unit != null ? null : next.value_id,
        value_name: split.value,
        unit_id: split.unit ?? next.unit_id ?? effectiveUnit(attr, row),
      };
    }
    return next;
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

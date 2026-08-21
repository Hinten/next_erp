/**
 * Mercado Livre measurement units, shared by the two surfaces that show them:
 * the size-chart grid (`medidas`) and the `number_unit` attributes on the
 * produto → Mercado Livre tab.
 *
 * No React and no IO — the display rule below is the whole module.
 */

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

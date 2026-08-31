/**
 * Clearing Mercado Livre's duplicate rule off an AI-filled size chart.
 *
 * ML rejects a guia in which two rows carry the SAME value for one attribute
 * (`duplicated_measure_value`, `validacao-tabela-de-medidas` rule 8):
 *
 * > O valor do atributo {ATTRIBUTE_ID} é igual ao especificado na linha
 * > {ROW}; não é permitido especificar valores duplicados numa guia de tamanho.
 *
 * A real size table breaks that rule all the time — the same chest width
 * genuinely prints against two adjacent sizes — so a model reporting it twice
 * is reading correctly. ML's constraint is a platform rule, not a fact about
 * the garment.
 *
 * ⭐ Which is why this offsets the repeat by **0,01** instead of dropping it,
 * and why the anti-duplicate rule is deliberately NOT in the prompt: a model
 * told "never repeat a value" answers by INVENTING a difference it cannot see,
 * which is the one thing the agent's instructions exist to prevent. A
 * hundredth of a centimetre is below the precision of any tape measure, it is
 * applied here rather than by the model, it is deterministic, and the review
 * modal discloses every one of them.
 *
 * ⚠️ Client-side on purpose. `applyAiMedidas` runs on the server and sees only
 * the model's own answer — `buildChartAiGrid` sends `{key, size}` per row and
 * no cell values — so a nudge there would be blind to a value already sitting
 * in a cell the AI never touched, and could offset straight into a fresh
 * duplicate. Only the browser holds the whole grid.
 */
import { formatarCentesimos, parseCentesimos } from '@delfrance/core/decimal';

import type { ChartCellValue, ChartRowDraft } from './chartRows';
import type { ChartColumn, ChartColumnPart } from './chartSpec';
import type { MercadoLivreMedidaSugestao } from './wire';

/** One suggested cell, plus what it looked like before ML's rule was applied. */
export interface MedidaSugestaoAjustada extends MercadoLivreMedidaSugestao {
  /**
   * The model's own value, when this cell was changed to clear a duplicate;
   * null when the suggestion is exactly what the model said.
   *
   * ⚠️ The review modal MUST render this. A fabricated hundredth the operator
   * cannot see is the difference between a disclosed workaround and quietly
   * editing their data.
   */
  ajustadoDe: string | null;
}

/** Guards a pathological grid from spinning: 100 steps is a whole unit. */
const MAX_PASSOS = 100;

/**
 * Offset repeated measurements and drop repeated size equivalences, so the
 * guia can pass ML's validation without the model having invented anything.
 *
 * Suggestions for a column that is neither numeric nor a closed multi-value
 * list pass through untouched: a 0,01 offset is undefined for free text, and
 * ML's own per-cell error already says so in Portuguese.
 */
export function nudgeDuplicateMeasures(
  sugestoes: readonly MercadoLivreMedidaSugestao[],
  rows: readonly ChartRowDraft[],
  columns: readonly ChartColumn[],
): MedidaSugestaoAjustada[] {
  const partById = new Map<string, ChartColumnPart>();
  const partnerById = new Map<string, string>();
  for (const column of columns) {
    for (const part of column.parts) partById.set(part.attributeId, part);
    // A `LINKED_BY_CONNECTOR_INPUT` column renders `*_FROM` and `*_TO` as two
    // parts under one header. Knowing the pair is what keeps an offset FROM
    // from crossing its own row's TO.
    if (column.parts.length === 2) {
      const [de, ate] = column.parts as [ChartColumnPart, ChartColumnPart];
      partnerById.set(de.attributeId, ate.attributeId);
    }
  }

  // Deleted rows are dropped by `toChartRows` before the guia is built, so the
  // values in them are not part of what ML validates.
  const vivas = rows.filter((row) => !row.deleted);
  const ordem = new Map(vivas.map((row, index) => [row.key, index]));
  const porChave = new Map(vivas.map((row) => [row.key, row]));

  const porAtributo = new Map<string, MercadoLivreMedidaSugestao[]>();
  for (const s of sugestoes) {
    porAtributo.set(s.attributeId, [...(porAtributo.get(s.attributeId) ?? []), s]);
  }

  const out: MedidaSugestaoAjustada[] = [];
  for (const [attributeId, doAtributo] of porAtributo) {
    const part = partById.get(attributeId);
    // Row order, never the order the model happened to answer in — the same
    // grid must produce the same offsets on every run.
    const ordenadas = [...doAtributo].sort(
      (a, b) => (ordem.get(a.rowKey) ?? Infinity) - (ordem.get(b.rowKey) ?? Infinity),
    );

    if (part?.kind === 'number') {
      out.push(
        ...offsetNumeros(ordenadas, {
          attributeId,
          partnerId: partnerById.get(attributeId) ?? null,
          vivas,
          porChave,
        }),
      );
      continue;
    }
    if (part?.kind === 'multiselect') {
      out.push(...unclaimEquivalencias(ordenadas, { attributeId, vivas }));
      continue;
    }
    out.push(...ordenadas.map((s) => ({ ...s, ajustadoDe: null })));
  }

  // Restore the caller's ordering: the grouping above is an implementation
  // detail, and the review modal lists cells in the order it is handed them.
  const posicao = new Map(sugestoes.map((s, i) => [cellKey(s), i]));
  return out.sort((a, b) => (posicao.get(cellKey(a)) ?? 0) - (posicao.get(cellKey(b)) ?? 0));
}

function cellKey(s: { rowKey: string; attributeId: string }): string {
  return `${s.rowKey}::${s.attributeId}`;
}

/**
 * The hundredths a cell currently denotes, or null when it denotes no number
 * this module can reason about.
 */
function valorAtual(cell: ChartCellValue | undefined): number | null {
  const name = cell?.value_name;
  return typeof name === 'string' ? parseCentesimos(name) : null;
}

function offsetNumeros(
  ordenadas: readonly MercadoLivreMedidaSugestao[],
  ctx: {
    attributeId: string;
    partnerId: string | null;
    vivas: readonly ChartRowDraft[];
    porChave: ReadonlyMap<string, ChartRowDraft>;
  },
): MedidaSugestaoAjustada[] {
  const sugeridas = new Set(ordenadas.map((s) => s.rowKey));
  // Seeded from the cells the AI is NOT about to overwrite. A row that has a
  // suggestion is skipped here: its stored value is on its way out, and
  // reserving it would offset a suggestion away from a number that will not
  // exist by the time ML sees the guia.
  const atribuidos = new Set<number>();
  for (const row of ctx.vivas) {
    if (sugeridas.has(row.key)) continue;
    const atual = valorAtual(row.cells[ctx.attributeId]);
    if (atual != null) atribuidos.add(atual);
  }

  // ⚠️ Every value the model asked for, INCLUDING the ones not reached yet. An
  // offset must step over a reading that a later row will legitimately keep,
  // or resolving one duplicate manufactures the next: `50 · 50 · 50,01` walked
  // the second row onto `50,01` and then displaced the third — moving the row
  // whose reading was never ambiguous. The model's own numbers win; only the
  // repeat moves.
  const pedidos = new Set<number>();
  for (const s of ordenadas) {
    const valor = parseCentesimos(s.value_name);
    if (valor != null) pedidos.add(valor);
  }

  return ordenadas.map((s) => {
    const valor = parseCentesimos(s.value_name);
    // Prose, a range, a unit suffix: nothing to offset, and ML will say so.
    if (valor == null) return { ...s, ajustadoDe: null };
    if (!atribuidos.has(valor)) {
      atribuidos.add(valor);
      return { ...s, ajustadoDe: null };
    }

    const livre = proximoLivre(valor, atribuidos, pedidos, limiteSuperior(s, ctx));
    if (livre == null) return { ...s, ajustadoDe: null };
    atribuidos.add(livre);
    return { ...s, value_name: formatarCentesimos(livre), ajustadoDe: s.value_name };
  });
}

/**
 * The value an offset must not exceed — this row's `*_TO`, when the column is a
 * FROM/TO pair and this is its FROM half. Otherwise there is no ceiling.
 *
 * ⚠️ Read off the row as it stands, not off the partner's own offset value: the
 * two halves are processed independently, and a bound that is itself out by one
 * hundredth cannot make this decision wrong.
 */
function limiteSuperior(
  s: MercadoLivreMedidaSugestao,
  ctx: {
    partnerId: string | null;
    porChave: ReadonlyMap<string, ChartRowDraft>;
  },
): number | null {
  if (ctx.partnerId == null) return null;
  return valorAtual(ctx.porChave.get(s.rowKey)?.cells[ctx.partnerId]);
}

/**
 * The nearest value that neither collides with what is already placed
 * (`atribuidos`) nor with a reading a later row still wants (`pedidos`),
 * stepping one hundredth at a time. Everything here is in integer hundredths.
 *
 * ⚠️ ONE step is not enough — see the note on `pedidos`. Steps DOWNWARDS when
 * going up would cross this row's own upper bound.
 */
function proximoLivre(
  valor: number,
  atribuidos: ReadonlySet<number>,
  pedidos: ReadonlySet<number>,
  teto: number | null,
): number | null {
  const paraCima = teto == null || valor + 1 <= teto;
  for (let i = 1; i <= MAX_PASSOS; i += 1) {
    const candidato = valor + (paraCima ? i : -i);
    if (!atribuidos.has(candidato) && !pedidos.has(candidato)) return candidato;
  }
  return null;
}

/**
 * A standard size claimed by an earlier row is removed from the later one.
 *
 * ML's equivalence column (`FILTRABLE_SIZE`) drives the anúncio's size filter,
 * and two rows cannot both BE a 40 — a buyer filtering on it would get an
 * ambiguous answer, which is why ML answers `duplicated_measure_value` here
 * too. `matchList` in `applyAiMedidas` already dedupes members inside ONE
 * cell; this is the same rule one level up.
 *
 * A suggestion left with no members is dropped: it would apply as a visibly
 * empty cell, the trap `aiApplicable` exists for.
 */
function unclaimEquivalencias(
  ordenadas: readonly MercadoLivreMedidaSugestao[],
  ctx: { attributeId: string; vivas: readonly ChartRowDraft[] },
): MedidaSugestaoAjustada[] {
  const sugeridas = new Set(ordenadas.map((s) => s.rowKey));
  const tomados = new Set<string>();
  for (const row of ctx.vivas) {
    if (sugeridas.has(row.key)) continue;
    for (const v of row.cells[ctx.attributeId]?.valueList ?? []) tomados.add(v.id);
  }

  const out: MedidaSugestaoAjustada[] = [];
  for (const s of ordenadas) {
    const lista = s.valueList;
    if (lista == null || lista.length === 0) {
      out.push({ ...s, ajustadoDe: null });
      continue;
    }
    const restantes = lista.filter((v) => !tomados.has(v.id));
    if (restantes.length === 0) continue;
    for (const v of restantes) tomados.add(v.id);
    if (restantes.length === lista.length) {
      out.push({ ...s, ajustadoDe: null });
      continue;
    }
    out.push({
      ...s,
      value_id: restantes[0]!.id,
      value_name: restantes.map((v) => v.name).join(', '),
      valueList: restantes,
      ajustadoDe: s.value_name,
    });
  }
  return out;
}

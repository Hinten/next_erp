import { roundReais } from '@delfrance/core/money';
import type { FormulaCalculoPreco, ListaDePrecos } from '../../listaDePrecos';
import type { ComponentesKit } from '../collection/embedded/kit';
import type { Preco } from '../collection/produto';

/**
 * Pure price-formula engine — port of the Flutter `ListaDePrecos.calcularPreco`
 * / `_calcularPrecoParaFormula` (`packages/produtos/lib/src/models.dart:144-212`)
 * and `FormulaCalculoPreco.getTaxaFixaPorPeso` (`:402-419`). Behavior mirrors
 * the Dart implementation (selection by `limiar`, weight-banded `taxaFixa`),
 * rounding money with the canonical `roundReais` (2dp from the IEEE-754
 * double — byte-parity with Dart's `duasCasasDecimais`) from
 * `@delfrance/core/money`.
 */

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------
//
// The Flutter app parses `formula` with the `math_expressions` package and
// binds single-letter variables. This is a minimal recursive-descent
// equivalent: numbers, variables, + - * / ^ (right-assoc power), unary minus
// and parentheses. Anything unparsable — OR unevaluatable, e.g. an unbound
// variable — returns null here. That is deliberately MORE tolerant than the
// Dart original: `models.dart:144-168` wraps only `p.parse(formula)` in
// try/catch; `exp.evaluate(...)` at `:167` is unguarded, so an unbound
// variable at evaluate time crashes the whole calc instead of just skipping
// that one formula. This engine skips instead of crashing on any
// parse-or-evaluate failure; malformed/unbound formulas are meant to be
// caught earlier, at edit time (the F1 formula validator), not re-thrown here.

class ParseError extends Error {}

class Tokenizer {
  private pos = 0;
  constructor(private readonly src: string) {}

  peek(): string | null {
    while (this.pos < this.src.length && this.src[this.pos] === ' ') this.pos += 1;
    return this.pos < this.src.length ? this.src[this.pos]! : null;
  }

  next(): string | null {
    const ch = this.peek();
    if (ch !== null) this.pos += 1;
    return ch;
  }

  /** Consume a number literal starting at the cursor. */
  number(): number {
    const start = this.pos;
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos]!)) this.pos += 1;
    const text = this.src.slice(start, this.pos);
    const value = Number(text);
    if (text === '' || Number.isNaN(value)) throw new ParseError(`número inválido: "${text}"`);
    return value;
  }
}

function parseExpression(t: Tokenizer, vars: Record<string, number>): number {
  let value = parseTerm(t, vars);
  for (;;) {
    const ch = t.peek();
    if (ch === '+') {
      t.next();
      value += parseTerm(t, vars);
    } else if (ch === '-') {
      t.next();
      value -= parseTerm(t, vars);
    } else {
      return value;
    }
  }
}

function parseTerm(t: Tokenizer, vars: Record<string, number>): number {
  let value = parseFactor(t, vars);
  for (;;) {
    const ch = t.peek();
    if (ch === '*') {
      t.next();
      value *= parseFactor(t, vars);
    } else if (ch === '/') {
      t.next();
      value /= parseFactor(t, vars);
    } else {
      return value;
    }
  }
}

function parseFactor(t: Tokenizer, vars: Record<string, number>): number {
  const base = parseUnary(t, vars);
  if (t.peek() === '^') {
    t.next();
    // Right-associative, like math_expressions' power operator.
    return base ** parseFactor(t, vars);
  }
  return base;
}

function parseUnary(t: Tokenizer, vars: Record<string, number>): number {
  if (t.peek() === '-') {
    t.next();
    return -parseUnary(t, vars);
  }
  return parsePrimary(t, vars);
}

function parsePrimary(t: Tokenizer, vars: Record<string, number>): number {
  const ch = t.peek();
  if (ch === null) throw new ParseError('expressão terminou inesperadamente');
  if (ch === '(') {
    t.next();
    const value = parseExpression(t, vars);
    if (t.next() !== ')') throw new ParseError('parêntese não fechado');
    return value;
  }
  if (/[0-9.]/.test(ch)) return t.number();
  if (/[a-zA-Z]/.test(ch)) {
    t.next();
    const bound = vars[ch];
    if (bound === undefined) throw new ParseError(`variável desconhecida: ${ch}`);
    return bound;
  }
  throw new ParseError(`caractere inesperado: ${ch}`);
}

/**
 * Evaluate a formula string with the given single-letter variable bindings.
 * Commas are decimal separators on the wire (`','→'.'`, mirroring the Dart
 * `replaceAll`). Returns null on any parse/evaluation error.
 */
export function evaluateFormula(expr: string, vars: Record<string, number>): number | null {
  const t = new Tokenizer(expr.replaceAll(',', '.'));
  try {
    const value = parseExpression(t, vars);
    if (t.peek() !== null) return null; // trailing garbage
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    if (err instanceof ParseError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Formula selection / price calculation
// ---------------------------------------------------------------------------

/**
 * Weight-banded fixed fee: weight rounded UP at 2 decimals, first band
 * containing it (inclusive both ends) wins, else the formula's `taxaFixa`.
 */
export function taxaFixaPorPeso(formula: FormulaCalculoPreco, pesoKg: number): number {
  const faixas = formula.faixasTaxaFixaPeso;
  if (!faixas || faixas.length === 0) return formula.taxaFixa;
  const peso = Math.ceil(pesoKg * 100) / 100;
  const faixa = faixas.find((f) => peso >= f.pesoMinKg && peso <= f.pesoMaxKg);
  return faixa ? faixa.taxaFixa : formula.taxaFixa;
}

function evaluateForFormula(
  custo: number,
  formula: FormulaCalculoPreco,
  pesoKg: number,
): number | null {
  return evaluateFormula(formula.formula, {
    C: custo,
    c: formula.custoFixo,
    T: taxaFixaPorPeso(formula, pesoKg),
    L: formula.margemDeLucro,
    M: formula.comissaoMarketplace,
    I: formula.imposto,
    F: formula.frete,
    K: formula.marketing,
  });
}

/**
 * Compute the price for a custo under a lista's formulas. Category-specific
 * formulas take precedence when present (falling back to the default list
 * when the category bucket has none); candidates run in ascending `limiar`
 * order and the first valid (>0) result that does not exceed its own limiar
 * wins, rounded to 2 decimals. Null when no formula applies — exactly the
 * Dart `calcularPreco`.
 */
export function calcularPreco(
  lista: Pick<ListaDePrecos, 'formulasCalculoPreco' | 'formulasPorCategoria'>,
  custo: number,
  options: { idCategoria?: string | null; pesoKg?: number | null } = {},
): Preco | null {
  if (custo <= 0) return null;

  const pesoKg = options.pesoKg ?? 0.25;
  let formulas: FormulaCalculoPreco[] | null | undefined;
  if (options.idCategoria && lista.formulasPorCategoria) {
    formulas = lista.formulasPorCategoria[options.idCategoria]?.formulasCalculoPreco;
  }
  formulas ??= lista.formulasCalculoPreco;
  if (!formulas || formulas.length === 0) return null;

  const sorted = [...formulas].sort((a, b) => a.limiar - b.limiar);
  for (const formula of sorted) {
    const valor = evaluateForFormula(custo, formula, pesoKg);
    if (valor === null || valor <= 0) continue;
    if (valor <= formula.limiar) return { valor: roundReais(valor) };
  }
  return null;
}

/** True when a lista can recalc for this produto (any usable formula list). */
export function temFormulas(
  lista: Pick<ListaDePrecos, 'formulasCalculoPreco' | 'formulasPorCategoria'>,
  idCategoria?: string | null,
): boolean {
  const daCategoria =
    idCategoria && lista.formulasPorCategoria
      ? (lista.formulasPorCategoria[idCategoria]?.formulasCalculoPreco?.length ?? 0)
      : 0;
  return daCategoria > 0 || (lista.formulasCalculoPreco?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Price-map diffing (history records)
// ---------------------------------------------------------------------------

export type PrecosMap = Record<string, Preco> | null | undefined;

/** Per-lista history record to persist after a precos change. */
export interface PrecoChange {
  listaId: string;
  valorOriginal: number | null;
  valorFinal: number | null;
}

/** Entry-wise equality of two precos maps (by `valor`). */
export function samePrecos(a: PrecosMap, b: PrecosMap): boolean {
  const ea = Object.entries(a ?? {});
  const eb = b ?? {};
  if (ea.length !== Object.keys(eb).length) return false;
  return ea.every(([k, v]) => eb[k]?.valor === v.valor);
}

/**
 * The history records a precos transition produces — mirror of the Flutter
 * `Produto.save()` logic (`models.dart:2078-2124`): changed entry → both
 * values; added → valorFinal only; removed → valorOriginal only; no change →
 * empty list.
 */
export function diffPrecos(oldPrecos: PrecosMap, newPrecos: PrecosMap): PrecoChange[] {
  if (samePrecos(oldPrecos, newPrecos)) return [];
  const oldMap = oldPrecos ?? {};
  const newMap = newPrecos ?? {};
  const changes: PrecoChange[] = [];
  for (const [listaId, preco] of Object.entries(newMap)) {
    const before = oldMap[listaId]?.valor ?? null;
    if (before !== preco.valor) {
      changes.push({ listaId, valorOriginal: before, valorFinal: preco.valor });
    }
  }
  for (const [listaId, preco] of Object.entries(oldMap)) {
    if (!(listaId in newMap)) {
      changes.push({ listaId, valorOriginal: preco.valor, valorFinal: null });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Kit cost
// ---------------------------------------------------------------------------

/** Result of {@link custoDoKit}. */
export interface CustoKitResult {
  /** Total kit cost (2-decimal), or null when it cannot be fully computed. */
  custo: number | null;
  /** Component produto ids whose cost could not be resolved. */
  faltando: string[];
}

/**
 * Resolve a kit component's effective cost — pure port of the Flutter fallback
 * in `Produto.custoProdutoContabilizandoKit` (`models.dart:1271-1287`): use the
 * component's own `custo`; when it has none but is a variation child (`paiId`
 * set), fall back to the PARENT produto's `custo`. Returns `null` only when both
 * are unresolved. `paiByProdutoId` maps a component id → its `paiId` (or null);
 * `custoByProdutoId` must therefore also carry the parents' costs for the
 * fallback to resolve.
 */
export function resolveComponentCusto(
  produtoId: string,
  custoByProdutoId: Record<string, number | null | undefined>,
  paiByProdutoId: Record<string, string | null | undefined> = {},
): number | null {
  const own = custoByProdutoId[produtoId];
  if (own !== null && own !== undefined) return own;
  const paiId = paiByProdutoId[produtoId];
  if (paiId) {
    const parent = custoByProdutoId[paiId];
    if (parent !== null && parent !== undefined) return parent;
  }
  return null;
}

/**
 * Sum a kit's component costs — pure port of the kit branch of Flutter's
 * `Produto.custoProdutoContabilizandoKit` (`models.dart:1265-1290`):
 * `Σ custo(component) × quantidade`, rounded to 2 decimals. Unlike the Flutter
 * getter — which reads each component (and its parent) from Firestore inline and
 * throws on a missing cost — this is pure: the caller resolves component costs
 * up front (one batched read) into `custoByProdutoId`, and a component with no
 * resolvable cost is reported in `faltando` (cost stays null) instead of
 * throwing, so the page can surface it as a validation error.
 *
 * A component variation with no own cost falls back to its parent's cost
 * (`resolveComponentCusto`) when `paiByProdutoId` maps it to a parent whose cost
 * is present in `custoByProdutoId`.
 *
 * Empty/absent `componentes` → `{ custo: null, faltando: [] }` (Flutter returns
 * null for a kit with no components).
 */
export function custoDoKit(
  componentes: ComponentesKit | null | undefined,
  custoByProdutoId: Record<string, number | null | undefined>,
  paiByProdutoId: Record<string, string | null | undefined> = {},
): CustoKitResult {
  const entries = Object.entries(componentes ?? {});
  if (entries.length === 0) return { custo: null, faltando: [] };

  const faltando: string[] = [];
  let total = 0;
  for (const [produtoId, kit] of entries) {
    const custo = resolveComponentCusto(produtoId, custoByProdutoId, paiByProdutoId);
    if (custo === null) {
      faltando.push(produtoId);
      continue;
    }
    total += custo * kit.quantidade;
  }
  if (faltando.length > 0) return { custo: null, faltando };
  return { custo: roundReais(total), faltando: [] };
}

// ---------------------------------------------------------------------------
// Kit weight
// ---------------------------------------------------------------------------

/**
 * Per-component weight defaults the Flutter getters fall back to when a
 * component has no resolvable weight (`models.dart:1505` / `:1535`): 0.3 kg
 * bruto, 0.25 kg líquido. Unlike cost, a kit weight ALWAYS computes — a missing
 * component weight uses these defaults rather than reporting "faltando".
 */
export const KIT_PESO_BRUTO_FALLBACK_KG = 0.3;
export const KIT_PESO_LIQUIDO_FALLBACK_KG = 0.25;

/**
 * Resolve a kit component's effective weight — pure port of the Flutter
 * `getPesoBrutoKg`/`getPesoLiquidoKg` component branch (`models.dart:1487-1541`):
 * use the component's own weight; when it has none but is a variation child
 * (`paiId` set), fall back to the PARENT produto's weight; otherwise the crude
 * `fallback` default. Always returns a number. `pesoByProdutoId` must carry the
 * parents' weights too for the parent fallback to resolve.
 */
export function resolveComponentPeso(
  produtoId: string,
  pesoByProdutoId: Record<string, number | null | undefined>,
  paiByProdutoId: Record<string, string | null | undefined>,
  fallback: number,
): number {
  const own = pesoByProdutoId[produtoId];
  if (own !== null && own !== undefined) return own;
  const paiId = paiByProdutoId[produtoId];
  if (paiId) {
    const parent = pesoByProdutoId[paiId];
    if (parent !== null && parent !== undefined) return parent;
  }
  return fallback;
}

/**
 * Sum a kit's component weights — pure port of the kit branch of Flutter's
 * `getPesoBrutoKg`/`getPesoLiquidoKg` (`models.dart:1487-1541`):
 * `Σ peso(component) × quantidade`, rounded to 2 decimals, with a per-component
 * `fallback` for any unresolved weight (so it never returns "missing"). Empty/
 * absent `componentes` → `null` (the caller leaves the produto's own weight as-is).
 */
export function pesoDoKit(
  componentes: ComponentesKit | null | undefined,
  pesoByProdutoId: Record<string, number | null | undefined>,
  paiByProdutoId: Record<string, string | null | undefined>,
  fallback: number,
): number | null {
  const entries = Object.entries(componentes ?? {});
  if (entries.length === 0) return null;
  let total = 0;
  for (const [produtoId, kit] of entries) {
    total +=
      resolveComponentPeso(produtoId, pesoByProdutoId, paiByProdutoId, fallback) * kit.quantidade;
  }
  return roundReais(total);
}

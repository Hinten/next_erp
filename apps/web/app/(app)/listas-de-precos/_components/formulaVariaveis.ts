/**
 * The formula "language" as the price-list UI understands it: the character
 * allow-list, the input sanitizer, the variable legend rendered by
 * `FormulaAjuda`, and the default formula seeded into a new row.
 *
 * One module owns all of it on purpose. The letter -> field mapping is already
 * restated in four other places (the `listaDePrecosSchema` docblock,
 * `evaluateForFormula`, `TestarFormulaDialog`'s binding, and the form schema's
 * probe vars); a fifth copy is only justified if it is the single one the UI
 * reads, so the legend the operator reads and the labels on the inputs they
 * type into cannot drift apart.
 */

/**
 * Characters the legacy formula input accepts (digits, the four arithmetic
 * operators, the decimal comma, parentheses, and the single-letter
 * variables). Mirrors the legacy `TextInputFormatter` allow-list --
 * `.old/lib/produtos/pages/listaDePrecosCadastroView.dart:454`
 * (confirmed: no `.`, no `^` there either -- legacy never let either through
 * its input formatter) -- stripped on every change so an invalid character
 * never lands in the field to begin with.
 *
 * Note this is STRICTER than `evaluateFormula`, which does implement `^`.
 * {@link FORMULA_REGRAS} therefore must not advertise exponentiation: the
 * operator would be stripped before it ever reached the parser.
 */
export const FORMULA_DISALLOWED_CHARS = /[^0-9+\-*/,CcTFLMIK()]/g;

/**
 * `.` is the natural decimal separator a user types (`C*1.5`), but the
 * formula wire format -- and this allow-list -- only accepts the comma
 * (`evaluateFormula` itself does `replaceAll(',', '.')` before parsing). If
 * `.` were simply stripped by {@link FORMULA_DISALLOWED_CHARS} like any other
 * disallowed character, `C*1.5` would silently become `C*15`: still a
 * perfectly parseable formula, so no validation error ever surfaces -- a
 * silent 10x price error. Auto-convert instead of dropping, so the user's
 * intended decimal survives (as `C*1,5`).
 */
export function normalizeFormulaInput(raw: string): string {
  return raw.replaceAll('.', ',').replace(FORMULA_DISALLOWED_CHARS, '');
}

/**
 * Seeded into the `formula` of every newly added row, so the screen teaches
 * its own syntax instead of presenting an empty box.
 *
 * Deliberately NOT legacy parity: the Flutter app declared `formula` as a
 * required field with no default and created new rows as an empty bag, so
 * nothing pre-filled it there. This is new behaviour, adopted because the
 * variable legend alone still leaves the operator to assemble their first
 * expression from scratch.
 *
 * Two properties this string must keep, both pinned by `formulaVariaveis.test.ts`:
 * it must survive {@link normalizeFormulaInput} unchanged (otherwise the
 * sanitizer silently rewrites the default on the first keystroke), and it must
 * pass the form schema's parse probe (otherwise every new row opens already
 * showing "Formula invalida").
 */
export const FORMULA_PADRAO = '((C+c+L*C+T)/(1-(M+I+F+K)))*(1,03)';

/** One entry in the variable legend. */
export interface FormulaVariavel {
  /** The single letter as it is typed into the formula. Case-sensitive. */
  simbolo: string;
  label: string;
  /** Rendered dimmed beside the label, for the one variable that is not a field. */
  nota?: string;
}

/** The seven coefficients that are editable fields on a formula row. */
export type CoeficienteKey =
  | 'taxaFixa'
  | 'custoFixo'
  | 'margemDeLucro'
  | 'comissaoMarketplace'
  | 'imposto'
  | 'frete'
  | 'marketing';

export interface FormulaCoeficiente extends FormulaVariavel {
  key: CoeficienteKey;
}

/**
 * `C` is the only variable that is not one of the row's own fields -- it is
 * the product's cost, supplied per product when the price is calculated. Kept
 * separate from {@link COEFFICIENTS} so the coefficient grid never tries to
 * render an input for it.
 */
export const VARIAVEL_CUSTO: FormulaVariavel = {
  simbolo: 'C',
  label: 'Custo do produto',
  nota: 'informado no cálculo',
};

/** The seven editable coefficients, in the order the grid renders them. */
export const COEFFICIENTS: readonly FormulaCoeficiente[] = [
  { key: 'taxaFixa', simbolo: 'T', label: 'Taxa fixa' },
  { key: 'custoFixo', simbolo: 'c', label: 'Custo fixo' },
  { key: 'margemDeLucro', simbolo: 'L', label: 'Margem de lucro' },
  { key: 'comissaoMarketplace', simbolo: 'M', label: 'Comissão marketplace' },
  { key: 'imposto', simbolo: 'I', label: 'Imposto' },
  { key: 'frete', simbolo: 'F', label: 'Frete' },
  { key: 'marketing', simbolo: 'K', label: 'Marketing' },
];

/**
 * Looks a coefficient up by key, throwing if it is missing. Used only to build
 * {@link FORMULA_VARIAVEIS}, so that reordering or renaming {@link COEFFICIENTS}
 * fails loudly at import instead of silently dropping a row from the legend.
 */
function coeficiente(key: CoeficienteKey): FormulaCoeficiente {
  const found = COEFFICIENTS.find((c) => c.key === key);
  if (!found) throw new Error(`coeficiente desconhecido: ${key}`);
  return found;
}

/**
 * Every variable the formula accepts, in the order the LEGEND lists them --
 * which is the legacy help block's order, not {@link COEFFICIENTS}' order.
 *
 * The difference is deliberate and is the whole reason this list is spelled out
 * rather than spread: `COEFFICIENTS` follows the input grid (taxa fixa first),
 * while the legend puts `C` and `c` adjacent. They are different variables
 * separated only by case, and confusing them yields a wrong price rather than
 * an error, so showing them side by side is the point.
 */
export const FORMULA_VARIAVEIS: readonly FormulaVariavel[] = [
  VARIAVEL_CUSTO,
  coeficiente('custoFixo'),
  coeficiente('taxaFixa'),
  coeficiente('margemDeLucro'),
  coeficiente('comissaoMarketplace'),
  coeficiente('imposto'),
  coeficiente('frete'),
  coeficiente('marketing'),
];

/**
 * The syntax rules, rewritten from the legacy help block
 * (`listaDePrecosCadastroView.dart:374-389`) for this layout.
 *
 * Three deliberate differences from the legacy wording: the legacy typo
 * "markeplace" is fixed (in {@link COEFFICIENTS}); the rules describe what the
 * field DOES about a stray `.` or space rather than only forbidding it, since
 * `normalizeFormulaInput` silently corrects both as you type; and the
 * case-sensitivity of `C` vs `c` is called out, which the legacy text never
 * did even though confusing them produces a wrong price rather than an error.
 */
export const FORMULA_REGRAS: readonly string[] = [
  'Operadores: * multiplicação, / divisão, + adição, - subtração.',
  'Use ( ) para agrupar operações.',
  'Decimais com vírgula (1,03). Um ponto digitado vira vírgula automaticamente.',
  'Não use ponto para separar milhares, nem espaços: são removidos ao digitar.',
  'Maiúsculas e minúsculas importam — C é o custo do produto, c é o custo fixo.',
  'Números fixos multiplicam o resultado: o *(1,03) da fórmula sugerida acrescenta 3% ao preço. Altere ou remova se não quiser esse acréscimo.',
];

/**
 * Explains the sibling `limiar` input, whose meaning is not obvious from its
 * label. Legacy help text: "Valor máximo de preço após a aplicação da fórmula".
 * Lives here rather than as a `description` on the input itself because that
 * input shares a `flex-end` row with the formula field and the Testar button,
 * which a description would push out of alignment.
 *
 * The selection rules stated here are `calcularPreco`'s, not the editor's, and
 * pinned against it by `formulaVariaveis.test.ts`. Both halves are easy to get
 * wrong from reading the screen alone: candidates run in ascending `limiar`
 * order rather than in the order the rows were added, and when none qualifies
 * the result is `null` -- no price at all, not a fallback to another row.
 */
export const LIMIAR_AJUDA =
  'Limiar: preço máximo que a fórmula pode gerar. As fórmulas são avaliadas do menor para o maior limiar, e vale a primeira cujo resultado não ultrapasse o próprio limiar. Se nenhuma couber, o produto fica sem preço.';

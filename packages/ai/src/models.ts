/**
 * The list of models the settings page may offer, and the resolution of which
 * one a call actually uses.
 *
 * Two jobs, deliberately in one file because they must agree: the page can only
 * offer what `resolveModelo` will accept, and `resolveModelo` re-validates
 * against the same list at call time. A settings page that can save a model the
 * route then rejects is worse than free text, because it looks safe.
 */

/** Shape the route hands back, and the shape the Select consumes. */
export interface AiModelo {
  /** Bare model id as a call must spell it — `gemini-3.5-flash-lite`. */
  id: string;
  /** What to show a human. Falls back to the id when the provider sends none. */
  label: string;
}

/** Where the list came from, so the UI can say so rather than imply freshness. */
export type AiModelosFonte = 'live' | 'fallback';

export interface AiModelosResult {
  modelos: AiModelo[];
  fonte: AiModelosFonte;
  /**
   * Why the list is a fallback, when it is one. Present only on `fonte:
   * 'fallback'` after a failed live call — a truncated provider message, never
   * the raw error, because this string reaches a browser.
   */
  erro?: string;
}

/**
 * ⚠️ The shipped fallback, and it is **not** cosmetic — the Select must never be
 * empty, because an empty Select makes the page look broken and leaves the
 * operator unable to fix a bad stored value.
 *
 * These three are the ones verified live against Vertex on 2026-08-11, and the
 * verification found something worth recording: they are served at location
 * `global` and **404 at `us-central1`** (see `DEFAULT_AI_LOCATION` in
 * `provider.ts`). Keep this list to models actually confirmed to answer.
 */
export const AI_MODELOS_FALLBACK: readonly AiModelo[] = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (padrão, mais barato)' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (mais capaz, ~4× o custo)' },
] as const;

/** What a provider row looks like, reduced to the two fields that matter. */
export interface ProviderModelRow {
  name?: string | undefined;
  displayName?: string | undefined;
  supportedActions?: string[] | undefined;
}

/**
 * Vertex returns a **resource name** (`publishers/google/models/gemini-3.6-flash`),
 * the Gemini API returns `models/gemini-3.6-flash`, and a call needs the bare id.
 * Taking the last segment covers all three, including a plain id.
 */
export function bareModelId(name: string | undefined): string | null {
  if (typeof name !== 'string') return null;
  const last = name
    .split('/')
    .filter((s) => s !== '')
    .pop();
  return last == null || last === '' ? null : last;
}

/**
 * Keep only Gemini models that can answer a `generateContent` call.
 *
 * ⚠️ `supportedActions` is **absent** on Vertex publisher rows, so an
 * `includes('generateContent')` test would filter the entire list to nothing —
 * the check has to treat "no actions reported" as "unknown, keep it" and only
 * reject a row that positively lists actions without this one. Embedding and
 * image models do report theirs, which is what makes the filter useful at all.
 */
export function isSuggestionCapable(row: ProviderModelRow): boolean {
  const id = bareModelId(row.name);
  if (id == null || !id.startsWith('gemini-')) return false;
  const actions = row.supportedActions;
  if (actions == null || actions.length === 0) return true;
  return actions.includes('generateContent');
}

/**
 * Project provider rows onto the UI shape, dropping duplicates and anything
 * unusable. Returns the fallback when nothing survives — a live call that
 * answers with rows we cannot use is the same outcome, for the operator, as a
 * live call that failed.
 */
export function projectModelos(rows: readonly ProviderModelRow[]): AiModelosResult {
  const seen = new Set<string>();
  const modelos: AiModelo[] = [];
  for (const row of rows) {
    if (!isSuggestionCapable(row)) continue;
    const id = bareModelId(row.name);
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row.displayName === 'string' && row.displayName.trim() !== '';
    modelos.push({ id, label: label ? row.displayName!.trim() : id });
  }
  if (modelos.length === 0) return { modelos: [...AI_MODELOS_FALLBACK], fonte: 'fallback' };
  return { modelos, fonte: 'live' };
}

/**
 * Resolve the model for one call: **config doc → env → shipped default**, then
 * re-validate against the available list.
 *
 * The re-validation is the point. A model can be retired between the day someone
 * picked it and the day the next suggestion runs, and a stored value that no
 * longer exists would 404 from Vertex as an opaque 500 on a button the operator
 * cannot see the cause of. Falling back to a model that does exist keeps the
 * feature working and the reason inspectable.
 *
 * `disponiveis` empty means "we could not find out" — not "nothing is
 * available" — so validation is skipped rather than failing everything closed.
 */
export function resolveModelo(input: {
  stored?: string | null;
  env?: string | null;
  padrao: string;
  disponiveis?: readonly AiModelo[];
}): { modelo: string; substituido: boolean } {
  const preferido = firstNonBlank(input.stored, input.env, input.padrao);
  const disponiveis = input.disponiveis ?? [];
  if (disponiveis.length === 0) return { modelo: preferido, substituido: false };
  if (disponiveis.some((m) => m.id === preferido)) return { modelo: preferido, substituido: false };

  // Prefer the shipped default when it is actually offered; otherwise the first
  // thing that is. Never return `preferido` here — that is the value we just
  // established the provider does not serve.
  const fallback = disponiveis.some((m) => m.id === input.padrao)
    ? input.padrao
    : disponiveis[0]!.id;
  return { modelo: fallback, substituido: true };
}

function firstNonBlank(...values: Array<string | null | undefined>): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  // Unreachable while `padrao` is a non-empty constant; throwing beats returning
  // '' and letting a provider 400 explain it.
  throw new Error('Nenhum modelo de IA configurado.');
}

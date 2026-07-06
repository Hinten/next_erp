/**
 * Pure doc-shape translations: legacy Flutter tax-config docs → the new
 * canonical schemas (#398).
 *
 * Verified legacy wire (`.old/packages/produtos/lib/src/models.odm.g.dart`
 * + `models.dart`):
 *   - categoria tax docs live in `categorias/{id}/imposto` (the Dart getter
 *     was `impostocategoria`, but the Firestore collection ID is `imposto`)
 *     and scope with `impostoCategoriaOperacaoOuterRef`; the new shape is
 *     `categorias/{id}/impostocategoria` + `impostoOperacaoOuterRef`.
 *   - operação rules live in `operacao/{id}/regras` (Dart getter
 *     `regraimposto`, collection ID `regras`) with UPPERCASE `CFOP`,
 *     path-shaped `produtos`/`categorias` entries (`produtos/<uid>`,
 *     `documents/...`-prefixed, or bare uids — the legacy writers were
 *     inconsistent) and free-form NCMs; the new shape is
 *     `operacao/{id}/regraimposto` with lowercase `cfop`, bare-uid arrays
 *     and 8-digit `ncms`.
 *   - produto tax docs (`produtos/{id}/imposto`, typo scope key
 *     `impostoOpercaoOuterRef`) are ALREADY the shape the new resolver
 *     reads — the migration does not touch them.
 *
 * Every function is idempotent: translating an already-translated doc is a
 * no-op, so the migration can be re-run safely.
 */
import { normalizeNCM } from '@delfrance/schemas';

/** Legacy Firestore collection IDs (see header). */
export const LEGACY_CATEGORIA_TAX_SUBCOLL = 'imposto';
export const LEGACY_REGRA_SUBCOLL = 'regras';
/** New canonical collection IDs (must match the *Meta collectionPaths). */
export const NEW_CATEGORIA_TAX_SUBCOLL = 'impostocategoria';
export const NEW_REGRA_SUBCOLL = 'regraimposto';

/** Legacy → new scope-key rename on categoria tax docs. */
export const LEGACY_CATEGORIA_SCOPE_KEY = 'impostoCategoriaOperacaoOuterRef';
export const NEW_SCOPE_KEY = 'impostoOperacaoOuterRef';

export interface FieldNote {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

export interface FieldDrop {
  readonly field: string;
  readonly value: unknown;
  readonly reason: string;
}

export interface TranslationResult {
  /** Translated doc — the input object is never mutated. */
  readonly doc: Record<string, unknown>;
  /** Renames/normalizations performed (for the change log). */
  readonly notes: readonly FieldNote[];
  /** Values that could not be carried over (for the skip log). */
  readonly drops: readonly FieldDrop[];
}

/**
 * Last non-empty segment of a path-or-id — `documents/produtos/p1`,
 * `produtos/p1` and `p1` all yield `p1`; null for empty input.
 */
export function trailingSegment(pathOrId: string): string | null {
  const seg = pathOrId
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .pop();
  return seg != null && seg.length > 0 ? seg : null;
}

/**
 * Normalize an operação scope ref to the canonical `operacao/<id>` the new
 * `idRefSchema` expects. Accepts a bare uid, `operacao/<id>` and
 * `documents/operacao/<id>` (all shapes the legacy writers produced);
 * anything non-string or empty yields null (= "applies to every operação").
 */
export function normalizeOperacaoRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const id = trailingSegment(ref);
  return id == null ? null : `operacao/${id}`;
}

/**
 * `categorias/{id}/imposto` doc → the `impostocategoria` shape:
 * `impostoCategoriaOperacaoOuterRef` renamed to `impostoOperacaoOuterRef`
 * (an existing new-key value wins), and whichever scope value survives is
 * normalized to `operacao/<id>`. Other fields pass through untouched —
 * the caller validates with `impostoCategoriaSchema`, which strips any
 * remaining legacy-only keys.
 */
export function translateLegacyImpostoCategoria(raw: Record<string, unknown>): TranslationResult {
  const doc: Record<string, unknown> = { ...raw };
  const notes: FieldNote[] = [];

  const legacyRef = doc[LEGACY_CATEGORIA_SCOPE_KEY];
  const newRef = doc[NEW_SCOPE_KEY];
  delete doc[LEGACY_CATEGORIA_SCOPE_KEY];

  const source = newRef ?? legacyRef ?? null;
  const normalized = normalizeOperacaoRef(source);
  doc[NEW_SCOPE_KEY] = normalized;
  if (source !== normalized || legacyRef !== undefined) {
    notes.push({ field: NEW_SCOPE_KEY, from: legacyRef ?? newRef ?? null, to: normalized });
  }

  return { doc, notes, drops: [] };
}

/**
 * `operacao/{id}/regras` doc → the `regraimposto` shape:
 *   - `CFOP` → `cfop` (an existing lowercase value wins);
 *   - `produtos` / `categorias` entries → bare uids (trailing segment,
 *     deduped, non-strings dropped);
 *   - `ncms` entries → digits-only; anything that doesn't land on exactly
 *     8 digits is dropped (reported in `drops`) — the new schema's
 *     `/^\d{8}$/` would otherwise fail the whole doc.
 */
export function translateLegacyRegra(raw: Record<string, unknown>): TranslationResult {
  const doc: Record<string, unknown> = { ...raw };
  const notes: FieldNote[] = [];
  const drops: FieldDrop[] = [];

  if ('CFOP' in doc) {
    const upper = doc.CFOP;
    delete doc.CFOP;
    if (doc.cfop == null && upper != null) {
      doc.cfop = upper;
      notes.push({ field: 'cfop', from: 'CFOP (uppercase key)', to: upper });
    }
  }

  for (const field of ['produtos', 'categorias'] as const) {
    const value = doc[field];
    if (!Array.isArray(value)) continue;
    const ids: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') {
        drops.push({ field, value: entry, reason: 'non-string array entry' });
        continue;
      }
      const id = trailingSegment(entry);
      if (id == null) {
        drops.push({ field, value: entry, reason: 'empty path' });
        continue;
      }
      if (!ids.includes(id)) ids.push(id);
      if (id !== entry) notes.push({ field, from: entry, to: id });
    }
    doc[field] = ids;
  }

  const ncms = doc.ncms;
  if (Array.isArray(ncms)) {
    const out: string[] = [];
    for (const entry of ncms) {
      const normalized = typeof entry === 'string' ? normalizeNCM(entry) : null;
      if (normalized == null || !/^\d{8}$/.test(normalized)) {
        drops.push({ field: 'ncms', value: entry, reason: 'not 8 digits after normalization' });
        continue;
      }
      if (!out.includes(normalized)) out.push(normalized);
      if (normalized !== entry) notes.push({ field: 'ncms', from: entry, to: normalized });
    }
    doc.ncms = out;
  }

  return { doc, notes, drops };
}

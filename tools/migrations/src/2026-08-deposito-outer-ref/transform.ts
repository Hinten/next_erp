/**
 * Pure transform for the `depositoOuterRef` encoding normalization.
 *
 * The repo's outerRef invariant is that **readers tolerate both forms** —
 * `documents/depositos/<id>` and the bare `depositos/<id>` — while every writer
 * in this codebase emits the first. That tolerance is deliberate and stays; this
 * pass only makes the STORED data match the standard, so the two-form
 * disjunction is carrying a legacy shape rather than an ongoing one.
 *
 * Three collections carry the field:
 *
 * | collection | scope | field |
 * |---|---|---|
 * | `estoques` | collection group | required (`outerRefSchema`) |
 * | `historicoEstoque` | collection group | nullable, added by the v2 reshape |
 * | `integracao` | root collection | nullable — the conta's default depósito |
 *
 * ---- ⚠️ Why this is worth a pass of its own.
 *
 * The Mercado Livre sweep filters estoques on this field and its ledger
 * aggregate GROUPS BY the raw value, so a single `(produto, depósito)` pair
 * stored under both encodings comes back as two groups — handled today by
 * accumulating rather than overwriting, but only because the data forces it.
 * More importantly the field is a **join key**: any consumer that compares it
 * with a single encoding silently misses the rows written in the other one.
 *
 * ---- What this transform will NOT do.
 *
 * A value matching neither accepted form is **reported, never guessed at** — the
 * same discipline the historicoEstoque v2 pass uses for an unrecoverable
 * balanço. Rewriting an unrecognized ref would turn an obvious data problem into
 * a plausible-looking wrong pointer, which is strictly worse.
 *
 * ---- Idempotent: a row already in canonical form is `ja-canonico` and is never
 * written, so a re-run after an interrupted pass touches only what is left. That
 * also makes the second pass the natural verification step — it must report zero
 * `normalizado`.
 */

/** The one form every writer in this repo emits. */
export const PREFIXO_CANONICO = 'documents/depositos/';
/** The bare form the outerRef invariant tolerates on READ. */
const PREFIXO_BARE = 'depositos/';

/** What the migration decided about one document's `depositoOuterRef`. */
export type DepositoRefVerdict =
  /** Already `documents/depositos/<id>` — nothing to write. */
  | { kind: 'ja-canonico' }
  /** No `depositoOuterRef` at all (legal on the two nullable collections). */
  | { kind: 'ausente' }
  /** Bare `depositos/<id>` — rewritten to the canonical form. */
  | { kind: 'normalizado'; de: string; para: string }
  /**
   * Present but matching neither accepted encoding — left UNTOUCHED and
   * reported. `motivo` names what was seen; the operator decides.
   */
  | { kind: 'desconhecido'; valor: unknown; motivo: string };

/**
 * A depósito id is **exactly one path segment** after the prefix: `depositos` is
 * a root collection, so `documents/depositos/<id>` has nothing below it.
 *
 * ⚠️ Both encodings are validated through this, and the symmetry is the point.
 * Accepting a nested tail on the canonical branch while rejecting it on the bare
 * one would report `documents/depositos/dep1/sub` as `ja-canonico` — "already
 * fine" — when it is a broken join key that no equality comparison will ever
 * match. Surfacing those is half of what this pass is for.
 */
function ehIdDeDeposito(id: string): boolean {
  return id !== '' && !id.includes('/');
}

/**
 * Classify one document's stored `depositoOuterRef`.
 *
 * Deliberately takes the raw field rather than the document, so the same
 * function serves all three collections and the unit tests need no Firestore
 * shape at all.
 */
export function planDepositoOuterRef(valor: unknown): DepositoRefVerdict {
  if (valor === undefined || valor === null) return { kind: 'ausente' };

  if (typeof valor !== 'string') {
    return { kind: 'desconhecido', valor, motivo: `tipo ${typeof valor}, esperado string` };
  }
  if (valor === '') return { kind: 'desconhecido', valor, motivo: 'string vazia' };

  if (valor.startsWith(PREFIXO_CANONICO)) {
    const id = valor.slice(PREFIXO_CANONICO.length);
    if (!ehIdDeDeposito(id)) {
      return { kind: 'desconhecido', valor, motivo: 'forma canônica com id ausente ou composto' };
    }
    return { kind: 'ja-canonico' };
  }

  if (valor.startsWith(PREFIXO_BARE)) {
    const id = valor.slice(PREFIXO_BARE.length);
    if (!ehIdDeDeposito(id)) {
      return { kind: 'desconhecido', valor, motivo: 'forma bare com id ausente ou composto' };
    }
    return { kind: 'normalizado', de: valor, para: `${PREFIXO_CANONICO}${id}` };
  }

  return { kind: 'desconhecido', valor, motivo: 'não aponta para depositos/' };
}

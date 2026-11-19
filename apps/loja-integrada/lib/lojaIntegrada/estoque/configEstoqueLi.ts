/**
 * The stock sync's NUMERIC settings, read from the environment an entry point passes in (master
 * plan step 12): the upper cap on what one store row advertises, the eager ceiling of the kit
 * fan-out, and the page size the daily reconcile reads the store's stock list with. A LEAF: it imports `@delfrance/schemas` and one type, so the stock trigger can
 * read both without pulling the send run's module — and with it the write context — into its
 * closure (`processarEstoque.ts` re-exports the cap reader, so none of its importers moved).
 *
 * Pure: no clock, no network, no Firestore; the environment is a parameter (`estrutura.test.ts`).
 * Nothing is trimmed or case-folded, as with the valves (`core/valvulas.ts`).
 */
import { MAX_KITS_EM_LINHA_ESTOQUE_LI, MAX_LIMITE_PAGINA_ESTOQUE_LI } from '@delfrance/schemas';

import type { AmbienteLi } from '../core/valvulas';

/* -------------------------------------------------------------------------- */
/*                                   The cap                                   */
/* -------------------------------------------------------------------------- */

/** The upper cap on what one row advertises (`processarEstoque.ts`'s module header, step 3). */
export const TETO_ESTOQUE_ENV_LI = 'LOJA_INTEGRADA_ESTOQUE_MAX';

/** A positive integer in canonical decimal: no sign, no leading zero, no space, no fraction. */
const TETO_CANONICO = /^[1-9][0-9]*$/;

/**
 * The cap, as the run applies it: `+∞` when unset or blank (exactly `''`, nothing trimmed); the
 * number when the value is a positive safe integer in canonical decimal; `null` — the run refuses
 * — for anything else (`0`, `-1`, `1.5`, ` 3`, `03`, `abc`).
 */
export function lerTetoEstoqueLi(ambiente: AmbienteLi): number | null {
  const valor = ambiente[TETO_ESTOQUE_ENV_LI];
  if (valor === undefined || valor === '') return Number.POSITIVE_INFINITY;
  if (!TETO_CANONICO.test(valor)) return null;
  const teto = Number(valor);
  return Number.isSafeInteger(teto) ? teto : null;
}

/* -------------------------------------------------------------------------- */
/*                         The kit fan-out's eager ceiling                     */
/* -------------------------------------------------------------------------- */

/**
 * The eager ceiling: a component with at most this many store kits has every kit it may have
 * moved checked at once, by the trigger (reading the kits' other components); one with more
 * sends only the kits whose quantity crossed from positive to 0, and leaves every other change to
 * the nightly reconcile. `0` is a legal value — the queue lever: every kit then takes the
 * zero-crossing path.
 */
export const TETO_KITS_IMEDIATOS_ENV_LI = 'LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX';

/**
 * The ceiling when the variable is unset or blank: the inline limit of the kits header. It is
 * also the largest value accepted — the eager path reads only the header's inline kits, which
 * never hold more than {@link MAX_KITS_EM_LINHA_ESTOQUE_LI}.
 */
export const TETO_KITS_IMEDIATOS_PADRAO_LI = MAX_KITS_EM_LINHA_ESTOQUE_LI;

/**
 * The ceiling a value that cannot be read falls back to: `0`, every kit on the zero-crossing
 * path, so a typo in the queue lever can never widen the eager fan-out. The caller logs ONE
 * WARNING; nothing throws (the trigger runs with `retry: true`, so a throw would be redelivered
 * for as long as the configuration stays wrong).
 */
export const TETO_KITS_IMEDIATOS_INVALIDO_LI = 0;

/** A non-negative integer in canonical decimal: `0`, or no leading zero, no sign, no space. */
const TETO_KITS_CANONICO = /^(0|[1-9][0-9]*)$/;

/** The eager ceiling as read, and whether the value could be read at all. */
export interface TetoKitsImediatosLi {
  readonly teto: number;
  /** `false` only when a value was set and refused: the caller logs one WARNING. */
  readonly valido: boolean;
}

/**
 * The eager ceiling: unset or blank (exactly `''`, nothing trimmed) ⇒ the default
 * ({@link TETO_KITS_IMEDIATOS_PADRAO_LI}); `0` to {@link MAX_KITS_EM_LINHA_ESTOQUE_LI} in
 * canonical decimal ⇒ that number; anything else (`31`, ` 3`, `03`, `-1`, `1.5`, `1e1`, `abc`,
 * `30 `) ⇒ {@link TETO_KITS_IMEDIATOS_INVALIDO_LI}, not valid. Never throws.
 */
export function lerTetoKitsImediatosLi(ambiente: AmbienteLi): TetoKitsImediatosLi {
  const valor = ambiente[TETO_KITS_IMEDIATOS_ENV_LI];
  if (valor === undefined || valor === '') {
    return { teto: TETO_KITS_IMEDIATOS_PADRAO_LI, valido: true };
  }
  if (TETO_KITS_CANONICO.test(valor)) {
    const teto = Number(valor);
    if (teto <= MAX_KITS_EM_LINHA_ESTOQUE_LI) return { teto, valido: true };
  }
  return { teto: TETO_KITS_IMEDIATOS_INVALIDO_LI, valido: false };
}

/* -------------------------------------------------------------------------- */
/*                   The reconcile's page of the store's stock list            */
/* -------------------------------------------------------------------------- */

/**
 * How many rows each page of the store's stock list asks for in the daily reconcile
 * (`estoque/reconcile/faseLi.ts`). Read when a conta's list walk STARTS and stored in the walk's
 * cursor (`sincEstoqueLojaIntegrada/{conta}.reconcile.limite`): a run never changes it mid-list,
 * whatever the environment says by the time it resumes.
 */
export const LIMITE_PAGINA_ESTOQUE_ENV_LI = 'LOJA_INTEGRADA_ESTOQUE_LIMITE_PAGINA';

/**
 * The page size when the variable is unset or blank: 100, as measured — the owner's read-only
 * stock captures saw `limit` 20, 50 and 100 honoured exactly. It is also the largest the list is
 * ever asked for ({@link MAX_LIMITE_PAGINA_ESTOQUE_LI}, the schema's one bound).
 */
export const LIMITE_PAGINA_ESTOQUE_PADRAO_LI = 100;

/** A positive integer in canonical decimal: no sign, no leading zero, no space, no fraction. */
const LIMITE_PAGINA_CANONICO = /^[1-9][0-9]*$/;

/** The page size as read, and whether the value could be read as given. */
export interface LimitePaginaEstoqueLi {
  readonly limite: number;
  /** `false` when a value was set and refused or clamped: the caller logs ONE WARNING per run. */
  readonly valido: boolean;
}

/**
 * The reconcile's page size: unset or blank (exactly `''`, nothing trimmed) ⇒ the default
 * ({@link LIMITE_PAGINA_ESTOQUE_PADRAO_LI}), valid; `1` to {@link MAX_LIMITE_PAGINA_ESTOQUE_LI} in
 * canonical decimal ⇒ that number, valid; a canonical number ABOVE it (`101`, `100000`, one past
 * the safe-integer range) ⇒ CLAMPED to it, not valid; anything else (`0`, `03`, ` 5`, `5 `, `1.5`,
 * `-1`, `1e2`, `abc`) ⇒ the default, not valid. Never throws: a misconfigured page size must not
 * stop the reconcile, only cost it a WARNING.
 */
export function lerLimitePaginaEstoqueLi(ambiente: AmbienteLi): LimitePaginaEstoqueLi {
  const valor = ambiente[LIMITE_PAGINA_ESTOQUE_ENV_LI];
  if (valor === undefined || valor === '') {
    return { limite: LIMITE_PAGINA_ESTOQUE_PADRAO_LI, valido: true };
  }
  if (!LIMITE_PAGINA_CANONICO.test(valor)) {
    return { limite: LIMITE_PAGINA_ESTOQUE_PADRAO_LI, valido: false };
  }
  const limite = Number(valor);
  if (!Number.isSafeInteger(limite) || limite > MAX_LIMITE_PAGINA_ESTOQUE_LI) {
    return { limite: MAX_LIMITE_PAGINA_ESTOQUE_LI, valido: false };
  }
  return { limite, valido: true };
}

/**
 * The one reader of an id that goes INTO a path: the order reads (`pedidos.ts`),
 * the write-back operations (`pedidosEscrita.ts`) and the grade detail read
 * (`catalogo.ts`) all use it, and none keeps its own. Package-local on purpose —
 * not exported from the package root.
 *
 * An id must be a positive safe integer — a number, or its plain decimal text
 * (no sign, no leading zero, no space, no exponent, no fraction). Anything else
 * is refused with `LiConfigError('caminho')` and NOTHING is built or fetched:
 * the value would not name one resource, and interpolated into a path it could
 * name another one (`'1/2'`, `'../165'`).
 */
import { LiConfigError } from './errors';

const INTEIRO_POSITIVO = /^[1-9][0-9]*$/;

/** The canonical decimal of a positive safe integer, or `null`. */
function idDoCaminho(valor: number | string): string | null {
  const texto = typeof valor === 'number' ? String(valor) : valor;
  if (!INTEIRO_POSITIVO.test(texto)) return null;
  return Number.isSafeInteger(Number(texto)) ? texto : null;
}

/** The canonical decimal of `valor`, or `LiConfigError('caminho')` naming `operacao`. */
export function idOuRecusa(valor: number | string, operacao: string): string {
  const id = idDoCaminho(valor);
  if (id === null) throw new LiConfigError('caminho', { operacao, refCredencial: null });
  return id;
}

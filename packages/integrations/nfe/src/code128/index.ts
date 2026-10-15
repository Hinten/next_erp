/**
 * Browser-safe Code 128/ZPL encoding for an NF-e access key.
 *
 * A chave is not necessarily numeric since NT 2026.004: positions 6-17
 * (zero-based) are the emitente CNPJ body and may contain A-Z. Zebra's `^BC`
 * invocation codes let one symbol keep the numeric head/tail in subset C and
 * switch only that fixed window to subset B:
 *
 *   `>;` start C · `>6` switch C -> B · `>5` switch B -> C
 *
 * Source: Zebra ZPL `^BC` reference, "Code 128 Invocation Characters".
 */
import { CHAVE_NFE_REGEX } from '@delfrance/schemas';

const ALL_DIGITS = /^\d+$/;
const HEAD_END = 6;
const BODY_END = 18;
const MODULES_PER_SYMBOL = 11;
const STOP_MODULES = 13;

export interface ChaveNfeZplEncoding {
  readonly kind: 'numeric' | 'mixed';
  /** Contents for `^FD`, including the Code 128 start/switch invocation codes. */
  readonly payload: string;
  /** Full symbol width in Code 128 modules, including start, checksum and stop. */
  readonly modules: number;
}

function modules(dataSymbols: number): number {
  // One start symbol + data/switch symbols + one checksum, then the stop.
  return (dataSymbols + 2) * MODULES_PER_SYMBOL + STOP_MODULES;
}

/**
 * Encode a schema-valid 44-character NF-e chave for Zebra `^BC`.
 *
 * Returns `null` for any shape outside `CHAVE_NFE_REGEX`; callers must surface
 * that as a format error rather than printing a plausible but wrong barcode.
 */
export function encodeChaveNfeZpl(chave: string): ChaveNfeZplEncoding | null {
  if (!CHAVE_NFE_REGEX.test(chave)) return null;

  if (ALL_DIGITS.test(chave)) {
    return {
      kind: 'numeric',
      payload: `>;${chave}`,
      modules: modules(chave.length / 2),
    };
  }

  const head = chave.slice(0, HEAD_END);
  const body = chave.slice(HEAD_END, BODY_END);
  const tail = chave.slice(BODY_END);
  return {
    kind: 'mixed',
    payload: `>;${head}>6${body}>5${tail}`,
    // 3 head pairs + CODE B + 12 body chars + CODE C + 13 tail pairs.
    modules: modules(3 + 1 + 12 + 1 + 13),
  };
}

/**
 * A FILE that Shopee answers instead of an envelope — the shipping label
 * (`v2.logistics.download_shipping_document`, step 15) — and the byte sniff that
 * says what kind of file it is.
 *
 * ⚠️ Two different questions live here, and they are answered by two different
 * functions on purpose:
 *
 *  1. **Is this body an envelope at all?** {@link pareceCorpoJson}. The TRANSPORT
 *     asks it (`call.ts`, `shopeeCallArquivo`), because a Shopee failure is
 *     routinely HTTP 200 and the download page documents neither a status nor a
 *     content type for either branch. A PDF or a ZIP can never start with `{`,
 *     so the first significant byte decides — never `res.ok`, never the header.
 *  2. **Which label format is it?** {@link classificarArquivoDeEnvio}. The APP
 *     asks it, on bytes the transport has already proven non-empty and
 *     non-JSON, and it REFUSES what it does not recognise (`desconhecido`).
 *
 * ⚠️ `json` and `vazio` are deliberately NOT sniff answers: they are transport
 * outcomes. A JSON body takes the envelope verdict (an error, or a success
 * envelope that is never a label), and an empty 2xx is
 * `ShopeeArquivoVazioError`. By the time a caller holds a
 * {@link ShopeeArquivoBaixado}, both are already impossible.
 *
 * ⚠️ Same magic numbers as Mercado Livre's route-local sniff, OPPOSITE policy:
 * ML falls back to `application/octet-stream`, and the print agent prints
 * nothing for that type while still answering 200 — a silent loss. Here an
 * unknown file is `desconhecido`, and the label route refuses it. That is why
 * the ML sniff is not shared: sharing it would share the fallback.
 */

/** What `shopeeCallArquivo` hands back: the bytes, and the headers VERBATIM. */
export interface ShopeeArquivoBaixado {
  /** The body, byte for byte — read with `arrayBuffer()`, never `text()`. */
  readonly bytes: Uint8Array;
  /**
   * The `Content-Type` header VERBATIM, or `null` when absent. Diagnostics and
   * the format-mismatch notice only — never the verdict: the sniff decides.
   */
  readonly contentType: string | null;
  /** The `Content-Disposition` header VERBATIM, or `null` when absent. */
  readonly contentDisposition: string | null;
  readonly httpStatus: number;
}

/**
 * The `Accept` header of a file download.
 *
 * ⚠️ Any type, on purpose (a probe constant, P7): the download page documents
 * no content type, and a narrower `Accept` risks a 406 from a server that would
 * have sent the label. The probe may narrow it once a real answer is observed.
 */
export const SHOPEE_ARQUIVO_ACCEPT = '*/*';

/** The UTF-8 byte-order mark, `EF BB BF`. */
const BOM_UTF8 = [0xef, 0xbb, 0xbf] as const;

/**
 * ASCII whitespace, as JSON defines it: space, TAB, LF, CR.
 *
 * ⚠️ JSON's four, not WHATWG's five: a form feed (`0x0C`) is NOT whitespace to
 * `JSON.parse`, so counting it here would route a body the envelope parser then
 * calls non-JSON. The same set serves the ZPL sniff.
 */
function ehEspacoAscii(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function comecaCom(bytes: Uint8Array, assinatura: readonly number[], desde = 0): boolean {
  if (bytes.byteLength - desde < assinatura.length) return false;
  return assinatura.every((byte, i) => bytes[desde + i] === byte);
}

/** The index of the first byte that is not ASCII whitespace, from `desde`. */
function pularEspacos(bytes: Uint8Array, desde: number): number {
  let i = desde;
  while (i < bytes.byteLength && ehEspacoAscii(bytes[i]!)) i += 1;
  return i;
}

/**
 * Whether the body is (or claims to be) JSON: the first byte after an OPTIONAL
 * UTF-8 BOM and ASCII whitespace is `{` or `[`.
 *
 * ⚠️ The BOM and the whitespace are skipped because both are legal in front of a
 * JSON document that a server — or a proxy re-encoding it — sends, and missing
 * them would hand an error envelope to the caller as a "label". The BOM is
 * skipped only at offset 0, where a BOM can be.
 *
 * ⚠️ It says "claims to be", not "is": a malformed `{…` still answers `true`,
 * and the transport then refuses it as a non-envelope. That is the right side
 * to err on — no label format starts with `{` or `[`.
 */
export function pareceCorpoJson(bytes: Uint8Array): boolean {
  const inicio = pularEspacos(bytes, comecaCom(bytes, BOM_UTF8) ? BOM_UTF8.length : 0);
  if (inicio >= bytes.byteLength) return false;
  const primeiro = bytes[inicio];
  return primeiro === 0x7b /* { */ || primeiro === 0x5b; /* [ */
}

/**
 * The label format, with the EXACT content type to serve it under.
 *
 * ⚠️ Every content type is a bare essence with NO parameter: the print agent
 * compares the type by string equality, so `text/plain;charset=utf-8` is a type
 * it does not print.
 */
export type ShopeeFormatoDeArquivo =
  | { readonly formato: 'pdf'; readonly contentType: 'application/pdf'; readonly extensao: 'pdf' }
  | { readonly formato: 'zip'; readonly contentType: 'application/zip'; readonly extensao: 'zip' }
  | { readonly formato: 'zpl'; readonly contentType: 'text/plain'; readonly extensao: 'txt' }
  | { readonly formato: 'desconhecido' };

/** `%PDF-` */
const ASSINATURA_PDF = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
/** `PK\x03\x04` — a ZIP LOCAL FILE HEADER, i.e. an archive with at least one entry. */
const ASSINATURA_ZIP = [0x50, 0x4b, 0x03, 0x04] as const;
/** `^XA` — the ZPL start-of-label command. */
const ASSINATURA_ZPL = [0x5e, 0x58, 0x41] as const;

/**
 * What kind of label file these bytes are, by signature alone.
 *
 * - **PDF** = `%PDF-` at offset 0. A truncated `%PD` is NOT a PDF.
 * - **ZIP** = `PK\x03\x04` at offset 0. ⚠️ `PK\x05\x06` — the end-of-central-
 *   directory record an EMPTY archive starts with — is `desconhecido`: an empty
 *   ZIP holds no label, and the agent would "print" it without a sheet.
 * - **ZPL** = `^XA` after ASCII whitespace. Undocumented for BR (the guide says
 *   ZIP for the thermal label), accepted because the agent prints a bare
 *   `text/plain` raw; served as EXACTLY `text/plain` (`.txt`).
 * - Anything else — HTML, an octet stream, JSON that slipped past the transport —
 *   is `desconhecido`, and the caller REFUSES it rather than serving it.
 *
 * ⚠️ There is no tie-break by the requested document type: the bytes decide, and
 * the requested type only labels a MISMATCH for the operator.
 */
export function classificarArquivoDeEnvio(bytes: Uint8Array): ShopeeFormatoDeArquivo {
  if (comecaCom(bytes, ASSINATURA_PDF)) {
    return { formato: 'pdf', contentType: 'application/pdf', extensao: 'pdf' };
  }
  if (comecaCom(bytes, ASSINATURA_ZIP)) {
    return { formato: 'zip', contentType: 'application/zip', extensao: 'zip' };
  }
  if (comecaCom(bytes, ASSINATURA_ZPL, pularEspacos(bytes, 0))) {
    return { formato: 'zpl', contentType: 'text/plain', extensao: 'txt' };
  }
  return { formato: 'desconhecido' };
}

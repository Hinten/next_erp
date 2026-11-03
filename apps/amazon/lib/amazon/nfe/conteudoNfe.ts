/**
 * The two values `submitInvoice` carries for an NF-e (step 14, PR 14-b):
 * `invoiceContent`, the base64 of the stored `nfeProc` XML, and
 * `contentMD5Value`, the base64 of the MD5 digest of THE SAME BYTES.
 *
 * ## One buffer, the stored string verbatim
 *
 * Both values come from ONE `Buffer.from(xml, 'utf8')` of the string the NF-e
 * document stores, never re-serialised, trimmed, re-parsed or re-encoded: the
 * proc's XML signature covers exact bytes, and a digest of anything but the
 * bytes sent is a digest Amazon refuses. A leading BOM and a trailing newline
 * are part of the bytes, and stay.
 *
 * - The digest is base64 (24 characters ending `==`), never hex: the model's own
 *   example value is a 32-hex placeholder and is never a vector (the package
 *   refuses a hex value before anything is sent).
 * - The digest is of the UTF-8 BYTES of the XML, never of its base64 text.
 *
 * The rule (base64 of the MD5 of the UTF-8 bytes of the full `nfeProc`) is the
 * one the legacy code ran in production; the package only checks the SHAPE of
 * both values and holds no crypto, so it stays platform-neutral (step-14 plan
 * §3 decision 5).
 *
 * ⚠️ PII: both values are a whole fiscal document with buyer data, and its
 * digest. They are RETURNED to the one caller that sends them and never reach a
 * log line, an aviso, a payload or a response. `node:crypto` lives here and
 * stays out of the logger's import closure (`estrutura.test.ts`).
 */
import { createHash } from 'node:crypto';

/** The pair one `submitInvoice` sends. */
export interface ConteudoNfeAmazon {
  /** The proc's UTF-8 bytes, base64. */
  readonly invoiceContent: string;
  /** The base64 of the MD5 of the SAME bytes. */
  readonly contentMD5Value: string;
}

/** `invoiceContent` and `contentMD5Value` of the stored proc (module header). */
export function conteudoDaNfeAmazon(xml: string): ConteudoNfeAmazon {
  const bytes = Buffer.from(xml, 'utf8');
  return {
    invoiceContent: bytes.toString('base64'),
    contentMD5Value: createHash('md5').update(bytes).digest('base64'),
  };
}

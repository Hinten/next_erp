/**
 * `<transp>` block builder.
 *
 * Phase A surface — `modFrete` is the only field that varies; the
 * transportador / veículo / volumes blocks are Phase D additions
 * that plug in by extending the typed object (no template surgery).
 * Element ordering and text escaping are owned by `serializeFragment`'s
 * META walker — same path used by `ide` / `emit` / `dest`.
 */
import { z } from 'zod';

import { serializeFragment, type XmlValue } from '../xml';
import type { TNFe_infNFe_transp } from '../types/nfe-schema';

export const modFreteSchema = z.enum(['0', '1', '2', '3', '4', '9']);
export type ModFrete = z.infer<typeof modFreteSchema>;

/**
 * Build the typed `<transp>` value. Use `buildTranspXml` for the
 * wire XML; this overload is the typed entry point for consumers
 * that want to plug the result into a larger value.
 */
export function buildTranspObject(
  opts: { modFrete?: ModFrete } = {},
): TNFe_infNFe_transp {
  return { modFrete: modFreteSchema.parse(opts.modFrete ?? '9') };
}

/**
 * Build the `<transp>` XML.
 *
 * Defaults to `modFrete='9'` (sem ocorrência de transporte) — the
 * right answer when the issuer doesn't transport the goods themselves
 * (which covers all retail point-of-sale).
 */
export function buildTranspXml(opts: { modFrete?: ModFrete } = {}): string {
  return serializeFragment(
    'TNFe_infNFe_transp',
    'transp',
    buildTranspObject(opts) as unknown as XmlValue,
  );
}

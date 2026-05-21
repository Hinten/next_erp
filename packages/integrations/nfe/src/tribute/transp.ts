/**
 * `<transp>` block builder.
 *
 * `modFrete` is required by the XSD; `<transporta>` (carrier info)
 * and the vehicle/volume blocks are optional and plug in by extending
 * the typed object. Element ordering + text escaping are owned by
 * `serializeFragment`'s META walker — same pipeline used by `ide` /
 * `emit` / `dest`.
 */
import { z } from 'zod';

import { serializeFragment, type XmlValue } from '../xml';
import type {
  TNFe_infNFe_transp,
  TNFe_infNFe_transp_transporta,
} from '../types/nfe-schema';

export const modFreteSchema = z.enum(['0', '1', '2', '3', '4', '9']);
export type ModFrete = z.infer<typeof modFreteSchema>;

/**
 * UF enum for the transporta block. Matches the XSD facet — same
 * 27-state set as the address blocks, plus `EX` for foreign carriers.
 */
const transpUfSchema = z.enum([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
  'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO', 'EX',
]);

/**
 * Carrier / transporter detail block. XSD makes every field optional
 * (the whole `<transporta>` element is itself optional). CNPJ and CPF
 * are mutually exclusive (XSD choice group 22) — supply at most one.
 */
export const transportaSchema = z
  .object({
    CNPJ: z.string().optional(),
    CPF: z.string().optional(),
    xNome: z.string().optional(),
    IE: z.string().optional(),
    xEnder: z.string().optional(),
    xMun: z.string().optional(),
    UF: transpUfSchema.optional(),
  })
  .refine((t) => !(t.CNPJ != null && t.CPF != null), {
    message: 'transporta: CNPJ and CPF are mutually exclusive (XSD choice group 22)',
  });
export type Transporta = z.infer<typeof transportaSchema>;

/**
 * Build the typed `<transp>` value. Use `buildTranspXml` for the
 * wire XML; this overload is the typed entry point for consumers
 * that want to plug the result into a larger value.
 */
export function buildTranspObject(
  opts: { modFrete?: ModFrete; transporta?: Transporta } = {},
): TNFe_infNFe_transp {
  const out: TNFe_infNFe_transp = {
    modFrete: modFreteSchema.parse(opts.modFrete ?? '9'),
  };
  if (opts.transporta != null) {
    const t = transportaSchema.parse(opts.transporta);
    const transporta: TNFe_infNFe_transp_transporta = {};
    if (t.CNPJ != null) transporta.CNPJ = t.CNPJ;
    if (t.CPF != null) transporta.CPF = t.CPF;
    if (t.xNome != null) transporta.xNome = t.xNome;
    if (t.IE != null) transporta.IE = t.IE;
    if (t.xEnder != null) transporta.xEnder = t.xEnder;
    if (t.xMun != null) transporta.xMun = t.xMun;
    if (t.UF != null) transporta.UF = t.UF;
    out.transporta = transporta;
  }
  return out;
}

/**
 * Build the `<transp>` XML.
 *
 * Defaults to `modFrete='9'` (sem ocorrência de transporte) — the
 * right answer when the issuer doesn't transport the goods themselves
 * (which covers all retail point-of-sale). Pass `transporta` when
 * the issuer contracts a carrier and wants to disclose its identity
 * on the NF-e.
 */
export function buildTranspXml(
  opts: { modFrete?: ModFrete; transporta?: Transporta } = {},
): string {
  return serializeFragment(
    'TNFe_infNFe_transp',
    'transp',
    buildTranspObject(opts) as unknown as XmlValue,
  );
}

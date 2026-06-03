/**
 * `<transp>` block builder.
 *
 * `modFrete` is required by the XSD; `<transporta>` (carrier info),
 * `<veicTransp>`, `<reboque>` (trailer list), `<vol>` (volume list),
 * `<vagao>` and `<balsa>` are all optional. Element ordering + text
 * escaping are owned by `serializeFragment`'s META walker — same
 * pipeline used by `ide` / `emit` / `dest`.
 *
 * Mirrors Flutter `pedido_nfe_base.dart:1504-1702` (the `get transp`
 * getter) — the orchestrator's `buildTranspFromFrete` projects
 * `pedido.freteInicial` into the shape this builder expects.
 */
import { z } from 'zod';

import { serializeFragment, type XmlValue } from '../xml';
import type {
  TNFe_infNFe_transp,
  TNFe_infNFe_transp_transporta,
  TNFe_infNFe_transp_vol,
  TVeiculo,
} from '../types/nfe-schema';

export const modFreteSchema = z.enum(['0', '1', '2', '3', '4', '9']);
export type ModFrete = z.infer<typeof modFreteSchema>;

/**
 * UF enum for the transporta + veicTransp blocks. Matches the XSD
 * facet — same 27-state set as the address blocks, plus `EX` for
 * foreign carriers.
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
 * Vehicle detail (TVeiculo) — used for both `<veicTransp>` and each
 * `<reboque>` (trailer). `placa` is required by the XSD; UF + RNTC
 * are optional. RNTC is the carrier's ANTT registration number.
 */
export const veicTranspSchema = z.object({
  placa: z.string().min(1),
  UF: transpUfSchema.optional(),
  RNTC: z.string().optional(),
});
export type VeicTransp = z.infer<typeof veicTranspSchema>;

/**
 * Volume entry — one per packed unit / bundle. Every field optional
 * (the whole `<vol>` element is itself optional). Weights are kg.
 */
export const volumeTranspSchema = z.object({
  qVol: z.number().int().nonnegative().optional(),
  esp: z.string().optional(),
  marca: z.string().optional(),
  nVol: z.string().optional(),
  pesoL: z.number().nonnegative().optional(),
  pesoB: z.number().nonnegative().optional(),
});
export type VolumeTransp = z.infer<typeof volumeTranspSchema>;

export interface BuildTranspOptions {
  readonly modFrete?: ModFrete;
  readonly transporta?: Transporta;
  readonly veicTransp?: VeicTransp;
  readonly reboque?: ReadonlyArray<VeicTransp>;
  readonly vagao?: string;
  readonly balsa?: string;
  readonly vol?: ReadonlyArray<VolumeTransp>;
}

/**
 * Build the typed `<transp>` value. Use `buildTranspXml` for the
 * wire XML; this overload is the typed entry point for consumers
 * that want to plug the result into a larger value.
 */
export function buildTranspObject(
  opts: BuildTranspOptions = {},
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
  if (opts.veicTransp != null) {
    out.veicTransp = toTVeiculo(veicTranspSchema.parse(opts.veicTransp));
  }
  if (opts.reboque != null && opts.reboque.length > 0) {
    out.reboque = opts.reboque.map((r) => toTVeiculo(veicTranspSchema.parse(r)));
  }
  if (opts.vagao != null) out.vagao = opts.vagao;
  if (opts.balsa != null) out.balsa = opts.balsa;
  if (opts.vol != null && opts.vol.length > 0) {
    out.vol = opts.vol.map((v) => toVol(volumeTranspSchema.parse(v)));
  }
  return out;
}

function toTVeiculo(v: VeicTransp): TVeiculo {
  const out: TVeiculo = { placa: v.placa };
  if (v.UF != null) out.UF = v.UF;
  if (v.RNTC != null) out.RNTC = v.RNTC;
  return out;
}

function toVol(v: VolumeTransp): TNFe_infNFe_transp_vol {
  const out: TNFe_infNFe_transp_vol = {};
  if (v.qVol != null) out.qVol = String(v.qVol);
  if (v.esp != null) out.esp = v.esp;
  if (v.marca != null) out.marca = v.marca;
  if (v.nVol != null) out.nVol = v.nVol;
  // pesoL / pesoB use XSD pattern TDec_1203 — 3 decimals.
  if (v.pesoL != null) out.pesoL = v.pesoL.toFixed(3);
  if (v.pesoB != null) out.pesoB = v.pesoB.toFixed(3);
  return out;
}

/**
 * Build the `<transp>` XML.
 *
 * Defaults to `modFrete='9'` (sem ocorrência de transporte) — the
 * right answer when the issuer doesn't transport the goods themselves
 * (which covers all retail point-of-sale). Pass `transporta` /
 * `veicTransp` / `reboque` / `vol` / `vagao` / `balsa` to disclose the
 * carrier, vehicle, trailers, volumes, train car or barge respectively.
 */
export function buildTranspXml(opts: BuildTranspOptions = {}): string {
  return serializeFragment(
    'TNFe_infNFe_transp',
    'transp',
    buildTranspObject(opts) as unknown as XmlValue,
  );
}

/**
 * `<pag>` block builder.
 *
 * Builds a typed `TNFe_infNFe_pag` value and hands it to
 * `serializeFragment`, the same META-driven walker that already
 * serializes `ide` / `emit` / `dest` in `src/generator/index.ts`.
 * No raw template strings — element ordering and text escaping are
 * owned by the serializer.
 *
 * SEFAZ requires at least one `<detPag>` (or a `<vTroco>` for "no
 * payment" NF-e, which Phase A doesn't issue). The `<card>` child is
 * optional in the XSD; we emit it only when the caller supplies card
 * data, mirroring `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:1812-1849`
 * which emits `<card>` only when `cartao != null`. Attaching an
 * empty `<card>` is what triggers SEFAZ rejection 391.
 */
import { z } from 'zod';

import { serializeFragment, type XmlValue } from '../xml';
import type {
  TNFe_infNFe_pag,
  TNFe_infNFe_pag_detPag,
  TNFe_infNFe_pag_detPag_card,
} from '../types/nfe-schema';
import { fmtMoney } from './format';

/**
 * `tPag` codes (SEFAZ NT 2020.001) — full surface. The most common for
 * Brazilian retail: '01' dinheiro, '03' cartão de crédito, '04' débito,
 * '17' Pix, '99' outros.
 */
export const tPagSchema = z.enum([
  '01',
  '02',
  '03',
  '04',
  '05',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '90',
  '99',
]);
export type TPag = z.infer<typeof tPagSchema>;

/**
 * Card-payment detail block. Mirrors `TNFe_infNFe_pag_detPag_card`
 * one-for-one. Required only when the caller attaches it; the XSD
 * makes the whole block optional.
 *
 *   tpIntegra='1' — integrated POS (TEF), CNPJ + tBand + cAut REQUIRED.
 *   tpIntegra='2' — standalone (PIX, marketplace acquirer, etc.); the
 *                   other fields are optional but customarily set to
 *                   the acquirer / PSP CNPJ.
 */
export const cardSchema = z.object({
  tpIntegra: z.enum(['1', '2']),
  CNPJ: z.string().optional(),
  tBand: z.string().optional(),
  cAut: z.string().optional(),
  CNPJReceb: z.string().optional(),
  idTermPag: z.string().optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const paymentSchema = z.object({
  tPag: tPagSchema,
  vPag: z.number().nonnegative(),
  /** indPag — 0=à vista, 1=a prazo. Optional per the XSD. */
  indPag: z.enum(['0', '1']).optional(),
  /**
   * Free-text description of the payment. Required by SEFAZ (cStat=441)
   * when `tPag='99'` (outros); otherwise optional. Already-sanitized;
   * the caller passes the trimmed/cleaned value, capped at 60 chars.
   */
  xPag: z.string().max(60).optional(),
  /** Card detail. Emit only when present — empty card triggers SEFAZ 391. */
  card: cardSchema.optional(),
});
export type Payment = z.infer<typeof paymentSchema>;

/**
 * Map a validated `Payment` to its typed `TNFe_infNFe_pag_detPag`
 * value (string-formatted leaves, ready for the META walker).
 */
function toDetPag(p: Payment): TNFe_infNFe_pag_detPag {
  const detPag: TNFe_infNFe_pag_detPag = {
    tPag: p.tPag,
    vPag: fmtMoney('vPag', p.vPag),
  };
  if (p.indPag != null) {
    detPag.indPag = p.indPag;
  }
  if (p.xPag != null) {
    detPag.xPag = p.xPag;
  }
  if (p.card != null) {
    const card: TNFe_infNFe_pag_detPag_card = { tpIntegra: p.card.tpIntegra };
    if (p.card.CNPJ != null) card.CNPJ = p.card.CNPJ;
    if (p.card.tBand != null) card.tBand = p.card.tBand;
    if (p.card.cAut != null) card.cAut = p.card.cAut;
    if (p.card.CNPJReceb != null) card.CNPJReceb = p.card.CNPJReceb;
    if (p.card.idTermPag != null) card.idTermPag = p.card.idTermPag;
    detPag.card = card;
  }
  return detPag;
}

/**
 * Build the typed `<pag>` value. The caller is the typed entry point
 * for any consumer that wants to plug the result into a larger object
 * (DANFE renderer, fiscal audit, …); use `buildPagXml` to emit the
 * wire XML directly.
 */
export function buildPagObject(payments: ReadonlyArray<Payment>): TNFe_infNFe_pag {
  if (payments.length === 0) {
    throw new Error('buildPagObject: at least one payment is required');
  }
  const validated = payments.map((p, i) => {
    try {
      return paymentSchema.parse(p);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const first = err.issues[0];
        throw new Error(
          `Payment[${i}]: ${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'invalid'}`,
        );
      }
      throw err;
    }
  });
  return { detPag: validated.map(toDetPag) };
}

/**
 * Build the `<pag>` XML from a list of payments. Requires at least one.
 *
 * Example: a single Pix payment of R$ 1500,00 with a standalone card
 * block (PSP CNPJ):
 *   buildPagXml([{ tPag: '17', vPag: 1500, card: { tpIntegra: '2', CNPJ: '...' } }])
 *   → <pag><detPag><tPag>17</tPag><vPag>1500.00</vPag><card><tpIntegra>2</tpIntegra><CNPJ>...</CNPJ></card></detPag></pag>
 */
export function buildPagXml(payments: ReadonlyArray<Payment>): string {
  return serializeFragment(
    'TNFe_infNFe_pag',
    'pag',
    buildPagObject(payments) as unknown as XmlValue,
  );
}

/**
 * `<pag>` block builder.
 *
 * Builds a typed `TNFe_infNFe_pag` value and hands it to
 * `serializeFragment`, the same META-driven walker that already
 * serializes `ide` / `emit` / `dest` in `src/generator/index.ts`.
 * No raw template strings — element ordering and text escaping are
 * owned by the serializer.
 *
 * SEFAZ requires at least one `<detPag>`. `<vTroco>` is emitted only
 * when the caller supplies one — see `buildPagObject`'s second parameter
 * and the channel gate in `apps/nfe`'s `generator-input.ts`: `Σ vPag > vNF`
 * is legal ONLY with a troco, and without one SEFAZ rejects with cStat 866
 * (YA03-20, "ausência de troco"). The `<card>` child is
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
 *
 * `vTroco` — change handed back, i.e. `Σ vPag − vNF`. It belongs to the
 * `<pag>` GROUP, not to any one `<detPag>`, which is why it is a parameter
 * here and not a field on {@link Payment}. Omitted when null or when it
 * formats to `0.00`: that IS XSD-valid (`TDec_1302` matches it) and would
 * therefore be caught by nothing downstream, while saying nothing. A NEGATIVE
 * troco throws — it means `Σ vPag < vNF`, a shortfall (rejection 865, which
 * has no troco remedy), so it can only be a caller bug.
 *
 * ⚠️ The CALLER rounds — same contract as `vPag`. The wire, the
 * `Σ vPag ↔ vNF` guard and SEFAZ's own YA03 summation must all see the
 * SAME 2-decimal values; a sub-cent troco rounded here instead of at the
 * source would let the guard pass a nota the wire mis-sums.
 */
export function buildPagObject(
  payments: ReadonlyArray<Payment>,
  vTroco?: number | null,
): TNFe_infNFe_pag {
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
  const pag: TNFe_infNFe_pag = { detPag: validated.map(toDetPag) };
  if (vTroco != null) {
    // fmtMoney THROWS on a negative, deliberately — see the doc block. Dropping
    // one silently would hide the caller bug that produced it.
    const formatted = fmtMoney('vTroco', vTroco);
    if (formatted !== '0.00') pag.vTroco = formatted;
  }
  return pag;
}

/**
 * Build the `<pag>` XML from a list of payments. Requires at least one.
 *
 * Example: a single Pix payment of R$ 1500,00 with a standalone card
 * block (PSP CNPJ):
 *   buildPagXml([{ tPag: '17', vPag: 1500, card: { tpIntegra: '2', CNPJ: '...' } }])
 *   → <pag><detPag><tPag>17</tPag><vPag>1500.00</vPag><card><tpIntegra>2</tpIntegra><CNPJ>...</CNPJ></card></detPag></pag>
 *
 * With change, on a R$ 90 cash sale paid with R$ 100:
 *   buildPagXml([{ tPag: '01', vPag: 100 }], 10)
 *   → <pag><detPag><tPag>01</tPag><vPag>100.00</vPag></detPag><vTroco>10.00</vTroco></pag>
 */
export function buildPagXml(payments: ReadonlyArray<Payment>, vTroco?: number | null): string {
  return serializeFragment(
    'TNFe_infNFe_pag',
    'pag',
    buildPagObject(payments, vTroco) as unknown as XmlValue,
  );
}

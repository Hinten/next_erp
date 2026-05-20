/**
 * `<pag>` block builder.
 *
 * Accepts a typed list of payment entries — the orchestrator builds this
 * from the Pedido.pagamentos subcollection. Each entry maps to one
 * `<detPag>` inside `<pag>`. SEFAZ requires at least one `<detPag>` (or
 * a `<vTroco>` for "no payment" NF-e, which Phase A doesn't issue).
 */
import { z } from 'zod';

import { fmtMoney } from './format';

/**
 * `tPag` codes (SEFAZ NT 2020.001) — full surface. The most common for
 * Brazilian retail: '01' dinheiro, '03' cartão de crédito, '04' débito,
 * '17' Pix, '99' outros.
 */
export const tPagSchema = z.enum([
  '01', '02', '03', '04', '05', '10', '11', '12', '13', '14',
  '15', '16', '17', '18', '19', '90', '99',
]);
export type TPag = z.infer<typeof tPagSchema>;

export const paymentSchema = z.object({
  tPag: tPagSchema,
  vPag: z.number().nonnegative(),
  /** indPag — 0=à vista, 1=a prazo. Optional per the XSD. */
  indPag: z.enum(['0', '1']).optional(),
});
export type Payment = z.infer<typeof paymentSchema>;

/**
 * Build the `<pag>` XML from a list of payments. Requires at least one.
 *
 * Example: a single Pix payment of R$ 1500,00:
 *   buildPagXml([{ tPag: '17', vPag: 1500 }])
 *   → <pag><detPag><tPag>17</tPag><vPag>1500.00</vPag></detPag></pag>
 */
export function buildPagXml(payments: ReadonlyArray<Payment>): string {
  if (payments.length === 0) {
    throw new Error('buildPagXml: at least one payment is required');
  }
  // Validate each entry — Zod throws with a clear path on bad input.
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

  const inside = validated
    .map((p) => {
      const detPag =
        (p.indPag ? `<indPag>${p.indPag}</indPag>` : '') +
        `<tPag>${p.tPag}</tPag>` +
        `<vPag>${fmtMoney('vPag', p.vPag)}</vPag>`;
      return `<detPag>${detPag}</detPag>`;
    })
    .join('');
  return `<pag>${inside}</pag>`;
}

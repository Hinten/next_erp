import { z } from 'zod';

/**
 * Movement magnitudes as entered in the editor (non-negative inputs) — the wire
 * shape of {@link MovimentacaoInput}. Defined as a Zod schema so the
 * `aplicarEstoque` Cloud Function can validate untrusted callable input; the
 * inferred type is structurally identical to `MovimentacaoInput`.
 */
export const movimentacaoInputSchema = z.object({
  tipo: z.enum(['entrada', 'saida', 'balanco']),
  // Magnitudes: `planMovimentacao` applies the tipo's sign, so the input must be
  // non-negative AND finite. Enforced here because this validates UNTRUSTED
  // callable input — a negative would invert entrada/saída, and a NaN/±Infinity
  // would corrupt the stored count.
  quantidade: z.number().min(0).finite(),
  quantidadeReservada: z.number().min(0).finite(),
  motivo: z.string().nullable(),
});

/**
 * Payload for the `aplicarEstoque` callable — the server-owned estoque write
 * (getOrCreate + movement/localização + audit, in one transaction). A
 * discriminated union over `op`: a `localizacao` set, or a stock `movimento`.
 * Shared by the web client (typed input) and the Cloud Function (validation), so
 * both sides agree on the contract.
 */
export const estoqueComandoSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('localizacao'),
    produtoId: z.string().min(1),
    depositoId: z.string().min(1),
    // Mirror the 50-char cap on `estoqueProdutoSchema.localizacao`: the callable's
    // update path writes this straight through (buildLocalizacaoOp doesn't
    // re-parse the stored schema), so the cap must be enforced at this boundary.
    localizacao: z.string().max(50).nullable(),
  }),
  z.object({
    op: z.literal('movimento'),
    produtoId: z.string().min(1),
    depositoId: z.string().min(1),
    input: movimentacaoInputSchema,
  }),
]);

export type EstoqueComando = z.infer<typeof estoqueComandoSchema>;

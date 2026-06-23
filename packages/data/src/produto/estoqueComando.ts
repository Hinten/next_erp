import { z } from 'zod';

/**
 * Movement magnitudes as entered in the editor (non-negative inputs) — the wire
 * shape of {@link MovimentacaoInput}. Defined as a Zod schema so the
 * `aplicarEstoque` Cloud Function can validate untrusted callable input; the
 * inferred type is structurally identical to `MovimentacaoInput`.
 */
export const movimentacaoInputSchema = z.object({
  tipo: z.enum(['entrada', 'saida', 'balanco']),
  quantidade: z.number(),
  quantidadeReservada: z.number(),
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
    localizacao: z.string().nullable(),
  }),
  z.object({
    op: z.literal('movimento'),
    produtoId: z.string().min(1),
    depositoId: z.string().min(1),
    input: movimentacaoInputSchema,
  }),
]);

export type EstoqueComando = z.infer<typeof estoqueComandoSchema>;

import { z } from 'zod';

const variation = z.object({
  id: z.string(),
  produtoId: z.string(),
  linkDocId: z.string(),
});
export type MigracaoUptinVariacao = z.infer<typeof variation>;

/** Admin-only claim and completion receipt, keyed by account and original item. */
export const migracaoUptinMercadoLivreSchema = z.object({
  produtoId: z.string(),
  linkDocId: z.string(),
  sellerUserId: z.number(),
  attempt: z.string(),
  claimedAt: z.number(),
  dispatching: z.boolean(),
  completed: z.boolean().default(false),
  previousState: z.string().nullable(),
  variations: z.array(variation),
});

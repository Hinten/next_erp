/**
 * `<transp>` block builder.
 *
 * Phase A surface — `modFrete` is the only field that varies; transportador
 * / veículo / volumes are Phase D when the Pedido.frete subcollection is
 * wired into the orchestrator.
 */
import { z } from 'zod';

export const modFreteSchema = z.enum(['0', '1', '2', '3', '4', '9']);
export type ModFrete = z.infer<typeof modFreteSchema>;

/**
 * Build the `<transp>` XML.
 *
 * Defaults to `modFrete='9'` (sem ocorrência de transporte) — the right
 * answer when the issuer doesn't transport the goods themselves (which
 * covers all retail point-of-sale).
 */
export function buildTranspXml(opts: { modFrete?: ModFrete } = {}): string {
  const modFrete = modFreteSchema.parse(opts.modFrete ?? '9');
  return `<transp><modFrete>${modFrete}</modFrete></transp>`;
}

import { defineCollection } from '@delfrance/data';
import { regraImpostoSchema } from '@delfrance/schemas';

/**
 * The `operacao/{operacaoId}/regras` subcollection (legacy Flutter wire name,
 * #423) — per-operação Imposto rules (the old "Macros"). A rule matches a
 * pedido item by produto / categoria / NCM and supplies the deep tax config;
 * it is the resolver's last fallback tier before the operação's own default
 * config. Legacy docs may carry UPPERCASE `CFOP`, path-shaped array entries
 * and free-form NCMs — readers normalize; this editor writes the new-style
 * fields (bare uids, 8-digit NCMs, lowercase `cfop`).
 */
export const regraImpostoCollection = defineCollection({
  path: 'operacao/{operacaoId}/regras',
  schema: regraImpostoSchema,
});

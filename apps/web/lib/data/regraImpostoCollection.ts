import { defineCollection } from '@delfrance/data';
import { regraImpostoSchema } from '@delfrance/schemas';

/**
 * The `operacao/{operacaoId}/regraimposto` subcollection — per-operação Imposto
 * rules (the old "Macros"). A rule matches a pedido item by produto / categoria
 * / NCM and supplies the deep tax config; it is the resolver's last fallback
 * tier before the operação's own default config.
 */
export const regraImpostoCollection = defineCollection({
  path: 'operacao/{operacaoId}/regraimposto',
  schema: regraImpostoSchema,
});

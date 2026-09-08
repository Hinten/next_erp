import { defineCollection } from '@delfrance/data';
import { apuracaoSimplesSchema, simplesNacionalConfigSchema } from '@delfrance/schemas';

/**
 * Subcollection: `filiais/{filialId}/simplesnacional` — the per-filial Simples
 * Nacional config (single doc, id `default`). Pass `{ filialId }` in the path
 * context.
 *
 * ⚠️ Only three fields are the UI's: `anexo`, `aliquotaDeclarada` and
 * `recalculoAutomatico`. Everything else on the document is written by the
 * monthly apuração runner and is read-only here — it is the single writer of
 * those, which is what keeps sibling filiais of one CNPJ from disagreeing on a
 * figure the Receita defines per company.
 */
export const simplesNacionalConfigCollection = defineCollection({
  path: 'filiais/{filialId}/simplesnacional',
  schema: simplesNacionalConfigSchema,
});

/** The single config doc id — mirrors `SIMPLES_NACIONAL_CONFIG_DOC_ID`. */
export const SIMPLES_CONFIG_DOC_ID = 'default';

/**
 * The append-only monthly records under that doc, one per competência
 * (`.../simplesnacional/default/apuracoes/{YYYY-MM}`). Read-only in the UI.
 */
export const apuracaoSimplesCollection = defineCollection({
  path: 'filiais/{filialId}/simplesnacional/default/apuracoes',
  schema: apuracaoSimplesSchema,
});

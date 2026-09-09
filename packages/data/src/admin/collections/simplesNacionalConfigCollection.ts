import {
  apuracaoSimplesMeta,
  apuracaoSimplesSchema,
  simplesNacionalConfigMeta,
  simplesNacionalConfigSchema,
} from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handle for the per-filial Simples Nacional config
 * (`filiais/{filialId}/simplesnacional/default`).
 *
 * The computed half of this document has exactly one writer — the monthly
 * apuração runner — which is what keeps sibling filiais of the same CNPJ from
 * disagreeing on a figure the Receita defines per company, not per
 * establishment. See `simplesNacionalConfigSchema`.
 */
export const simplesNacionalConfigCollection = defineAdminCollection({
  path: simplesNacionalConfigMeta.collectionPath,
  schema: simplesNacionalConfigSchema,
});

/**
 * Admin-SDK handle for the append-only monthly apuração records
 * (`filiais/{filialId}/simplesnacional/default/apuracoes/{YYYY-MM}`).
 *
 * The document id IS the competência, so a re-run of the same month overwrites
 * its own record instead of accumulating duplicates — the runner is idempotent
 * by construction rather than by a guard.
 */
export const apuracaoSimplesCollection = defineAdminCollection({
  path: apuracaoSimplesMeta.collectionPath,
  schema: apuracaoSimplesSchema,
});

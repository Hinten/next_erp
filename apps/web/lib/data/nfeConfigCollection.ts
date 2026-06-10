import { defineCollection } from '@delfrance/data';
import { nfeConfigSchema } from '@delfrance/schemas';

/**
 * Subcollection: `filiais/{filialId}/nfeconfig` — the per-filial NF-e
 * counter + environment document (single doc, id `default`). Pass
 * `{ filialId }` in the path context. The counters advance server-side
 * (apps/nfe transactions); the web UI edits only the contingency switch
 * (`contingencia_modo` / `contingencia_justificativa` /
 * `contingencia_dataInicio`).
 */
export const nfeConfigCollection = defineCollection({
  path: 'filiais/{filialId}/nfeconfig',
  schema: nfeConfigSchema,
});

/** The single config doc id under `nfeconfig` — mirrors apps/nfe. */
export const NFE_CONFIG_DOC_ID = 'default';

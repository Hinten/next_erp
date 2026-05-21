import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Mirror `PERM.fiscal` from @delfrance/auth.
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

/**
 * `ambienteNFE` — wire codes SEFAZ uses for `<tpAmb>` (and the value
 * `apps/nfe` reads when picking the SEFAZ endpoint set).
 *
 *   '1' → produção
 *   '2' → homologação
 */
export const ambienteNFEschema = z.enum(['1', '2']);
export type AmbienteNFE = z.infer<typeof ambienteNFEschema>;

/**
 * NFeConfig — per-Filial NF-e counter document.
 *
 * Single document per filial at `filiais/{filialId}/nfeconfig/{configId}`.
 * Mirrors `NFeConfig` em `.old/packages/nfe_client/lib/src/models.dart:63`
 * — same field names and wire codes so the existing Flutter ERP and the
 * TS apps/nfe can read each other's writes during the migration.
 *
 * The three counters (`numeracao_atual`, `idLote`) advance through the
 * library's `numeracao` helpers — see
 * `packages/integrations/nfe/src/numeracao/` for the transactional
 * `nextNumeracao`, `nextNumeracaoBulk`, and `nextIdLote` flows.
 */
export const nfeConfigSchema = z.object({
  /** Last-used NF-e number for this filial + serie. */
  numeracao_atual: z.number().int().min(0).describe('Numeração atual'),
  /** SEFAZ série (0..889 for normal emission). */
  serie: z.number().int().min(0).max(889).describe('Série'),
  /** Last-used lote receipt id — independent counter from numeracao_atual. */
  idLote: z.number().int().min(0).describe('Lote'),
  /** '1' produção, '2' homologação. */
  ambiente: ambienteNFEschema.describe('Ambiente'),
  timestamp: z.string().datetime().nullable().optional(),
});

export type NFeConfig = z.infer<typeof nfeConfigSchema>;

export const nfeConfigMeta: CollectionMetadata = {
  collectionPath: 'filiais/{filialId}/nfeconfig',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
};

export const nfeConfig = { schema: nfeConfigSchema, meta: nfeConfigMeta };

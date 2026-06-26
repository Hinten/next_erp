import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { millisSinceEpoch } from './shared/datetime';

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
 * `contingenciaModo` — manual contingency switch for NF-e emission.
 *
 *   'none' → normal emission (tpEmis=1)
 *   'svc'  → SEFAZ Virtual de Contingência (tpEmis=6 SVC-AN / 7 SVC-RS, per UF)
 *   'epec' → Evento Prévio de Emissão em Contingência (tpEmis=4)
 *
 * Activation is a human decision (MOC Anexo III): the operator flips the mode
 * after confirming the home SEFAZ is down (see the status-check helper in the
 * filial NF-e config screen) and must justify it — `contingencia_justificativa`
 * becomes the NF-e's `xJust` (B29) and `contingencia_dataInicio` its `dhCont`
 * (B28), both printed on the DANFE.
 */
export const contingenciaModoSchema = z.enum(['none', 'svc', 'epec']);
export type ContingenciaModo = z.infer<typeof contingenciaModoSchema>;

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
export const nfeConfigSchema = z
  .object({
    /** Last-used NF-e number for this filial + serie. */
    numeracao_atual: z.number().int().min(0).describe('Numeração atual'),
    /** SEFAZ série (0..889 for normal emission). */
    serie: z.number().int().min(0).max(889).describe('Série'),
    /** Last-used lote receipt id — independent counter from numeracao_atual. */
    idLote: z.number().int().min(0).describe('Lote'),
    /** '1' produção, '2' homologação. */
    ambiente: ambienteNFEschema.describe('Ambiente'),
    /**
     * Contingency switch. `.default('none')` keeps pre-contingency docs (and
     * Flutter writes that never knew the field) parseable.
     */
    contingencia_modo: contingenciaModoSchema.default('none').describe('Contingência'),
    /** SEFAZ `xJust` (B29) — required (15..255 chars) while modo ≠ 'none'. */
    contingencia_justificativa: z
      .string()
      .min(15)
      .max(255)
      .nullable()
      .default(null)
      .describe('Justificativa da contingência'),
    /** SEFAZ `dhCont` (B28) — stamped when the operator activates the mode. The
     * offset-aware `dhCont` printed on the DANFE is rebuilt from this ms instant
     * + the issuer timezone at emission time, matching the Flutter wire shape. */
    contingencia_dataInicio: millisSinceEpoch('Início da contingência').nullable().default(null),
    /**
     * Reforma Tributária (IBS/CBS/IS) emission switch — NT 2025.002. When
     * `true`, emitted NF-e carry the RTC item/total groups (built from each
     * item's `configuracaoIBSCBS`). **Off by default**: the Simples Nacional
     * RTC rules are pending a future NT (mandatory only 2027-01-04), so this
     * stays a deliberate per-filial opt-in (homologação first). `.default(false)`
     * keeps pre-RTC docs (and Flutter writes that never knew the field)
     * parseable.
     */
    emitirReformaTributaria: z
      .boolean()
      .default(false)
      .describe('Emitir Reforma Tributária (IBS/CBS/IS)'),
    timestamp: millisSinceEpoch().nullable().default(null),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.contingencia_modo !== 'none') {
      if (cfg.contingencia_justificativa === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['contingencia_justificativa'],
          message: 'Justificativa é obrigatória com contingência ativa',
        });
      }
      if (cfg.contingencia_dataInicio === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['contingencia_dataInicio'],
          message: 'Data de início é obrigatória com contingência ativa',
        });
      }
    }
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

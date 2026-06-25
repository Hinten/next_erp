import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';
import { enderecoSchema } from './endereco';
import { certificadoFilialInfoSchema } from './certificadoFilial';

// Mirror `PERM.configuracoes` from @delfrance/auth.
const PERM_CONFIG_READ = 1n << 40n;
const PERM_CONFIG_WRITE = 1n << 41n;

/**
 * Filial — unidade fiscal (CNPJ) dentro de um grupo econômico. Mirrors
 * `Filial` em `.old/packages/grupo_economico/lib/src/models.dart`.
 * Reuses the shared `enderecoSchema` for `sede`.
 */
export const filialSchema = z.object({
  razaoSocial: z.string().min(1).max(1000).describe('Razão Social'),
  // `.nullable()` (no `.default`) keeps the field required-present — the
  // Firebase JS SDK rejects `undefined`, and forms supply `null` themselves.
  fantasia: z.string().max(1000).nullable().describe('Nome Fantasia'),
  cnae: z
    .string()
    .max(255)
    .nullable()
    .describe(
      '{"label":"CNAE","hint":"Classificação Nacional de Atividades Econômicas, informado pelo contador"}',
    ),
  cnpj: z.string().max(18).regex(/^\d*$/, 'apenas números').describe('CNPJ'),
  ie: z.string().regex(/^\d*$/, 'apenas números').describe('Inscrição Estadual'),
  iest: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .describe(
      '{"label":"IEST","hint":"Inscrição Estadual do substituto tributário, quando houver"}',
    ),
  imun: z.string().regex(/^\d*$/, 'apenas números').nullable().describe('Inscrição Municipal'),
  sede: enderecoSchema.describe('Endereço sede'),
  // Public A1 cert metadata, managed by the cert upload endpoint (apps/nfe),
  // NOT by this form — it is excluded from the Dados ObjectView. `.optional()`
  // keeps legacy/never-uploaded docs parseable, and because edits write only
  // dirty fields (`saveRecord` → `tx.update(pickDirty(...))`), a Dados save
  // never wipes it. The secret key lives in the admin-only
  // `certificadoSecreto` subcollection; this is just the public badge data.
  certificado: certificadoFilialInfoSchema.nullable().optional().describe('Certificado Digital'),
  timestamp: millisSinceEpoch().nullable().optional(),
  // Update-monitor field — `saveRecord` stamps it on every write. Legacy
  // (Flutter-written) docs lack it; pipeline sorts treat the missing field
  // as null (sorted last on desc) instead of excluding the doc, which is
  // what FilialPicker's recency ordering relies on.
  ultimaModificacao: millisSinceEpoch().nullable().optional(),
});

export type Filial = z.infer<typeof filialSchema>;

export const filialMeta: CollectionMetadata = {
  collectionPath: 'filiais',
  permissions: {
    read: PERM_CONFIG_READ,
    write: PERM_CONFIG_WRITE,
    delete: PERM_CONFIG_WRITE,
  },
  defaultQuery: {
    orderBy: [{ field: 'razaoSocial', direction: 'asc' }],
    limit: 50,
  },
};

export const filial = { schema: filialSchema, meta: filialMeta };

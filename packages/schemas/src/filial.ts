import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { enderecoSchema } from './endereco';

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
  cnpj: z
    .string()
    .max(18)
    .regex(/^\d*$/, 'apenas números')
    .describe('CNPJ'),
  ie: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .describe('Inscrição Estadual'),
  iest: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .describe(
      '{"label":"IEST","hint":"Inscrição Estadual do substituto tributário, quando houver"}',
    ),
  imun: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .describe('Inscrição Municipal'),
  sede: enderecoSchema.describe('Endereço sede'),
  timestamp: z.string().datetime().nullable().optional(),
});

export type Filial = z.infer<typeof filialSchema>;

export const filialMeta: CollectionMetadata = {
  collectionPath: 'filiais',
  permissions: {
    read: PERM_CONFIG_READ,
    write: PERM_CONFIG_WRITE,
    delete: PERM_CONFIG_WRITE,
  },
};

export const filial = { schema: filialSchema, meta: filialMeta };

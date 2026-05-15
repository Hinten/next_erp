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
  razaoSocial: z.string().min(1).max(1000),
  fantasia: z.string().max(1000).nullable(),
  cnae: z.string().max(255).nullable(),
  cnpj: z
    .string()
    .max(18)
    .regex(/^\d*$/, 'apenas números'),
  ie: z.string().regex(/^\d*$/, 'apenas números'),
  iest: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .nullable(),
  imun: z
    .string()
    .regex(/^\d*$/, 'apenas números')
    .nullable(),
  sede: enderecoSchema,
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

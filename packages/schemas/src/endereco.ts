import { z } from 'zod';
import type { CollectionMetadata } from './types';

const PERM_ENDERECO_READ = 1n << 3n;
const PERM_ENDERECO_WRITE = 1n << 4n;
const PERM_ENDERECO_DELETE = 1n << 5n;

/**
 * UF (Brazilian state code). Includes 'EX' for endereços no exterior.
 */
export const ufSchema = z.enum([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO',
  'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SE', 'SP', 'TO',
  'EX',
]);
export type UF = z.infer<typeof ufSchema>;

/**
 * Endereço schema. Subcollection of Cliente.
 * Mirrors `packages/clientes/lib/src/models.dart` Endereco fields.
 */
export const enderecoSchema = z.object({
  idExterno: z.string().nullable().optional(),
  logradouro: z.string().min(1).max(150),
  numero: z.string().min(1).max(10),
  bairro: z.string().min(1).max(100).default('SEM BAIRRO'),
  complemento: z.string().max(50).nullable().optional(),
  cep: z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos'),
  codigoMunicipio: z
    .string()
    .max(8)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional(),
  cidade: z.string().min(1).max(100),
  estado: ufSchema,
  cPais: z.string().nullable().optional(),
  pais: z.string().nullable().optional(),
  // Recebedor (NFe destinatário, opcional)
  nome: z.string().max(255).nullable().optional(),
  cpf_cnpj: z
    .string()
    .max(18)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional(),
  rg: z.string().nullable().optional(),
  ie: z.string().max(14).nullable().optional(),
  imun: z
    .string()
    .max(15)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional(),
  email: z.string().max(255).email().nullable().optional(),
  telefone: z
    .string()
    .max(16)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional(),
});

export type Endereco = z.infer<typeof enderecoSchema>;

export const enderecoMeta: CollectionMetadata = {
  collectionPath: 'clientes/{clienteId}/enderecos',
  permissions: {
    read: PERM_ENDERECO_READ,
    write: PERM_ENDERECO_WRITE,
    delete: PERM_ENDERECO_DELETE,
  },
};

export const endereco = { schema: enderecoSchema, meta: enderecoMeta };

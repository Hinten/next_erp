import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

const PERM_ENDERECO_READ = 1n << 3n;
const PERM_ENDERECO_WRITE = 1n << 4n;
const PERM_ENDERECO_DELETE = 1n << 5n;

/**
 * UF (Brazilian state code). Includes 'EX' for endereços no exterior.
 */
export const ufSchema = z.enum([
  'AC',
  'AL',
  'AM',
  'AP',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MG',
  'MS',
  'MT',
  'PA',
  'PB',
  'PE',
  'PI',
  'PR',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SE',
  'SP',
  'TO',
  'EX',
]);
export type UF = z.infer<typeof ufSchema>;

/**
 * Named members of {@link ufSchema}. Each name IS its wire value — a UF sigla is
 * already the readable form — so unlike the other companion constants in this
 * package this one buys rename-safety and `Find all references`, not
 * translation. `UF_SIGLA.EX` is the one that reads better than the raw literal:
 * it is not a state, it is the endereço-no-exterior marker.
 *
 * NOT named `UF`: the `delfrance/prefer-schema-enum` suggestion lands its import
 * by looking for a specifier named after the TYPE, so a constant sharing that
 * name would emit `import { UF, UF }`.
 *
 * Enforced by that same rule, which fires for any Zod enum that has a companion
 * constant like this one.
 */
export const UF_SIGLA = {
  AC: 'AC',
  AL: 'AL',
  AM: 'AM',
  AP: 'AP',
  BA: 'BA',
  CE: 'CE',
  DF: 'DF',
  ES: 'ES',
  GO: 'GO',
  MA: 'MA',
  MG: 'MG',
  MS: 'MS',
  MT: 'MT',
  PA: 'PA',
  PB: 'PB',
  PE: 'PE',
  PI: 'PI',
  PR: 'PR',
  RJ: 'RJ',
  RN: 'RN',
  RS: 'RS',
  RO: 'RO',
  RR: 'RR',
  SC: 'SC',
  SE: 'SE',
  SP: 'SP',
  TO: 'TO',
  EX: 'EX',
} as const satisfies Record<string, UF>;

/**
 * Endereço schema. Subcollection of Cliente.
 * Mirrors `packages/clientes/lib/src/models.dart` Endereco fields.
 */
export const enderecoSchema = z.object({
  idExterno: z.string().nullable().default(null).describe('ID Externo'),
  // CEP first: it's the entry point of the form (the "Buscar CEP" lookup
  // autofills logradouro/bairro/cidade/estado), so it leads the visible
  // fields. Field order here drives render order in every address form.
  cep: z
    .string()
    .regex(/^\d{8}$/, 'CEP deve ter 8 dígitos')
    .describe('CEP'),
  logradouro: z.string().min(1).max(150).describe('Logradouro'),
  numero: z.string().min(1).max(10).describe('Número'),
  bairro: z.string().min(1).max(100).default('SEM BAIRRO').describe('Bairro'),
  complemento: z.string().max(50).nullable().default(null).describe('Complemento'),
  codigoMunicipio: z
    .string()
    .max(8)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .default(null)
    .describe('Código do Município'),
  cidade: z.string().min(1).max(100).describe('Cidade'),
  estado: ufSchema.describe('Estado (UF)'),
  cPais: z.string().nullable().default(null).describe('Código do País'),
  pais: z.string().nullable().default(null).describe('País'),
  // Recebedor (NFe destinatário, opcional)
  nome: z.string().max(255).nullable().default(null).describe('Nome do recebedor'),
  cpf_cnpj: z
    .string()
    .max(18)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .default(null)
    .describe('CPF/CNPJ do recebedor'),
  rg: z.string().nullable().default(null).describe('RG'),
  ie: z.string().max(14).nullable().default(null).describe('Inscrição Estadual'),
  imun: z
    .string()
    .max(15)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .default(null)
    .describe('Inscrição Municipal'),
  email: z.string().max(255).email().nullable().default(null).describe('E-mail'),
  telefone: z
    .string()
    .max(16)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .default(null)
    .describe('Telefone'),
  // System stamps — stamped by `saveRecord` / ObjectView (hidden from forms).
  timestamp: millisSinceEpoch('Criação').nullable().default(null),
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
});

export type Endereco = z.infer<typeof enderecoSchema>;

export const enderecoMeta: CollectionMetadata = {
  collectionPath: 'clientes/{clienteId}/enderecos',
  permissions: {
    read: PERM_ENDERECO_READ,
    write: PERM_ENDERECO_WRITE,
    delete: PERM_ENDERECO_DELETE,
  },
  defaultQuery: {
    orderBy: [{ field: 'logradouro', direction: 'asc' }],
    limit: 50,
  },
};

export const endereco = { schema: enderecoSchema, meta: enderecoMeta };

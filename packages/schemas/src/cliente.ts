import { z } from 'zod';
import type { CollectionMetadata } from './types';

// Permission bits live in @delfrance/auth. Duplicating the literal values
// here would create a circular dep; instead we encode the bit positions and
// let consumers compose with PERM at use sites if they want symbolic names.
const PERM_CLIENTE_READ = 1n << 0n;
const PERM_CLIENTE_WRITE = 1n << 1n;
const PERM_CLIENTE_DELETE = 1n << 2n;

/**
 * Tipo de cliente — wire format mirrors the Flutter `tipoCliente` enum
 * (string codes '0'/'1'/'2'). Preserving the wire format is required for
 * coexistence with the live app.
 */
export const tipoClienteSchema = z.enum(['0', '1', '2']);
export type TipoCliente = z.infer<typeof tipoClienteSchema>;

export const TIPO_CLIENTE_LABELS: Record<TipoCliente, string> = {
  '0': 'Pessoa Física',
  '1': 'Pessoa Jurídica',
  '2': 'Estrangeiro',
};

/**
 * Cliente schema. Fields mirror `packages/clientes/lib/src/models.dart`
 * shape so the Flutter app and this app share the same Firestore documents.
 *
 * `.describe()` strings are the source of truth for UI labels — consumed
 * by `extractFieldsFromSchema()` in `@delfrance/ui`. Plain strings become
 * the label; JSON objects encode richer hints (kind overrides, reference
 * collection ids, etc.).
 *
 * Vector embeddings (`nome_embedding`, `telefone_embedding`) are written by
 * server-side code (Functions). They aren't part of the form schema; the
 * runtime treats them as opaque pass-through.
 */
export const clienteSchema = z.object({
  tipo: tipoClienteSchema.nullable().optional().describe('Tipo'),
  nome: z.string().max(255).nullable().optional().describe('Nome'),
  cpf_cnpj: z
    .string()
    .max(18)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional()
    .describe('CPF / CNPJ'),
  idEstrangeiro: z
    .string()
    .max(20)
    .nullable()
    .optional()
    .describe('ID estrangeiro'),
  ie: z.string().max(16).nullable().optional().describe('Inscrição estadual'),
  imun: z
    .string()
    .max(15)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional()
    .describe('Inscrição municipal'),
  isUF: z
    .string()
    .min(8)
    .max(9)
    .regex(/^\d+$/, 'apenas números')
    .nullable()
    .optional()
    .describe('IS UF'),
  email: z
    .string()
    .max(255)
    .email()
    .nullable()
    .optional()
    .describe('E-mail'),
  telefone: z
    .string()
    .max(16)
    .regex(/^\d*$/, 'apenas números')
    .nullable()
    .optional()
    .describe('Telefone'),
  observacoesInternas: z
    .string()
    .max(255)
    .nullable()
    .optional()
    .describe('Observações internas'),
  // ISO 8601; Firestore stores these as Timestamps, the data layer converts.
  timestamp: z.string().datetime().nullable().optional(),
  // Embeddings are server-managed; treat as opaque on the client.
  nome_embedding: z.unknown().nullable().optional(),
  telefone_embedding: z.unknown().nullable().optional(),
  // userCliente outer reference: stored as a Firestore document path string
  // (`users/<uid>`) on writes from this app. Phase 1 keeps it pass-through.
  userCliente: z.string().nullable().optional(),
});

export type Cliente = z.infer<typeof clienteSchema>;

export const clienteMeta: CollectionMetadata = {
  collectionPath: 'clientes',
  permissions: {
    read: PERM_CLIENTE_READ,
    write: PERM_CLIENTE_WRITE,
    delete: PERM_CLIENTE_DELETE,
  },
  cascade: [
    { path: 'clientes/{clienteId}/enderecos', onDelete: 'cascade' },
  ],
};

export const cliente = { schema: clienteSchema, meta: clienteMeta };

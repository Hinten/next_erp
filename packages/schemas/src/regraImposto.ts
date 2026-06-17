import { z } from 'zod';
import { millisSinceEpoch } from './datetime';
import type { CollectionMetadata } from './types';

// Mirrors PERM.regraImposto in packages/auth/src/permissions.ts (byte 12;
// relocated from the mis-assigned 81-83 — 81-82 belong to arquivo).
const PERM_REGRA_IMPOSTO_READ = 1n << 99n;
const PERM_REGRA_IMPOSTO_WRITE = 1n << 100n;
const PERM_REGRA_IMPOSTO_DELETE = 1n << 101n;

/**
 * RegraImposto — subcoleção
 * `operacao/{operacaoId}/regraimposto/{auto-id}`.
 * Per-operação Imposto rule; the resolver's last fallback before the
 * pedido item carries no resolvable imposto (in which case emission
 * fails loudly).
 *
 * Matching arrays use OR semantics: a rule matches an item when ANY of
 * its produtoUid / categoriaUid / NCM appears in the rule's respective
 * array. Empty arrays do not match (so an empty rule never fires).
 * When multiple rules match, the first one in the loaded order wins
 * (Flutter parity — Firestore order, no priority field).
 *
 * `nome` is optional but recommended for UI / audit.
 *
 * Imposto blob fields are pass-through and validated downstream by the
 * tribute engine.
 */
export const regraImpostoSchema = z
  .object({
    id: z.string().nullable().default(null),
    nome: z.string().min(1).max(255).nullable().default(null),
    produtos: z.array(z.string()).default([]),
    categorias: z.array(z.string()).default([]),
    ncms: z.array(z.string().regex(/^\d{8}$/)).default([]),
    dataCadastro: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type RegraImposto = z.infer<typeof regraImpostoSchema>;

export const regraImpostoMeta: CollectionMetadata = {
  collectionPath: 'operacao/{operacaoId}/regraimposto',
  permissions: {
    read: PERM_REGRA_IMPOSTO_READ,
    write: PERM_REGRA_IMPOSTO_WRITE,
    delete: PERM_REGRA_IMPOSTO_DELETE,
  },
};

export const regraImposto = {
  schema: regraImpostoSchema,
  meta: regraImpostoMeta,
};

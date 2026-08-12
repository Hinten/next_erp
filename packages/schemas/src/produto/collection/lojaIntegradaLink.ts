import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schema for the Loja Integrada listing link doc —
 * `produtos/{id}/produtolojaintegrada/{docId}` — in the EXACT old Flutter
 * wire shape (`ProdutoIntegrada`, loja_integrada `models.dart`): dual-run
 * coexistence means the Flutter app keeps reading the docs the new app
 * writes.
 *
 * This is deliberately NOT a DomainSchema and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domain in `subcollections.ts` (leaf name
 * `produtolojaintegrada` — verified against the compiled
 * `models.odm.g.dart`; `produtointegrada` is just the Dart accessor getter
 * name, #289) already covers the Firestore rules (client reads, parent
 * produto permissions); this typed shape exists for the Admin-SDK writer (the
 * future apps/loja-integrada publish flow), which bypasses rules but must not
 * drift from the Flutter wire format.
 *
 * Wire notes (#289):
 *  - `estadoPublicacao` codes aren't enumerated in the audit — modeled as a
 *    loose int-or-string rather than a guessed enum (wire tolerance over
 *    strictness);
 *  - `grades` is parent-only and `variacoes` is children-only — both stay
 *    nullable arrays since either can be absent depending on which side of
 *    the link a given doc represents.
 */

/** `produtos/{id}/produtolojaintegrada/{docId}` — the Loja Integrada listing link doc. */
export const produtoLojaIntegradaLinkSchema = z
  .object({
    // Required account link back to the owning ContaLojaIntegrada (legacy
    // required ctor param).
    contaLojaIntegrada: outerRefSchema,
    id: z.number().int().nullable().default(null),
    paiProdutoIntegradaId: z.number().int().nullable().default(null),
    estadoPublicacao: z.union([z.string(), z.number().int()]).nullable().default(null),
    error: z.string().nullable().default(null),
    sku: z.string().min(1),
    nome: z.string().nullable().default(null),
    descricao_html: z.string().nullable().default(null),
    // Legacy constructor defaults `ativo = true` — a fresh listing is active.
    ativo: z.boolean().default(true),
    destaque: z.boolean().default(false),
    usado: z.boolean().default(false),
    /** Parent-only: the option-name (grade) list. */
    grades: z.array(z.string()).nullable().default(null),
    /** Children-only: the child variation listing ids. */
    variacoes: z.array(z.string()).nullable().default(null),
    categorias: z.array(z.string()).nullable().default(null),
    marca: z.string().nullable().default(null),
    removido: z.boolean().default(false),
  })
  .passthrough();
export type ProdutoLojaIntegradaLink = z.infer<typeof produtoLojaIntegradaLinkSchema>;

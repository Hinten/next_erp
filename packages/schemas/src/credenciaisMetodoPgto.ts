import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/* -------------------------------------------------------------------------- */
/*                    CredenciaisMetodoPgto (subcollection)                   */
/* -------------------------------------------------------------------------- */

/**
 * Mercado Pago OAuth credential doc — `metodo_pgto/{metodoId}/credenciais`.
 * Mirrors `credenciaisIntegracaoSchema` (the marketplace-channel credential
 * store): one generic store, uniform OAuth-token dimension, with whatever
 * extras Mercado Pago returns (`token_type`, `scope`, `public_key`,
 * `live_mode`, …) riding along via `.passthrough()` with no bespoke fields.
 * Single-token semantics: the writer deletes older docs so at most one lives.
 *
 * **Admin-only / default-deny** — these docs hold a live `refresh_token`, so
 * they follow the `certificadoSecreto` / `credenciaisIntegracao` secret
 * pattern: this domain is deliberately left OUT of `ALL_DOMAINS` (see the
 * NOTE below), so rules-gen emits no match block and Firestore default-denies
 * every client read/write. Only the Admin SDK (the `apps/mercado-pago` OAuth
 * callback + refresh flow), which bypasses rules, reaches them — there is no
 * client consumer. The `metodo_pgto` → `credenciais` cascade is declared on
 * `metodoPagamentoMeta` but not yet enforced server-side (tracked with the
 * generic cascade triggers, #401/#516/#517) — until that lands, deleting a
 * `metodo_pgto` doc orphans this subcollection.
 */
export const credenciaisMetodoPgtoSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    /** Required ms since epoch (`now + expires_in`). Server-side only. */
    expirationDate: millisSinceEpoch(),
  })
  .passthrough();
export type CredenciaisMetodoPgto = z.infer<typeof credenciaisMetodoPgtoSchema>;

export const credenciaisMetodoPgtoMeta: CollectionMetadata = {
  collectionPath: 'metodo_pgto/{metodoId}/credenciais',
  // No client domain grants these bits — placeholder values. This collection is
  // deliberately NOT registered in `ALL_DOMAINS`, so the rules generator emits
  // no match block for it and Firestore default-denies every client read/write.
  // Only the Admin SDK (apps/mercado-pago), which bypasses rules, reaches the
  // OAuth tokens. Mirrors `credenciaisIntegracaoMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally NOT exported as a `{ schema, meta }` DomainSchema and NOT
// added to `ALL_DOMAINS` — that would make the rules generator grant clients
// access to live refresh tokens. Admin-only = default-deny (see
// `credenciaisMetodoPgtoMeta`, mirroring `credenciaisIntegracaoMeta` /
// `certificadoSecreto`). The admin collection handle consumes the path +
// schema directly. The `metodo_pgto` cascade that would free this
// subcollection on delete is declarative metadata for now — server-side
// enforcement is tracked by the generic cascade triggers (#401/#516/#517).

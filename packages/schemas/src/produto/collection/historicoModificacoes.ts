import { z } from 'zod';
import { microsSinceEpoch } from '../../shared/datetime';
import type { CollectionMetadata } from '../../types';

// Unified modification history is produto-scoped: it reuses the produto
// permission bits (byte 8 — see `produto.ts`), so reading a produto's history
// requires the same read claim as the produto itself. Write/delete bits are
// declared (required by `resolvePermissions`, which throws on an invalid bit)
// but stay inert — `meta.serverOwned` makes the rules generator deny every
// client write regardless of claim.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * `produtos/{id}/historicoDeModificacoes` doc — the unified modification
 * history for a produto. Written EXCLUSIVELY by the `onProdutoChanged`
 * trigger family (Admin SDK, `apps/functions`); clients are read-only
 * (`meta.serverOwned`, no `su` bypass). One doc per Firestore CloudEvent that
 * touches the produto — `docId` = `eventId`, so a redelivered event overwrites
 * the same doc with content-identical data instead of duplicating it.
 * `timestamp` is the event's `event.time` as **microseconds since epoch**
 * (`microsSinceEpoch()`, the repo's datetime standard; ms-derived precision ×
 * 1000, like `nowMicros()`) — never `Date.now()`, so replays stay
 * content-identical and ordered by when the write actually happened.
 * `campos`/`changes` cover only top-level fields that changed, diffed by
 * `@delfrance/core`'s `diffDocumentFields`.
 *
 * This supersedes the per-field `historicoDePrecos`/`historicoDeCusto`
 * subcollections (`./historicos.ts`) for produto writes made through this
 * app: those two stay registered (and are still written by the legacy
 * Flutter app for its own dual-run), but the Next trigger no longer writes
 * them.
 */
export const historicoModificacaoSchema = z
  .object({
    path: z.string(),
    subcolecao: z.string().nullable().default(null),
    docId: z.string(),
    kind: z.enum(['create', 'update', 'delete']),
    campos: z.array(z.string()),
    changes: z.record(z.string(), z.object({ old: z.unknown(), new: z.unknown() }).passthrough()),
    timestamp: microsSinceEpoch(),
    eventId: z.string(),
  })
  .passthrough();

export type HistoricoModificacao = z.infer<typeof historicoModificacaoSchema>;

export const historicoModificacaoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/historicoDeModificacoes',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
  serverOwned: true,
};

export const historicoModificacao = {
  schema: historicoModificacaoSchema,
  meta: historicoModificacaoMeta,
};

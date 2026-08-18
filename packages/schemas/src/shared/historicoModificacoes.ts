import { z } from 'zod';
import { microsSinceEpoch } from './datetime';
import { outerRefSchema } from './outerRef';

/**
 * ONE `historicoDeModificacoes` entry — the unified, field-level modification
 * history shared by every collection root that has one
 * (`produtos/{id}/historicoDeModificacoes`,
 * `pedidos/{id}/historicoDeModificacoes`).
 *
 * The SCHEMA is shared because the entry shape must not drift between roots —
 * one trigger factory writes them all and one feed component reads them all.
 * The `*Meta` objects are NOT generated from a factory: they stay plain
 * literals in each root's own file, because `delfrance/default-query-needs-index`
 * only fires on a `defaultQuery` property sitting next to a **string-literal**
 * `collectionPath` (`collectionPathSibling` in the rule), so a computed meta
 * would silently switch that lint error off and leave only the slower
 * `defaultQuery.indexes` runtime backstop. `historicoModificacoes.meta.test.ts`
 * pins the two literals to each other instead.
 *
 * Written EXCLUSIVELY by the `apps/functions` trigger family (Admin SDK);
 * clients are read-only (`meta.serverOwned`, no `su` bypass). One doc per
 * Firestore CloudEvent that touches the owning document or one of its covered
 * subcollections — `docId` = `eventId`, so a redelivered event overwrites the
 * same doc with content-identical data instead of duplicating it.
 *
 * `timestamp` is the event's `event.time` as **microseconds since epoch**
 * (`microsSinceEpoch()`, the repo's datetime standard) — never `Date.now()`, so
 * replays stay content-identical and ordered by when the write actually
 * happened.
 *
 * `campos`/`changes` come from `@delfrance/core`'s `diffDocumentFields`.
 * ⚠️ For a field the trigger EXPANDS (today: `pedido.itens`), `campos` carries
 * both the coarse field name and the fine `<field>.<itemKey>.<subfield>` keys
 * while `changes` carries only the fine keys — so `campos` is not
 * `Object.keys(changes)`. That asymmetry is deliberate: `array-contains` cannot
 * prefix-scan, so the coarse entry is what keeps "which entries touched the
 * items at all" queryable.
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
    /**
     * `documents/usuarios/<uid>` of whoever caused the write, resolved from the
     * Firestore event's auth context by `resolveUsuarioOuterRef`
     * (`apps/functions/src/lib/authContext.ts`).
     *
     * THREE states, and the distinction is load-bearing:
     *  - a ref — a signed-in client-SDK write; the actor is known.
     *  - `null` — the trigger LOOKED and found no end user: an Admin-SDK write
     *    (Mercado Livre import, Mercado Pago webhook, the estoque sync's own
     *    write-back, a script), or a console / service-account write whose
     *    `authId` is an e-mail rather than a uid. Renders as "Sistema".
     *  - ABSENT (`undefined`) — the row predates this field.
     *
     * Hence `.nullable().optional()` with NO `.default(null)`: Firestore
     * distinguishes an absent key from an explicit `null`, and collapsing the
     * two would make every legacy row claim to be a system write. No backfill is
     * possible — the CloudEvent that carried the actor is long gone, and
     * inventing one would corrupt the trail this collection exists to be.
     */
    usuarioOuterRef: outerRefSchema.nullable().optional(),
  })
  .passthrough();

export type HistoricoModificacao = z.infer<typeof historicoModificacaoSchema>;

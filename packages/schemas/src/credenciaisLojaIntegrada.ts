import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/* -------------------------------------------------------------------------- */
/*              CredenciaisLojaIntegrada (subcollection, one doc)             */
/* -------------------------------------------------------------------------- */

/**
 * The ONE document id of the store: `integracao/{id}/credenciaisLojaIntegrada/current`.
 * One Personal Token per conta, so the id is fixed rather than an auto-id — a
 * save can read "the" credential by id, and two writers can never create two.
 */
export const CREDENCIAL_LOJA_INTEGRADA_DOC_ID = 'current';

/**
 * The longest `reconexaoPendente.refCredencial` accepted. Meant to equal
 * `MAX_REF_CREDENCIAL` in `@delfrance/integrations-loja-integrada` (the
 * package's `client.ts`), which refuses a longer `ref` on every request.
 * ⚠️ This is a COPY, and nothing in this package compares the two: there is no
 * dependency edge between them, so `credenciaisLojaIntegrada.test.ts` pins only
 * the literal 64 here. The cross-check belongs in `apps/loja-integrada`, the
 * first workspace that depends on both packages (step 2, PR b). Until it lands,
 * changing either value means changing the other by hand.
 */
const MAX_REF_CREDENCIAL = 64;

/**
 * Loja Integrada Personal Token store —
 * `integracao/{integracaoId}/credenciaisLojaIntegrada/current`.
 *
 * The Personal Token is the store's live API key: the store owner generates it
 * in the painel, it is shown ONCE, and it lasts three months unless renewed
 * there (renewal keeps the same token). It is secret and must never live on the
 * client-readable `integracao` doc, so it is split out here, the
 * `credenciaisWhatsapp` shape.
 *
 * **Admin-only / default-deny** — same rationale as `credenciaisWhatsapp`:
 * deliberately left OUT of `ALL_DOMAINS` (see the NOTE below) so rules-gen
 * emits no match block and Firestore default-denies every client read/write.
 * Only the Admin SDK (`apps/loja-integrada`) reaches it; the browser sees a
 * status projection through that backend, never this document.
 *
 * **Cascade: NOT declared in `integracaoMeta.cascade`, on purpose.** Nothing at
 * runtime reads `meta.cascade`: the conta delete trigger
 * (`apps/functions/src/lib/cascadeCaroGenerico.ts`) walks `listCollections()`
 * and reclaims whatever subcollection EXISTS — it already reclaims
 * `brandshopee`, which the meta never declared, and
 * `apps/functions/src/cascades/caroGenerico.storage.test.ts` proves the walk
 * deletes an unregistered subcollection. Declaring it would mean editing
 * `integracao.ts`, which sits on the NF-e live lane's path list, so every push
 * to that PR would cost a SEFAZ homologação emission for a line nothing reads.
 *
 * Field notes:
 *  - `personalToken` is stored exactly as the route received it: the route
 *    trims the ends ONCE, this schema never trims. The visible-ASCII rule lives
 *    only in the package's client, which refuses anything else before a request.
 *  - `tokenFingerprint` is DIAGNOSTIC ONLY (logs, support). ⚠️ Never a guard
 *    input: the park guard compares a ref the app re-derives from
 *    `personalToken` + `tokenAtualizadoEmMs`, so a hand-edited fingerprint
 *    cannot disable parking.
 *  - Both `*Ms` fields are **milliseconds**. ⚠️ `millisSinceEpoch()` COERCES a
 *    µs value to ms instead of rejecting it, so a unit mistake on write would be
 *    silently "repaired" here — the store's tests pin each raw stored value to
 *    the injected ms clock instead of trusting this parse.
 *  - `webhookPedido` is the order-webhook registration of a later step, pinned
 *    now so that step never edits this schema. A save of the token never
 *    mentions it.
 *  - `reconexaoPendente` is the park: Loja Integrada refused the stored token
 *    with HTTP 401/403, and the conta's flows stop until a valid token is saved.
 */
export const credenciaisLojaIntegradaSchema = z.strictObject({
  personalToken: z.string().min(1),
  /** 16 lowercase hex characters — a domain-prefixed sha256 prefix. Diagnostic only. */
  tokenFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  /** ms — 23:59:59 São Paulo time on the date the operator copied from the painel. */
  tokenExpiraEmMs: millisSinceEpoch(),
  /** ms — wall clock of the last VALIDATED save or renewal. Part of the park ref. */
  tokenAtualizadoEmMs: millisSinceEpoch(),
  webhookPedido: z
    .strictObject({
      notifyUrl: z.string().regex(/^https:\/\//),
      /** At least 43 characters: 32 random bytes in base64url. */
      token: z.string().min(43),
    })
    .nullable()
    .default(null),
  reconexaoPendente: z
    .strictObject({
      /** ms, for DISPLAY only — never compared, never a clock. */
      desdeMs: millisSinceEpoch(),
      status: z.union([z.literal(401), z.literal(403)]),
      /** The versioned ref of the credential that was refused (opaque here). */
      refCredencial: z.string().min(1).max(MAX_REF_CREDENCIAL),
    })
    .nullable()
    .default(null),
});
export type CredenciaisLojaIntegrada = z.infer<typeof credenciaisLojaIntegradaSchema>;

export const credenciaisLojaIntegradaMeta: CollectionMetadata = {
  collectionPath: 'integracao/{integracaoId}/credenciaisLojaIntegrada',
  // No client domain grants these bits — placeholder values. This collection
  // is deliberately NOT registered in `ALL_DOMAINS`, so the rules generator
  // emits no match block for it and Firestore default-denies every client
  // read/write. Only the Admin SDK reaches the Personal Token. Mirrors
  // `credenciaisWhatsappMeta`.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally NOT exported as a `{ schema, meta }` DomainSchema and NOT
// added to `ALL_DOMAINS` — that would make the rules generator grant clients
// access to a live Personal Token. Admin-only = default-deny (see
// `credenciaisLojaIntegradaMeta`, mirroring `credenciaisWhatsappMeta`). The admin
// collection handle consumes the path + schema directly; the server-side
// cascade on `integracao` delete frees the subcollection without a rules block,
// through its discovery walk rather than a declared `cascade` entry (see the
// docblock above). ⚠️ `registry.test.ts` fails any barrel export of the combined
// shape that is missing from `ALL_DOMAINS` — and "fixing" that by registering it
// is exactly the client grant this NOTE forbids.

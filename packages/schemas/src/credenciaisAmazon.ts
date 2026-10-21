import { z } from 'zod';
import { credenciaisIntegracaoSchema } from './integracao';
import { millisSinceEpoch } from './shared/datetime';

/* -------------------------------------------------------------------------- */
/*        CredenciaisAmazon — the typed Amazon shape of `credenciais/current`  */
/* -------------------------------------------------------------------------- */

/**
 * The ONE document id of an Amazon conta's LWA credential:
 * `integracao/{id}/credenciais/current`. One authorization per conta, so the id
 * is fixed rather than an auto-id — a consent can overwrite "the" credential by
 * id, and two writers can never create two.
 */
export const CREDENCIAL_AMAZON_DOC_ID = 'current';

/**
 * The longest `refCredencial` / `acessoRef` accepted. Meant to equal
 * `MAX_REF_CREDENCIAL` in `@delfrance/integrations-amazon-sp-api` (its
 * `transporte.ts`), which refuses a longer `ref` on every request, so a stored
 * ref past it could never be matched.
 *
 * ⚠️ A pinned COPY: this package has no dependency edge to the provider
 * package, so `credenciaisAmazon.test.ts` pins only the literal 64 here. The
 * cross-check (`MAX_REF_CREDENCIAL_AMAZON === MAX_REF_CREDENCIAL`) lives in
 * `apps/amazon`, the first workspace that depends on both — changing either
 * value alone reds it there.
 */
export const MAX_REF_CREDENCIAL_AMAZON = 64;

/**
 * The PARK: the LWA token endpoint refused the conta's CURRENT refresh token,
 * and the conta's flows stop until an operator reconnects it (a new consent
 * overwrites the whole document, clearing this block).
 *
 *  - `desdeMs` — ms, for DISPLAY only. Never compared, never a clock: the aviso
 *    clock is the document's commit time.
 *  - `status` — the HTTP status of the refusal that parked it (a 4xx).
 *  - `codigoLwa` — the package's `CodigoErroLwa` as text (`invalid_grant`, …),
 *    or `null` when the refusal carried no LWA code. Opaque here: the closed set
 *    lives in the provider package, which this one cannot import.
 *  - `refCredencial` — the versioned ref of the credential that was refused.
 *    Opaque here; the app re-derives the CURRENT ref from the stored
 *    `refresh_token` + `autorizadoEmMs` and parks only when the two match, so a
 *    refusal of an older token never parks a newer one.
 */
export const reconexaoPendenteAmazonSchema = z.strictObject({
  desdeMs: millisSinceEpoch(),
  status: z.number().int().min(400).max(499),
  codigoLwa: z.string().max(32).nullable(),
  refCredencial: z.string().min(1).max(MAX_REF_CREDENCIAL_AMAZON),
});

/**
 * The Amazon conta's Login with Amazon (LWA) credential, stored in the GENERIC
 * marketplace store `integracao/{integracaoId}/credenciais/{@link CREDENCIAL_AMAZON_DOC_ID}`.
 *
 * **Not a new collection.** The path is `credenciaisIntegracaoMeta`'s (admin-only,
 * default-deny, 0n/0n/0n, outside `ALL_DOMAINS`), so this file declares no meta
 * and registers nothing: the rulesets cannot change because of it. Only the
 * Admin SDK in `apps/amazon` reaches the document; the browser sees a status
 * projection through that backend (`statusContaAmazonSchema`), never this.
 *
 * **One definition of the OAuth trio.** `access_token`, `refresh_token` and
 * `expirationDate` (ms) come from `credenciaisIntegracaoSchema` unchanged; this
 * schema only EXTENDS it with Amazon's three fields and then closes it.
 *
 * **Strict on purpose.** The generic schema is `.passthrough()`; this one is
 * `.strict()`, so a hand-added key makes the document read as CORRUPT instead of
 * riding along. App reads use `credenciaisAmazonSchema.safeParse`, never the
 * collection handle's soft `parseRead` (which logs and hands back the raw
 * document on a mismatch) — a strict reader never gives a half-formed credential
 * to the park guard.
 *
 * Field notes:
 *  - `access_token` / `expirationDate` — the LWA access token and its expiry in
 *    ms, persisted so every request does not cost an LWA exchange.
 *  - `refresh_token` — the long-lived grant. Amazon does not rotate it on use.
 *  - `autorizadoEmMs` — ms, the start of OUR callback's code exchange: the clock
 *    of the 365-day reauthorization (`reautorizarAteAmazon`). Never
 *    `dataCadastro` and never a value from the migrated corpus, which carries no
 *    authorization date. Part of the park ref.
 *  - `acessoRef` — the ref of the refresh token that minted the stored access
 *    token. The getter uses the stored token only when `acessoRef` equals the
 *    ref it re-derives now, so a token minted from an older grant that lands
 *    after a new consent is ignored rather than served. `null` until the first
 *    access token is persisted.
 *  - `reconexaoPendente` — the park ({@link reconexaoPendenteAmazonSchema}).
 *
 * ⚠️ Every `*Ms` field (and `expirationDate`) is **milliseconds**, and
 * `millisSinceEpoch()` COERCES a µs value to ms instead of rejecting it: a unit
 * mistake on write would be silently "repaired" here. The store's tests pin the
 * RAW stored values instead of trusting this parse to catch it.
 *
 * ⚠️ Never add a stored fingerprint of the refresh token as a guard input: the
 * park ref is always re-derived from `refresh_token` + `autorizadoEmMs`, so a
 * hand-edited field can never disable parking.
 */
export const credenciaisAmazonSchema = credenciaisIntegracaoSchema
  .extend({
    autorizadoEmMs: millisSinceEpoch(),
    acessoRef: z.string().min(1).max(MAX_REF_CREDENCIAL_AMAZON).nullable().default(null),
    reconexaoPendente: reconexaoPendenteAmazonSchema.nullable().default(null),
  })
  .strict();
export type CredenciaisAmazon = z.infer<typeof credenciaisAmazonSchema>;

// NOTE: intentionally NO meta and NO `{ schema, meta }` export. The collection
// is `credenciaisIntegracaoMeta`'s, admin-only and outside `ALL_DOMAINS`, and the
// admin handle (`credenciaisIntegracaoCollection`) already resolves the path.
// ⚠️ `registry.test.ts` fails any barrel export of the combined shape that is
// missing from `ALL_DOMAINS` — and "fixing" that by registering it would make
// the rules generator grant clients access to a live refresh token.

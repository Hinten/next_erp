import { z } from 'zod';
import { FEED_ID_REGISTRO_AMAZON_REGEX } from '../../feedAmazon';
import { outerRefSchema } from '../../shared/outerRef';
import { millisSinceEpoch } from '../../shared/datetime';

/**
 * Typed write-side schema for the Amazon listing link doc —
 * `produtos/{id}/prodAmazon/{docId}` — in the EXACT old Flutter wire shape
 * (`ProdutoAmazon`, amazon `models.dart`): the migrated corpus is stored in
 * exactly this shape, so it has to be read and written that way.
 *
 * This is deliberately NOT a DomainSchema and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domain in `subcollections.ts` (leaf name
 * `prodAmazon` — verified against the compiled `models.odm.g.dart`, #289)
 * already covers the Firestore rules (client reads, parent produto
 * permissions); this typed shape exists for the Admin-SDK writer (the future
 * apps/amazon publish flow + notification processor, #363), which bypasses
 * rules but must not drift from the Flutter wire format.
 *
 * Wire notes (from the parity audit, #289 + #363):
 *  - `submitStatus` / `listingStatus` use the raw SP-API uppercase codes
 *    (`SUBMIT_STATUS.fromJson` / `LISTING_STATUS.fromJson`) — `ACCEPTED` |
 *    `INVALID` | `VALID` and `BUYABLE` | `DISCOVERABLE` respectively;
 *  - `issues` are raw SP-API issue objects (`code`, `message`, `severity`,
 *    `attributeNames`, `categories`, #363) — typed loosely here (extra keys
 *    pass through) since the audit didn't need the full SP-API issue schema;
 *  - on a 404 from `getListingsItem` the notification processor resets the
 *    child doc to `asin: null, retrySubmitDate: null, issues: null,
 *    submitStatus: null, listingStatus: []` (#363), so every optional field
 *    below must stay nullable to represent that reset.
 */

/** Amazon `SUBMIT_STATUS` wire codes (models.dart). */
export const amazonSubmitStatusSchema = z.enum(['ACCEPTED', 'INVALID', 'VALID']);
export type AmazonSubmitStatus = z.infer<typeof amazonSubmitStatusSchema>;

/** Named members of {@link amazonSubmitStatusSchema} — the SP-API wire codes. */
export const AMAZON_SUBMIT_STATUS = {
  accepted: 'ACCEPTED',
  invalid: 'INVALID',
  valid: 'VALID',
} as const satisfies Record<string, AmazonSubmitStatus>;

/** Amazon `LISTING_STATUS` wire codes (models.dart). */
export const amazonListingStatusSchema = z.enum(['BUYABLE', 'DISCOVERABLE']);
export type AmazonListingStatus = z.infer<typeof amazonListingStatusSchema>;

/** Named members of {@link amazonListingStatusSchema} — the SP-API wire codes. */
export const AMAZON_LISTING_STATUS = {
  buyable: 'BUYABLE',
  discoverable: 'DISCOVERABLE',
} as const satisfies Record<string, AmazonListingStatus>;

/** One raw SP-API listing issue (`code`, `message`, `severity`, ..., #363). */
export const amazonIssueWireSchema = z
  .object({
    code: z.string().nullable().default(null),
    message: z.string().nullable().default(null),
    severity: z.string().nullable().default(null),
    attributeNames: z.array(z.string()).nullable().default(null),
    categories: z.array(z.string()).nullable().default(null),
  })
  .passthrough();
export type AmazonIssueWire = z.infer<typeof amazonIssueWireSchema>;

/** How a stock outcome reached Amazon: one `patchListingsItem`, or one `JSON_LISTINGS_FEED`. */
export const viaEnvioEstoqueAmazonSchema = z.enum(['patch', 'feed']);
export type ViaEnvioEstoqueAmazon = z.infer<typeof viaEnvioEstoqueAmazonSchema>;

/** Named members of {@link viaEnvioEstoqueAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const VIA_ENVIO_ESTOQUE_AMAZON = {
  patch: 'patch',
  feed: 'feed',
} as const satisfies Record<string, ViaEnvioEstoqueAmazon>;

/**
 * What Amazon answered a stock send: `aceito`, `aceito-com-avisos`, `recusado`,
 * or `incerto` — a patch whose answer was lost (a cut connection, a 5xx),
 * written BEFORE its retry so the retry treats it as a recent send.
 */
export const resultadoEnvioEstoqueAmazonSchema = z.enum([
  'aceito',
  'recusado',
  'aceito-com-avisos',
  'incerto',
]);
export type ResultadoEnvioEstoqueAmazon = z.infer<typeof resultadoEnvioEstoqueAmazonSchema>;

/** Named members of {@link resultadoEnvioEstoqueAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const RESULTADO_ENVIO_ESTOQUE_AMAZON = {
  aceito: 'aceito',
  recusado: 'recusado',
  aceitoComAvisos: 'aceito-com-avisos',
  incerto: 'incerto',
} as const satisfies Record<string, ResultadoEnvioEstoqueAmazon>;

/** The most issues one stock outcome keeps (the rest are only counted, in the log). */
export const MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON = 10;

/** A non-negative SAFE integer. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/**
 * The last stock outcome of ONE link doc (Amazon step 12) — a field of its own,
 * apart from the legacy `issues`, so the stock and price flows and their three
 * sources (the patch answer, a feed report, the read-back) never overwrite each
 * other.
 *
 *  - `emMs` — OUR submission instant, in ms (a patch: right before the PATCH; a
 *    feed: right before `createFeed`). It is the field's watermark: a writer
 *    replaces a stored outcome only with a STRICTLY newer `emMs` (equal keeps
 *    the stored), so a feed report arriving hours later never overwrites a
 *    later patch's outcome.
 *  - `quantidade` — the quantity a PATCH carried; `null` for a feed, whose
 *    quantities live only inside its never-stored document.
 *  - `submissionId` — Amazon's id of a patch submission (null when its answer
 *    carried none, and always for `incerto`); `feedId` — the feed's (a feed
 *    only).
 *  - `problemas` — Amazon's issues for this SKU, at most
 *    {@link MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON}.
 *
 * The coherence between `via`, `resultado` and the ids is checked here, on the
 * nested object, so the link schema itself carries no top-level refinement.
 */
export const envioEstoqueAmazonSchema = z
  .object({
    via: viaEnvioEstoqueAmazonSchema,
    /** ms — our submission instant: the watermark (above). */
    emMs: inteiroSeguro(),
    /** The quantity a patch sent; null for a feed. */
    quantidade: inteiroSeguro().nullable(),
    resultado: resultadoEnvioEstoqueAmazonSchema,
    submissionId: z.string().min(1).nullable().default(null),
    /** The feed record's own grammar: a feed outcome names a feed the record can name. */
    feedId: z.string().regex(FEED_ID_REGISTRO_AMAZON_REGEX).nullable().default(null),
    problemas: z
      .array(amazonIssueWireSchema)
      .max(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON)
      .default(() => []),
  })
  .superRefine((envio, ctx) => {
    const recusar = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (envio.via === VIA_ENVIO_ESTOQUE_AMAZON.feed) {
      if (envio.quantidade !== null) recusar('quantidade', 'um feed não guarda quantidade');
      if (envio.feedId === null) recusar('feedId', 'um resultado de feed precisa do feedId');
      if (envio.submissionId !== null) recusar('submissionId', 'um feed não tem submissionId');
      if (envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto) {
        recusar('resultado', 'só um patch pode ficar incerto');
      }
      return;
    }
    if (envio.quantidade === null) recusar('quantidade', 'um patch guarda a quantidade enviada');
    if (envio.feedId !== null) recusar('feedId', 'um patch não tem feedId');
    if (envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto) {
      if (envio.submissionId !== null) recusar('submissionId', 'um patch incerto não tem resposta');
      if (envio.problemas.length > 0) recusar('problemas', 'um patch incerto não tem resposta');
    }
  });
export type EnvioEstoqueAmazon = z.infer<typeof envioEstoqueAmazonSchema>;

/** `produtos/{id}/prodAmazon/{docId}` — the Amazon listing link doc. */
export const produtoAmazonLinkSchema = z
  .object({
    // Required account link — the `(contaAmazonOuterRef, sku)` lookup key of
    // the #363 notification processors (legacy required ctor param).
    contaAmazonOuterRef: outerRefSchema,
    name: z.string().min(1),
    sku: z.string().min(1),
    asin: z.string().nullable().default(null),
    marketplaceIds: z.array(z.string()).default(['A2Q3Y263D00KWC']),
    productType: z.string().nullable().default(null),
    productTypeVersion: z.string().nullable().default(null),
    // Raw SP-API attributes JSON — pass-through, not fully enumerated by the audit.
    productDataJson: z.record(z.string(), z.unknown()).nullable().default(null),
    productDataAllFields: z.array(z.string()).nullable().default(null),
    submitStatus: amazonSubmitStatusSchema.nullable().default(null),
    listingStatus: z.array(amazonListingStatusSchema).nullable().default(null),
    issues: z.array(amazonIssueWireSchema).nullable().default(null),
    retrySubmitDate: millisSinceEpoch().nullable().default(null),
    // The last stock outcome (Amazon step 12); null on every link it never reached.
    envioEstoqueAmazon: envioEstoqueAmazonSchema.nullable().default(null),
  })
  .passthrough();
export type ProdutoAmazonLink = z.infer<typeof produtoAmazonLinkSchema>;

/**
 * The fields of the Amazon order import's link query, IN INDEX ORDER — the ONE
 * spelling of them (Amazon step 5). The query builds its `.where()` calls from
 * this tuple, and `produtoAmazon.indexes.test.ts` pins the
 * `prodAmazon (contaAmazonOuterRef ASC, sku ASC)` collection-group index in
 * `firestore.indexes.json` against it, so the query and its index cannot name
 * different fields.
 *
 * The query is `contaAmazonOuterRef in <the conta's ref forms>` and
 * `sku == <the order line's seller SKU>`, over EVERY produto's `prodAmazon`
 * subcollection. On this Enterprise database a query with no matching index
 * does not fail: it scans every link doc and bills the data scanned, so the
 * index is declared with the query's first reader. DEPLOYING it is
 * migration-window work, and agents never run it.
 *
 * Typed against the schema's own keys, so a renamed schema field breaks the
 * build here rather than leaving the index pointing at a field no doc has.
 */
export const CAMPOS_INDICE_VINCULO_AMAZON = [
  'contaAmazonOuterRef',
  'sku',
] as const satisfies ReadonlyArray<keyof typeof produtoAmazonLinkSchema.shape>;
